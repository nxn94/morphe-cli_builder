# AutoMorpheBuilder

> **Warning:** This project is vibecoded and a work in progress. Expect bugs, breaking changes, and incomplete documentation.

Automated GitHub Actions pipeline for building patched Android APKs with [Morphe patches](https://github.com/MorpheApp/morphe-patches), [morphe-cli](https://github.com/MorpheApp/morphe-cli), and [APKEditor](https://github.com/REAndroid/APKEditor).

## Supported Apps

- `youtube` -> `com.google.android.youtube`
- `ytmusic` -> `com.google.android.apps.youtube.music`
- `reddit` -> `com.reddit.frontpage`

## What The Workflow Does

1. Checks latest Morphe patch/CLI release tags.
2. Skips build if versions are unchanged.
3. **Automatically resolves latest supported app versions** from morphe-cli and finds APKMirror download URLs.
4. Falls back to manual URLs in `patches.json` if automatic resolution fails.
5. Extracts/selects a patchable APK (prefers configured architecture, rejects dex-less split configs).
6. Enforces signing (signed or fail).
7. Runs `morphe-cli` and applies your patch config from `patches.json`.
8. Publishes artifacts and creates a GitHub Release.
9. Updates `state.json` and keeps `patches.json` synced with upstream patch list.

## Release And Obtainium Model

Each build creates a single GitHub Release with a date-based tag (`vYYYY.MM.DD`).

For Obtainium, use filename regex filtering:

| App | Regex |
|-----|-------|
| YouTube | `^youtube.*\.apk$` |
| YouTube Music | `^ytmusic.*\.apk$` |
| Reddit | `^reddit.*\.apk$` |

Required Obtainium fields per entry:

1. Source: `GitHub`
2. Repo URL: `https://github.com/<your-user>/<your-repo>`
3. Use the above regex in the "Filter" field

## Required Secrets

Signed builds are enforced.

| Secret | Required | Notes |
|---|---|---|
| `KEYSTORE_BASE64` | Yes | Base64 of your keystore file |
| `KEYSTORE_PASSWORD` | Yes | Keystore password |
| `KEY_ALIAS` | No | If empty, workflow picks first alias in keystore |
| `KEY_PASSWORD` | No | Only needed when key password differs from keystore password |

## Patch Configuration (`patches.json`)

### Configuration Options

```json
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
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `preferred_arch` | `arm64-v8a` | Preferred CPU architecture (e.g., `arm64-v8a`, `armeabi-v7a`) |
| `apkmirror_paths` | required | Mapping of package IDs to APKMirror app paths |

- Allowed branch values: `main` and `dev`.
- Manual APK URLs (fallback if auto-resolution fails):
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

## Download Flow

The workflow automatically resolves APK download URLs at build time:

1. Uses `morphe-cli list-versions` to find the latest Morphe-supported version for each app
2. Constructs the APKMirror URL directly using the predictable URL format
3. Uses curl to probe for the correct variant number (APKMirror variants are numbered -1, -2, etc.)
4. Falls back to manual URLs in `patches.json` if automatic resolution fails

The resolved URLs are stored in `patches.json` as they're used.

APKMirror URL format:
- Version page: `https://www.apkmirror.com/apk/{developer}/{app}/{app}-{version}-release/`
- Download: `https://www.apkmirror.com/apk/{developer}/{app}/{app}-{version}-{variant}-android-apk-download/`

## APK Selection Logic

- Resolves Morphe-supported versions from patch compatibility and downloads only the latest supported version.
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

- Uses curl for URL resolution (lightweight, no browser overhead).
- npm cache (`~/.npm`) is used for any remaining npm dependencies.

## Artifacts And Releases

- Workflow artifact upload includes versioned patched APKs named `<app>-<patches-version>-v<base-version>.apk`.
- GitHub Release is created with tag `vYYYY.MM.DD` containing all APKs.

## Setup

Full setup steps are in [`SETUP.md`](SETUP.md).

## Troubleshooting

### Error: `No manual URL configured`

The workflow requires manual download URLs. Add them to `patches.json` under `__morphe.download_urls`.

### Error: `Chosen APK has no classes.dex`

The selected file is not a patchable base APK (usually split/config artifact). The workflow now fails fast instead of patching invalid APKs.

### Error: `Wrong version of key store`

Keystore format/password mismatch. Verify:

1. `KEYSTORE_BASE64` decodes to your real keystore file
2. `KEYSTORE_PASSWORD` is correct
3. `KEY_PASSWORD` is set if key password differs

### Obtainium not finding updates

Use filename regex filtering as documented in the Release And Obtainium Model section.

## Thanks

- [Morphe patches](https://github.com/MorpheApp/morphe-patches) for patch definitions and compatibility metadata.
- [morphe-cli](https://github.com/MorpheApp/morphe-cli) for patching and signing.
- [APKEditor](https://github.com/REAndroid/APKEditor) for split package merge support.
- [AntiSplit-M](https://github.com/AbdurazaaqMohammed/AntiSplit-M) for practical split-APK workflow inspiration.
- [Bouncy Castle](https://www.bouncycastle.org/) for keystore/provider compatibility used in signing conversion.

## License

This project is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
