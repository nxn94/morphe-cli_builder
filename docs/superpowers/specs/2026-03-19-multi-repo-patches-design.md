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

### Branch-to-tag resolution

Both `check-versions` (morphe-build) and the `update-patches` workflow resolve a branch to a release tag using the same mechanism already present in the workflow: call the GitHub Releases API for `owner/repo`, filter releases by branch (using the `target_commitish` field), and select the most recent one. If no release is found for the configured branch, the job fails with an error. If the GitHub API is unavailable or rate-limited, the job also fails — there is no fallback to a stale version.

### `check-versions` job

- Reads `patch_repos` from `config.json` to determine active apps and their repos; fails immediately with a clear error if `patch_repos` is absent or if the `cli` key is absent
- Deduplicates to get unique `repo+branch` pairs; resolves one release tag per unique pair using branch-to-tag resolution above
- Outputs a JSON map `{ "owner/repo": "vX.Y.Z" }` and the list of active app IDs as workflow outputs
- Build triggers if any repo's resolved tag changed from `state.json`, CLI version changed, or manual dispatch
- An existing `state.json` with the old flat `patches_version`/`patches_branch` keys is treated as "version unknown" — triggering a build on first run after migration
- Tag resolution failure fails the job immediately (no partial output)

### `build` job (matrix)

- Matrix is driven by the active app list output from `check-versions` (replaces the hardcoded app list)
- Each matrix entry receives its assigned `repo` and `branch` as env vars
- `.mpp` files are named using the full `owner-repo` slug with `/` replaced by `-` (e.g. `MorpheApp-morphe-patches.mpp`, `wchill-rvx-morphed.mpp`) — avoids collisions when two owners have repos with the same name
- Each matrix entry independently downloads its assigned `.mpp` using `actions/cache` with key `morphe-patches-<owner-repo-slug>-<resolved_tag>`. No explicit coordination between parallel matrix entries is needed — whichever entry runs first warms the cache; subsequent entries sharing the same repo+tag get a cache hit. Cache miss falls back to downloading from GitHub Releases
- `list-versions` is called with the app's specific `.mpp` file
- `morphe-cli patch --patches=tools/<owner-repo-slug>.mpp`
- `patches-list.json` is fetched per repo at its resolved tag
- If `patches.json` has no entry for an app's repo+package (e.g. `update-patches` has not been run yet), the build proceeds with all patches enabled for that app and emits a `::warning::` — it does not fail

### `update-state` job

- Writes the new `state.json` `patches` map structure (see below), fully replacing the old flat fields
- Reads per-app patch toggles from `patches.json` using the repo-keyed structure

### `state.json` new structure

```json
{
  "patches": {
    "MorpheApp/morphe-patches": { "branch": "dev", "version": "v1.20.0-dev.3" }
  },
  "cli_branch": "dev",
  "cli_version": "v1.6.0-dev.5",
  "last_build": "...",
  "status": "success",
  "build_history": [ ... ]
}
```

The old flat `patches_branch` and `patches_version` top-level keys are removed after the first successful build post-migration.

## `patches-list.json` Schema

`patches-list.json` is fetched from `https://raw.githubusercontent.com/<owner>/<repo>/<tag>/patches-list.json`. The file has a `patches` array at the root (or the root itself is the array — both forms are handled). Each element is an object with:

```json
{
  "name": "Hide ads",
  "compatiblePackages": {
    "com.google.android.youtube": ["20.44.38", "20.45.00"]
  }
}
```

- `name` — the patch name (used as the key in `patches.json`)
- `compatiblePackages` (also accepted as `compatible_packages`) — object keyed by app package ID, value is an array of compatible version strings. A package ID present as a key means that patch applies to that app.

This schema is the existing upstream format already consumed by `morphe-build.yml` — no changes to the format.

## New Workflow: `update-patches.yml`

**Trigger:** `workflow_dispatch` only.

**Single job — `update-patches`:**

1. Checkout repo
2. Read `patch_repos` from `config.json`; fail immediately with a clear error if `patch_repos` is absent or empty. Also fail if the `cli` key is absent (required by `morphe-build`).
3. Deduplicate to unique `repo+branch` pairs
4. Resolve latest release tag for each unique repo using branch-to-tag resolution (ephemeral — tags are not written to `state.json` or any file)
5. Fetch `patches-list.json` from each repo at its resolved tag — if any fetch fails, the entire workflow fails immediately with no changes committed
6. Sync `patches.json`:
   - Add new patches (default `true`)
   - Remove patches no longer in upstream
   - Preserve existing `true`/`false` user values
   - Drop repos/apps absent from `config.json`'s `patch_repos`
   - Apps in `patch_repos` with no patches in their upstream `patches-list.json` get `{}`
7. If `patches.json` is unchanged, skip commit and exit successfully
8. Otherwise commit and push: `chore: sync patches from upstream repos`

**Out of scope for this workflow:** APK downloads, builds, `state.json` updates, `config.json` updates. Resolved release tags are ephemeral and must not be persisted.

**Intended usage:** Run `update-patches` → review/edit `patches.json` → run full build workflow.

## APK Download

No changes. Download logic reads `apkmirror_paths` and `download_urls` from `config.json` keyed by app ID — these are unaffected by the patch repo restructuring.

## Migration

**`config.json`** — one-time manual edit:
- Remove `branches` key
- Add `patch_repos` with explicit `{ repo, branch }` per app
- Add `cli` key with `{ repo, branch }` for `MorpheApp/morphe-cli`

**`patches.json`** — rewritten by the first run of `update-patches`. The old flat structure (app at top level) is not structurally compatible with the new repo-keyed structure, so the first run discards the old file and writes a fresh repo-keyed file with all patches defaulting to `true`. The operator must re-configure any `false` toggles after migration. Subsequent runs preserve user-configured values normally.

**`state.json`** — migrated automatically by the first successful build after the config change. The `check-versions` job treats a missing or flat `patches`/`patches_version` key as "version unknown", triggering a build. The `update-state` job writes the new structure, removing the old flat keys.
