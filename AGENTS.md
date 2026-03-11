# AGENTS.md - AutoMorpheBuilder

This file provides guidelines for agentic coding agents working in this repository.

## Project Overview

AutoMorpheBuilder is a GitHub Actions-based automation project for building patched Android APKs using Morphe patches. It's primarily a CI/CD configuration project, not a traditional software application.

## Project Structure

```
.
├── .github/
│   ├── workflows/
│   │   └── morphe-build.yml    # Main GitHub Actions workflow
│   └── scripts/
│       ├── apkmirror-playwright.js
│       ├── apkmirror-version-resolver.js
│       └── apkmirror-downloader.js
├── tools/
│   ├── morphe-cli.jar          # Morphe CLI tool
│   └── patches-*.mpp           # Morphe patch definitions
├── patches.json                # Patch configuration (user-editable)
├── state.json                 # Build state tracking
├── README.md                   # Project documentation
└── SETUP.md                   # Setup guide
```

## Build/Test Commands

This project doesn't have traditional build commands. Testing is done via GitHub Actions:

### Running the Workflow

1. **Manual Trigger**: Go to GitHub Actions → "Build Morphe-patched apps" → "Run workflow"
2. **Automatic**: Runs daily at 05:15 UTC (scheduled)
3. **Local Validation**: Run `actionlint` on the workflow:
   ```bash
   docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .
   ```

### JSON Validation

Validate JSON files:
```bash
# Validate patches.json
jq '.' patches.json > /dev/null && echo "Valid JSON"

# Validate state.json
jq '.' state.json > /dev/null && echo "Valid JSON"
```

### Shell Script Validation

```bash
# Check shell scripts with shellcheck
shellcheck .github/scripts/*.sh
```

### JavaScript Linting

```bash
# Lint JavaScript files (requires Node.js)
npx eslint .github/scripts/*.js
```

## Code Style Guidelines

### General Principles

- **Shell scripts**: Use `set -euo pipefail` for strict error handling
- **JSON**: Use consistent indentation (2 spaces)
- **YAML**: Use consistent indentation (2 spaces)
- **JavaScript**: Use ES6+ features, prefer async/await over callbacks

### YAML (GitHub Actions Workflows)

```yaml
# Use 2-space indentation
# Use quotes for strings that could be misinterpreted
# Prefer explicit Boolean values (true/false over yes/no)

- name: Checkout
  uses: actions/checkout@v4

- name: Run script
  run: |
    set -euo pipefail
    # ... commands
```

### JavaScript

```javascript
// Use strict mode
'use strict';

// Use const/let, never var
const fs = require('node:fs');
const path = require('node:path');

// Prefer async/await over promises
async function resolveApkUrl(packageId, targetVersion, preferredArch) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config;
  } catch (e) {
    throw new Error(`Error: ${e.message}`);
  }
}

// Use template literals
const message = `Processing ${packageId} version ${targetVersion}`;

// Prefer arrow functions for callbacks
const handler = (error) => {
  console.error(error);
  process.exit(1);
};
```

### Shell Scripts

```bash
#!/usr/bin/env bash
set -euo pipefail

# Use descriptive variable names
readonly APK_DIR="apps"
readonly OUTPUT_DIR="out"

# Use functions for reusable logic
download_apk() {
  local url="$1"
  local output="$2"
  
  curl -fSL -o "$output" "$url"
}
```

### JSON Configuration

```json
{
  "__morphe": {
    "preferred_arch": "arm64-v8a",
    "apkmirror_paths": {
      "com.google.android.youtube": "google-inc/youtube"
    }
  }
}
```

### Naming Conventions

- **Files**: kebab-case (`apkmirror-version-resolver.js`)
- **Variables**: camelCase (`downloadUrl`, `targetVersion`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRIES`, `DEFAULT_TIMEOUT`)
- **Functions**: camelCase, descriptive names (`resolveApkUrl`, `mergeSplitPackage`)
- **GitHub Actions jobs**: kebab-case (`check-versions`, `build-app`)

### Error Handling

1. **Shell**: Always use `set -euo pipefail`
2. **JavaScript**: Use try/catch with meaningful error messages
3. **YAML**: Use proper error messages in `echo "::error::..."`
4. **Fail fast**: Exit early on critical errors

```bash
# Shell error handling
set -euo pipefail

if [ -z "$VARIABLE" ]; then
  echo "::error::Required variable VARIABLE is not set"
  exit 1
fi
```

```javascript
// JavaScript error handling
try {
  const result = await someOperation();
} catch (error) {
  console.error(`Operation failed: ${error.message}`);
  process.exit(1);
}
```

### Git Commits

Follow conventional commits:
- `feat: add new app support`
- `fix: resolve APK download issue`
- `chore: update patches.json`
- `docs: update README`

### Security Considerations

- Never commit keystores or secrets
- Use GitHub Secrets for sensitive data
- Base64-encode keystore if committing (only for local testing)
- Sanitize URLs before downloading

### Key Files to Know

1. **patches.json**: User configuration for which patches to enable/disable
2. **state.json**: Tracks Morphe versions and build history
3. **morphe-build.yml**: Main workflow - contains all build logic
4. **APKMirror scripts**: Handle APK download from APKMirror

### Common Operations

**Adding a new app**:
1. Add entry to `patches.json` with app package ID
2. Add APKMirror path mapping in `__morphe.apkmirror_paths`
3. Add app to matrix in `morphe-build.yml`

**Updating Morphe version**:
1. Run workflow manually or wait for scheduled run
2. Workflow auto-detects new versions
3. state.json is auto-updated

**Troubleshooting builds**:
1. Check workflow run logs in GitHub Actions
2. Look for `::error::` and `::warning::` markers
3. Verify patches.json is valid JSON
4. Check that download URLs are still valid
