# Pinned App Versions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to pin a specific APK version per app in `config.json`. When pinned, the workflow uses that version instead of auto-resolving the latest Morphe-supported version. If the pinned version can't be downloaded (all methods exhausted), fall back to auto-resolution.

**Architecture:** Add `pin_version` field to each `patch_repos` entry in `config.json`. Workflow checks this before calling `morphe-cli list-versions`. If set, use it directly. If download fails, fall back to auto-resolution. `update-download-urls.js` and `update-state` job skip writing/committing URLs for pinned apps.

**Tech Stack:** GitHub Actions workflow (bash + jq), Node.js script

---

## Chunk 1: `update-download-urls.js` — pin_version protection

**Files:**
- Modify: `.github/scripts/update-download-urls.js`

- [ ] **Step 1: Read the current file**

Verify contents at `.github/scripts/update-download-urls.js`

- [ ] **Step 2: Add pin_version check before writing URLs**

Modify the main() function to check if `config.patch_repos[packageId].pin_version` is set. If yes, skip the write and output a notice.

```javascript
// After line 46 (after `if (!config.download_urls[packageId]) { ... }` block)
// Check if this app has a pinned version
const pinVersion = config.patch_repos?.[packageId]?.pin_version;
if (pinVersion) {
  console.log(JSON.stringify({
    success: true,
    skipped: true,
    reason: `pin_version is set for ${packageId} (${pinVersion}) — skipping URL update`
  }, null, 2));
  return;
}
```

The check goes after the `config.download_urls[packageId]` initialization (line 46) and before the URL write (line 50).

- [ ] **Step 3: Validate JSON still parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('.github/scripts/update-download-urls.js', 'utf8').replace(/^#!/, ''))"` (strip shebang first)
Expected: No error output

- [ ] **Step 4: Commit**

```bash
git add .github/scripts/update-download-urls.js
git commit -m "feat: skip URL updates for pinned app versions in update-download-urls.js"
```

---

## Chunk 2: `check-versions` — pre-download step pin_version handling

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (lines ~349–394)

- [ ] **Step 1: Read the current pre-download loop**

Lines 349–394 of `.github/workflows/morphe-build.yml`.

Key section to modify:
```bash
while IFS= read -r PKG; do
    ...
    # morphe-cli list-versions reads tools/patches.mpp by default
    cp "$MPP_FILE" tools/patches.mpp
    echo "Getting supported version for $PKG..."
    VERSIONS_OUTPUT=$(java -jar tools/morphe-cli.jar list-versions "$PKG" 2>/dev/null || echo "")
    ...
    LATEST_VERSION=$(echo "$VERSIONS_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
    ...
    RESULT=$(node .github/scripts/unified-downloader.js "$PKG" "$LATEST_VERSION" "$APK_DIR" 2>&1) || true
```

- [ ] **Step 2: Add pin_version check before list-versions call**

After line 357 (`continue` for missing .mpp), add:

```bash
# Check if this app has a pinned version
PINNED_VERSION="$(jq -r --arg pkg "$PKG" '.patch_repos[$pkg].pin_version // empty' config.json)"
if [ -n "$PINNED_VERSION" ] && [ "$PINNED_VERSION" != "null" ]; then
  echo "::notice::Using pinned version for $PKG: $PINNED_VERSION"
  VERSION_TO_DOWNLOAD="$PINNED_VERSION"
else
  # Normal flow: get latest supported version from morphe-cli
  cp "$MPP_FILE" tools/patches.mpp
  echo "Getting supported version for $PKG..."
  VERSIONS_OUTPUT=$(java -jar tools/morphe-cli.jar list-versions "$PKG" 2>/dev/null || echo "")
  echo "::debug::morphe-cli output for $PKG: $VERSIONS_OUTPUT"
  VERSION_TO_DOWNLOAD=$(echo "$VERSIONS_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
fi
```

The old `LATEST_VERSION` variable becomes `VERSION_TO_DOWNLOAD`. The unified-downloader call at line 378 uses `VERSION_TO_DOWNLOAD` instead of `LATEST_VERSION`.

- [ ] **Step 3: Add fallback if pinned version download fails**

In the failure block (lines 391–393), add fallback logic:

```bash
if echo "$RESULT" | jq -e '.success' >/dev/null 2>&1; then
    ...existing success handling...
else
    echo "Failed to download $PKG (version $VERSION_TO_DOWNLOAD): $RESULT"
    # If pinned version failed, fall back to list-versions
    if [ -n "$PINNED_VERSION" ] && [ "$PINNED_VERSION" != "null" ]; then
      echo "::notice::Pinned version failed; falling back to auto-resolution..."
      cp "$MPP_FILE" tools/patches.mpp
      VERSIONS_OUTPUT=$(java -jar tools/morphe-cli.jar list-versions "$PKG" 2>/dev/null || echo "")
      VERSION_TO_DOWNLOAD=$(echo "$VERSIONS_OUTPUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
      if [ -n "$VERSION_TO_DOWNLOAD" ]; then
        echo "::notice::Retrying download with auto-resolved version: $VERSION_TO_DOWNLOAD"
        RESULT=$(node .github/scripts/unified-downloader.js "$PKG" "$VERSION_TO_DOWNLOAD" "$APK_DIR" 2>&1) || true
      fi
    fi
    if ! echo "$RESULT" | jq -e '.success' >/dev/null 2>&1; then
      echo "Failed to download $PKG after fallback: $RESULT"
    fi
fi
```

- [ ] **Step 4: Validate workflow syntax**

Run: `docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/morphe-build.yml 2>&1 | head -50`
Expected: No errors (warnings OK)

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "feat: check pin_version before auto-resolving APK versions in check-versions"
```

---

## Chunk 3: `build` — `targetver` step pin_version handling

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (lines ~656–736)

- [ ] **Step 1: Read the targetver step**

Lines 656–736. Focus on lines 717–736 where `TARGET_VERSION` is set.

```bash
TARGET_VERSION=""
TARGET_VERSIONS=""
if [ -n "$STRICT_VERSIONS" ]; then
  ...set TARGET_VERSION from STRICT_VERSIONS...
elif [ -n "$VERSION_COUNTS" ]; then
  ...set TARGET_VERSION from VERSION_COUNTS...
fi

if [ -n "$TARGET_VERSION" ]; then
  echo "version=$TARGET_VERSION" >> "$GITHUB_OUTPUT"
  echo "versions=$TARGET_VERSIONS" >> "$GITHUB_OUTPUT"
```

- [ ] **Step 2: Add pin_version check before jq resolution logic**

Before line 667 (before `STRICT_VERSIONS=$(...)`), add:

```bash
# Check if this app has a pinned version configured
PINNED_VERSION="$(jq -r --arg pkg '${{ matrix.appId }}' '.patch_repos[$pkg].pin_version // empty' config.json 2>/dev/null || true)"

if [ -n "$PINNED_VERSION" ] && [ "$PINNED_VERSION" != "null" ]; then
  echo "::notice::Using pinned version for ${{ matrix.appId }}: $PINNED_VERSION"

  # Validate the pinned version is actually supported by enabled patches
  PINNED_COMPATIBLE="$(jq -r \
    --arg pkg '${{ matrix.appId }}' \
    --arg ver "$PINNED_VERSION" \
    '[.patches[]? | select(
      ((.use // true) == true)
      and ((.compatiblePackages | type) == "array")
      and ([.compatiblePackages[]? | select(.packageName == $pkg and .targets[]?.version == $ver)] | length > 0)
    )] | length' "$TOOLS_DIR/patches-list.json" 2>/dev/null || echo "0")"

  if [ "$PINNED_COMPATIBLE" -gt 0 ]; then
    echo "version=$PINNED_VERSION" >> "$GITHUB_OUTPUT"
    echo "versions=$PINNED_VERSION" >> "$GITHUB_OUTPUT"
    echo "Selected version for ${{ matrix.appId }}: $PINNED_VERSION (pinned, validated against patches-list.json)"
  else
    echo "::warning::Pinned version $PINNED_VERSION is not in the compatible list for ${{ matrix.appId }}; falling back to auto-resolution"
    PINNED_VERSION=""  # force fallback
  fi
fi
```

- [ ] **Step 3: Guard the jq resolution to only run when not pinned**

Wrap the existing jq resolution block (lines 667–725) with:

```bash
if [ -z "$PINNED_VERSION" ] || [ "$PINNED_VERSION" = "null" ]; then
  # existing STRICT_VERSIONS / VERSION_COUNTS logic
  STRICT_VERSIONS="$(
    jq -r \
    ...
  )"
  ...rest of existing jq logic...
fi
```

The existing `if [ -n "$TARGET_VERSION" ]; then` block at line 727 remains — it's already guarded.

- [ ] **Step 4: Validate workflow syntax**

Run: `docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/morphe-build.yml 2>&1 | head -50`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "feat: respect pin_version in targetver step with patches-list.json validation"
```

---

## Chunk 4: `build` — `getapk` emergency fallback

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (lines ~1020–1023)

- [ ] **Step 1: Read the getapk failure handling**

Lines 1020–1023:
```bash
if [ "$DOWNLOAD_SUCCESS" = false ]; then
  echo "::error::No APK could be downloaded for $APP_ID version $TARGET_VERSION."
  exit 1
fi
```

- [ ] **Step 2: Add emergency fallback to list-versions before fatal exit**

```bash
if [ "$DOWNLOAD_SUCCESS" = false ]; then
  # Emergency fallback: try morphe-cli list-versions if this was a pinned version
  PINNED_CHECK="$(jq -r --arg pkg "$APP_ID" '.patch_repos[$pkg].pin_version // empty' config.json)"
  if [ -n "$PINNED_CHECK" ] && [ "$PINNED_CHECK" != "null" ]; then
    echo "::warning::Pinned version download failed; attempting emergency fallback to list-versions..."
    PATCH_REPO="$(jq -r --arg pkg "$APP_ID" '.patch_repos[$pkg].repo // empty' config.json)"
    PATCH_SLUG="${PATCH_REPO//\//-}"
    if [ -f "tools/${PATCH_SLUG}.mpp" ]; then
      cp "tools/${PATCH_SLUG}.mpp" tools/patches.mpp
      FALLBACK_VERSIONS=$(java -jar tools/morphe-cli.jar list-versions "$APP_ID" 2>/dev/null || echo "")
      FALLBACK_VERSION=$(echo "$FALLBACK_VERSIONS" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)
      if [ -n "$FALLBACK_VERSION" ]; then
        echo "::notice::Emergency fallback: retrying with version $FALLBACK_VERSION"
        TARGET_VERSION="$FALLBACK_VERSION"
        if RESULT=$(node .github/scripts/unified-downloader.js "$APP_ID" "$FALLBACK_VERSION" "$APKS_DIR" 2>&1); then
          echo "::notice::Emergency fallback succeeded: $RESULT"
          DOWNLOAD_SUCCESS=true
        fi
      fi
    fi
  fi
fi

if [ "$DOWNLOAD_SUCCESS" = false ]; then
  echo "::error::No APK could be downloaded for $APP_ID version $TARGET_VERSION."
  exit 1
fi
```

- [ ] **Step 3: Validate workflow syntax**

Run: `docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/morphe-build.yml 2>&1 | head -50`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "feat: add emergency fallback to list-versions in getapk step"
```

---

## Chunk 5: `update-state` — strip pinned app URLs before committing config.json

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (lines ~1840–1869)

- [ ] **Step 1: Read the commit step**

Lines 1840–1869. The `git add config.json` is at line 1856.

- [ ] **Step 2: Before `git add config.json`, strip pinned app URLs**

In the `Commit state.json and patches.json` step, modify to strip pinned URLs before staging:

```bash
- name: Commit state.json and patches.json
  run: |
    set -euo pipefail

    # Remove download_urls entries for pinned apps before committing config.json
    PINNED_APPS="$(jq -r '[.patch_repos | to_entries[] | select(.value.pin_version != null and .value.pin_version != "") | .key]' config.json)"

    if [ "$PINNED_APPS" != "[]" ] && [ -n "$PINNED_APPS" ]; then
      echo "::notice::Stripping download_urls for pinned apps: $PINNED_APPS"
      tmp_config=$(mktemp)
      jq --argjson pinned "$PINNED_APPS" \
        'if .download_urls then
          .download_urls |= with_entries(select(.key as $k | ($pinned | index($k) | not)))
         else . end' \
        config.json > "$tmp_config"
      mv "$tmp_config" config.json
    fi

    git config user.name "GitHub Actions"
    git config user.email "actions@github.com"
    git add state.json patches.json config.json
```

- [ ] **Step 3: Validate workflow syntax**

Run: `docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/morphe-build.yml 2>&1 | head -50`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/morphe-build.yml
git commit -m "feat: strip pinned app URLs from config.json before committing in update-state"
```

---

## Chunk 6: Test — validate config.json schema and end-to-end behavior

**Files:**
- Modify: `config.json` (add test pin_version to one app)

- [ ] **Step 1: Add pin_version to YouTube in config.json for testing**

Add `"pin_version": "20.45.36"` to the YouTube `patch_repos` entry. Keep others null.

- [ ] **Step 2: Validate config.json**

Run: `jq '.' config.json > /dev/null && echo "Valid JSON"`
Expected: `Valid JSON`

- [ ] **Step 3: Test update-download-urls.js skips pinned app**

Run: `node .github/scripts/update-download-urls.js com.google.android.youtube 20.45.36 "https://example.com/test"`
Expected: JSON output with `skipped: true` and reason mentioning pin_version

- [ ] **Step 4: Remove test pin_version**

Remove the test `pin_version` from config.json, commit.

- [ ] **Step 5: Commit test**

```bash
git add config.json
git commit -m "test: validate pin_version schema and update-download-urls.js behavior"
```

---

## Summary

| Chunk | What changes | Where |
|-------|---------------|-------|
| 1 | `update-download-urls.js` skips write if pin_version set | `.github/scripts/update-download-urls.js` |
| 2 | `check-versions` pre-download checks pin_version before list-versions | `.github/workflows/morphe-build.yml:~349` |
| 3 | `targetver` checks pin_version before jq resolution | `.github/workflows/morphe-build.yml:~656` |
| 4 | `getapk` emergency fallback to list-versions | `.github/workflows/morphe-build.yml:~1020` |
| 5 | `update-state` strips pinned URLs before git add config.json | `.github/workflows/morphe-build.yml:~1840` |
| 6 | Test pin_version behavior | `config.json` |

Total: 5 commits across 2 files (1 workflow, 1 script) + config test.