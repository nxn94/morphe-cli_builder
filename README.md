# AutoMorpheBuilder

Automated GitHub Actions pipeline for building patched Android APKs with [Morphe patches](https://github.com/MorpheApp/morphe-patches), [morphe-cli](https://github.com/MorpheApp/morphe-cli), [Playwright](https://playwright.dev/), and [APKEditor](https://github.com/REAndroid/APKEditor).

## Supported Apps

- `youtube` -> `com.google.android.youtube`
- `ytmusic` -> `com.google.android.apps.youtube.music`
- `reddit` -> `com.reddit.frontpage`

## What The Workflow Does

1. Checks latest Morphe patch/CLI release tags.
2. Skips build if versions are unchanged.
3. Downloads app packages from APKMirror using Playwright and manual URL overrides from `patches.json`.
4. Prefers supported app versions from Morphe patch compatibility.
5. Extracts/selects a patchable APK (prefers `arm64-v8a`, rejects dex-less split configs).
6. Enforces signing (signed or fail).
7. Runs `morphe-cli` and applies your patch config from `patches.json`.
8. Publishes artifacts and rolling GitHub Releases per app.
9. Updates `state.json` and keeps `patches.json` synced with upstream patch list (without overriding your existing true/false edits).

## Release And Obtainium Model

Each app gets:

- A stable tag for Obtainium:
  - `youtube`
  - `ytmusic`
  - `reddit`

Use one Obtainium entry per app, all pointing to the same repository.

Required Obtainium fields per entry:

1. Source: `GitHub`
2. Repo URL: `https://github.com/<your-user>/<your-repo>`
3. Track tag: one of the exact tags above

No regex is required when using these stable tags.

## Required Secrets

Signed builds are enforced.

| Secret | Required | Notes |
|---|---|---|
| `KEYSTORE_BASE64` | Yes | Base64 of your keystore file |
| `KEYSTORE_PASSWORD` | Yes | Keystore password |
| `KEY_ALIAS` | No | If empty, workflow picks first alias in keystore |
| `KEY_PASSWORD` | No | Only needed when key password differs from keystore password |

## Patch Configuration (`patches.json`)

- Branch/channel selection for Morphe sources is configured at the top:
  ```json
  "__morphe": {
    "branches": {
      "morphe_patches": "main",
      "morphe_cli": "main"
    }
  }
  ```
- Allowed values are `main` and `dev`.
- Manual APK source override (required for each app):
  ```json
  "__morphe": {
    "download_urls": {
      "com.google.android.youtube": {
        "20.40.45": "https://www.apkmirror.com/apk/.../android-apk-download/",
        "latest_supported": "https://www.apkmirror.com/apk/.../android-apk-download/"
      }
    }
  }
  ```
- Resolution order for manual URL:
  1. `__morphe.download_urls.<appId>.<target_version>`
  2. `__morphe.download_urls.<appId>.latest_supported`
- `true` = enable patch
- `false` = disable patch
- Workflow syncs missing upstream patch keys at runtime/start and during state update.
- Existing user values are preserved (your edited true/false values are not overwritten).

During build logs, each app prints:

- `Enabled patches for <package> (...)`
- `Disabled patches for <package> (...)`

Disabled patches are passed to Morphe via `-d "<patch name>"`.

## APK Selection Logic

- Resolves Morphe-supported versions from patch compatibility and downloads only the latest supported version using Playwright.
- Handles `.apk`, `.xapk`, `.apkm`.
- For split packages (`.xapk/.apkm/.apks`), tries APKEditor merge first, then falls back to dex-bearing extraction if needed.
- Prioritizes names containing `arm64-v8a`.
- Rejects dex-less APKs (`classes*.dex` required).

## Signing Flow

- Decodes `KEYSTORE_BASE64` into `tools/source.keystore`.
- Detects source keystore type (`PKCS12`, `JKS`, `BKS`, `UBER`).
- Converts keystore to BKS for Morphe signing compatibility.
- Validates alias and signs patched APK.
- Build fails immediately if signing cannot be completed.

## Build Triggers

- Manual: `workflow_dispatch`
- Scheduled: daily at `05:15 UTC`
- Actual build only runs when Morphe patch or CLI version changed.

## State Tracking (`state.json`)

Workflow updates:

- `patches_branch`
- `patches_version`
- `cli_branch`
- `cli_version`
- `last_build`
- `status`
- `build_history` (most recent entries, includes run id, run number, commit, timestamp)

## Performance Notes

- npm cache (`~/.npm`) is used to speed up Playwright dependency installation.

## Artifacts And Releases

- Workflow artifact upload includes versioned patched APKs named `<app>-<patches-version>-v<base-version>.apk`.
- GitHub Releases use stable per-app tags (`youtube`, `ytmusic`, `reddit`) with fixed asset names (`<app>.apk`).
- Old version-pinned tags and previous naming schemes are cleaned up automatically.

## Setup

Full setup steps are in [`SETUP.md`](SETUP.md).

## Troubleshooting

### Error: `No package downloaded for latest Morphe-supported version`

The workflow downloads only the latest Morphe-supported version. If that version is not downloadable, the build fails (no fallback to older supported versions).

Verify `patches.json` has a manual URL for that app/version under `__morphe.download_urls`.

### Error: `Chosen APK has no classes.dex`

The selected file is not a patchable base APK (usually split/config artifact). The workflow now fails fast instead of patching invalid APKs.

### Error: `Wrong version of key store`

Keystore format/password mismatch. Verify:

1. `KEYSTORE_BASE64` decodes to your real keystore file
2. `KEYSTORE_PASSWORD` is correct
3. `KEY_PASSWORD` is set if key password differs

### Obtainium 404

Use exact stable tags (`youtube`, `ytmusic`, `reddit`) instead of regex-based matching.

## Thanks

- [Morphe patches](https://github.com/MorpheApp/morphe-patches) for patch definitions and compatibility metadata.
- [morphe-cli](https://github.com/MorpheApp/morphe-cli) for patching and signing.
- [Playwright](https://playwright.dev/) for browser-driven APKMirror downloads.
- [APKEditor](https://github.com/REAndroid/APKEditor) for split package merge support.
- [AntiSplit-M](https://github.com/AbdurazaaqMohammed/AntiSplit-M) for practical split-APK workflow inspiration.
- [Bouncy Castle](https://www.bouncycastle.org/) for keystore/provider compatibility used in signing conversion.

## License

This project is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
