# APK Download Reliability Design

**Date:** 2026-03-14
**Status:** Approved

## 1. Architecture Overview

### Current State
- Unified downloader already exists with fallback chain: cache → apkeep → apkmirror
- Sources are tried sequentially (one after another)
- Cache exists but isn't being used optimally
- Aurora is currently skipped (no working CLI available)

### Proposed State
- Parallel source resolution (all sources attempt simultaneously)
- First valid result wins
- Aggressive URL caching
- Only use Morphe-supported versions (no pre-resolution)

```
┌─────────────────────────────────────────────────────────┐
│                    download(packageId, version)         │
└─────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│    apkeep     │    │ apkmirror-api │    │   apkmirror   │
│  (parallel)   │    │  (parallel)   │    │  (parallel)   │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │  Parallel        │
                    │  Resolver        │
                    │ (first valid URL)│
                    └───────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │  Download File   │
                    └───────────────────┘
```

## 2. Parallel Source Resolution

### Parallel Resolver Pattern

```javascript
async function parallelResolveSources(packageId, version, outputDir) {
  const sources = [
    { name: 'apkeep', fn: () => resolveApkeep(packageId, version) },
    { name: 'apkmirror-api', fn: () => resolveApkmirrorApi(packageId, version) },
    { name: 'apkmirror', fn: () => resolveApkmirror(packageId, version) },
  ];

  const SOURCE_TIMEOUT = 60000; // 60 seconds each

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${source.name} timeout`)), SOURCE_TIMEOUT)
      );
      return Promise.race([source.fn(), timeout]);
    })
  );

  // Find first successful resolution
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value?.url) {
      return { ...result.value, source: result.value.source || 'unknown' };
    }
  }

  throw new Error("All sources failed");
}
```

### Timeout Strategy
- Source resolution: 60 seconds each (parallel)
- Download: 180 seconds (3 min)
- Total max: ~240 seconds worst case (wait for all parallel to fail + download)

### Implementation

1. Add `resolveApkeep()` — returns URL only (no download)
2. Add `resolveApkmirrorApi()` — returns URL from API
3. Add `resolveApkmirror()` — returns URL from Playwright
4. Add `downloadWithUrl(url, outputDir)` — downloads from pre-resolved URL
   - **Always validate APK version** after download using aapt (existing behavior)
   - If version doesn't match expected, treat as download failure and retry
5. Keep existing sequential fallback as ultimate safety net

## 3. URL Caching

### Cache Location

```
~/.cache/auto-morphe-builder/
├── apks/                    # Existing: downloaded APK files
│   └── {packageId}/
│       └── {version}.apk
└── urls/                    # NEW: resolved URLs (JSON)
    └── {packageId}/
        └── {version}.json
```

### URL Cache Format

```json
{
  "version": "20.40.45",
  "url": "https://apkpure.com/...",
  "source": "apkeep",
  "resolvedAt": "2026-03-14T10:30:00Z",
  "downloads": 5,
  "lastWorkingAt": "2026-03-14T10:30:00Z"
}
```

- `downloads`: Counter that increments each time this URL is successfully used to download an APK
- `lastWorkingAt`: Timestamp of most recent successful download using this URL

### Cache Strategy

1. **On successful download**: Save resolved URL to cache
2. **On cache hit**: Verify URL still works (HEAD request with 5s timeout), use if valid
3. **On cache miss or URL invalid**: Run parallel resolution
4. **On URL failure**: Mark as broken, try alternative sources

Only cache versions that are Morphe-supported (from patches.json). No pre-resolution.

### Cache Validation Policy

- On each download request, verify cached URL with HEAD request (5s timeout)
- If HEAD fails, treat as cache miss and re-resolve
- Track `lastWorkingAt` timestamp to help identify stale URLs

## 4. Source Priority

1. **Check URL cache** → if valid, use directly
2. **Check patches.json** → use existing URL if present (from previous successful builds)
3. **Parallel resolution**: apkeep + apkmirror-api + apkmirror (all at once)
4. **First valid URL wins** → download
5. **Fallback**: sequential if all parallel fail

### Sources Used

1. **apkeep** — Primary, uses APKPure
2. **apkmirror-api** — Secondary, uses official API
3. **apkmirror** — Fallback, uses Playwright (slower but more flexible)

Note: Aurora Store is excluded (no working CLI available).

## 5. Error Handling

### Retry Logic

- **Parallel phase**: All sources try simultaneously
- **On all parallel fail**: Fall back to sequential (apkeep → apkmirror-api → apkmirror)
- **Final failure**: Clear error with which sources failed and why

### Error Output

```json
{
  "success": false,
  "error": "VERSION_NOT_FOUND",
  "packageId": "com.google.android.youtube",
  "version": "20.40.45",
  "sourcesAttempted": [
    { "source": "apkeep", "error": "Version not available" },
    { "source": "apkmirror-api", "error": "Connection timeout" },
    { "source": "apkmirror", "error": "Version not in catalog" }
  ],
  "suggestion": "Update patches.json to latest supported version"
}
```

### Logging

- Log all source attempts to stderr
- Include timing per source (helps identify slow sources)
- Log cache hits/misses

## 6. Implementation Changes

### Modified Files

1. **`.github/scripts/unified-downloader.js`**
   - Add parallel resolution with Promise.allSettled
   - Add URL caching layer
   - Modify `download()` function to use parallel resolver first

### New Functions

| Function | Purpose |
|----------|---------|
| `resolveApkeep(packageId, version)` | Get URL from apkeep (no download) |
| `resolveApkmirrorApi(packageId, version)` | Get URL from APKMirror API |
| `resolveApkmirror(packageId, version)` | Get URL from APKMirror Playwright |
| `parallelResolveSources(packageId, version)` | Run all resolvers in parallel |
| `getCachedUrl(packageId, version)` | Check URL cache |
| `saveCachedUrl(packageId, version, url, source)` | Save to URL cache |
| `verifyUrl(url)` | HEAD request to verify URL still works (5s timeout) |

### Download Flow (Revised)

```
download(packageId, version, outputDir)
    │
    ▼
Check URL cache ──valid──► downloadWithUrl(url, outputDir)
    │
    invalid/miss
    ▼
Check patches.json ──has URL──► verifyUrl(url) ──valid──► downloadWithUrl(url)
    │
    no/invalid
    ▼
parallelResolveSources(packageId, version)
    │
    ▼
First valid URL ──► downloadWithUrl(url, outputDir)
    │
    ▼
Save to URL cache
    │
    ▼
All fail? ──yes──► sequential fallback
```

## 7. Testing

### Test Cases

1. **Cache hit**: Request cached version → should use URL directly
2. **Cache miss**: Request uncached version → should resolve from sources
3. **Source failure**: One source down → should use another
4. **All fail**: All sources fail → should show clear error
5. **Version not available**: Source doesn't have version → should try next source

### Local Testing

```bash
# Test with cache
node unified-downloader.js com.google.android.youtube 20.40.45 ./test-output

# Check cache
cat ~/.cache/auto-morphe-builder/urls/com.google.android.youtube/20.40.45.json
```
