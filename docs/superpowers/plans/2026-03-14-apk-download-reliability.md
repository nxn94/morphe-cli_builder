# APK Download Reliability Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement parallel source resolution and URL caching to make APK downloads more reliable

**Architecture:** Add parallel resolution layer that runs all sources simultaneously with first-valid-wins pattern. Add URL cache to avoid re-resolution. Keep existing sequential fallback as safety net.

**Tech Stack:** Node.js, unified-downloader.js (existing)

---

## File Structure

- **Modify:** `.github/scripts/unified-downloader.js` — Main implementation (add parallel resolver, URL cache functions, modify download flow)
- **No new files** — All functionality added to existing script

---

## Chunk 1: URL Cache Layer

### Task 1: Add URL Cache Constants and getCachedUrl Function

**Files:**
- Modify: `.github/scripts/unified-downloader.js` — Add URL_CACHE_DIR constant and getCachedUrl function

- [ ] **Step 1: Add URL cache directory constant**

After line 27 (CACHE_DIR), add:
```javascript
// URL cache directory - stores resolved URLs as JSON
const URL_CACHE_DIR = path.join(os.homedir(), ".cache", "auto-morphe-builder", "urls");
```

- [ ] **Step 2: Add getCachedUrl function**

After line 27 (after URL_CACHE_DIR constant), add:
```javascript
/**
 * Check URL cache for a package version
 * @returns {object|null} Cache entry or null if not found/invalid
 */
function getCachedUrl(packageId, version) {
  const cacheDir = path.join(URL_CACHE_DIR, packageId);
  const cacheFile = path.join(cacheDir, `${version}.json`);

  if (!fs.existsSync(cacheFile)) {
    console.error(`[url-cache] Miss: ${packageId} v${version}`);
    return null;
  }

  try {
    const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.error(`[url-cache] Hit: ${packageId} v${version} (source: ${cacheData.source}, downloads: ${cacheData.downloads})`);
    return cacheData;
  } catch (e) {
    console.error(`[url-cache] Error reading cache: ${e.message}`);
    return null;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: add URL cache constants and getCachedUrl function"
```

---

### Task 2: Add saveCachedUrl and verifyUrl Functions

**Files:**
- Modify: `.github/scripts/unified-downloader.js` — Add saveCachedUrl and verifyUrl functions

- [ ] **Step 1: Add saveCachedUrl function**

After getCachedUrl function, add:
```javascript
/**
 * Save URL to cache
 * @param {string} packageId - Package ID
 * @param {string} version - Version
 * @param {string} url - Resolved URL
 * @param {string} source - Source that provided the URL
 * @returns {string} Path to cached file
 */
function saveCachedUrl(packageId, version, url, source) {
  const cacheDir = path.join(URL_CACHE_DIR, packageId);

  // Create directory if it doesn't exist
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const cacheFile = path.join(cacheDir, `${version}.json`);

  // Read existing cache or create new
  let cacheData = { downloads: 0, lastWorkingAt: null };
  if (fs.existsSync(cacheFile)) {
    try {
      cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      // Ignore parse errors, use defaults
    }
  }

  // Update cache entry
  const newCacheData = {
    version,
    url,
    source,
    resolvedAt: new Date().toISOString(),
    downloads: cacheData.downloads + 1,
    lastWorkingAt: new Date().toISOString()
  };

  fs.writeFileSync(cacheFile, JSON.stringify(newCacheData, null, 2));
  console.error(`[url-cache] Saved: ${packageId} v${version} from ${source}`);

  return cacheFile;
}
```

- [ ] **Step 2: Add verifyUrl function**

After saveCachedUrl function, add:
```javascript
/**
 * Verify URL still works with HEAD request
 * @param {string} url - URL to verify
 * @returns {Promise<boolean>} True if URL is valid
 */
async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeout);
    const isValid = response.ok && (response.status >= 200 && response.status < 300);
    console.error(`[url-cache] URL verify: ${isValid ? 'valid' : 'invalid'} (${response.status})`);
    return isValid;
  } catch (e) {
    console.error(`[url-cache] URL verify failed: ${e.message}`);
    return false;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: add saveCachedUrl and verifyUrl functions"
```

---

## Chunk 2: Source Resolution Functions

### Task 3: Add resolveApkeep Function (URL only, no download)

**Files:**
- Modify: `.github/scripts/unified-downloader.js` — Add resolveApkeep function

- [ ] **Step 1: Add resolveApkeep function**

After verifyUrl function (around line 200), add:
```javascript
/**
 * Resolve URL using apkeep (APKPure) - returns URL only, no download
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkeep(packageId, version) {
  console.error(`[apkeep-resolve] Resolving ${packageId} v${version}`);

  return new Promise((resolve, reject) => {
    const args = ['-a', `${packageId}@${version}`, '-d', 'apk-pure', '--print-url'];

    execFile('apkeep', args, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[apkeep-resolve] Failed: ${error.message}`);
        reject(new Error(`apkeep failed: ${error.message}`));
        return;
      }

      const url = stdout.trim();
      if (!url || !url.startsWith('http')) {
        reject(new Error('No valid URL returned from apkeep'));
        return;
      }

      console.error(`[apkeep-resolve] Got URL: ${url}`);
      resolve({ url, source: 'apkeep' });
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: add resolveApkeep function for URL-only resolution"
```

---

### Task 4: Add resolveApkmirrorApi and resolveApkmirror Functions

**Files:**
- Modify: `.github/scripts/unified-downloader.js` — Add resolve functions

- [ ] **Step 1: Add resolveApkmirrorApi function**

After resolveApkeep, add:
```javascript
/**
 * Resolve URL using APKMirror API - returns URL only
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkmirrorApi(packageId, version) {
  console.error(`[apkmirror-api-resolve] Resolving ${packageId} v${version}`);

  const apkmirrorPath = APK_MIRROR_PATHS[packageId];
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path for ${packageId}`);
  }

  // API endpoint to get download info
  const apiUrl = `https://api.apkmirror.com/wp-json/apkmirror/posts/1/${apkmirrorPath}/${version}`;

  try {
    const response = await fetch(apiUrl, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const downloadUrl = data.downloadUrl;

    if (!downloadUrl) {
      throw new Error('No download URL in API response');
    }

    console.error(`[apkmirror-api-resolve] Got URL: ${downloadUrl}`);
    return { url: downloadUrl, source: 'apkmirror-api' };
  } catch (e) {
    console.error(`[apkmirror-api-resolve] Failed: ${e.message}`);
    throw e;
  }
}
```

- [ ] **Step 2: Add resolveApkmirror function**

After resolveApkmirrorApi, add:
```javascript
/**
 * Resolve URL using APKMirror Playwright - returns URL only
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkmirror(packageId, version) {
  console.error(`[apkmirror-resolve] Resolving ${packageId} v${version}`);

  const apkmirrorPath = APK_MIRROR_PATHS[packageId];
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path for ${packageId}`);
  }

  // Use existing resolveApkmirrorUrl function (it already exists and returns URL)
  const url = await resolveApkmirrorUrl(apkmirrorPath, version);
  console.error(`[apkmirror-resolve] Got URL: ${url}`);

  return { url, source: 'apkmirror' };
}
```

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: add resolveApkmirrorApi and resolveApkmirror functions"
```

---

## Chunk 3: Parallel Resolution and Download Flow

### Task 5: Add downloadWithUrl Function

**Files:**
- Modify: `.github/scripts/unified-downloader.js` — Add downloadWithUrl function

- [ ] **Step 1: Add downloadWithUrl function**

After resolveApkmirror function, add:
```javascript
/**
 * Download APK from a pre-resolved URL
 * @param {string} url - Direct URL to APK
 * @param {string} outputDir - Output directory
 * @param {string} packageId - Package ID
 * @param {string} version - Expected version
 * @returns {Promise<object>} Download result
 */
async function downloadWithUrl(url, outputDir, packageId, version) {
  console.error(`[download-url] Downloading from: ${url}`);

  // Use curl for direct downloads
  const filename = `${packageId}_${version}.apk`;
  const outputPath = path.join(outputDir, filename);

  return new Promise((resolve, reject) => {
    const curl = spawn('curl', ['-L', '-o', outputPath, '-w', '%{http_code}', '--fail', url]);

    let httpCode = '';
    let stderr = '';

    curl.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    curl.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`curl failed: ${stderr}`));
        return;
      }

      // Validate downloaded file
      if (!fs.existsSync(outputPath)) {
        reject(new Error('Downloaded file not found'));
        return;
      }

      const stats = fs.statSync(outputPath);
      if (stats.size < 10000) { // Less than 10KB is probably an error
        reject(new Error(`Downloaded file too small: ${stats.size} bytes`));
        return;
      }

      // Validate APK version
      const validation = validateApkVersion(outputPath, version);
      if (!validation.valid) {
        reject(new Error(`VERSION MISMATCH: expected ${version}, got ${validation.version}`));
        return;
      }

      console.error(`[download-url] Downloaded and validated: ${outputPath} (${stats.size} bytes)`);
      resolve({
        success: true,
        path: outputPath,
        filename,
        version: validation.version,
        source: 'direct-url',
        url
      });
    });
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: add downloadWithUrl function"
```

---

### Task 6: Add parallelResolveSources Function

**Files:**
- Modify: `.github/scripts/unified-downloader.js` — Add parallelResolveSources function

- [ ] **Step 1: Add parallelResolveSources function**

After downloadWithUrl function, add:
```javascript
/**
 * Resolve URLs from all sources in parallel, first valid wins
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function parallelResolveSources(packageId, version) {
  const sources = [
    { name: 'apkeep', fn: () => resolveApkeep(packageId, version) },
    { name: 'apkmirror-api', fn: () => resolveApkmirrorApi(packageId, version) },
    { name: 'apkmirror', fn: () => resolveApkmirror(packageId, version) },
  ];

  const SOURCE_TIMEOUT = 60000; // 60 seconds each

  console.error(`[parallel-resolve] Starting parallel resolution for ${packageId} v${version}`);
  const startTime = Date.now();

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${source.name} timeout`)), SOURCE_TIMEOUT)
      );
      return Promise.race([source.fn(), timeout]);
    })
  );

  const elapsed = Date.now() - startTime;
  console.error(`[parallel-resolve] All sources completed in ${elapsed}ms`);

  // Find first successful resolution
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sourceName = sources[i].name;

    if (result.status === 'fulfilled' && result.value?.url) {
      console.error(`[parallel-resolve] Winner: ${sourceName}`);
      return { ...result.value, source: result.value.source || sourceName };
    }

    const error = result.reason?.message || 'Unknown error';
    console.error(`[parallel-resolve] ${sourceName} failed: ${error}`);
  }

  throw new Error('All sources failed to resolve URL');
}
```

- [ ] **Step 2: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: add parallelResolveSources function"
```

---

### Task 7: Modify download Function to Use New Flow

**Files:**
- Modify: `.github/scripts/unified-downloader.js` — Modify download function (around line 1199)

- [ ] **Step 1: Read current download function**

Find the download function and understand its current flow.

- [ ] **Step 2: Replace download function with new flow**

Replace the existing download function with:
```javascript
/**
 * Main download function with improved reliability:
 * 1. Check URL cache -> if valid, use directly
 * 2. Check patches.json -> if has URL, verify and use
 * 3. Parallel resolution -> first valid URL wins
 * 4. Download from URL
 * 5. Save to cache on success
 * 6. Fallback to sequential on all parallel fail
 */
async function download(packageId, version, outputDir) {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Step 1: Check URL cache
  const cachedUrl = getCachedUrl(packageId, version);
  if (cachedUrl) {
    console.error(`[download] Trying cache for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(cachedUrl.url);
      if (isValid) {
        const result = await downloadWithUrl(cachedUrl.url, outputDir, packageId, version);
        // Update cache with incremented download count
        saveCachedUrl(packageId, version, cachedUrl.url, cachedUrl.source);
        return result;
      }
    } catch (e) {
      console.error(`[download] Cache URL invalid: ${e.message}`);
    }
  }

  // Step 2: Check patches.json for existing URL
  const existingUrl = loadExistingUrl(packageId, version);
  if (existingUrl) {
    console.error(`[download] Trying patches.json URL for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(existingUrl);
      if (isValid) {
        const result = await downloadWithUrl(existingUrl, outputDir, packageId, version);
        // Save to our URL cache
        saveCachedUrl(packageId, version, existingUrl, 'patches.json');
        return result;
      }
    } catch (e) {
      console.error(`[download] patches.json URL invalid: ${e.message}`);
    }
  }

  // Step 3: Try parallel resolution
  console.error(`[download] Starting parallel resolution for ${packageId} v${version}`);
  try {
    const resolved = await parallelResolveSources(packageId, version);
    const result = await downloadWithUrl(resolved.url, outputDir, packageId, version);
    // Save to URL cache
    saveCachedUrl(packageId, version, resolved.url, resolved.source);
    return result;
  } catch (e) {
    console.error(`[download] Parallel resolution failed: ${e.message}`);
  }

  // Step 4: Fallback to sequential (existing behavior)
  console.error(`[download] Falling back to sequential resolution`);

  // Try apkeep
  console.error(`[apkeep] Attempting download for ${packageId} v${version}`);
  try {
    const result = await downloadWithApkeep(packageId, version, outputDir);
    const url = result.url || `apkeep:${packageId}@${version}`;
    saveCachedUrl(packageId, version, url, 'apkeep');
    return result;
  } catch (e) {
    console.error(`[apkeep] Failed: ${e.message}`);
  }

  // Try APKMirror API
  console.error(`[apkmirror-api] Attempting download for ${packageId} v${version} via API`);
  try {
    const result = await downloadWithApkmirrorApi(packageId, version, outputDir);
    saveCachedUrl(packageId, version, result.url, 'apkmirror-api');
    return result;
  } catch (e) {
    console.error(`[apkmirror-api] Failed: ${e.message}`);
  }

  // Try APKMirror Playwright - last resort
  console.error(`[apkmirror] Starting APKMirror Playwright fallback...`);
  try {
    return await downloadWithApkmirror(packageId, version, outputDir);
  } catch (e) {
    console.error(`[apkmirror] Failed: ${e.message}`);
    throw e;
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "feat: update download function with parallel resolution and URL caching"
```

---

## Chunk 4: Testing and Verification

### Task 8: Test the Implementation

**Files:**
- Test: `.github/scripts/unified-downloader.js`

- [ ] **Step 1: Test with cache miss (fresh resolution)**

```bash
# Create test output directory
mkdir -p ./test-output

# Clear any existing URL cache for YouTube
rm -rf ~/.cache/auto-morphe-builder/urls/com.google.android.youtube

# Run downloader (this will trigger parallel resolution)
node .github/scripts/unified-downloader.js com.google.android.youtube 19.45.51 ./test-output
```

Expected: Should run parallel resolution and download from first successful source

- [ ] **Step 2: Verify cache was saved**

```bash
cat ~/.cache/auto-morphe-builder/urls/com.google.android.youtube/19.45.51.json
```

Expected: JSON file with url, source, downloads count

- [ ] **Step 3: Test cache hit**

```bash
# Run again - should use cached URL
node .github/scripts/unified-downloader.js com.google.android.youtube 19.45.51 ./test-output-2
```

Expected: Should say "[url-cache] Hit" and use cached URL

- [ ] **Step 4: Test other apps**

```bash
# Test YouTube Music
node .github/scripts/unified-downloader.js com.google.android.apps.youtube.music 7.28.51 ./test-output-ytmusic

# Test Reddit
node .github/scripts/unified-downloader.js com.google.android.reddit.pro 2025.6.0 ./test-output-reddit
```

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "test: verify parallel resolution and URL caching works"
```

---

## Summary

| Task | Description |
|------|-------------|
| 1 | Add URL cache constants and getCachedUrl |
| 2 | Add saveCachedUrl and verifyUrl |
| 3 | Add resolveApkeep function |
| 4 | Add resolveApkmirrorApi and resolveApkmirror |
| 5 | Add downloadWithUrl function |
| 6 | Add parallelResolveSources function |
| 7 | Modify download function with new flow |
| 8 | Test implementation |
