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

Repository -> `Settings` -> `Secrets and variables` -> `Actions`

Add:

- `KEYSTORE_BASE64` (required)
- `KEYSTORE_PASSWORD` (required)
- `KEY_ALIAS` (optional, defaults to first alias found)
- `KEY_PASSWORD` (optional, only if key password differs)

Signed builds are enforced. Missing required signing secrets will fail the run.

## 4. Configure `patches.json`

Edit `patches.json` to choose patches:

- Set Morphe channels in the top metadata block:
  - `"morphe_patches": "main"` or `"dev"`
  - `"morphe_cli": "main"` or `"dev"`
- Set preferred architecture (optional, defaults to `arm64-v8a`):
  - `"preferred_arch": "arm64-v8a"`
- Add APKMirror path mapping for each app (required for auto-resolution):
  - `"apkmirror_paths": { "com.google.android.youtube": "google-inc/youtube", ... }`
- `true` enables a patch
- `false` disables a patch

Workflow behavior:

- Missing upstream patches are auto-added.
- Existing true/false edits are preserved.
- Build logs show enabled and disabled patch lists per app.
- **Automatic URL resolution:** The workflow automatically finds the latest Morphe-supported version and resolves the APKMirror download URL.
- Manual URLs in `download_urls` are used as fallback if auto-resolution fails.

Example `patches.json` structure:

```json
{
  "__morphe": {
    "preferred_arch": "arm64-v8a",
    "apkmirror_paths": {
      "com.google.android.youtube": "google-inc/youtube",
      "com.google.android.apps.youtube.music": "google-inc/youtube-music",
      "com.reddit.frontpage": "redditinc/reddit"
    },
    "branches": {
      "morphe_patches": "main",
      "morphe_cli": "main"
    },
    "download_urls": {
      "com.google.android.youtube": {
        "latest_supported": "https://www.apkmirror.com/apk/google-inc/youtube/..."
      }
    }
  },
  "com.google.android.youtube": {
    "YouTube Vanced": true
  },
  "com.google.android.apps.youtube.music": {
    "YouTube Music Vanced": true
  },
  "com.reddit.frontpage": {
    "Reddit": true
  }
}
```

URL resolution order (at build time):
1. Automatic: Query morphe-cli for latest supported version, then resolve APKMirror URL via curl
2. Manual fallback: `__morphe.download_urls.<appId>.<target_version>`
3. Manual fallback: `__morphe.download_urls.<appId>.latest_supported`

The automatic resolver:
- Queries morphe-cli for the latest supported version
- Constructs the APKMirror version page URL
- Probes variant numbers (1-15) using curl until a working URL is found
- This approach bypasses Cloudflare protection that Playwright struggles with

## 5. Run The Workflow

- Manual: `Actions` -> `Build Morphe-patched apps` -> `Run workflow`
- Automatic: scheduled daily at `05:15 UTC`

Build only runs when Morphe patch or CLI versions changed.

## 6. Download Outputs

You get:

- GitHub Actions artifacts (`<app>-<patches-version>-v<base-version>.apk`)
- GitHub Release (dated `vYYYY.MM.DD` with all APKs)

## 7. Add To Obtainium

Create 3 separate Obtainium entries (same repo, different filter).

For each entry:

1. Source: `GitHub`
2. Repository URL: `https://github.com/<your-user>/<your-repo>`
3. Use Filter (regex):
   - YouTube: `^youtube.*\.apk$`
   - YouTube Music: `^ytmusic.*\.apk$`
   - Reddit: `^reddit.*\.apk$`

## 8. Notes On APK Selection

- Architecture: Configurable via `preferred_arch` (default: `arm64-v8a`)
- DPI preference: `nodpi` > single DPI values > DPI ranges
- Workflow prefers configured architecture and rejects split config APKs without `classes.dex`.
- For `.xapk/.apkm/.apks`, it attempts APKEditor merge to produce a normal APK before fallback extraction.

## Common Failures

### `Could not resolve APKMirror URL`

The automatic URL resolution failed. Check:
- APKMirror is accessible from GitHub Actions
- The `apkmirror_paths` in `patches.json` are correct for each app
- Fallback: Add manual URLs to `__morphe.download_urls`

### `Wrong version of key store`

- Check `KEYSTORE_BASE64` is correct.
- Check `KEYSTORE_PASSWORD`.
- Set `KEY_PASSWORD` if different from keystore password.

### `Chosen APK has no classes.dex`

Downloaded package is not a patchable base APK (split/config). Workflow now fails fast to avoid invalid outputs.
