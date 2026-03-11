# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AutoMorpheBuilder is a GitHub Actions-based CI/CD automation project for building patched Android APKs using Morphe patches, morphe-cli, and APKEditor. It's primarily a CI/CD configuration project, not a traditional software application.

## Supported Apps

- YouTube (`com.google.android.youtube`)
- YouTube Music (`com.google.android.apps.youtube.music`)
- Reddit (`com.reddit.frontpage`)

## Common Commands

### Running the Workflow

- **Manual trigger**: Go to GitHub Actions → "Build Morphe-patched apps" → "Run workflow"
- **Automatic**: Runs daily at 05:15 UTC (scheduled)
- **Skip build**: Workflow only runs when Morphe patch or CLI version changes

### Local Validation

```bash
# Validate GitHub Actions workflow
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .

# Validate JSON files
jq '.' patches.json > /dev/null && echo "Valid JSON"
jq '.' state.json > /dev/null && echo "Valid JSON"

# Lint shell scripts
shellcheck .github/scripts/*.sh

# Lint JavaScript files (requires Node.js)
npx eslint .github/scripts/*.js
```

## Architecture

### Workflow Structure (`.github/workflows/morphe-build.yml`)

The workflow has these main jobs:

1. **check-versions**: Queries Morphe GitHub repos for latest patch/CLI versions, determines if build is needed
2. **setup**: Prepares tools (morphe-cli.jar, APKEditor), decodes keystore, downloads APKs
3. **build-app**: Runs morphe-cli to patch each APK
4. **create-release**: Creates GitHub Release with dated tag `vYYYY.MM.DD`

### Key Files

| File | Purpose |
|------|---------|
| `patches.json` | User configuration - which patches to enable/disable, APKMirror paths, manual download URLs |
| `state.json` | Tracks Morphe versions and build history |
| `.github/workflows/morphe-build.yml` | Main CI/CD workflow with all build logic |
| `.github/scripts/apkmirror-*.js` | JavaScript utilities for APKMirror URL resolution |

### Download URL Resolution

1. Uses `morphe-cli list-versions` to find latest Morphe-supported app version
2. Constructs APKMirror URL using predictable format
3. Probes variant numbers (1-15) with curl to find correct download URL
4. Falls back to manual URLs in `patches.json` if auto-resolution fails

### APK Selection Logic

- Resolves Morphe-supported versions and downloads only the latest supported
- Handles `.apk`, `.xapk`, `.apkm` files
- For split packages, tries APKEditor merge first, falls back to dex-bearing extraction
- Prioritizes configured architecture (`preferred_arch`, defaults to `arm64-v8a`)
- Rejects dex-less APKs (requires `classes*.dex`)

### Signing Flow

- Decodes `KEYSTORE_BASE64` secret into `tools/source.keystore`
- Detects keystore type (PKCS12, JKS, BKS, UBER) and converts to BKS format
- Signs patched APK using morphe-cli
- **Build fails if signing cannot complete** - signed builds are enforced

## Configuration

### patches.json Structure

```json
{
  "__morphe": {
    "preferred_arch": "arm64-v8a",
    "apkmirror_paths": {
      "com.google.android.youtube": "google-inc/youtube"
    },
    "branches": {
      "morphe_patches": "main",
      "morphe_cli": "main"
    },
    "download_urls": {
      "com.google.android.youtube": {
        "latest_supported": "https://www.apkmirror.com/apk/..."
      }
    }
  },
  "com.google.android.youtube": {
    "YouTube Vanced": true
  }
}
```

### Required GitHub Secrets

| Secret | Required | Notes |
|--------|----------|-------|
| `KEYSTORE_BASE64` | Yes | Base64-encoded keystore file |
| `KEYSTORE_PASSWORD` | Yes | Keystore password |
| `KEY_ALIAS` | No | Defaults to first alias in keystore |
| `KEY_PASSWORD` | No | Only if key password differs |

## Code Style

- **Shell scripts**: Use `set -euo pipefail` for strict error handling
- **YAML**: 2-space indentation, explicit booleans (`true`/`false`)
- **JavaScript**: ES6+, async/await, const/let (never var)
- **Files**: kebab-case (`apkmirror-version-resolver.js`)
- **Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Git commits**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)

## Troubleshooting

- Check workflow run logs in GitHub Actions for `::error::` and `::warning::` markers
- Verify `patches.json` is valid JSON
- Ensure APKMirror URLs in `download_urls` are still valid
- Keystore errors: verify `KEYSTORE_BASE64` decodes correctly and passwords match
