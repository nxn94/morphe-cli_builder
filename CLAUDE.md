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
# Run JavaScript unit tests
npm test

# Run a single test file
npx jest .github/scripts/__tests__/apkmirror-scraper.test.js

# Validate GitHub Actions workflow
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .

# Validate JSON files
jq '.' patches.json > /dev/null && echo "patches.json valid"
jq '.' config.json > /dev/null && echo "config.json valid"
jq '.' state.json > /dev/null && echo "state.json valid"

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
| `patches.json` | Patch toggles — repo-keyed structure: `{ "owner/repo": { "pkg": { "Patch": true } } }` |
| `config.json` | Build configuration — preferred arch, APKMirror paths, per-app patch repo assignments, cached download URLs |
| `state.json` | Tracks Morphe versions and build history |
| `.github/workflows/morphe-build.yml` | Main CI/CD workflow with all build logic |
| `.github/workflows/update-patches.yml` | Manual-trigger workflow to sync `patches.json` from upstream patch repos before building |
| `.github/scripts/unified-downloader.js` | APK downloader — multi-source fallback chain with APKMirror scraper and Playwright |
| `.github/scripts/update-download-urls.js` | Updates `config.json` `download_urls` after a successful build |
| `.github/scripts/__tests__/apkmirror-scraper.test.js` | Jest unit tests for URL-building and variant-selection helpers |

### Download Flow

Multi-source fallback chain (first valid result wins):

1. **APK cache** — `~/.cache/auto-morphe-builder/apks/` for previously downloaded APKs
2. **URL cache** — `~/.cache/auto-morphe-builder/urls/` for previously resolved direct download URLs
3. **config.json `download_urls`** — version-specific URLs saved by `update-download-urls.js` after each successful build
4. **Parallel resolution** — apkeep (APKPure), APKMirror API, and APKMirror curl scraper run simultaneously
5. **Playwright fallback** — Chromium browser used when Cloudflare blocks curl on APKMirror; all 3 navigation pages run within the same browser session to preserve cookies

### APK Selection Logic

- Resolves Morphe-supported versions via `morphe-cli list-versions`, downloads only the latest supported
- Handles `.apk`, `.xapk`, `.apkm` files
- For split packages, tries APKEditor merge first, falls back to dex-bearing APK extraction
- Prioritizes configured architecture (`preferred_arch`, defaults to `arm64-v8a`)
- DPI preference order: `nodpi` → `120-640dpi` → `240-480dpi`
- Rejects dex-less APKs (requires `classes*.dex`)
- Output artifacts named `<app>-<patches-version>-v<base-version>.apk`

### Workflow: `update-patches.yml`

Manual-trigger only (`workflow_dispatch`). Syncs `patches.json` from all configured patch repos in `patch_repos`. Run this before the build workflow when repos have new patches.

Intended usage: Run `update-patches` → review/edit `patches.json` → run full build workflow.

### Signing Flow

- Decodes `KEYSTORE_BASE64` secret into `tools/source.keystore`
- Detects keystore type (PKCS12, JKS, BKS, UBER) and converts to BKS format
- Signs patched APK using morphe-cli
- **Build fails if signing cannot complete** - signed builds are enforced

## Configuration

### config.json Structure

```json
{
  "preferred_arch": "arm64-v8a",
  "auto_update_urls": true,
  "apkmirror_paths": {
    "com.google.android.youtube": "google-inc/youtube"
  },
  "patch_repos": {
    "com.google.android.youtube": { "name": "youtube", "repo": "MorpheApp/morphe-patches", "branch": "dev" }
  },
  "cli": { "repo": "MorpheApp/morphe-cli", "branch": "dev" },
  "download_urls": {
    "com.google.android.youtube": {
      "latest_supported": "https://www.apkmirror.com/apk/..."
    }
  }
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `preferred_arch` | `arm64-v8a` | Target ABI for APK selection |
| `auto_update_urls` | — | When true, `update-download-urls.js` persists resolved URLs back to this file |
| `apkmirror_paths` | — | Maps package ID to APKMirror URL path segment |
| `patch_repos` | — | Maps each app package ID to `{ name, repo, branch }`. Apps absent from this map are skipped by the build. |
| `cli` | — | Patch CLI repo and branch: `{ repo, branch }` for `morphe-cli`. |
| `download_urls` | — | Version-specific cached download URLs, written by `update-download-urls.js` |

### patches.json Structure

Repo-keyed structure: each top-level key is an `owner/repo` patch repository, mapping to an object of package IDs, each containing patch name toggles.

```json
{
  "MorpheApp/morphe-patches": {
    "com.google.android.youtube": { "Hide ads": true, "SponsorBlock": true }
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
- **Files**: kebab-case (`unified-downloader.js`)
- **Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE
- **Git commits**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)

## Troubleshooting

- Check workflow run logs in GitHub Actions for `::error::` and `::warning::` markers
- Verify `patches.json` and `config.json` are valid JSON
- Ensure APKMirror URLs in `config.json` `download_urls` are still valid
- Keystore errors: verify `KEYSTORE_BASE64` decodes correctly and passwords match
