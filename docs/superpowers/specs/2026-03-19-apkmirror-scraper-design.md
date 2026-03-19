# APKMirror Scraper: fetch + cheerio Hybrid Design

**Date:** 2026-03-19
**Status:** Draft

## Problem

The current `resolveApkmirrorUrl` in `unified-downloader.js` has two failures:

1. **Wrong return value** — the primary code path returns a Page 2 (download-button) URL rather than the final direct APK URL (Page 3), causing `downloadWithPlaywright` to receive a mid-flow page URL and fail. A secondary fallback path (lines 1047-1051) can return a Page 1 release URL, which also cannot be downloaded directly.
2. **Cloudflare blocks Playwright** — headless browser detection prevents scraping before the URL can be resolved.

## Solution

Replace `resolveApkmirrorUrl` with a `fetch` + `cheerio` 3-page scraper. In testing, plain HTTP requests with browser-like headers avoid APKMirror's Cloudflare check; if Cloudflare upgrades to a full JS challenge this approach would need revisiting. No browser = significantly less bot-detection surface area.

## Architecture

### 3-Page Navigation Flow

```
Page 1 — Release page
  URL: /apk/{org}/{app}/{app-slug}-{version-slugified}-release/
       e.g. /apk/google-inc/youtube/youtube-20-44-38-release/
  Action: Parse variant table, find row matching arch/DPI/type priority
  Extract: href from that row's download link

Page 2 — Variant page
  URL: https://www.apkmirror.com + href from Page 1
  Action: Find <a class="downloadButton">
  Extract: href

Page 3 — Download page
  URL: https://www.apkmirror.com + href from Page 2
  Action: Find <a[data-google-interstitial="false"]> or <a[rel=nofollow]>
  Extract: final APK URL (returned to caller)
```

**URL construction note:** The release page segment must be formed as `{slug}-{version.replace(/\./g, '-')}-release`, not just `{version.replace(/\./g, '-')}-release`. The current implementation omits the slug prefix. The slug is derived from the last path component of `apkmirror_paths` in `config.json` (e.g. `google-inc/youtube` → slug `youtube`).

### Call Sites

`resolveApkmirrorUrl` is called from two places in `unified-downloader.js`:

- **Line 244** — `resolveApkmirror()`: the third concurrent source in `parallelResolveSources`, used for URL resolution only
- **Line 900** — `downloadWithApkmirror()`: feeds the resolved URL into `downloadWithPlaywright` for the actual file download

Both call sites only need a final APK URL — the new fetch+cheerio implementation is a drop-in replacement for both. `downloadWithPlaywright` continues to handle the actual HTTP download using the URL the new scraper returns.

### Session / Cookie Handling

- Cookies from `Set-Cookie` response headers collected into a plain JS object
- Forwarded via `Cookie` header on subsequent requests
- No persistent cookie jar files needed

### HTTP Request Strategy

- **User-Agent:** `Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0`
- **Headers:** `Accept`, `Accept-Language`, `Referer` (set to previous page for pages 2+), `DNT: 1`
- **Redirects:** `redirect: 'follow'`
- **Timeout:** 30s per request
- **Retries:** None — `parallelResolveSources` runs all three resolvers (apkeep, apkmirror-api, apkmirror) concurrently via `Promise.allSettled` and uses the first successful result; failures are handled at that level

### Variant Selection

Reads `preferred_arch` from `config.json` (defaults to `arm64-v8a`). Tries variants in priority order:

| Priority | Arch | DPI | Type |
|----------|------|-----|------|
| 1 | `preferred_arch` | `nodpi` | APK |
| 2 | `preferred_arch` | `nodpi` | BUNDLE |
| 3 | `universal` | `nodpi` | APK |
| 4 | `universal` | `nodpi` | BUNDLE |
| 5 | `noarch` | `nodpi` | APK |

`noarch` + BUNDLE is intentionally excluded — `noarch` packages are rare and do not come as bundles in practice.

If no variant matches, throws with a descriptive error listing all variants found on the page.

## Configuration Split

### `config.json` (new)

All non-patch configuration extracted from `patches.json.__morphe`. This file is git-tracked and included in the same automated commit as `state.json` after each successful build.

```json
{
  "preferred_arch": "arm64-v8a",
  "auto_update_urls": true,
  "apkmirror_paths": {
    "com.google.android.youtube": "google-inc/youtube",
    "com.google.android.apps.youtube.music": "google-inc/youtube-music",
    "com.reddit.frontpage": "redditinc/reddit"
  },
  "branches": {
    "morphe_patches": "dev",
    "morphe_cli": "dev"
  },
  "download_urls": {
    "com.google.android.youtube": {
      "latest_supported": "https://..."
    }
  }
}
```

### `patches.json` (updated)

Patch toggles only, no `__morphe` block:

```json
{
  "com.google.android.youtube": {
    "YouTube Vanced": true
  }
}
```

## Files Changed

| File | Change |
|------|--------|
| `config.json` | **New** — extracted from `patches.json.__morphe`; git-tracked, added to automated commit |
| `patches.json` | Remove `__morphe` block |
| `.github/scripts/unified-downloader.js` | Replace `resolveApkmirrorUrl` with fetch+cheerio; load config from `config.json` |
| `.github/scripts/update-download-urls.js` | Write `download_urls` to `config.json` instead of `patches.json` |
| `.github/workflows/morphe-build.yml` | See workflow changes detail below |
| `CLAUDE.md` | Update key files table and configuration docs |
| `package.json` / `package-lock.json` | **New** — created with `npm init -y`, then `cheerio` added as dependency |

### Workflow Changes Detail

The following specific locations in `morphe-build.yml` must be updated:

1. **`check-versions` job (lines 37-38):** Change `jq` reads of `patches.json.__morphe.branches` to read from `config.json`
2. **`setup` job (lines 712-719):** Change `jq` reads of `patches.json.__morphe.download_urls` to read from `config.json`
3. **`update-download-urls` job (line ~1545):** Change `git add patches.json` to `git add config.json`. Note: this job runs on a fresh checkout; how the updated `config.json` reaches this runner (artifact upload/download or inline script) must be confirmed during implementation, as this is a pre-existing cross-runner persistence concern.
4. **`update-state` job (lines 1609-1625):** The jq merge logic uses `$base` (the full existing `patches.json`) as its starting point, which means any `__morphe` key still present in `patches.json` during a transitional state will be written back. The jq expression must be updated to explicitly strip `__morphe` from `$base` (e.g. `del($base.__morphe)`) rather than relying on the key being absent. Add `config.json` to the `git add` on line 1689 — but note the same cross-runner persistence concern from point 3 applies here and must be resolved.
5. **Dead reference cleanup:** Remove the reference to `.github/scripts/apkmirror-playwright.js` (around line 842) — this file does not exist and is a pre-existing dead reference

### Pre-existing Note

The workflow references `.github/scripts/apkmirror-playwright.js` (around line 842) but this file does not exist in the repository. This is a pre-existing dead reference; it will be cleaned up as part of this work.

## Dependencies

- `cheerio` — HTML parsing with CSS selectors (npm)
- No other new dependencies

## Out of Scope

- Playwright is not removed — it remains in `downloadWithPlaywright` as the last-resort download fallback
- No changes to caching, APK validation, or the concurrent resolution logic in `parallelResolveSources`
- No changes to apkeep or aurora-store download paths
