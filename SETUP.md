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
- Define manual APKMirror URLs in `__morphe.download_urls` for each app (`<target_version>` and/or `latest_supported`).

## 5. Run The Workflow

- Manual: `Actions` -> `Build Morphe-patched apps` -> `Run workflow`
- Automatic: scheduled daily at `05:15 UTC`

Build only runs when Morphe patch or CLI versions changed.

## 6. Download Outputs

You get both:

- GitHub Actions artifacts (`<app>-<patches-version>-v<base-version>.apk`)
- GitHub Releases (per app)

Per app releases include:

- Stable tag for clients: `<app>` (`youtube`, `ytmusic`, `reddit`)
- Old version-pinned release tags are removed by the workflow.

## 7. Add All 3 Apps To Obtainium

Create 3 separate Obtainium entries (same repo, different tag).

For each entry:

1. Source: `GitHub`
2. Repository URL: `https://github.com/<your-user>/<your-repo>`
3. Track tag:
   - YouTube: `youtube`
   - YouTube Music: `ytmusic`
   - Reddit: `reddit`

Do not use regex when these stable tags are available.

## 8. Notes On APK Selection

Workflow prefers patchable `arm64-v8a` APKs and rejects split config APKs without `classes.dex`.
For `.xapk/.apkm/.apks`, it attempts APKEditor merge to produce a normal APK before fallback extraction.

The workflow tries only the latest Morphe-supported version per app. If that exact version cannot be downloaded, the build fails.
The workflow uses Playwright-only download flow from the manual URLs in `patches.json`.

## Common Failures

### `Wrong version of key store`

- Check `KEYSTORE_BASE64` is correct.
- Check `KEYSTORE_PASSWORD`.
- Set `KEY_PASSWORD` if different from keystore password.

### `Chosen APK has no classes.dex`

Downloaded package is not a patchable base APK (split/config). Workflow now fails fast to avoid invalid outputs.
