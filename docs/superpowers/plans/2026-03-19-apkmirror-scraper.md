# APKMirror Scraper (fetch + cheerio) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken Playwright-based APKMirror URL resolver with a fetch+cheerio 3-page scraper, and split `patches.json` into `patches.json` (patch toggles only) + `config.json` (all config).

**Architecture:** A new `resolveApkmirrorUrl` function in `unified-downloader.js` uses Node's built-in `fetch` + `cheerio` HTML parsing to navigate APKMirror's 3-page download flow (release page → variant page → download page), forwarding cookies between requests. Configuration is extracted from `patches.json.__morphe` into a new `config.json` file.

**Tech Stack:** Node.js 18+, `cheerio` (HTML parsing), `jest` (testing), `jq` (workflow YAML shell scripts)

---

## Chunk 1: Configuration Split + Workflow Updates

### Task 1: Create `config.json`

**Files:**
- Create: `config.json`

- [ ] **Step 1: Extract `config.json` directly from `patches.json.__morphe` using jq**

Copy the entire `__morphe` block verbatim — all versioned download URL entries, all packages:

```bash
jq '.["__morphe"]' patches.json > config.json
```

Verify it looks correct (should have preferred_arch, branches, apkmirror_paths, download_urls for both YouTube and YT Music with versioned keys):

```bash
jq '.' config.json
```

- [ ] **Step 2: Verify it's valid JSON**

```bash
jq '.' config.json > /dev/null && echo "Valid JSON"
```

Expected: `Valid JSON`

- [ ] **Step 3: Commit**

```bash
git add config.json
git commit -m "feat: extract config.json from patches.json.__morphe"
```

---

### Task 2: Strip `__morphe` from `patches.json`

**Files:**
- Modify: `patches.json`

- [ ] **Step 1: Remove the `__morphe` block from `patches.json`**

The file should contain only the package patch toggles. Remove everything from `"__morphe": {` through its closing `},` at the top.

- [ ] **Step 2: Verify both files are valid and `patches.json` has no `__morphe`**

```bash
jq '.' patches.json > /dev/null && echo "patches.json valid"
jq 'has("__morphe")' patches.json
```

Expected: `patches.json valid` then `false`

- [ ] **Step 3: Commit**

```bash
git add patches.json
git commit -m "chore: remove __morphe block from patches.json (moved to config.json)"
```

---

### Task 3: Update `check-versions` workflow job

**Files:**
- Modify: `.github/workflows/morphe-build.yml:36-48`

The `check-versions` job reads `branches` from `patches.json.__morphe`. Change it to read from `config.json`.

- [ ] **Step 1: Update lines 36-48 to read from `config.json`**

Find this block (around line 36):
```yaml
          PATCHES_BRANCH="main"
          CLI_BRANCH="main"
          if [ -s patches.json ] && jq -e 'type=="object"' patches.json >/dev/null 2>&1; then
            PATCHES_BRANCH="$(jq -r '(.["__morphe"]?.branches?.morphe_patches // "main") | ascii_downcase' patches.json)"
            CLI_BRANCH="$(jq -r '(.["__morphe"]?.branches?.morphe_cli // "main") | ascii_downcase' patches.json)"
          fi
```

Replace with:
```yaml
          PATCHES_BRANCH="main"
          CLI_BRANCH="main"
          if [ -s config.json ] && jq -e 'type=="object"' config.json >/dev/null 2>&1; then
            PATCHES_BRANCH="$(jq -r '(.branches?.morphe_patches // "main") | ascii_downcase' config.json)"
            CLI_BRANCH="$(jq -r '(.branches?.morphe_cli // "main") | ascii_downcase' config.json)"
          fi
```

Also update the comment above it from `patches.json metadata` to `config.json`:
```yaml
          # Read channel selection from config.json.
```

- [ ] **Step 2: Verify YAML is valid**

```bash
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color . 2>&1 | head -30
```

Expected: no errors (or same pre-existing warnings as before)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "fix: read branches config from config.json in check-versions job"
```

---

### Task 4: Update `setup` job download URL lookup

**Files:**
- Modify: `.github/workflows/morphe-build.yml:703-719`

The `setup` job reads `download_urls` from `patches.json.__morphe`. Change it to read from `config.json`.

- [ ] **Step 1: Update lines 703-719**

Find this block (around line 703):
```yaml
          # Manual source URL override (fallback).
          # patches.json shape:
          # "__morphe": {
          #   "download_urls": {
          #     "com.google.android.youtube": {
          #       "latest_supported": "https://www.apkmirror.com/apk/.../android-apk-download/"
          #     }
          #   }
          # }
          MANUAL_URL="$(
            jq -r \
              --arg pkg "$APP_ID" \
              '
                .["__morphe"]?.download_urls?[$pkg]?["latest_supported"]
                // empty
              ' patches.json 2>/dev/null || true
          )"
```

Replace with:
```yaml
          # Manual source URL override (fallback).
          # config.json shape:
          # {
          #   "download_urls": {
          #     "com.google.android.youtube": {
          #       "latest_supported": "https://www.apkmirror.com/apk/.../android-apk-download/"
          #     }
          #   }
          # }
          MANUAL_URL="$(
            jq -r \
              --arg pkg "$APP_ID" \
              '
                .download_urls?[$pkg]?["latest_supported"]
                // empty
              ' config.json 2>/dev/null || true
          )"
```

- [ ] **Step 2: Verify YAML is valid**

```bash
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color . 2>&1 | head -30
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "fix: read download_urls from config.json in setup job"
```

---

### Task 5: Update `update-state` job — jq merge + git add

**Files:**
- Modify: `.github/workflows/morphe-build.yml:1609-1689`

Two changes: (a) explicitly strip `__morphe` from `$base` in the jq merge so any transient `__morphe` key is never written back to `patches.json`; (b) add `config.json` to the `git add` command.

- [ ] **Step 1: Update the jq merge logic (around line 1615-1625)**

Find:
```yaml
          jq -n --slurpfile defaults "$DEFAULTS_FILE" --slurpfile existing "$EXISTING_FILE" '
            ($defaults[0] // {}) as $d
            | ($existing[0] // {}) as $e
            | ($e | if type == "object" then . else {} end) as $base
            | reduce ($d | keys[]) as $pkg ($base;
```

Replace with (note: `del(.__morphe)` must be applied inline in the pipe chain, before the `as $base` binding):
```yaml
          jq -n --slurpfile defaults "$DEFAULTS_FILE" --slurpfile existing "$EXISTING_FILE" '
            ($defaults[0] // {}) as $d
            | ($existing[0] // {}) as $e
            | ($e | if type == "object" then . else {} end | del(.__morphe)) as $base
            | reduce ($d | keys[]) as $pkg ($base;
```

- [ ] **Step 2: Update the `git add` line (around line 1689)**

Find:
```yaml
          git add state.json patches.json
```

Replace with:
```yaml
          git add state.json patches.json config.json
```

Note: `config.json` is not modified by the `update-state` job itself (it only modifies state.json and patches.json). Adding it to `git add` is safe — git will silently skip it if it has no staged changes. This sets up the correct behavior for a future fix where URL updates are made available to this runner via artifact.

- [ ] **Step 3: Verify YAML is valid**

```bash
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color . 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "fix: strip __morphe from patches.json merge and track config.json in update-state"
```

---

### Task 6: Fix dead reference and update `update-download-urls` job

**Files:**
- Modify: `.github/workflows/morphe-build.yml:842` (dead ref)
- Modify: `.github/workflows/morphe-build.yml:1540-1550` (job commit)

- [ ] **Step 1: Remove the dead reference to `apkmirror-playwright.js` (around line 842)**

Find this entire function that references it:
```yaml
            # Run Playwright downloader
            node .github/scripts/apkmirror-playwright.js "$url" "" "$meta_file" "$output_file"
          }
```

Replace the `node .github/scripts/apkmirror-playwright.js` call with the unified downloader. The containing function `download_with_playwright` is likely dead code — check if it's called anywhere and remove the call + function if unused. If it is referenced, replace the body with:
```yaml
            # Use unified downloader instead
            node .github/scripts/unified-downloader.js "$APP_ID" "$VERSION" "$APKS_DIR"
```

- [ ] **Step 2: Update `update-download-urls` job (around line 1540)**

> **Note:** This job currently has a pre-existing bug — it runs on a fresh checkout and no step has written a modified `config.json` (or `patches.json`) to this runner, so `git status --porcelain` will always be empty and the job always skips the commit. This is a pre-existing issue that predates this change and is deferred. For now, update the file reference from `patches.json` to `config.json` for correctness when/if the artifact-transfer issue is fixed.

Find:
```yaml
      - name: Commit updated patches.json
        run: |
          if [ -n "$(git status --porcelain)" ]; then
            git config --local user.email "github-actions[bot]@users.noreply.github.com"
            git config --local user.name "github-actions[bot]"
            git add patches.json
            git commit -m "chore: update download URLs after successful build" || true
            git push || true
          else
            echo "No changes to patches.json"
          fi
```

Replace with:
```yaml
      - name: Commit updated config.json
        run: |
          # Note: this job runs on a fresh checkout; config.json changes from
          # other runners are not automatically present here. The git status check
          # will typically find nothing to commit. This is a known pre-existing
          # limitation — URL commits happen via update-state job's git add instead.
          if [ -n "$(git status --porcelain)" ]; then
            git config --local user.email "github-actions[bot]@users.noreply.github.com"
            git config --local user.name "github-actions[bot]"
            git add config.json
            git commit -m "chore: update download URLs after successful build" || true
            git push || true
          else
            echo "No changes to config.json on this runner"
          fi
```

- [ ] **Step 3: Verify YAML is valid**

```bash
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color . 2>&1 | head -30
```

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "fix: remove dead apkmirror-playwright.js reference, update-download-urls uses config.json"
```

---

## Chunk 2: npm Setup + APKMirror Scraper + Script Updates

### Task 7: Set up `package.json` with cheerio and jest

**Files:**
- Create: `package.json`
- Modify: `.github/workflows/morphe-build.yml:134` and `:454`

- [ ] **Step 1: Create `package.json`**

```bash
npm init -y
```

Then edit the generated `package.json` to add dependencies and test script. Do NOT hardcode playwright's version — let npm resolve the latest so the lockfile matches what CI was previously installing via `npm install --no-save playwright`:

```json
{
  "name": "auto-morphe-builder",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "test": "jest"
  },
  "dependencies": {
    "cheerio": "^1.0.0",
    "playwright": "latest"
  },
  "devDependencies": {
    "jest": "^29.0.0"
  }
}
```

- [ ] **Step 2: Install dependencies and generate lock file**

```bash
npm install
```

Expected: `node_modules/` created, `package-lock.json` created. Check the installed playwright version:

```bash
node -e "console.log(require('playwright/package.json').version)"
```

The lockfile pins this version for all future CI runs.

- [ ] **Step 3: Configure `.gitignore`**

```bash
# Ensure node_modules is ignored but package-lock.json is NOT ignored
grep -q node_modules .gitignore 2>/dev/null || echo "node_modules/" >> .gitignore
# Explicitly un-ignore the lockfile if needed
grep -q package-lock .gitignore 2>/dev/null && sed -i '/package-lock/d' .gitignore || true
```

`package-lock.json` MUST be committed. `npm ci` (used in CI) requires it — if it's absent CI will hard-fail with `"npm ci requires a lockfile"`.

- [ ] **Step 4: Update workflow npm install steps to use `npm ci`**

In `.github/workflows/morphe-build.yml`, find (there are two occurrences around lines 134 and 454):
```yaml
        run: npm install --no-save playwright
```

Replace both with:
```yaml
        run: npm ci
```

This installs everything in `package.json` (playwright + cheerio) using the lockfile.

- [ ] **Step 5: Verify YAML is valid**

```bash
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color . 2>&1 | head -30
```

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json .gitignore .github/workflows/morphe-build.yml
git commit -m "feat: add package.json with cheerio + jest, update workflow to npm ci"
```

---

### Task 8: Write failing tests for APKMirror scraper helpers

**Files:**
- Create: `.github/scripts/__tests__/apkmirror-scraper.test.js`

These tests cover the pure helper functions that will be extracted from `resolveApkmirrorUrl`. We write the tests first, confirm they fail, then implement.

- [ ] **Step 1: Create the test file**

```javascript
// .github/scripts/__tests__/apkmirror-scraper.test.js
'use strict';

// We'll import helpers once they're exported from unified-downloader.js
const {
  buildReleasePageUrl,
  buildVariantPriorities,
  selectVariant,
  collectCookies,
} = require('../unified-downloader');

const cheerio = require('cheerio');

describe('buildReleasePageUrl', () => {
  test('constructs correct URL with slug prefix', () => {
    const url = buildReleasePageUrl('google-inc/youtube', '20.44.38');
    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-44-38-release/'
    );
  });

  test('constructs correct URL for youtube music', () => {
    const url = buildReleasePageUrl('google-inc/youtube-music', '8.44.54');
    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube-music/youtube-music-8-44-54-release/'
    );
  });
});

describe('buildVariantPriorities', () => {
  test('preferred_arch is first priority as APK', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[0]).toEqual({ arch: 'arm64-v8a', dpi: 'nodpi', type: 'APK' });
  });

  test('universal APK is third priority', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[2]).toEqual({ arch: 'universal', dpi: 'nodpi', type: 'APK' });
  });

  test('noarch APK is fifth priority', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[4]).toEqual({ arch: 'noarch', dpi: 'nodpi', type: 'APK' });
  });

  test('returns 5 priorities total', () => {
    expect(buildVariantPriorities('arm64-v8a')).toHaveLength(5);
  });
});

describe('selectVariant', () => {
  const makeHtml = (rows) => `
    <div class="variants-table">
      ${rows.map(r => `
        <div class="table-row">
          <div class="table-cell">${r.version}</div>
          <div class="table-cell">${r.dpi}</div>
          <div class="table-cell">${r.arch}</div>
          <div class="table-cell">${r.type}</div>
          <div class="table-cell"><a href="${r.href}">Download</a></div>
        </div>
      `).join('')}
    </div>
  `;

  test('selects arm64-v8a APK nodpi as first priority', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/arm64' },
      { version: '20.44.38', dpi: 'nodpi', arch: 'universal', type: 'APK', href: '/apk/universal' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/arm64');
  });

  test('falls back to universal when preferred_arch not found', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'universal', type: 'APK', href: '/apk/universal' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/universal');
  });

  test('throws with list of available variants when nothing matches', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '320dpi', arch: 'x86_64', type: 'APK', href: '/apk/x86' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(() => selectVariant($, priorities)).toThrow(/No matching variant/);
  });

  test('prefers APK over BUNDLE for same arch', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'BUNDLE', href: '/apk/bundle' },
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/apk' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/apk');
  });
});

describe('collectCookies', () => {
  // Mock uses getSetCookie() returning string[] — matches the Headers API
  const makeResponse = (cookieStrings) => ({
    headers: { getSetCookie: () => cookieStrings }
  });

  test('collects a single cookie', () => {
    const resp = makeResponse(['session=abc123; Path=/']);
    const cookies = collectCookies(resp, {});
    expect(cookies).toEqual({ session: 'abc123' });
  });

  test('collects multiple cookies from separate Set-Cookie headers', () => {
    const resp = makeResponse(['session=abc123; Path=/', 'token=xyz; HttpOnly']);
    const cookies = collectCookies(resp, {});
    expect(cookies).toEqual({ session: 'abc123', token: 'xyz' });
  });

  test('merges with existing cookies', () => {
    const resp = makeResponse(['new=val; Path=/']);
    const cookies = collectCookies(resp, { existing: 'keep' });
    expect(cookies).toEqual({ existing: 'keep', new: 'val' });
  });

  test('returns existing when no Set-Cookie headers', () => {
    const resp = makeResponse([]);
    const cookies = collectCookies(resp, { keep: 'me' });
    expect(cookies).toEqual({ keep: 'me' });
  });
});
```

- [ ] **Step 2: Run tests and confirm they all fail** (the functions don't exist yet)

```bash
npm test -- --testPathPattern="apkmirror-scraper" 2>&1 | tail -20
```

Expected: Tests fail with `TypeError: buildReleasePageUrl is not a function` or similar.

---

### Task 9: Implement APKMirror scraper + export helpers

**Files:**
- Modify: `.github/scripts/unified-downloader.js`

- [ ] **Step 1: Replace `resolveApkmirrorUrl` with the fetch+cheerio implementation**

Find the existing `resolveApkmirrorUrl` function (around line 922) and replace the entire function body. Also add the helper functions before it. Add `const cheerio = require('cheerio');` at the top of the file alongside the existing requires.

Add after the existing `require` statements at the top of the file:
```javascript
const cheerio = require('cheerio');
```

Add these helper functions before `resolveApkmirrorUrl` (they can go right after the `APK_MIRROR_PATHS` constant):

```javascript
/**
 * Build APKMirror release page URL for a given version.
 * Slug is derived from the last path component of apkmirrorPath.
 * e.g. "google-inc/youtube" + "20.44.38" → ".../youtube-20-44-38-release/"
 */
function buildReleasePageUrl(apkmirrorPath, version) {
  const slug = apkmirrorPath.split('/').pop();
  const versionSlug = version.replace(/\./g, '-');
  return `https://www.apkmirror.com/apk/${apkmirrorPath}/${slug}-${versionSlug}-release/`;
}

/**
 * Build ordered variant priority list from preferred arch.
 * Priority: preferred APK → preferred BUNDLE → universal APK → universal BUNDLE → noarch APK
 */
function buildVariantPriorities(preferredArch) {
  return [
    { arch: preferredArch, dpi: 'nodpi', type: 'APK' },
    { arch: preferredArch, dpi: 'nodpi', type: 'BUNDLE' },
    { arch: 'universal',   dpi: 'nodpi', type: 'APK' },
    { arch: 'universal',   dpi: 'nodpi', type: 'BUNDLE' },
    { arch: 'noarch',      dpi: 'nodpi', type: 'APK' },
  ];
}

/**
 * Parse variant table rows from a cheerio-loaded release page.
 * Returns the href of the first row matching the priority list.
 * Throws with available variants if nothing matches.
 */
function selectVariant($, priorities) {
  const rows = [];
  $('.table-row').each((_, row) => {
    const cells = $(row).find('.table-cell').map((_, c) => $(c).text().trim()).get();
    if (cells.length < 4) return;
    const href = $(row).find('a[href*="/apk/"]').attr('href');
    if (!href) return;
    rows.push({
      dpi:  cells[1]?.toLowerCase() ?? '',
      arch: cells[2]?.toLowerCase() ?? '',
      type: cells[3]?.toUpperCase() ?? '',
      href,
    });
  });

  for (const { arch, dpi, type } of priorities) {
    const match = rows.find(r =>
      r.arch.includes(arch.toLowerCase()) &&
      r.dpi === dpi.toLowerCase() &&
      r.type === type
    );
    if (match) return match.href;
  }

  const found = rows.map(r => `${r.arch}/${r.dpi}/${r.type}`).join(', ') || 'none';
  throw new Error(`No matching variant found on APKMirror. Available: ${found}`);
}

/**
 * Collect cookies from a fetch Response's Set-Cookie headers into a plain object.
 * Uses getSetCookie() which returns an array — safe for multi-cookie responses.
 * Falls back to get('set-cookie') for environments that don't have getSetCookie().
 * Merges with any existing cookies.
 */
function collectCookies(response, existing = {}) {
  // getSetCookie() returns string[] and handles multi-value Set-Cookie correctly.
  // response.headers.get('set-cookie') joins multiple values with ',' which is
  // ambiguous with commas inside cookie attribute values (e.g. Expires dates).
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return existing;
  const cookies = { ...existing };
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) continue;
    cookies[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return cookies;
}

/**
 * Make a fetch request with browser-like headers and cookie forwarding.
 * Throws on non-OK responses or timeout.
 */
async function apkmirrorFetch(url, cookies = {}, referer = null) {
  const headers = {
    'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'DNT':             '1',
  };
  if (referer) headers['Referer'] = referer;
  if (Object.keys(cookies).length > 0) {
    headers['Cookie'] = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return response;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}
```

Now replace the entire existing `resolveApkmirrorUrl` function with:

```javascript
/**
 * Resolve APKMirror direct APK download URL using fetch + cheerio (3-page navigation).
 * Page 1: Release page → find correct arch/DPI/type variant row
 * Page 2: Variant page → find download button
 * Page 3: Download page → find final APK link
 */
async function resolveApkmirrorUrl(apkmirrorPath, version) {
  const config = loadConfig();
  const preferredArch = config.preferred_arch || 'arm64-v8a';
  const priorities = buildVariantPriorities(preferredArch);

  // Page 1: Release page
  const page1Url = buildReleasePageUrl(apkmirrorPath, version);
  console.error(`[apkmirror-scraper] Page 1: ${page1Url}`);
  const resp1 = await apkmirrorFetch(page1Url);
  let cookies = collectCookies(resp1);
  const $1 = cheerio.load(await resp1.text());

  const variantHref = selectVariant($1, priorities);

  // Page 2: Variant page
  const page2Url = `https://www.apkmirror.com${variantHref}`;
  console.error(`[apkmirror-scraper] Page 2: ${page2Url}`);
  const resp2 = await apkmirrorFetch(page2Url, cookies, page1Url);
  cookies = collectCookies(resp2, cookies);
  const $2 = cheerio.load(await resp2.text());

  const downloadButtonHref = $2('a.downloadButton[href]').attr('href');
  if (!downloadButtonHref) {
    throw new Error('Download button not found on APKMirror variant page');
  }

  // Page 3: Download page
  const page3Url = `https://www.apkmirror.com${downloadButtonHref}`;
  console.error(`[apkmirror-scraper] Page 3: ${page3Url}`);
  const resp3 = await apkmirrorFetch(page3Url, cookies, page2Url);
  cookies = collectCookies(resp3, cookies);
  const $3 = cheerio.load(await resp3.text());

  const finalHref =
    $3('a[data-google-interstitial="false"][href]').attr('href') ||
    $3('a[rel=nofollow][href*=".apk"]').attr('href');

  if (!finalHref) {
    throw new Error('Final APK download link not found on APKMirror download page');
  }

  const finalUrl = finalHref.startsWith('http')
    ? finalHref
    : `https://www.apkmirror.com${finalHref}`;

  console.error(`[apkmirror-scraper] Resolved: ${finalUrl}`);
  return finalUrl;
}
```

- [ ] **Step 2: Guard `main()` and add exports at the bottom of `unified-downloader.js`**

Find the unconditional `main()` call at the very bottom of the file:
```javascript
main();
```

Replace it with a guard and the module exports:
```javascript
// Guard: only run main() when executed directly, not when require()'d by tests
if (require.main === module) {
  main();
}

// Export helpers for testing and external use
module.exports = {
  buildReleasePageUrl,
  buildVariantPriorities,
  selectVariant,
  collectCookies,
  resolveApkmirrorUrl,
};
```

Without the `require.main` guard, importing this file via `require()` (in tests or the smoke test) will immediately call `main()`, which calls `process.exit()` and kills the test runner.

- [ ] **Step 3: Run the tests and confirm they pass**

```bash
npm test -- --testPathPattern="apkmirror-scraper" 2>&1 | tail -30
```

Expected: All tests pass (`PASS .github/scripts/__tests__/apkmirror-scraper.test.js`)

- [ ] **Step 4: Commit**

```bash
git add .github/scripts/unified-downloader.js .github/scripts/__tests__/apkmirror-scraper.test.js
git commit -m "feat: replace resolveApkmirrorUrl with fetch+cheerio 3-page scraper"
```

---

### Task 10: Update `loadConfig` and `loadExistingUrl` to use `config.json`

**Files:**
- Modify: `.github/scripts/unified-downloader.js`

The `APK_MIRROR_PATHS` constant (line 33) is hardcoded. `loadExistingUrl` (line 406) reads from `patches.__morphe`. Both need to read from `config.json` instead.

- [ ] **Step 1: Add a `loadConfig` function** (if not already present; check if `loadPatchesJson` exists)

Add after the existing `loadPatchesJson` function:

```javascript
/**
 * Load config.json
 */
function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Warning: Failed to parse config.json: ${e.message}`);
    return {};
  }
}
```

- [ ] **Step 2: Update `loadExistingUrl` to read from `config.json`**

Find `loadExistingUrl` (around line 406):
```javascript
function loadExistingUrl(packageId, version) {
  const patches = loadPatchesJson();
  if (!patches) {
    return null;
  }

  const downloadUrls = patches.__morphe?.download_urls?.[packageId];
```

Replace with:
```javascript
function loadExistingUrl(packageId, version) {
  const config = loadConfig();

  const downloadUrls = config.download_urls?.[packageId];
```

The rest of the function stays the same.

- [ ] **Step 3: Update `APK_MIRROR_PATHS` to read from `config.json` dynamically**

The `APK_MIRROR_PATHS` constant is used in `resolveApkmirrorApi`, `resolveApkmirror`, `downloadWithApkmirrorApi`, `downloadWithApkmirror`. Replace the static constant with a function:

Remove:
```javascript
// APKMirror paths mapping
const APK_MIRROR_PATHS = {
  "com.google.android.youtube": "google-inc/youtube",
  "com.google.android.apps.youtube.music": "google-inc/youtube-music",
  "com.reddit.frontpage": "redditinc/reddit"
};
```

Add a function instead (near the top, after `URL_CACHE_DIR`):
```javascript
/**
 * Get APKMirror path for a package from config.json, with hardcoded fallback.
 */
function getApkmirrorPath(packageId) {
  const config = loadConfig();
  const paths = config.apkmirror_paths || {
    "com.google.android.youtube": "google-inc/youtube",
    "com.google.android.apps.youtube.music": "google-inc/youtube-music",
    "com.reddit.frontpage": "redditinc/reddit"
  };
  return paths[packageId] || null;
}
```

Then replace all uses of `APK_MIRROR_PATHS[packageId]` with `getApkmirrorPath(packageId)` throughout the file (there are ~4 occurrences).

- [ ] **Step 4: Verify the script still parses without errors**

```bash
node --check .github/scripts/unified-downloader.js && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 5: Run all tests**

```bash
npm test 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/unified-downloader.js
git commit -m "fix: load apkmirror_paths and download_urls from config.json"
```

---

### Task 11: Update `update-download-urls.js` to write to `config.json`

**Files:**
- Modify: `.github/scripts/update-download-urls.js`

- [ ] **Step 1: Update the script to read/write `config.json` instead of `patches.json`**

Find the section that reads `patches.json` (around line 23):
```javascript
  const patchesPath = path.join(process.cwd(), 'patches.json');
  try {
    const content = fs.readFileSync(patchesPath, 'utf8');
    patches = JSON.parse(content);
  } catch (err) {
    if (err.code === 'ENOENT') {
      ...
      process.exit(1);
    }
  }
```

And the section that writes:
```javascript
    patches.__morphe.download_urls[packageId][version] = url;
    patches.__morphe.download_urls[packageId].latest_supported = url;
    fs.writeFileSync(patchesPath, JSON.stringify(patches, null, 2) + '\n', 'utf8');
```

Replace the entire `main` function body with the updated version that reads/writes `config.json`:

```javascript
function main() {
  const args = process.argv.slice(2);

  if (args.length !== 3) {
    console.log(JSON.stringify({
      success: false,
      error: 'Usage: node update-download-urls.js <package_id> <version> <url>'
    }, null, 2));
    process.exit(1);
  }

  const [packageId, version, url] = args;
  const configPath = path.join(process.cwd(), 'config.json');

  try {
    let config;
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(JSON.stringify({
          success: false,
          error: 'config.json not found in current directory'
        }, null, 2));
        process.exit(1);
      }
      throw err;
    }

    // Initialize download_urls if needed
    if (!config.download_urls) {
      config.download_urls = {};
    }
    if (!config.download_urls[packageId]) {
      config.download_urls[packageId] = {};
    }

    // Update the URL for the specific version and latest_supported
    config.download_urls[packageId][version] = url;
    config.download_urls[packageId].latest_supported = url;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    console.log(JSON.stringify({
      success: true,
      packageId,
      version,
      url
    }, null, 2));

  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: err.message
    }, null, 2));
    process.exit(1);
  }
}
```

- [ ] **Step 2: Verify the script works against the actual `config.json`**

```bash
node .github/scripts/update-download-urls.js com.google.android.youtube 99.99.99 https://example.com/test.apk
jq '.download_urls["com.google.android.youtube"]["99.99.99"]' config.json
```

Expected: `"https://example.com/test.apk"`

Then revert the test change:
```bash
git checkout config.json
```

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/update-download-urls.js
git commit -m "fix: update-download-urls.js writes to config.json instead of patches.json"
```

---

### Task 12: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Key Files table to add `config.json` and note `patches.json` change**

Find the table:
```markdown
| File | Purpose |
|------|---------|
| `patches.json` | User configuration - which patches to enable/disable, APKMirror paths, manual download URLs |
```

Replace that row and add a new one:
```markdown
| File | Purpose |
|------|---------|
| `patches.json` | Patch toggles only — which patches to enable/disable per app |
| `config.json` | Build configuration — preferred arch, APKMirror paths, branch selection, cached download URLs |
```

- [ ] **Step 2: Update the Configuration section**

Find the `patches.json` structure example that shows `__morphe` and update it to show the split structure. Update the `patches.json` example to show only patch toggles, and add a `config.json` example.

- [ ] **Step 3: Verify CLAUDE.md looks correct**

```bash
head -100 CLAUDE.md
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md to reflect config.json split"
```

---

### Task 13: Final validation

- [ ] **Step 1: Run all tests**

```bash
npm test 2>&1
```

Expected: All tests pass.

- [ ] **Step 2: Validate JSON files**

```bash
jq '.' config.json > /dev/null && echo "config.json OK"
jq '.' patches.json > /dev/null && echo "patches.json OK"
jq 'has("__morphe")' patches.json
```

Expected: both OK, then `false` (no `__morphe` in patches.json)

- [ ] **Step 3: Validate workflow YAML**

```bash
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color . 2>&1
```

Expected: No new errors introduced.

- [ ] **Step 4: Verify script syntax**

```bash
node --check .github/scripts/unified-downloader.js && echo "OK"
node --check .github/scripts/update-download-urls.js && echo "OK"
```

Expected: Both `OK`

- [ ] **Step 5: Lint shell scripts**

```bash
shellcheck .github/scripts/*.sh 2>/dev/null || echo "no shell scripts to lint"
```

- [ ] **Step 6: Smoke test the APKMirror scraper against a real page**

The unit tests use a synthetic HTML fixture. Verify the scraper works against live APKMirror before calling the implementation done. Run this from the repo root (requires internet access):

```bash
node -e "
const { resolveApkmirrorUrl } = require('./.github/scripts/unified-downloader');
resolveApkmirrorUrl('google-inc/youtube', '20.44.38')
  .then(url => { console.log('OK:', url); process.exit(0); })
  .catch(err => { console.error('FAIL:', err.message); process.exit(1); });
"
```

Expected: prints a URL ending in `.apk` (e.g. `https://www.apkmirror.com/apk/google-inc/youtube/.../download/`). If `selectVariant` throws "No matching variant found", the cheerio selectors need adjusting to match the real APKMirror DOM — inspect the page HTML to find the actual class names used in the variant table and update `selectVariant` accordingly.
