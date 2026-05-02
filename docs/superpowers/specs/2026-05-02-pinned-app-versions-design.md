# Pinned App Versions in config.json

**Date:** 2026-05-02
**Status:** Draft (revised after review)

## Summary

Allow users to pin a specific APK version per app in `config.json`. When pinned, the workflow uses that version instead of auto-resolving the latest Morphe-supported version. If the pinned version can't be downloaded (all methods exhausted), fall back to auto-resolution.

## Motivation

Apps evolve, and not every latest version has the patches or features a user needs. A pinned version lets users lock to a known-good APK version without the workflow overwriting it on the next scheduled run.

## Config Schema

New optional field `pin_version` in each `patch_repos` entry:

```json
{
  "patch_repos": {
    "com.google.android.youtube": {
      "name": "youtube",
      "repo": "MorpheApp/morphe-patches",
      "branch": "dev",
      "pin_version": "20.45.36"
    },
    "com.google.android.apps.youtube.music": {
      "name": "ytmusic",
      "repo": "MorpheApp/morphe-patches",
      "branch": "dev"
    }
  }
}
```

- `pin_version` is optional. Absent or `null` → current behavior (auto-resolve latest).
- Value is a string matching typical APK version format (e.g. `20.45.36`, `2025.04.21`).
- If `pin_version` is set, the workflow must NOT overwrite that app's download URL in `config.json`.

## Workflow Changes

Seven touchpoints in `.github/workflows/morphe-build.yml` and one Node script:

### 1. `check-versions` — Pre-download step (~line 349)

Currently iterates `patch_repos` keys, calls `morphe-cli list-versions` for each, downloads the latest.

**Change:** Before calling `list-versions`, read `pin_version` from `patch_repos[PKG]` in config.json. If set, use the pinned version as the download target instead of calling `list-versions`. If unified-downloader fails for that version, fall back to `list-versions` → normal auto-resolution.

Note: This pre-download step supplies APKs to the build matrix via artifact upload. If a pinned APK is downloaded here but `targetver` in the build job also pins it, both agree on the version. If pre-download falls back, `targetver` will independently fall back too (see touchpoint 2).

### 2. `build` — `targetver` step (~line 656)

Currently runs jq against `patches-list.json` to find the latest mutually-compatible version.

**Change:** Before jq resolution, check `pin_version` from `patch_repos[$APP_ID]`. If set, validate it against `patches-list.json` — does any enabled patch target this version? If yes, output it directly as `TARGET_VERSION`, set `TARGET_VERSIONS` to that single version, and skip jq logic. If the pinned version is not in the compatible list, emit a warning and fall back to normal jq resolution.

### 3. `build` — APK cache key (~line 743)

Already uses `steps.targetver.outputs.version`. No change needed — pinned version from `targetver` flows through automatically. Cache key will be `apk-$APP_ID-$PINNED_VERSION` when pinned.

### 4. `build` — `getapk` download step (~line 746)

Already uses `TARGET_VERSION` from `targetver`. No structural change needed.

If download fails for the pinned version (all methods exhausted), call `morphe-cli list-versions` as emergency fallback, update `TARGET_VERSION`, retry download with that version.

### 5. `update-download-urls.js`

Called from `check-versions` (line ~399). Writes resolved download URLs into `config.json`.

**Change:** Before writing `config.download_urls[packageId]`, check if `config.patch_repos[packageId].pin_version` is set. If yes, skip the write and log a notice: "Skipping URL update for {packageId} — version is pinned to {pin_version}". No new CLI flag needed — read config.json directly.

### 6. `update-download-urls` job (~line 1626)

This job is architecturally a no-op for URL updates (it commits local changes on a fresh checkout where no script has run). However, for safety:

**Change:** If any `config.json` changes exist locally, verify they don't include URL changes for pinned apps before committing. Skip if unnecessary.

### 7. `update-state` job (~line 1850)

This is where `config.json` actually gets committed (alongside `state.json` and `patches.json`). Line ~1856: `git add state.json patches.json config.json`.

**Change:** Before `git add config.json`, strip any `download_urls` entries for apps that have `pin_version` set. Use jq to remove pinned app URLs from the `download_urls` object before committing. This prevents stale auto-resolution URLs from overwriting pinned entries during the state commit.

## Fallback Behavior

```
pinned version set?
  ├─ Yes → validate against patches-list.json
  │         ├─ Not compatible → warn, fall back to auto-resolution
  │         └─ Compatible → try all download methods for pinned version
  │                          ├─ Success → use it
  │                          └─ All fail → fall back to auto-resolution
  └─ No  → current behavior (auto-resolve latest)
```

Fallback is per-app. If YouTube is pinned but YT Music is not, only YouTube gets the pinned-version-first treatment.

## What Does NOT Change

- The version-change detection in `check-versions` (patch tag comparison) — unchanged. A pinned version doesn't affect whether a build triggers.
- Release naming — still `{app}-v{version}-{patchTag}.apk` (version comes from the actually-used APK).
- `state.json` — no new fields. The pinned version is config-only state.

## Error Cases

| Scenario | Behavior |
|----------|----------|
| `pin_version` set, compatible with patches, download succeeds | Use pinned version |
| `pin_version` set, compatible with patches, download fails | Fall back to auto-resolution |
| `pin_version` set, not compatible with any enabled patch | Warn, fall back to auto-resolution |
| `pin_version` set, auto-resolution also fails | Normal error (build fails) |
| `pin_version` missing/null | Current behavior (auto-resolve) |
| `check-versions` pre-downloads pinned version, `targetver` uses it | Cache hits, no double-download |
| `check-versions` pre-downloads fallback version, `targetver` falls back too | Cache may miss, but version agrees |
| `update-download-urls.js` runs for pinned app | Skipped (URL not written) |
| `update-state` commits config.json | Pinned app URLs stripped before commit |
| Multiple apps share same repo, some pinned some not | Each app handled independently |

## Validation

- `jq '.' config.json` passes (valid JSON with new optional field).
- Manual `workflow_dispatch` with a pinned version downloads and patches the correct APK.
- Scheduled run with pinned version does not overwrite the pinned version's URL in `config.json`.
- Removing `pin_version` from config restores auto-resolution behavior.
