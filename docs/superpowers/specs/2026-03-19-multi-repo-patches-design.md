# Multi-Repo Patch Support Design

**Date:** 2026-03-19
**Status:** Approved

## Overview

Add support for configuring multiple patch repositories in `config.json` with per-app repo+branch assignment. Update `patches.json` to a repo-keyed structure containing patches from all configured repos. Add a new `update-patches` workflow for syncing `patches.json` from upstream before running a full build.

## Requirements

- Each app can be assigned a different patch repo and branch in `config.json`
- Apps without an explicit repo assignment are skipped by the build (no fallback)
- `patches.json` groups patches by repo at the top level, with apps nested underneath
- A new manual-trigger `update-patches` workflow syncs `patches.json` from all configured repos
- APK download logic is unchanged
- All patch repos must be `morphe-cli`-compatible; one global CLI for all repos

## Config Changes

### `config.json`

Replace the `branches` key with two new keys:

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
    "com.google.android.youtube":                  { "repo": "MorpheApp/morphe-patches", "branch": "dev" },
    "com.google.android.apps.youtube.music":       { "repo": "MorpheApp/morphe-patches", "branch": "dev" },
    "com.reddit.frontpage":                        { "repo": "MorpheApp/morphe-patches", "branch": "dev" }
  },
  "cli": { "repo": "MorpheApp/morphe-cli", "branch": "dev" },
  "download_urls": { ... }
}
```

- `patch_repos` — maps each app package ID to `{ repo, branch }`. Absent apps are skipped entirely by the build.
- `cli` — replaces `branches.morphe_cli`. CLI is global (all patch repos use `morphe-cli`).
- `branches` key is removed.

### `patches.json`

Repo is the top-level key; apps are nested underneath:

```json
{
  "MorpheApp/morphe-patches": {
    "com.google.android.youtube": { "Hide ads": true, "SponsorBlock": true },
    "com.google.android.apps.youtube.music": { "Theme": true }
  },
  "wchill/rvx-morphed": {
    "com.reddit.frontpage": { "Hide ads": true }
  }
}
```

- New patches discovered upstream default to `true`
- Patches removed upstream are dropped
- User-configured `true`/`false` values are preserved across syncs
- Repos/apps no longer present in `config.json`'s `patch_repos` are removed from `patches.json` on next sync

## Build Workflow Changes (`morphe-build.yml`)

### `check-versions` job

- Reads `patch_repos` from `config.json` to determine active apps and their repos
- Deduplicates to get unique `repo+branch` pairs; resolves one release tag per unique pair
- Outputs a JSON map `{ "owner/repo": "vX.Y.Z" }` and the list of active app IDs
- Build triggers if any repo tag changed, CLI version changed, or manual dispatch
- `state.json` `patches` field changes from flat `patches_version`/`patches_branch` to a map:
  ```json
  {
    "patches": {
      "MorpheApp/morphe-patches": { "branch": "dev", "version": "v1.20.0-dev.3" }
    },
    "cli_branch": "dev",
    "cli_version": "v1.6.0-dev.5"
  }
  ```

### `build` job (matrix)

- Matrix is driven by the active app list output from `check-versions` (replaces the hardcoded app list)
- Each matrix entry receives its assigned `repo` and `branch` as env vars
- Downloads `patches-<repo-slug>.mpp` per unique repo; cache key is `repo + resolved_tag`
- Two apps sharing the same repo reuse the cached `.mpp` (no duplicate downloads)
- `list-versions` is called with the app's specific `.mpp` file
- `morphe-cli patch --patches=tools/<repo-slug>.mpp` — slug derived from the last path component of the repo (e.g. `morphe-patches`, `rvx-morphed`)
- `patches-list.json` fetched per repo at its resolved tag

### `update-state` job

- Updates `state.json` with the new `patches` map structure
- Reads per-app patch toggles from `patches.json` using the repo-keyed structure

## New Workflow: `update-patches.yml`

**Trigger:** `workflow_dispatch` only.

**Single job — `update-patches`:**

1. Checkout repo
2. Read `patch_repos` from `config.json`; deduplicate to unique `repo+branch` pairs
3. Resolve latest release tag for each unique repo
4. Fetch `patches-list.json` from each repo at its resolved tag
5. Sync `patches.json`:
   - Add new patches (default `true`)
   - Remove patches no longer in upstream
   - Preserve existing `true`/`false` user values
   - Drop repos/apps absent from `config.json`'s `patch_repos`
   - Apps in `patch_repos` with no patches in upstream get `{}`
6. Commit and push: `chore: sync patches from upstream repos`

**Out of scope for this workflow:** APK downloads, builds, `state.json` updates, `config.json` updates.

**Intended usage:** Run `update-patches` → review/edit `patches.json` → run full build workflow.

## APK Download

No changes. Download logic reads `apkmirror_paths` and `download_urls` from `config.json` keyed by app ID — these are unaffected by the patch repo restructuring.

## Migration

`config.json` requires a one-time manual migration:
- Remove `branches` key
- Add `patch_repos` with explicit repo+branch per app
- Add `cli` key

`patches.json` is rewritten by the first run of `update-patches` into the new repo-keyed structure. Existing user `true`/`false` values are preserved during the migration merge.
