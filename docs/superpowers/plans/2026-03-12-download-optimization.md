# Download Optimization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a unified APK downloader with fallback chain, auto-update patches.json URLs, and optimize workflow with caching.

**Architecture:** Single unified downloader script with fallback chain (apkeep → aurora-store → apkmirror). New workflow step to auto-update URLs after successful build. Enhanced caching for faster builds.

**Tech Stack:** Node.js, Playwright, GitHub Actions, apkeep, aurora-store

---

## File Structure

### New Files
- `.github/scripts/unified-downloader.js` - Main unified downloader (replaces 4 scripts)
- `.github/scripts/update-download-urls.js` - Script to update patches.json after build

### Modified Files
- `.github/workflows/morphe-build.yml` - Main workflow with caching and new steps
- `patches.json` - Add auto_update_urls option

### Deleted Files (after verification)
- `.github/scripts/apkmirror-downloader.js`
- `.github/scripts/apkmirror-version-resolver.js`
- `.github/scripts/apkmirror-playwright.js`
- `.github/scripts/apkmirror-url-resolver.js`
- `.github/scripts/apkeep-downloader.sh`

---

## Chunk 1: Unified Downloader Script

### Task 1: Create unified-downloader.js

**Files:**
- Create: `.github/scripts/unified-downloader.js`

**Implementation notes:**
- The script should check `patches.json` first for existing URL matching the version
- Skip download if URL already exists and version matches
- Accept package_id, version, output_dir as arguments
- Try apkeep first with specific version
- Fall back to aurora-store
- Fall back to apkmirror with Playwright
- Output JSON to stdout, logs to stderr
- Proper error handling with retries

- [ ] **Step 1: Create the unified-downloader.js script**

Create the script with these key functions:
- `loadExistingUrl(packageId, version)` - Check patches.json for existing URL
- `downloadWithApkeep(packageId, version, outputDir)` - Try APKPure first
- `downloadWithAurora(packageId, version, outputDir)` - Try Aurora Store second
- `downloadWithApkmirror(packageId, version, outputDir)` - Try APKMirror last

- [ ] **Step 2: Make script executable**

Run: `chmod +x .github/scripts/unified-downloader.js`

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: add unified APK downloader with fallback chain"
```

---

## Chunk 2: Update Download URLs Script

### Task 2: Create update-download-urls.js

**Files:**
- Create: `.github/scripts/update-download-urls.js`

- [ ] **Step 1: Create the update-download-urls.js script**

Functionality:
1. Accept package_id, version, url as arguments
2. Read patches.json
3. Update __morphe.download_urls[packageId][version] = url
4. Update __morphe.download_urls[packageId].latest_supported = url
5. Write back to patches.json

- [ ] **Step 2: Make script executable**

Run: `chmod +x .github/scripts/update-download-urls.js`

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/update-download-urls.js
git commit -m "feat: add script to update download URLs in patches.json"
```

---

## Chunk 3: Update Workflow with Caching and New Steps

### Task 3: Modify morphe-build.yml

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (various sections)

- [ ] **Step 1: Add caching for dependencies**

Add caching for:
1. apkeep binary - use actions/cache to cache /usr/local/bin/apkeep
2. node_modules - existing cache action for npm dependencies
3. Playwright browsers - cache ~/.cache/ms-playwright

Example:
```yaml
- name: Cache apkeep
  uses: actions/cache@v4
  with:
    path: /usr/local/bin/apkeep
    key: apkeep-${{ runner.os }}-v1
```

- [ ] **Step 2: Add aurora-store installation**

Add aurora-store installation in the setup job:
```yaml
- name: Install aurora-store
  run: |
    # Install aurora-store from F-Droid or aurora-droid
    # Option 1: Using aurora-droid
    curl -sSL https://github.com/Whyorean/AURAD/releases/download/nightly/aurad -o /usr/local/bin/aurad
    chmod +x /usr/local/bin/aurad
```
Or use Docker-based aurora-store if available.

- [ ] **Step 3: Add parallel downloads**

In the download step, use background processes for parallel downloads:
```yaml
- name: Download APKs in parallel
  run: |
    # Download all APKs in parallel using background processes
    for PKG in com.google.android.youtube com.google.android.apps.youtube.music com.reddit.frontpage; do
      (
        node .github/scripts/unified-downloader.js "$PKG" "$VERSION" "$APK_DIR"
      ) &
    done
    wait  # Wait for all background jobs
```

- [ ] **Step 4: Replace download section with unified-downloader**

Replace the inline apkeep commands with calls to unified-downloader.js:
```bash
node .github/scripts/unified-downloader.js "$PKG" "$LATEST_VERSION" "$APK_DIR"
```

- [ ] **Step 5: Add update-download-urls job**

Add new job after create-release:
```yaml
update-download-urls:
  needs: create-release
  if: success()
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - name: Commit updated patches.json
      run: |
        # Commit if there are changes
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "feat: add caching and unified downloader to workflow"
```

---

## Chunk 4: Cleanup Redundant Scripts

### Task 4: Remove old scripts

**Files:**
- Delete: Multiple files in .github/scripts/

- [ ] **Step 1: Remove redundant downloader scripts**

```bash
rm -f .github/scripts/apkmirror-downloader.js
rm -f .github/scripts/apkmirror-version-resolver.js
rm -f .github/scripts/apkmirror-playwright.js
rm -f .github/scripts/apkmirror-url-resolver.js
rm -f .github/scripts/apkeep-downloader.sh
```

- [ ] **Step 2: Verify remaining files**

Run: `ls -la .github/scripts/`

Expected: Only unified-downloader.js and update-download-urls.js

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor: remove redundant downloader scripts"
```

---

## Chunk 5: Add auto_update_urls config

### Task 5: Update patches.json

**Files:**
- Modify: `patches.json`

- [ ] **Step 1: Add auto_update_urls option to __morphe**

Add `"auto_update_urls": true` to the __morphe section in patches.json.

- [ ] **Step 2: Commit**

```bash
git add patches.json
git commit -m "feat: add auto_update_urls config option"
```

---

## Implementation Notes

### Security Considerations
When implementing, use proper input sanitization for commands that include user input (package IDs, versions). Use execFile instead of exec where possible, or validate inputs rigorously.

### Testing
1. Test unified downloader locally with a known package
2. Test URL update script
3. Validate workflow with actionlint
4. Run a test build

### Fallback Order
1. apkeep (APKPure) - fastest, most reliable
2. aurora-store - free, no auth needed
3. apkmirror - last resort, requires browser automation

### End-to-End Verification

After cleanup (Chunk 4), verify the build works:

1. Trigger a manual workflow run in GitHub Actions
2. Verify all 3 apps download successfully (check logs for "Downloaded via...")
3. Verify patches apply correctly (check build output)
4. Verify signed APK is produced (check release artifacts)
5. Verify patches.json was updated with new URLs (check git commit)

### Cleanup Verification

Verify only the expected files remain:
```bash
ls -la .github/scripts/
# Expected:
# - unified-downloader.js
# - update-download-urls.js
```
