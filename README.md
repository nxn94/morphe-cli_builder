# AutoMorpheBuilder

> **Warning:** This project is vibecoded and a work in progress. Expect bugs, breaking changes, and incomplete documentation.

Automated GitHub Actions pipeline for building patched Android APKs with [Morphe patches](https://github.com/MorpheApp/morphe-patches), [morphe-cli](https://github.com/MorpheApp/morphe-cli), and [APKEditor](https://github.com/REAndroid/APKEditor).

## Supported Apps

- `youtube` → `com.google.android.youtube`
- `ytmusic` → `com.google.android.apps.youtube.music`
- `reddit` → `com.reddit.frontpage`

## What The Workflow Does

1. Checks latest Morphe patch/CLI release tags.
2. Skips build if versions are unchanged.
3. **Automatically resolves latest supported app versions** from morphe-cli and downloads APKs from APKMirror.
4. Extracts/selects a patchable APK (prefers configured architecture, rejects dex-less split configs).
5. Enforces signing (signed or fail).
6. Runs `morphe-cli` and applies your patch config from `patches.json`.
7. Publishes artifacts and creates a GitHub Release.
8. Updates `state.json` and keeps `patches.json` synced with upstream patch list.

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

## Configuration Files

### `config.json` — build settings

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
  },
  "download_urls": {
    "com.google.android.youtube": {
      "20.44.38": "https://www.apkmirror.com/wp-content/themes/APKMirror/download.php?id=..."
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `preferred_arch` | `arm64-v8a` | CPU architecture to prefer (`arm64-v8a`, `armeabi-v7a`, etc.) |
| `apkmirror_paths` | see above | Maps package IDs to APKMirror app paths |
| `branches.morphe_patches` | `main` | Morphe patches branch (`main` or `dev`) |
| `branches.morphe_cli` | `main` | morphe-cli branch (`main` or `dev`) |
| `download_urls` | — | Version-specific direct download URLs (auto-updated after each successful build) |

### `patches.json` — patch toggles

```json
{
  "com.google.android.youtube": {
    "Hide ads": true,
    "SponsorBlock": true,
    "Return YouTube Dislike": false
  }
}
```

- `true` = enable patch, `false` = disable patch
- Workflow syncs missing upstream patch keys at runtime; your edits are preserved

## Download Flow

APKs are resolved using a multi-source fallback chain:

1. **URL cache** — checks `~/.cache/auto-morphe-builder/urls/` for a previously resolved direct download URL
2. **config.json URLs** — version-specific URLs stored by the `update-download-urls` job
3. **Parallel resolution** — tries apkeep (APKPure), APKMirror API, and APKMirror scraper simultaneously; first valid URL wins
4. **APKMirror scraper** — 3-page navigation (release → variant → download) using curl; falls back to Playwright (Chromium) if Cloudflare blocks curl

The APKMirror scraper navigates all 3 pages within the same browser session so session cookies are preserved for the final download. Resolved URLs are cached for future runs.

## APK Selection Logic

- Resolves Morphe-supported versions and downloads only the latest supported.
- Handles `.apk`, `.xapk`, `.apkm`.
- For split packages, tries APKEditor merge first, then falls back to dex-bearing APK extraction.
- Prefers `nodpi` → `120-640dpi` → `240-480dpi` for DPI.
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

- `patches_branch`, `patches_version`
- `cli_branch`, `cli_version`
- `last_build`, `status`
- `build_history` (most recent entries: run id, run number, commit, timestamp)

## Artifacts And Releases

- Workflow artifact upload includes versioned patched APKs named `<app>-<patches-version>-v<base-version>.apk`.
- GitHub Release is created with tag `vYYYY.MM.DD` containing all APKs.

## Setup

Full setup steps are in [`SETUP.md`](SETUP.md).

## Troubleshooting

### APK download fails

The APKMirror scraper uses Playwright (Chromium) as a fallback when curl is blocked by Cloudflare. Playwright browsers are cached between runs. If the cache is stale, the workflow reinstalls them automatically.

### Error: `Chosen APK has no classes.dex`

The selected file is not a patchable base APK (usually a split/config artifact). The workflow fails fast instead of patching invalid APKs.

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
- [Bouncy Castle](https://www.bouncycastle.org/) for keystore/provider compatibility used in signing conversion.

## License

This project is licensed under the Apache License 2.0. See [`LICENSE`](LICENSE).
