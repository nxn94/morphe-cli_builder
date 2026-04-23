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

Each app gets its own GitHub Release per build. Releases are named `<app>-v<base-version>-<patches-version>`.

Example releases:
- `youtube-v20.44.38-v1.24.0-dev.8`
- `ytmusic-v8.44.54-v1.24.0-dev.8`
- `reddit-v2025.02.17-v1.24.0-dev.8`

For Obtainium, create one entry per app:

| App | Release Tag Filter | APK Filter |
|-----|-------------------|------------|
| YouTube | `^youtube-` | `^youtube-v.*\.apk$` |
| YouTube Music | `^ytmusic-` | `^ytmusic-v.*\.apk$` |
| Reddit | `^reddit-` | `^reddit-v.*\.apk$` |

> **Note:** Each release contains only the APK for that app. Use the release tag filter to subscribe to one app at a time, or use the APK filter to match within a release that contains multiple apps.

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
  "auto_update_urls": true,
  "apkmirror_paths": {
    "com.google.android.youtube": "google-inc/youtube",
    "com.google.android.apps.youtube.music": "google-inc/youtube-music",
    "com.reddit.frontpage": "redditinc/reddit"
  },
  "patch_repos": {
    "com.google.android.youtube": {
      "name": "youtube",
      "repo": "MorpheApp/morphe-patches",
      "branch": "dev"
    },
    "com.google.android.apps.youtube.music": {
      "name": "ytmusic",
      "repo": "MorpheApp/morphe-patches",
      "branch": "dev"
    },
    "com.reddit.frontpage": {
      "name": "reddit",
      "repo": "MorpheApp/morphe-patches",
      "branch": "dev"
    }
  },
  "cli": {
    "repo": "MorpheApp/morphe-cli",
    "branch": "dev"
  },
  "download_urls": {
    "com.google.android.youtube": {
      "latest_supported": "https://www.apkmirror.com/apk/google-inc/youtube/..."
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `preferred_arch` | `arm64-v8a` | CPU architecture to prefer (`arm64-v8a`, `armeabi-v7a`, etc.) |
| `auto_update_urls` | `true` | Auto-update download URLs after successful builds |
| `apkmirror_paths` | see above | Maps package IDs to APKMirror app paths |
| `patch_repos` | — | Per-app patch repo, branch, and display name |
| `cli` | — | morphe-cli repo and branch (`main` or `dev`) |
| `download_urls` | — | Version-specific direct download URLs (auto-updated after each successful build) |

### `patches.json` — patch toggles

```json
{
  "MorpheApp/morphe-patches": {
    "com.google.android.youtube": {
      "Hide ads": true,
      "SponsorBlock": true,
      "Return YouTube Dislike": false
    },
    "com.google.android.apps.youtube.music": {
      "Hide music video ads": true
    },
    "com.reddit.frontpage": {
      "Hide ads": true
    }
  }
}
```

- `true` = enable patch, `false` = disable patch
- Workflow syncs missing upstream patch keys at runtime; your edits are preserved
- Top-level key is the patch repo (e.g. `MorpheApp/morphe-patches`)

## Download Flow

APKs are resolved using a multi-source fallback chain:

1. **Pre-downloaded APKs** — checked first from `tools/` directory populated by `check-versions` job
2. **URL cache** — checks `~/.cache/auto-morphe-builder/urls/` for a previously resolved direct download URL
3. **config.json URLs** — version-specific URLs stored by the `update-download-urls` job
4. **Parallel resolution** — tries apkeep (APKPure), APKMirror API, and APKMirror scraper simultaneously; first valid URL wins
5. **APKMirror scraper** — 3-page navigation (release → variant → download) using curl; falls back to Playwright (Chromium) if Cloudflare blocks curl

The APKMirror scraper navigates all 3 pages within the same browser session so session cookies are preserved for the final download. Resolved URLs are cached for future runs.

## APK Selection Logic

- Resolves Morphe-supported versions and downloads only the latest supported.
- Handles `.apk`, `.xapk`, `.apkm`, `.apks`.
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

- `patches` — per-repo branch and version
- `cli_branch`, `cli_version`
- `last_build`, `status`
- `build_history` (most recent entries: run id, run number, commit, timestamp)

## Artifacts And Releases

- Per-app workflow artifacts: `<app>-v<base-version>-<patches-version>.apk`
- Per-app GitHub Releases: `<app>-v<base-version>-<patches-version>` containing only that app's APK

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
