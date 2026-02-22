# AutoMorpheBuilder

Automated GitHub Actions pipeline for building patched Android APKs with [Morphe patches](https://github.com/MorpheApp/morphe-patches), [morphe-cli](https://github.com/MorpheApp/morphe-cli), [apkeep](https://github.com/EFForg/apkeep), and [APKEditor](https://github.com/REAndroid/APKEditor).

## Supported Apps

- `youtube` -> `com.google.android.youtube`
- `ytmusic` -> `com.google.android.apps.youtube.music`
- `reddit` -> `com.reddit.frontpage`

## What The Workflow Does

1. Checks latest Morphe patch/CLI release tags.
2. Skips build if versions are unchanged.
3. Downloads app packages with `apkeep`.
4. Prefers supported app versions from Morphe patch compatibility.
5. Extracts/selects a patchable APK (prefers `arm64-v8a` + `nodpi`, rejects dex-less split configs).
6. Enforces signing (signed or fail).
7. Runs `morphe-cli` and applies your patch config from `patches.json`.
8. Publishes artifacts and rolling latest GitHub Releases per app.
9. Updates `state.json` and keeps `patches.json` synced with upstream patch list (without overriding your existing true/false edits).

## Release And Obtainium Model

Each app gets:

- A stable tag for Obtainium:
  - `morphe-youtube-latest`
  - `morphe-ytmusic-latest`
  - `morphe-reddit-latest`

Use one Obtainium entry per app, all pointing to the same repository.

Required Obtainium fields per entry:

1. Source: `GitHub`
2. Repo URL: `https://github.com/<your-user>/<your-repo>`
3. Track tag: one of the exact `morphe-*-latest` tags above

No regex is required when using the stable `-latest` tags.

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
- `true` = enable patch
- `false` = disable patch
- Workflow syncs missing upstream patch keys at runtime/start and during state update.
- Existing user values are preserved (your edited true/false values are not overwritten).

During build logs, each app prints:

- `Enabled patches for <package> (...)`
- `Disabled patches for <package> (...)`

Disabled patches are passed to Morphe via `-d "<patch name>"`.

## APK Selection Logic

- Tries Morphe-supported versions first (derived from enabled patch compatibility).
- If no package is downloaded from supported-version attempts, retries source default package selection.
- Handles `.apk`, `.xapk`, `.apkm`.
- For split packages (`.xapk/.apkm/.apks`), tries APKEditor merge first, then falls back to dex-bearing extraction if needed.
- Prioritizes names containing `arm64-v8a` and `nodpi`.
- Rejects dex-less APKs (`classes*.dex` required).
- Reddit has an optional fallback URL (`REDDIT_FALLBACK_APK_URL`) if split output is not patchable.

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
- `build_history` (rolling latest entries, includes run id, run number, commit, timestamp)

## Performance Notes

- Rust/apkeep toolchain is cached (`~/.cargo`, `~/.rustup`) to reduce repeated compile time.
- `apkeep` is rebuilt only when cache is missing.

## Artifacts And Releases

- Workflow artifact upload includes versioned patched APKs.
- GitHub Releases only use stable `-latest` tags (fixed asset name `<app>-latest.apk`).
- Old version-pinned `morphe-<app>-...` releases are cleaned up automatically.

## Setup

Full setup steps are in [`SETUP.md`](SETUP.md).

## Troubleshooting

### Warning: `No package downloaded from supported-version attempts`

This can be normal. It means none of the compatibility-targeted version attempts returned a package and the workflow fell back to the source default selection.

### Error: `Chosen APK has no classes.dex`

The selected file is not a patchable base APK (usually split/config artifact). The workflow now fails fast instead of patching invalid APKs.

### Error: `Wrong version of key store`

Keystore format/password mismatch. Verify:

1. `KEYSTORE_BASE64` decodes to your real keystore file
2. `KEYSTORE_PASSWORD` is correct
3. `KEY_PASSWORD` is set if key password differs

### Obtainium 404

Use exact stable tags (`morphe-youtube-latest`, `morphe-ytmusic-latest`, `morphe-reddit-latest`) instead of regex-based matching.

## Thanks

- [Morphe patches](https://github.com/MorpheApp/morphe-patches) for patch definitions and compatibility metadata.
- [morphe-cli](https://github.com/MorpheApp/morphe-cli) for patching and signing.
- [apkeep](https://github.com/EFForg/apkeep) for APK package downloads.
- [APKEditor](https://github.com/REAndroid/APKEditor) for split package merge support.
- [AntiSplit-M](https://github.com/AbdurazaaqMohammed/AntiSplit-M) for practical split-APK workflow inspiration.
- [Bouncy Castle](https://www.bouncycastle.org/) for keystore/provider compatibility used in signing conversion.

## License

This project is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
