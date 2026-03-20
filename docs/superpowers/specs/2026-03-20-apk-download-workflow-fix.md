# APK Download Workflow Fix

**Date:** 2026-03-20
**Status:** Approved

## Problem

The shell script in `morphe-build.yml` has malformed if/else blocks introduced by commit `43ad57a` (feat: cache downloaded APKs by version across workflow runs). When a cached APK exists:

1. Workflow takes the `if` branch
2. Skips the `else` branch where shell functions are defined
3. Later code calls `find_package_candidate()` which was never defined
4. Result: `find_package_candidate: command not found`

## Design

### 1. Function Definitions (Outside Conditionals)

All shell functions are defined at the top of the run block, before any if/else logic:

- `find_package_candidate()` - finds best APK in directory
- `apk_has_dex()` - checks if APK contains classes.dex
- `merge_split_package_with_apkeditor()` - merges split APKs
- `best_ranked_apk_in_dir()` - alternative APK ranking
- `download_with_playwright()` - Playwright-based download
- `download_with_curl()` - curl-based download

This ensures functions are always in scope regardless of which branch executes.

### 2. Restructured if/else Logic

```bash
if [ -n "$CACHED_APK" ]; then
  echo "::notice::Using cached APK: $CACHED_APK (v$TARGET_VERSION)"
  DOWNLOAD_SUCCESS=true
else
  rm -f "$APKS_DIR"/* || true
  # Full download logic here
fi
```

### 3. Behavior

**When cached APK exists:**
- Set `DOWNLOAD_SUCCESS=true`
- Skip ALL download logic
- Continue to validation step

**When no cached APK:**
- Run full download logic (unified-downloader.js + fallbacks)
- Then continue to validation step

### 4. Files Changed

- `.github/workflows/morphe-build.yml` - restructure if/else blocks and move function definitions outside conditionals

## Implementation Notes

- The `MANUAL_URL` variable (from config.json) should be defined outside the if/else as well, since it's only used when download fails
- All existing function logic remains unchanged
- Only structural changes, no functional changes to download behavior
