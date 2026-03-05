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
- `true` enables
- `false` disables

Workflow behavior:

- Missing upstream patches are auto-added.
- Existing true/false edits are preserved.
- Build logs show enabled and disabled patch lists per app.
- **Required:** Define manual download URLs in `__morphe.download_urls` for each app.

Example `patches.json` structure:

```json
{
  "__morphe": {
    "branches": {
      "morphe_patches": "main",
      "morphe_cli": "main"
    },
    "download_urls": {
      "com.google.android.youtube": {
        "20.40.45": "https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-40-45-android-apk-download/",
        "latest_supported": "https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-40-45-android-apk-download/"
      },
      "com.google.android.apps.youtube.music": {
        "6.45.52": "https://www.apkmirror.com/apk/google-inc/youtube-music/youtube-music-6-45-52-android-apk-download/",
        "latest_supported": "https://www.apkmirror.com/apk/google-inc/youtube-music/youtube-music-6-45-52-android-apk-download/"
      },
      "com.reddit.frontpage": {
        "2024.45.0": "https://www.apkmirror.com/apk/redditinc/reddit/reddit-2024-45-0-android-apk-download/",
        "latest_supported": "https://www.apkmirror.com/apk/redditinc/reddit/reddit-2024-45-0-android-apk-download/"
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

The workflow resolves download URLs in this order:
1. `__morphe.download_urls.<appId>.<target_version>`
2. `__morphe.download_urls.<appId>.latest_supported`

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

Workflow prefers patchable `arm64-v8a` APKs and rejects split config APKs without `classes.dex`.
For `.xapk/.apkm/.apks`, it attempts APKEditor merge to produce a normal APK before fallback extraction.

The workflow tries only the latest Morphe-supported version per app. If that exact version cannot be downloaded, the build fails.
You must provide a valid manual download URL for the latest supported version.

## Common Failures

### `No manual URL configured`

Add manual download URLs to `patches.json` under `__morphe.download_urls`. The workflow does not have automated downloads - you must provide URLs.

### `Wrong version of key store`

- Check `KEYSTORE_BASE64` is correct.
- Check `KEYSTORE_PASSWORD`.
- Set `KEY_PASSWORD` if different from keystore password.

### `Chosen APK has no classes.dex`

Downloaded package is not a patchable base APK (split/config). Workflow now fails fast to avoid invalid outputs.
