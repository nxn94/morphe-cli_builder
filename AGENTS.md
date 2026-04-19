# AGENTS.md - AutoMorpheBuilder

## Project Overview

GitHub Actions CI/CD project for building patched Android APKs with Morphe patches. Not a traditional app — the workflow *is* the product.

## Key Files

| File | Purpose |
|------|---------|
| `config.json` | Build config: `patch_repos` (per-app), `cli` repo/branch, APKMirror paths, cached download URLs |
| `patches.json` | Patch toggles — repo-keyed: `{ "owner/repo": { "pkg": { "Patch": true } } }` |
| `state.json` | Tracks live Morphe versions and build history |
| `.github/workflows/morphe-build.yml` | Main workflow (1877 lines — contains all build logic) |
| `.github/workflows/update-patches.yml` | Manual workflow to sync `patches.json` from upstream |
| `.github/scripts/unified-downloader.js` | APK downloader with multi-source fallback + Playwright |
| `.github/scripts/update-download-urls.js` | Writes resolved URLs back to `config.json` |
| `.github/scripts/__tests__/apkmirror-scraper.test.js` | Jest unit tests |

## Workflow Jobs

```
check-versions → build (matrix per app) → create-release → update-download-urls + update-state
```

- `check-versions`: Queries GitHub for latest Morphe patch/CLI tags, decides whether build is needed
- `build`: Per-app parallel matrix jobs — download APK, patch, sign, output artifact
- `create-release`: Creates GitHub Release `vYYYY.MM.DD`
- `update-download-urls`: Persists resolved download URLs to `config.json`
- `update-state`: Updates `state.json` with new versions and build history

## Config Structure (CRITICAL)

### config.json uses `patch_repos` + `cli` (NOT `branches`)

```json
{
  "patch_repos": {
    "com.google.android.youtube": { "name": "youtube", "repo": "MorpheApp/morphe-patches", "branch": "dev" }
  },
  "cli": { "repo": "MorpheApp/morphe-cli", "branch": "dev" }
}
```

### patches.json is repo-keyed

```json
{
  "MorpheApp/morphe-patches": {
    "com.google.android.youtube": { "Hide ads": true }
  }
}
```

## Artifact Naming

Format: `<app>-v<base-version>-<patches-version>.apk`

Example: `youtube-v20.44.38-v1.24.0-dev.8.apk`

## Obtainium Regex

Use: `^youtube-v.*\.apk$` / `^ytmusic-v.*\.apk$` / `^reddit-v.*\.apk$`

The `-v` infix is required to distinguish from other APK files.

## Developer Commands

```bash
# Run tests
npm test                    # all tests
npx jest file              # single test file

# Validate workflow
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .

# Validate JSON
jq '.' patches.json && jq '.' config.json && jq '.' state.json

# Lint JS
npx eslint .github/scripts/*.js
```

## Adding a New App

1. Add to `config.json` `patch_repos` and `apkmirror_paths`
2. Run `update-patches.yml` workflow (manual trigger) to populate `patches.json`
3. Edit `patches.json` to toggle patches
4. Push — next scheduled run builds it automatically

No workflow edits needed — the matrix is derived from `config.json`.

## Common Failures

- **`Chosen APK has no classes.dex`**: Downloaded a split/config APK, not the base. Usually means APKMirror only has a BUNDLE variant for that version.
- **`Wrong version of key store`**: Keystore password wrong, or key password differs from keystore password.
- **APK download fails**: Run workflow again — transient Cloudflare blocks are common.
- **Build skipped despite new version**: Check that `state.json` was updated by `update-state` job. If the runner's git push failed silently, state can drift.

## Repo Quirks

- Workflow runs `npm ci` then `npx playwright install chromium` on every run (not cached at npm level)
- BouncyCastle is downloaded fresh from Maven Central each build (no lockfile)
- Keystore conversion: source keystore → BKS for morphe-cli compatibility
- APKMirror scraper uses Playwright when curl is blocked; all 3 pages navigated in same browser session to preserve cookies
