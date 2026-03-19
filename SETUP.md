# Setup Guide

Quick setup for signed Morphe builds and Obtainium-ready releases.

## 1. Create A Signing Keystore

```bash
keytool -genkey -v -keystore morphe.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias Key \
  -dname "CN=Your Name, O=Your Org, L=City, ST=State, C=US"
```

Keep this file safe. Do not commit it.

## 2. Base64 Encode The Keystore

```bash
# Linux/macOS
base64 -w 0 morphe.jks > morphe.jks.b64
cat morphe.jks.b64
```

```powershell
# Windows PowerShell
[Convert]::ToBase64String([System.IO.File]::ReadAllBytes("morphe.jks"))
```

## 3. Add GitHub Actions Secrets

Repository → `Settings` → `Secrets and variables` → `Actions`

Add:

- `KEYSTORE_BASE64` (required)
- `KEYSTORE_PASSWORD` (required)
- `KEY_ALIAS` (optional, defaults to first alias found)
- `KEY_PASSWORD` (optional, only if key password differs)

Signed builds are enforced. Missing required signing secrets will fail the run.

## 4. Configure `config.json`

Edit `config.json` to set build options:

```json
{
  "preferred_arch": "arm64-v8a",
  "apkmirror_paths": {
    "com.google.android.youtube": "google-inc/youtube",
    "com.google.android.apps.youtube.music": "google-inc/youtube-music",
    "com.reddit.frontpage": "redditinc/reddit"
  },
  "branches": {
    "morphe_patches": "main",
    "morphe_cli": "main"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `preferred_arch` | `arm64-v8a` | CPU architecture to prefer when selecting APK variant |
| `apkmirror_paths` | see above | Maps package IDs to APKMirror app slugs — required for auto-resolution |
| `branches.morphe_patches` | `main` | Morphe patches branch (`main` or `dev`) |
| `branches.morphe_cli` | `main` | morphe-cli branch (`main` or `dev`) |

The `download_urls` field is managed automatically by the workflow after each successful build. You don't need to set it manually.

## 5. Configure `patches.json`

Edit `patches.json` to choose which patches to enable or disable:

```json
{
  "com.google.android.youtube": {
    "Hide ads": true,
    "SponsorBlock": true,
    "Return YouTube Dislike": false
  },
  "com.google.android.apps.youtube.music": {
    "Hide ads": true,
    "Remove background playback restrictions": true
  },
  "com.reddit.frontpage": {
    "Hide ads": true,
    "Open links directly": true
  }
}
```

- `true` = enable patch, `false` = disable patch
- The workflow auto-adds any new upstream patches (defaulting to `true`)
- Your existing `true`/`false` values are never overwritten

Build logs show which patches were enabled and disabled per app.

## 6. Run The Workflow

- **Manual:** `Actions` → `Build Morphe-patched apps` → `Run workflow`
- **Automatic:** scheduled daily at `05:15 UTC`

The build only runs when Morphe patch or CLI versions have changed since the last build.

## 7. Download Outputs

You get:

- GitHub Actions artifacts: `<app>-<patches-version>-v<base-version>.apk`
- GitHub Release tagged `vYYYY.MM.DD` containing all APKs

## 8. Add To Obtainium

Create 3 separate Obtainium entries (same repo URL, different filter per app).

For each entry:

1. Source: `GitHub`
2. Repository URL: `https://github.com/<your-user>/<your-repo>`
3. Filter (regex):
   - YouTube: `^youtube.*\.apk$`
   - YouTube Music: `^ytmusic.*\.apk$`
   - Reddit: `^reddit.*\.apk$`

## Notes On APK Download

The workflow downloads APKs using a multi-source fallback chain:

1. **URL cache** — previously resolved direct download URLs (instant)
2. **config.json URLs** — version-specific URLs saved by the `update-download-urls` job
3. **apkeep (APKPure)** — tries first in parallel resolution
4. **APKMirror scraper** — 3-page navigation using curl; automatically falls back to Playwright (Chromium) if Cloudflare blocks curl
5. **APKMirror API** — tried in parallel alongside the scraper

The APKMirror scraper navigates release page → variant page → download page within the same browser session, preserving session cookies needed for the final download.

## Notes On APK Selection

- Architecture is configured via `preferred_arch` in `config.json` (default: `arm64-v8a`)
- DPI preference: `nodpi` → `120-640dpi` → `240-480dpi`
- APK types: prefers `APK` over `BUNDLE` for same arch/DPI
- For `.xapk`/`.apkm`/`.apks`, APKEditor merge produces a normal `.apk` before patching

## Common Failures

### APK download fails / `No APK could be downloaded`

The download chain exhausted all sources. Check:

- The `apkmirror_paths` values in `config.json` are correct for each app
- Run the workflow again (transient Cloudflare blocks are common)

### `Chosen APK has no classes.dex`

The downloaded file is a split config APK, not the base APK. The scraper selects variants using the priority list but some releases only have BUNDLE variants. Check APKMirror manually to confirm an APK variant exists for the target version.

### `Wrong version of key store`

- Verify `KEYSTORE_BASE64` decodes to your actual keystore
- Verify `KEYSTORE_PASSWORD` is correct
- Set `KEY_PASSWORD` if the key password differs from the keystore password
