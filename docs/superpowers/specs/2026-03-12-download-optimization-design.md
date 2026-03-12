# AutoMorpheBuilder Optimization Design

**Date:** 2026-03-12
**Status:** Approved

## 1. Architecture Overview

### Current State
- 4 separate download scripts (apkmirror-downloader.js, apkmirror-version-resolver.js, apkmirror-playwright.js, apkmirror-url-resolver.js) + apkeep-downloader.sh
- Inconsistent usage in workflow
- APKMirror downloads are brittle due to Cloudflare

### Proposed State
Single unified downloader script with intelligent fallback chain:
1. Try `apkeep` with specific version (APKPure)
2. Try Aurora Store (F-Droid) as secondary
3. Try APKMirror as last resort (with improved Playwright handling)
4. Auto-update `patches.json` with working URL after successful build

### Data Flow
```
Workflow check-versions → Get Morphe supported version
                              ↓
                        Download APK
                              ↓
                   [Success] → Update patches.json with URL
                              ↓
                        Build app
```

## 2. Unified Downloader Script

### New Script: `.github/scripts/unified-downloader.js`

**Usage:**
```bash
node unified-downloader.js <package_id> <version> <output_dir>
```

**Output (JSON to stdout):**
```json
{
  "success": true,
  "filepath": "/path/to/app.apk",
  "version": "20.40.45",
  "source": "apkeep",
  "url": "https://apkpure.com/..."
}
```

**Features:**
- Accepts: `<package_id> <version> <output_dir>`
- Returns JSON: `{ success, filepath, version, source, url }`
- Implements fallback chain with retry logic
- Logs to stderr (GitHub Actions), outputs JSON to stdout
- Timeout: 120 seconds per attempt, 3 retries

### Download Sources (in order)

1. **apkeep** - `apkeep -a "com.package@version" -d apk-pure`
   - Primary source, already integrated
   - Supports specific version downloads

2. **aurora-store** - CLI mode with no-auth (anonymous)
   - Free, open-source, no account needed
   - Better version availability than APKPure sometimes

3. **apkmirror-playwright** - improved version
   - Last resort fallback
   - Better Cloudflare handling with longer timeouts

## 3. Auto-Update patches.json

### Mechanism
- After successful build, workflow runs `update-download-urls` step
- Records: `{ "version": "20.40.45", "url": "https://..." }` for each package
- Updates `__morphe.download_urls[PACKAGE_ID]` with working version URL
- Commits back to repository (if enabled)

### Config Option in patches.json
```json
"__morphe": {
  "auto_update_urls": true  // default: true
}
```

## 4. Workflow Optimization & Caching

### Improvements

1. **Cache JavaScript dependencies**
   - Cache `node_modules` and Playwright browsers
   - Use `actions/cache` with proper keys

2. **Cache apkeep**
   - Don't reinstall every run
   - Use GitHub Actions cache for binaries

3. **Parallel downloads**
   - Download all APKs in parallel in the setup job
   - Use `matrix` strategy or background processes

4. **Skip redundant resolution**
   - If URL already in patches.json and version matches, skip resolution
   - Check local cache first

5. **Reduce Playwright overhead**
   - Only use if apkeep/aurora fail
   - Reuse browser instance across downloads

### Caching Strategy
- `~/.cache/ms-playwright` - Playwright browsers
- `/usr/local/bin/apkeep` - apkeep binary (cached)
- `~/.cache/aurora` - Aurora Store data (if used)

### Job Dependencies
```
check-versions (determines what to build)
    ↓
setup (parallel: download APKs + prepare tools)
    ↓
build-app (depends on setup)
    ↓
create-release
    ↓
update-download-urls (only on success)
```

## 5. Cleanup

### Remove Redundant Scripts
- `apkmirror-downloader.js` - replaced by unified script
- `apkmirror-version-resolver.js` - replaced by unified script
- `apkmirror-playwright.js` - replaced (functionality moved to unified script)
- `apkmirror-url-resolver.js` - replaced

### Keep
- `unified-downloader.js` - new unified script
- `apkeep-downloader.sh` - can be removed (functionality in unified script)

## 6. Error Handling

### Download Failures
- Log clear error messages with source of failure
- Provide fallback URL in error output for manual recovery
- Non-zero exit code on failure

### Build Failures
- Preserve downloaded APKs for debugging
- Log which source succeeded/failed
- Retry logic with exponential backoff

## 7. Security Considerations

- No API keys required for APKPure/Aurora
- APKMirror may require captcha solving (handled by Playwright)
- Keystore remains encrypted in GitHub Secrets

## 8. Testing

### Local Testing
```bash
# Test unified downloader
node .github/scripts/unified-downloader.js com.google.android.youtube 20.40.45 ./test-output

# Test workflow locally (if act is installed)
act workflow_dispatch
```

### Verification
- Verify all 3 apps download successfully
- Verify patches apply correctly
- Verify signed APK is produced
