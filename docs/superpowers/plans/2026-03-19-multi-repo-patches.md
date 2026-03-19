# Multi-Repo Patch Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-app patch repo+branch assignment to `config.json`, restructure `patches.json` to be repo-keyed, and add a `update-patches` workflow to sync patches before building.

**Architecture:** `config.json` gains `patch_repos` (per-app `{name, repo, branch}`) and `cli` (`{repo, branch}`) replacing the old `branches` key. `patches.json` becomes `{ "owner/repo": { "pkg": { "Patch": true } } }`. A new `update-patches.yml` workflow syncs `patches.json` from all configured repos. The build workflow gains a dynamic matrix driven by `patch_repos` and per-app `.mpp` files named by owner-repo slug.

**Tech Stack:** GitHub Actions YAML, bash/jq (inline workflow scripts), `gh` CLI, `morphe-cli` Java jar, Node.js/Jest (existing test suite)

**Spec:** `docs/superpowers/specs/2026-03-19-multi-repo-patches-design.md`

---

## Chunk 1: Config migration

### Task 1: Migrate `config.json`

**Files:**
- Modify: `config.json`

- [ ] **Step 1: Edit config.json — replace `branches` with `patch_repos` + `cli`**

  Replace the current `branches` block with the following structure. Add a `name` field to each `patch_repos` entry (used for APK output naming — must match the current `matrix.name` values: `youtube`, `ytmusic`, `reddit`).

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
      ...keep existing download_urls unchanged...
    }
  }
  ```

- [ ] **Step 2: Validate config.json**

  ```bash
  jq '.' config.json > /dev/null && echo "valid"
  jq -e '.patch_repos | type == "object"' config.json
  jq -e '.cli | has("repo") and has("branch")' config.json
  # Verify each entry has name, repo, branch
  jq -e '.patch_repos | to_entries[] | .value | has("name") and has("repo") and has("branch")' config.json
  ```

  Expected: all commands print `true` or `valid`.

- [ ] **Step 3: Commit**

  ```bash
  git add config.json
  git commit -m "feat: migrate config.json to per-app patch_repos structure"
  ```

---

## Chunk 2: update-patches workflow

### Task 2: Create `.github/workflows/update-patches.yml`

**Files:**
- Create: `.github/workflows/update-patches.yml`

This workflow reads `config.json`, resolves the latest tag per unique repo+branch pair, fetches each repo's `patches-list.json`, and syncs `patches.json` to the repo-keyed structure. Fails entirely if any fetch fails.

The `resolve_release_tag` function is duplicated from `morphe-build.yml` — this is intentional (avoid cross-workflow dependencies).

- [ ] **Step 1: Create the workflow file**

  ```yaml
  name: Update patches.json from upstream repos

  on:
    workflow_dispatch:

  permissions:
    contents: write

  jobs:
    update-patches:
      runs-on: ubuntu-latest
      env:
        GH_TOKEN: ${{ github.token }}
      steps:
        - name: Checkout
          uses: actions/checkout@v4

        - name: Sync patches.json
          run: |
            set -euo pipefail

            # Validate required config keys
            if ! jq -e '.patch_repos | type == "object"' config.json >/dev/null 2>&1; then
              echo "::error::config.json is missing 'patch_repos'. Run the config migration first."
              exit 1
            fi
            if ! jq -e '.cli | has("repo") and has("branch")' config.json >/dev/null 2>&1; then
              echo "::error::config.json is missing 'cli.repo' or 'cli.branch'."
              exit 1
            fi

            # Resolve branch → tag. Same logic as morphe-build.yml.
            resolve_release_tag() {
              local repo="$1"
              local branch="$2"
              local stable_tag selected_tag
              stable_tag="$(gh release view --repo "$repo" --json tagName -q .tagName || true)"
              if [ "$branch" = "main" ]; then
                selected_tag="$stable_tag"
              else
                selected_tag="$(
                  gh api "repos/${repo}/releases?per_page=100" --jq '
                    [ .[]
                      | select(
                          (.draft != true)
                          and (
                            ((.target_commitish // "" | ascii_downcase) == "dev")
                            or (.prerelease == true)
                            or ((.tag_name // "" | ascii_downcase | test("(^|[-_.])(dev|beta|alpha|rc)")))
                          )
                        )
                    ][0].tag_name // empty
                  ' || true
                )"
                if [ -z "$selected_tag" ]; then
                  echo "::warning::No dev-style release found for ${repo}; falling back to latest."
                  selected_tag="$stable_tag"
                fi
              fi
              if [ -z "$selected_tag" ]; then
                echo "::error::Could not resolve release tag for ${repo} (branch=${branch})."
                exit 1
              fi
              echo "$selected_tag"
            }

            # Build list of unique repo+branch pairs from config.json
            REPO_PAIRS="$(jq -r '
              .patch_repos
              | to_entries
              | map(.value | "\(.repo)|\(.branch)")
              | unique[]
            ' config.json)"

            # Resolve tag for each unique repo+branch; store in temp files
            mkdir -p "$RUNNER_TEMP/patch-tags"
            while IFS='|' read -r repo branch; do
              echo "::notice::Resolving tag for ${repo} (branch=${branch})..."
              tag="$(resolve_release_tag "$repo" "$branch")"
              echo "::notice::  -> ${tag}"
              # Store tag in a file named by slug (/ replaced by -)
              slug="${repo//\//-}"
              echo "$tag" > "$RUNNER_TEMP/patch-tags/${slug}.tag"
            done <<< "$REPO_PAIRS"

            # Fetch patches-list.json for each unique repo at its resolved tag.
            # Fail immediately if any fetch fails — no partial commits.
            mkdir -p "$RUNNER_TEMP/patches-lists"
            while IFS='|' read -r repo branch; do
              slug="${repo//\//-}"
              tag="$(cat "$RUNNER_TEMP/patch-tags/${slug}.tag")"
              url="https://raw.githubusercontent.com/${repo}/${tag}/patches-list.json"
              echo "::notice::Fetching patches-list.json from ${repo}@${tag}..."
              curl -fsSL "$url" -o "$RUNNER_TEMP/patches-lists/${slug}.json"
            done <<< "$REPO_PAIRS"

            # Build the new repo-keyed patches.json.
            # For each repo, for each app assigned to that repo in config.json:
            #   - collect patches from patches-list.json that are compatible with that app
            #   - default each to true
            #   - preserve any existing true/false from current patches.json if it's already repo-keyed
            #
            # If current patches.json is NOT repo-keyed (old flat structure), discard it entirely
            # and default everything to true. Operator must re-configure false toggles after migration.

            EXISTING_IS_REPO_KEYED=false
            if [ -s patches.json ] && jq -e 'type=="object"' patches.json >/dev/null 2>&1; then
              # Repo-keyed: top-level keys look like "owner/repo" (contain /)
              if jq -e 'keys | map(select(contains("/"))) | length > 0' patches.json >/dev/null 2>&1; then
                EXISTING_IS_REPO_KEYED=true
              fi
            fi

            if [ "$EXISTING_IS_REPO_KEYED" = "true" ]; then
              echo "::notice::Existing patches.json is repo-keyed; preserving user toggles."
            else
              echo "::warning::Existing patches.json is flat or empty; resetting all toggles to true (migration run)."
            fi

            # jq compat_pkg_names helper (same as morphe-build.yml)
            COMPAT_FN='
              def compat_pkg_names($patch):
                if ($patch.compatiblePackages? | type) == "object" then
                  ($patch.compatiblePackages | keys)
                elif ($patch.compatible_packages? | type) == "object" then
                  ($patch.compatible_packages | keys)
                elif ($patch.compatiblePackages? | type) == "array" then
                  ($patch.compatiblePackages | map(.name // .packageName // empty))
                elif ($patch.compatible_packages? | type) == "array" then
                  ($patch.compatible_packages | map(.name // .packageName // empty))
                else
                  []
                end;
            '

            # Build the new patches.json
            # Strategy: start from existing (if repo-keyed) as base, then for each repo
            # rebuild its section from upstream patches-list.json + preserved toggles.
            if [ "$EXISTING_IS_REPO_KEYED" = "true" ]; then
              cp patches.json "$RUNNER_TEMP/patches_base.json"
            else
              echo '{}' > "$RUNNER_TEMP/patches_base.json"
            fi

            # Process each repo
            while IFS='|' read -r repo branch; do
              slug="${repo//\//-}"
              PATCHES_LIST="$RUNNER_TEMP/patches-lists/${slug}.json"

              # Get all apps assigned to this repo
              APPS_FOR_REPO="$(jq -c --arg r "$repo" '
                [.patch_repos | to_entries[]
                  | select(.value.repo == $r)
                  | .key]
              ' config.json)"

              # Build defaults: for each app, collect compatible patch names, default true
              jq --argjson apps "$APPS_FOR_REPO" "$COMPAT_FN"'
                . as $src
                | reduce $apps[] as $pkg ({};
                    .[$pkg] = (
                      reduce (
                        (($src.patches // $src)[])
                        | select((compat_pkg_names(.) | index($pkg)) != null)
                        | .name
                      ) as $name
                      ({};
                        .[$name] = true
                      )
                    )
                  )
              ' "$PATCHES_LIST" > "$RUNNER_TEMP/defaults_${slug}.json"

              # Merge defaults with existing user toggles for this repo.
              # Key rule: only upstream patch names survive (stale keys are dropped).
              # For each patch name present in upstream, use the existing user toggle if set,
              # otherwise default to true.
              jq -n \
                --arg repo "$repo" \
                --slurpfile defaults "$RUNNER_TEMP/defaults_${slug}.json" \
                --slurpfile base "$RUNNER_TEMP/patches_base.json" '
                ($defaults[0] // {}) as $d
                | ($base[0] // {}) as $existing
                | ($existing[$repo] // {}) as $repo_existing
                | reduce ($d | keys[]) as $pkg ({};
                    .[$pkg] = (
                      reduce ($d[$pkg] | keys[]) as $pname ({};
                        .[$pname] = (($repo_existing[$pkg] // {})[$pname] // true)
                      )
                    )
                  )
              ' > "$RUNNER_TEMP/merged_${slug}.json"

              # Inject merged section back into base
              jq --arg repo "$repo" \
                 --slurpfile merged "$RUNNER_TEMP/merged_${slug}.json" \
                 '.[$repo] = $merged[0]' \
                 "$RUNNER_TEMP/patches_base.json" > "$RUNNER_TEMP/patches_next.json"
              mv "$RUNNER_TEMP/patches_next.json" "$RUNNER_TEMP/patches_base.json"
            done <<< "$REPO_PAIRS"

            # Drop repos not in config.json from the result
            ACTIVE_REPOS="$(jq -c '[.patch_repos | to_entries[] | .value.repo] | unique' config.json)"
            jq --argjson active "$ACTIVE_REPOS" 'with_entries(select(.key as $k | $active | index($k) != null))' \
              "$RUNNER_TEMP/patches_base.json" > patches.json.tmp
            mv patches.json.tmp patches.json

            echo "::notice::patches.json updated."
            jq 'keys' patches.json

        - name: Commit if changed
          run: |
            set -euo pipefail
            git config user.name "GitHub Actions"
            git config user.email "actions@github.com"
            git add patches.json
            if git diff --cached --quiet; then
              echo "::notice::patches.json unchanged; nothing to commit."
              exit 0
            fi
            git commit -m "chore: sync patches from upstream repos"
            BRANCH_NAME="${GITHUB_REF_NAME:-main}"
            git push origin "HEAD:${BRANCH_NAME}"
            echo "::notice::Committed and pushed updated patches.json."
  ```

- [ ] **Step 2: Validate with actionlint**

  ```bash
  docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/update-patches.yml
  ```

  Expected: no errors.

- [ ] **Step 3: Validate config.json is readable**

  ```bash
  jq '.' config.json
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add .github/workflows/update-patches.yml
  git commit -m "feat: add update-patches workflow for syncing patches.json from upstream repos"
  ```

---

## Chunk 3: `check-versions` job — config reading and matrix output

The `check-versions` job currently reads a single patch repo from `config.json` and outputs flat `patches-version`/`patches-branch`. It needs to:
1. Read per-app `patch_repos` + `cli` (fail if missing)
2. Resolve tags for each unique repo+branch pair
3. Output a `matrix-include` JSON array for the dynamic build matrix
4. Compare against `state.json`'s new `patches` map (fall back to old flat keys)
5. Update the "Resolve latest APK versions" step for per-app repos

### Task 3: Update `check-versions` job outputs and config reading

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (lines 15–125)

- [ ] **Step 1: Replace outputs declaration (lines 15-20)**

  Replace:
  ```yaml
      outputs:
        should-build: ${{ steps.version-check.outputs.should-build }}
        patches-version: ${{ steps.version-check.outputs.patches-version }}
        cli-version: ${{ steps.version-check.outputs.cli-version }}
        patches-branch: ${{ steps.version-check.outputs.patches-branch }}
        cli-branch: ${{ steps.version-check.outputs.cli-branch }}
  ```

  With:
  ```yaml
      outputs:
        should-build: ${{ steps.version-check.outputs.should-build }}
        matrix-include: ${{ steps.version-check.outputs.matrix-include }}
        repo-versions: ${{ steps.version-check.outputs.repo-versions }}
        cli-version: ${{ steps.version-check.outputs.cli-version }}
        cli-branch: ${{ steps.version-check.outputs.cli-branch }}
  ```

  - `matrix-include`: JSON array of `{name, appId, patchRepo, patchBranch, patchTag, patchSlug}` — one entry per active app
  - `repo-versions`: JSON map of `{ "owner/repo": "vX.Y.Z" }` — for state comparison and update-state

- [ ] **Step 2: Replace config reading + validation block (lines 32-48)**

  Replace:
  ```bash
            # Read channel selection from config.json.
            # Supported values: main, dev.
            PATCHES_BRANCH="main"
            CLI_BRANCH="main"
            if [ -s config.json ] && jq -e 'type=="object"' config.json >/dev/null 2>&1; then
              PATCHES_BRANCH="$(jq -r '(.branches?.morphe_patches // "main") | ascii_downcase' config.json)"
              CLI_BRANCH="$(jq -r '(.branches?.morphe_cli // "main") | ascii_downcase' config.json)"
            fi

            if [ "$PATCHES_BRANCH" != "main" ] && [ "$PATCHES_BRANCH" != "dev" ]; then
              echo "::warning::Invalid morphe_patches branch '$PATCHES_BRANCH' in config.json. Falling back to 'main'."
              PATCHES_BRANCH="main"
            fi
            if [ "$CLI_BRANCH" != "main" ] && [ "$CLI_BRANCH" != "dev" ]; then
              echo "::warning::Invalid morphe_cli branch '$CLI_BRANCH' in config.json. Falling back to 'main'."
              CLI_BRANCH="main"
            fi
  ```

  With:
  ```bash
            # Validate required config keys.
            if ! jq -e '.patch_repos | type == "object" and length > 0' config.json >/dev/null 2>&1; then
              echo "::error::config.json is missing 'patch_repos' or it is empty. Add per-app repo assignments."
              exit 1
            fi
            if ! jq -e '.cli | has("repo") and has("branch")' config.json >/dev/null 2>&1; then
              echo "::error::config.json is missing 'cli.repo' or 'cli.branch'."
              exit 1
            fi

            CLI_REPO="$(jq -r '.cli.repo' config.json)"
            CLI_BRANCH="$(jq -r '.cli.branch | ascii_downcase' config.json)"
            if [ "$CLI_BRANCH" != "main" ] && [ "$CLI_BRANCH" != "dev" ]; then
              echo "::warning::Invalid cli.branch '$CLI_BRANCH'. Falling back to 'main'."
              CLI_BRANCH="main"
            fi

            # Build list of unique patch repo+branch pairs
            REPO_PAIRS="$(jq -r '
              .patch_repos
              | to_entries
              | map(.value | "\(.repo)|\(.branch | ascii_downcase)")
              | unique[]
            ' config.json)"
  ```

- [ ] **Step 3: Replace single `resolve_release_tag` calls (lines 87-93) with per-repo loop**

  Replace (lines 87-93):
  ```bash
            PATCHES_TAG="$(resolve_release_tag "MorpheApp/morphe-patches" "$PATCHES_BRANCH")"
            CLI_TAG="$(resolve_release_tag "MorpheApp/morphe-cli" "$CLI_BRANCH")"

            echo "patches-version=$PATCHES_TAG" >> "$GITHUB_OUTPUT"
            echo "cli-version=$CLI_TAG" >> "$GITHUB_OUTPUT"
            echo "patches-branch=$PATCHES_BRANCH" >> "$GITHUB_OUTPUT"
            echo "cli-branch=$CLI_BRANCH" >> "$GITHUB_OUTPUT"
  ```

  With:
  ```bash
            # Resolve tag for each unique patch repo+branch pair
            declare -A REPO_TAGS
            while IFS='|' read -r repo branch; do
              echo "::notice::Resolving tag for ${repo} (branch=${branch})..."
              tag="$(resolve_release_tag "$repo" "$branch")"
              echo "::notice::  ${repo} -> ${tag}"
              REPO_TAGS["$repo"]="$tag"
            done <<< "$REPO_PAIRS"

            # Resolve CLI tag
            CLI_TAG="$(resolve_release_tag "$CLI_REPO" "$CLI_BRANCH")"
            echo "::notice::CLI (${CLI_REPO}) -> ${CLI_TAG}"

            # Build matrix-include JSON array
            MATRIX_INCLUDE="$(jq -c '
              .patch_repos
              | to_entries
              | map({
                  name: .value.name,
                  appId: .key,
                  patchRepo: .value.repo,
                  patchBranch: (.value.branch | ascii_downcase),
                  patchSlug: (.value.repo | gsub("/"; "-"))
                })
            ' config.json)"

            # Inject resolved tags into matrix entries
            MATRIX_WITH_TAGS="$(
              echo "$MATRIX_INCLUDE" | jq -c \
                --argjson tags "$(
                  for repo in "${!REPO_TAGS[@]}"; do
                    echo "{\"repo\":\"$repo\",\"tag\":\"${REPO_TAGS[$repo]}\"}"
                  done | jq -sc 'map({(.repo): .tag}) | add // {}'
                )" '
                map(. + {patchTag: ($tags[.patchRepo] // "")})
              '
            )"

            # Guard: if matrix is empty (no apps configured), skip build
            if [ "$(echo "$MATRIX_WITH_TAGS" | jq 'length')" = "0" ]; then
              echo "::warning::No apps configured in patch_repos; skipping build."
              echo "should-build=false" >> "$GITHUB_OUTPUT"
              echo "matrix-include=[]" >> "$GITHUB_OUTPUT"
              echo "repo-versions={}" >> "$GITHUB_OUTPUT"
              echo "cli-version=$CLI_TAG" >> "$GITHUB_OUTPUT"
              echo "cli-branch=$CLI_BRANCH" >> "$GITHUB_OUTPUT"
              exit 0
            fi

            # Build repo-versions map (for state comparison and update-state)
            REPO_VERSIONS="$(
              for repo in "${!REPO_TAGS[@]}"; do
                echo "{\"repo\":\"$repo\",\"tag\":\"${REPO_TAGS[$repo]}\"}"
              done | jq -sc 'map({(.repo): .tag}) | add // {}'
            )"

            echo "matrix-include=$MATRIX_WITH_TAGS" >> "$GITHUB_OUTPUT"
            echo "repo-versions=$REPO_VERSIONS" >> "$GITHUB_OUTPUT"
            echo "cli-version=$CLI_TAG" >> "$GITHUB_OUTPUT"
            echo "cli-branch=$CLI_BRANCH" >> "$GITHUB_OUTPUT"
  ```

- [ ] **Step 4: Replace state comparison block (lines 95-124)**

  Replace (lines 95-124):
  ```bash
            # Load previous state
            if [ -s state.json ] && jq -e 'type=="object"' state.json >/dev/null 2>&1; then
              PREV_PATCHES=$(jq -r '.patches_version // "none"' state.json)
              PREV_CLI=$(jq -r '.cli_version // "none"' state.json)
              PREV_PATCHES_BRANCH=$(jq -r '.patches_branch // "main"' state.json)
              PREV_CLI_BRANCH=$(jq -r '.cli_branch // "main"' state.json)
            else
              if [ -f state.json ]; then
                echo "::warning::state.json is missing or invalid JSON; using default previous state."
              fi
              PREV_PATCHES="none"
              PREV_CLI="none"
              PREV_PATCHES_BRANCH="main"
              PREV_CLI_BRANCH="main"
            fi

            # Check if versions/channels changed
            if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
              echo "should-build=true" >> "$GITHUB_OUTPUT"
              echo "::notice::Manual run detected; forcing build."
            elif [ "$PATCHES_TAG" != "$PREV_PATCHES" ] || \
                 [ "$CLI_TAG" != "$PREV_CLI" ] || \
                 [ "$PATCHES_BRANCH" != "$PREV_PATCHES_BRANCH" ] || \
                 [ "$CLI_BRANCH" != "$PREV_CLI_BRANCH" ]; then
              echo "should-build=true" >> "$GITHUB_OUTPUT"
              echo "::notice::Version/channel changes detected. Patches: $PREV_PATCHES_BRANCH/$PREV_PATCHES -> $PATCHES_BRANCH/$PATCHES_TAG, CLI: $PREV_CLI_BRANCH/$PREV_CLI -> $CLI_BRANCH/$CLI_TAG"
            else
              echo "should-build=false" >> "$GITHUB_OUTPUT"
              echo "::notice::No version/channel changes detected. Skipping build."
            fi
  ```

  With:
  ```bash
            # Load previous state — read new patches map; fall back to old flat keys for migration.
            PREV_REPO_VERSIONS="{}"
            PREV_CLI_VERSION="none"
            PREV_CLI_BRANCH_STATE="main"
            if [ -s state.json ] && jq -e 'type=="object"' state.json >/dev/null 2>&1; then
              PREV_CLI_VERSION="$(jq -r '.cli_version // "none"' state.json)"
              PREV_CLI_BRANCH_STATE="$(jq -r '.cli_branch // "main"' state.json)"
              if jq -e '.patches | type == "object"' state.json >/dev/null 2>&1; then
                # New repo-keyed structure
                PREV_REPO_VERSIONS="$(jq -c '.patches | map_values(.version)' state.json)"
              else
                # Old flat structure (pre-migration): treat as unknown versions
                echo "::notice::state.json uses old flat structure; treating patch versions as unknown (will trigger build)."
                PREV_REPO_VERSIONS="{}"
              fi
            else
              if [ -f state.json ]; then
                echo "::warning::state.json is missing or invalid JSON; using defaults."
              fi
            fi

            # Check if any repo version changed
            VERSION_CHANGED=false
            for repo in "${!REPO_TAGS[@]}"; do
              CURRENT_TAG="${REPO_TAGS[$repo]}"
              PREV_TAG="$(echo "$PREV_REPO_VERSIONS" | jq -r --arg r "$repo" '.[$r] // "none"')"
              if [ "$CURRENT_TAG" != "$PREV_TAG" ]; then
                echo "::notice::Patch version changed: ${repo}: ${PREV_TAG} -> ${CURRENT_TAG}"
                VERSION_CHANGED=true
              fi
            done

            if [ "$CLI_TAG" != "$PREV_CLI_VERSION" ] || [ "$CLI_BRANCH" != "$PREV_CLI_BRANCH_STATE" ]; then
              echo "::notice::CLI version changed: ${PREV_CLI_BRANCH_STATE}/${PREV_CLI_VERSION} -> ${CLI_BRANCH}/${CLI_TAG}"
              VERSION_CHANGED=true
            fi

            # Check if versions/channels changed
            if [ "${GITHUB_EVENT_NAME:-}" = "workflow_dispatch" ]; then
              echo "should-build=true" >> "$GITHUB_OUTPUT"
              echo "::notice::Manual run detected; forcing build."
            elif [ "$VERSION_CHANGED" = "true" ]; then
              echo "should-build=true" >> "$GITHUB_OUTPUT"
            else
              echo "should-build=false" >> "$GITHUB_OUTPUT"
              echo "::notice::No version/channel changes detected. Skipping build."
            fi
  ```

- [ ] **Step 5: Update "Resolve latest APK versions from APKMirror" step — config reading and .mpp download**

  This step (around line 183) downloads patches.mpp to call `list-versions`. Replace the download-and-rename block with per-repo downloads.

  Replace the block starting with `PATCHES_VERSION=...` and ending just before the `Cache morphe-cli` step. Here is the new version of the `Resolve latest APK versions from APKMirror` step run block:

  ```bash
            set -euo pipefail

            CLI_TAG="${{ steps.version-check.outputs.cli-version }}"
            CLI_REPO="$(jq -r '.cli.repo' config.json)"
            REPO_VERSIONS='${{ steps.version-check.outputs.repo-versions }}'

            mkdir -p tools

            echo "::notice::Downloading morphe-cli ${CLI_TAG}..."
            gh release download "$CLI_TAG" --repo "$CLI_REPO" --pattern "*.jar" --clobber || true
            for f in *.jar; do
              [ -f "$f" ] && mv "$f" tools/morphe-cli.jar && echo "::notice::Moved $f to tools/morphe-cli.jar"
            done

            # Download .mpp for each unique patch repo (slug-named)
            REPO_PAIRS="$(jq -r '
              .patch_repos
              | to_entries
              | map(.value | "\(.repo)|\(.branch | ascii_downcase)")
              | unique[]
            ' config.json)"

            while IFS='|' read -r repo branch; do
              slug="${repo//\//-}"
              tag="$(echo "$REPO_VERSIONS" | jq -r --arg r "$repo" '.[$r] // empty')"
              if [ -z "$tag" ]; then
                echo "::error::No resolved tag for repo ${repo}. Cannot download .mpp."
                exit 1
              fi
              mpp_dest="tools/${slug}.mpp"
              if [ ! -f "$mpp_dest" ]; then
                echo "::notice::Downloading patches .mpp from ${repo}@${tag}..."
                gh release download "$tag" --repo "$repo" --pattern "patches-*.mpp" --dir tools >/dev/null
                # Rename the downloaded .mpp to slug-named file
                for f in tools/patches-*.mpp; do
                  [ -f "$f" ] && mv "$f" "$mpp_dest" && echo "::notice::Saved as ${mpp_dest}"
                  break
                done
              else
                echo "::notice::Using existing ${mpp_dest}"
              fi
            done <<< "$REPO_PAIRS"

            if [ ! -f tools/morphe-cli.jar ]; then
              echo "::warning::morphe-cli.jar not found; skipping APK version resolution."
              exit 0
            fi
  ```

- [ ] **Step 6: Update the per-app `list-versions` loop to use per-app .mpp**

  The `for PKG in com.google.android...` loop (around line 264) currently calls `list-versions` with the global `tools/patches.mpp`. Replace the hardcoded package list with config-driven list, and pass the correct .mpp per app.

  Replace (around line 264-301):
  ```bash
            for PKG in com.google.android.youtube com.google.android.apps.youtube.music com.reddit.frontpage; do
              (
                # Get version from morphe-cli list-versions
                echo "Getting supported version for $PKG..."
                VERSIONS_OUTPUT=$(java -jar tools/morphe-cli.jar list-versions "$PKG" 2>/dev/null || echo "")
  ```

  With (sequential loop — no `&`/parallel, to avoid race on tools/patches.mpp):
  ```bash
            while IFS= read -r PKG; do
              PATCH_REPO="$(jq -r --arg pkg "$PKG" '.patch_repos[$pkg].repo // empty' config.json)"
              PATCH_SLUG="${PATCH_REPO//\//-}"
              MPP_FILE="tools/${PATCH_SLUG}.mpp"

              if [ -z "$PATCH_REPO" ] || [ ! -f "$MPP_FILE" ]; then
                echo "::warning::No .mpp available for $PKG (repo=${PATCH_REPO:-unset}); skipping version resolution."
                continue
              fi

              # morphe-cli list-versions reads tools/patches.mpp by default; swap in the right .mpp
              cp "$MPP_FILE" tools/patches.mpp
              echo "Getting supported version for $PKG..."
              VERSIONS_OUTPUT=$(java -jar tools/morphe-cli.jar list-versions "$PKG" 2>/dev/null || echo "")
  ```

  Close the loop with `done` (instead of the final `done` at end of the `for` loop block, which currently has `&`/wait pattern). Remove the `&` and final `wait` from this block.

  The rest of the loop body (version extraction, download, URL save) stays the same.

- [ ] **Step 7: Update the `Cache morphe-cli and patches` step (around line 231)**

  The current cache step caches `tools/patches.mpp`. With per-repo .mpps, we cache all `tools/*.mpp` files. Replace:
  ```yaml
        - name: Cache morphe-cli and patches
          if: steps.version-check.outputs.should-build == 'true'
          uses: actions/cache@v4
          with:
            path: |
              tools/morphe-cli.jar
              tools/patches.mpp
            key: morphe-tools-${{ steps.version-check.outputs.patches-version }}-${{ steps.version-check.outputs.cli-version }}
            restore-keys: |
              morphe-tools-${{ steps.version-check.outputs.patches-version }}-
              morphe-tools-
  ```

  With:
  ```yaml
        - name: Cache morphe-cli and patches
          if: steps.version-check.outputs.should-build == 'true'
          uses: actions/cache@v4
          with:
            path: |
              tools/morphe-cli.jar
              tools/*.mpp
            key: morphe-tools-cli-${{ steps.version-check.outputs.cli-version }}-repos-${{ hashFiles('config.json') }}
            restore-keys: |
              morphe-tools-cli-${{ steps.version-check.outputs.cli-version }}-
              morphe-tools-
  ```

- [ ] **Step 8: Validate with actionlint**

  ```bash
  docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/morphe-build.yml
  ```

  Expected: no errors.

- [ ] **Step 9: Commit**

  ```bash
  git add .github/workflows/morphe-build.yml
  git commit -m "feat: update check-versions job for per-app patch repo config"
  ```

---

## Chunk 4: `build` job — dynamic matrix and per-app .mpp

### Task 4: Update `build` job

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (build job, lines ~319–1464)

- [ ] **Step 1: Replace static matrix with dynamic fromJSON (lines 324-333)**

  Replace:
  ```yaml
      strategy:
        fail-fast: false
        matrix:
          include:
            - name: youtube
              appId: com.google.android.youtube
            - name: ytmusic
              appId: com.google.android.apps.youtube.music
            - name: reddit
              appId: com.reddit.frontpage
  ```

  With:
  ```yaml
      strategy:
        fail-fast: false
        matrix:
          include: ${{ fromJSON(needs.check-versions.outputs.matrix-include) }}
  ```

- [ ] **Step 2: Replace env vars block (lines 335-344)**

  Replace:
  ```yaml
      env:
        GH_TOKEN: ${{ github.token }}
        TOOLS_DIR: tools
        APKS_DIR: apps
        OUT_DIR: out
        PATCHES_VERSION: ${{ needs.check-versions.outputs.patches-version }}
        CLI_VERSION: ${{ needs.check-versions.outputs.cli-version }}
        PATCHES_BRANCH: ${{ needs.check-versions.outputs.patches-branch }}
        CLI_BRANCH: ${{ needs.check-versions.outputs.cli-branch }}
  ```

  With:
  ```yaml
      env:
        GH_TOKEN: ${{ github.token }}
        TOOLS_DIR: tools
        APKS_DIR: apps
        OUT_DIR: out
        PATCH_REPO: ${{ matrix.patchRepo }}
        PATCH_BRANCH: ${{ matrix.patchBranch }}
        PATCH_TAG: ${{ matrix.patchTag }}
        PATCH_SLUG: ${{ matrix.patchSlug }}
        CLI_VERSION: ${{ needs.check-versions.outputs.cli-version }}
        CLI_BRANCH: ${{ needs.check-versions.outputs.cli-branch }}
  ```

- [ ] **Step 3: Update `Cache morphe-cli and patches` step (around line 472-481)**

  Replace:
  ```yaml
        - name: Cache morphe-cli and patches
          uses: actions/cache@v4
          with:
            path: |
              ${{ env.TOOLS_DIR }}/morphe-cli.jar
              ${{ env.TOOLS_DIR }}/patches.mpp
            key: morphe-tools-${{ needs.check-versions.outputs.patches-version }}-${{ needs.check-versions.outputs.cli-version }}
            restore-keys: |
              morphe-tools-${{ needs.check-versions.outputs.patches-version }}-
              morphe-tools-
  ```

  With:
  ```yaml
        - name: Cache morphe-cli and patches
          uses: actions/cache@v4
          with:
            path: |
              ${{ env.TOOLS_DIR }}/morphe-cli.jar
              ${{ env.TOOLS_DIR }}/${{ matrix.patchSlug }}.mpp
            key: morphe-patches-${{ matrix.patchSlug }}-${{ matrix.patchTag }}-cli-${{ needs.check-versions.outputs.cli-version }}
            restore-keys: |
              morphe-patches-${{ matrix.patchSlug }}-${{ matrix.patchTag }}-
              morphe-patches-${{ matrix.patchSlug }}-
  ```

- [ ] **Step 4: Update "Get latest Morphe patches + CLI + APKEditor" step (lines ~483–547)**

  In the run block, replace the patches download section:

  Replace:
  ```bash
            # Only download patches if not already cached
            if [ ! -f "$TOOLS_DIR/patches.mpp" ]; then
              echo "patches_tag=$PATCHES_TAG" >> "$GITHUB_OUTPUT"
              gh release download "$PATCHES_TAG" \
                --repo MorpheApp/morphe-patches \
                --pattern 'patches-*.mpp' \
                --dir "$TOOLS_DIR" >/dev/null
            else
              echo "patches_tag=$PATCHES_TAG" >> "$GITHUB_OUTPUT"
              echo "::notice::Using cached patches.mpp"
            fi

            # Always fetch patches-list.json (small file, always needed)
            curl -fsSL "https://raw.githubusercontent.com/MorpheApp/morphe-patches/${PATCHES_TAG}/patches-list.json" \
              -o "$TOOLS_DIR/patches-list.json"
  ```

  With:
  ```bash
            # Validate required env vars
            if [ -z "${PATCH_REPO:-}" ] || [ -z "${PATCH_TAG:-}" ] || [ -z "${PATCH_SLUG:-}" ]; then
              echo "::error::PATCH_REPO/PATCH_TAG/PATCH_SLUG not set. Check check-versions matrix output."
              exit 1
            fi

            MPP_DEST="$TOOLS_DIR/${PATCH_SLUG}.mpp"

            # Download .mpp if not cached
            if [ ! -f "$MPP_DEST" ]; then
              echo "::notice::Downloading patches from ${PATCH_REPO}@${PATCH_TAG}..."
              gh release download "$PATCH_TAG" \
                --repo "$PATCH_REPO" \
                --pattern 'patches-*.mpp' \
                --dir "$TOOLS_DIR" >/dev/null
              # Rename to slug-named file
              for f in "$TOOLS_DIR"/patches-*.mpp; do
                [ -f "$f" ] && mv "$f" "$MPP_DEST" && echo "::notice::Saved as ${MPP_DEST}"
                break
              done
            else
              echo "::notice::Using cached ${MPP_DEST}"
            fi

            if [ ! -f "$MPP_DEST" ]; then
              echo "::error::Failed to obtain ${MPP_DEST} from ${PATCH_REPO}@${PATCH_TAG}."
              exit 1
            fi
            echo "patches_tag=${PATCH_TAG}" >> "$GITHUB_OUTPUT"

            # Always fetch patches-list.json (small file, always needed)
            curl -fsSL "https://raw.githubusercontent.com/${PATCH_REPO}/${PATCH_TAG}/patches-list.json" \
              -o "$TOOLS_DIR/patches-list.json"
  ```

- [ ] **Step 5: Remove "Sync patches.json with latest patches (preserve edits)" step (lines ~549-614)**

  Delete this entire step from the `build` job. The `update-patches` workflow now owns `patches.json` sync. The build job only reads `patches.json`.

- [ ] **Step 6: Update "Resolve supported version" step — patches.json read (line ~621)**

  Update the `DISABLED_PATCHES_JSON` line to read from repo-keyed patches.json:

  Replace:
  ```bash
            DISABLED_PATCHES_JSON="$(jq -c --arg pkg "${{ matrix.appId }}" '.[$pkg] // {} | to_entries | map(select(.value == false) | .key)' patches.json)"
  ```

  With:
  ```bash
            DISABLED_PATCHES_JSON="$(jq -c \
              --arg repo "$PATCH_REPO" \
              --arg pkg "${{ matrix.appId }}" \
              '.[$repo][$pkg] // {} | to_entries | map(select(.value == false) | .key)' \
              patches.json 2>/dev/null || echo '[]')"
  ```

- [ ] **Step 7: Update `Patch` step — MPP variable and patches.json read (lines ~1328-1353)**

  Replace (line ~1329):
  ```bash
            MPP="$(ls -1 $TOOLS_DIR/patches*.mpp | head -n1)"
  ```

  With:
  ```bash
            MPP="$TOOLS_DIR/${PATCH_SLUG}.mpp"
            if [ ! -f "$MPP" ]; then
              echo "::error::Patch file not found: $MPP"
              exit 1
            fi
  ```

  Replace (lines ~1353-1354, reading enabled+disabled patches from flat patches.json):
  ```bash
            ENABLED_PATCHES="$(jq -r --arg pkg "${{ matrix.appId }}" '.[$pkg] // {} | to_entries[] | select(.value == true) | .key' patches.json || true)"
            DISABLED_PATCHES="$(jq -r --arg pkg "${{ matrix.appId }}" '.[$pkg] // {} | to_entries[] | select(.value == false) | .key' patches.json || true)"
  ```

  With:
  ```bash
            ENABLED_PATCHES="$(jq -r \
              --arg repo "$PATCH_REPO" \
              --arg pkg "${{ matrix.appId }}" \
              '.[$repo][$pkg] // {} | to_entries[] | select(.value == true) | .key' \
              patches.json 2>/dev/null || true)"
            DISABLED_PATCHES="$(jq -r \
              --arg repo "$PATCH_REPO" \
              --arg pkg "${{ matrix.appId }}" \
              '.[$repo][$pkg] // {} | to_entries[] | select(.value == false) | .key' \
              patches.json 2>/dev/null || true)"
            if [ -z "$ENABLED_PATCHES" ] && [ -z "$DISABLED_PATCHES" ]; then
              echo "::warning::No patches.json entry for ${PATCH_REPO}/${{ matrix.appId }}; applying all patches."
            fi
  ```

- [ ] **Step 8: Update OUTPUT_NAME and artifact name to use PATCH_TAG (lines ~1455, 1462)**

  Replace (line ~1455):
  ```bash
            OUTPUT_NAME="${{ matrix.name }}-${PATCHES_VERSION}-v${APK_VERSION}.apk"
  ```

  With:
  ```bash
            OUTPUT_NAME="${{ matrix.name }}-${PATCH_TAG}-v${APK_VERSION}.apk"
  ```

  Replace (line ~1462):
  ```yaml
            name: ${{ matrix.name }}-${{ env.PATCHES_VERSION }}-v${{ steps.getapk.outputs.version }}
  ```

  With:
  ```yaml
            name: ${{ matrix.name }}-${{ matrix.patchTag }}-v${{ steps.getapk.outputs.version }}
  ```

- [ ] **Step 9: Validate with actionlint**

  ```bash
  docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/morphe-build.yml
  ```

  Expected: no errors.

- [ ] **Step 10: Commit**

  ```bash
  git add .github/workflows/morphe-build.yml
  git commit -m "feat: update build job for dynamic matrix and per-app .mpp handling"
  ```

---

## Chunk 5: `update-state` and `create-release` jobs

### Task 5: Update `update-state` job — repo-keyed patches.json and new state.json structure

**Files:**
- Modify: `.github/workflows/morphe-build.yml` (update-state and create-release jobs, lines ~1465–1720)

- [ ] **Step 1: Update `create-release` job release notes (lines ~1492-1516)**

  The release notes currently show a single `PATCHES_VERSION` and `PATCHES_BRANCH`. Replace with CLI version + "see state.json for patch versions":

  Replace:
  ```bash
            PATCHES_VERSION="${{ needs.check-versions.outputs.patches-version }}"
            CLI_VERSION="${{ needs.check-versions.outputs.cli-version }}"
            PATCHES_BRANCH="${{ needs.check-versions.outputs.patches-branch }}"
            CLI_BRANCH="${{ needs.check-versions.outputs.cli-branch }}"

            RELEASE_TITLE="Morphe Patched Apps (${PATCHES_VERSION}, ${CLI_BRANCH}-${CLI_VERSION})"

            RELEASE_NOTES="$(cat <<EOF
            Morphe-patched apps release.

            **Patches channel:** ${PATCHES_BRANCH}
            **Patches version:** ${PATCHES_VERSION}
            **CLI channel:** ${CLI_BRANCH}
            **CLI version:** ${CLI_VERSION}
  ```

  With:
  ```bash
            CLI_VERSION="${{ needs.check-versions.outputs.cli-version }}"
            CLI_BRANCH="${{ needs.check-versions.outputs.cli-branch }}"
            REPO_VERSIONS='${{ needs.check-versions.outputs.repo-versions }}'

            PATCHES_SUMMARY="$(echo "$REPO_VERSIONS" | jq -r 'to_entries | map("- \(.key): \(.value)") | join("\n")')"

            RELEASE_TITLE="Morphe Patched Apps (${CLI_BRANCH}-${CLI_VERSION})"

            RELEASE_NOTES="$(cat <<EOF
            Morphe-patched apps release.

            **CLI channel:** ${CLI_BRANCH}
            **CLI version:** ${CLI_VERSION}

            **Patch repo versions:**
  ${PATCHES_SUMMARY}
  ```

- [ ] **Step 2: Update `update-state` job — replace hardcoded packages list with config-driven**

  Find the `PKGS='["com.google..."]'` line (around line 1578) and replace it with a config-driven value:

  Replace:
  ```bash
            PKGS='["com.google.android.youtube","com.google.android.apps.youtube.music","com.reddit.frontpage"]'
  ```

  With:
  ```bash
            PKGS="$(jq -c '.patch_repos | keys' config.json)"
            REPO_VERSIONS='${{ needs.check-versions.outputs.repo-versions }}'
  ```

- [ ] **Step 3: Replace patches.json sync in update-state with repo-keyed logic**

  The current sync (lines ~1586-1635) fetches from a single hardcoded repo and builds a flat patches.json. Replace with the same per-repo sync logic as in `update-patches.yml`.

  Replace the entire block from `# Keep repository patches.json in sync...` through the `mv patches.json.tmp patches.json` line with:

  ```bash
            # Sync patches.json to repo-keyed structure (same logic as update-patches.yml)
            COMPAT_FN='
              def compat_pkg_names($patch):
                if ($patch.compatiblePackages? | type) == "object" then
                  ($patch.compatiblePackages | keys)
                elif ($patch.compatible_packages? | type) == "object" then
                  ($patch.compatible_packages | keys)
                elif ($patch.compatiblePackages? | type) == "array" then
                  ($patch.compatiblePackages | map(.name // .packageName // empty))
                elif ($patch.compatible_packages? | type) == "array" then
                  ($patch.compatible_packages | map(.name // .packageName // empty))
                else
                  []
                end;
            '

            REPO_PAIRS="$(jq -r '
              .patch_repos
              | to_entries
              | map(.value | "\(.repo)|\(.branch | ascii_downcase)")
              | unique[]
            ' config.json)"

            # Guard: nothing to sync if no repos configured
            if [ -z "$REPO_PAIRS" ]; then
              echo "::warning::No repos in patch_repos; skipping patches.json sync."
            else

            # Fetch patches-list.json for each unique repo
            mkdir -p "$RUNNER_TEMP/patches-lists"
            while IFS='|' read -r repo branch; do
              slug="${repo//\//-}"
              tag="$(echo "$REPO_VERSIONS" | jq -r --arg r "$repo" '.[$r] // empty')"
              if [ -z "$tag" ]; then
                echo "::warning::No resolved tag for ${repo}; skipping patches sync for this repo."
                continue
              fi
              url="https://raw.githubusercontent.com/${repo}/${tag}/patches-list.json"
              curl -fsSL "$url" -o "$RUNNER_TEMP/patches-lists/${slug}.json" || \
                echo "::warning::Failed to fetch patches-list.json for ${repo}; skipping."
            done <<< "$REPO_PAIRS"

            # Determine if existing patches.json is repo-keyed
            EXISTING_IS_REPO_KEYED=false
            if [ -s patches.json ] && jq -e 'type=="object"' patches.json >/dev/null 2>&1; then
              if jq -e 'keys | map(select(contains("/"))) | length > 0' patches.json >/dev/null 2>&1; then
                EXISTING_IS_REPO_KEYED=true
              fi
            fi

            if [ "$EXISTING_IS_REPO_KEYED" = "true" ]; then
              cp patches.json "$RUNNER_TEMP/patches_base.json"
            else
              echo '{}' > "$RUNNER_TEMP/patches_base.json"
            fi

            while IFS='|' read -r repo branch; do
              slug="${repo//\//-}"
              PATCHES_LIST="$RUNNER_TEMP/patches-lists/${slug}.json"
              [ -f "$PATCHES_LIST" ] || continue

              APPS_FOR_REPO="$(jq -c --arg r "$repo" '
                [.patch_repos | to_entries[]
                  | select(.value.repo == $r)
                  | .key]
              ' config.json)"

              jq --argjson apps "$APPS_FOR_REPO" "$COMPAT_FN"'
                . as $src
                | reduce $apps[] as $pkg ({};
                    .[$pkg] = (
                      reduce (
                        (($src.patches // $src)[])
                        | select((compat_pkg_names(.) | index($pkg)) != null)
                        | .name
                      ) as $name
                      ({};
                        .[$name] = true
                      )
                    )
                  )
              ' "$PATCHES_LIST" > "$RUNNER_TEMP/defaults_${slug}.json"

              # Same merge logic as update-patches.yml: only upstream keys survive.
              jq -n \
                --arg repo "$repo" \
                --slurpfile defaults "$RUNNER_TEMP/defaults_${slug}.json" \
                --slurpfile base "$RUNNER_TEMP/patches_base.json" '
                ($defaults[0] // {}) as $d
                | ($base[0] // {}) as $existing
                | ($existing[$repo] // {}) as $repo_existing
                | reduce ($d | keys[]) as $pkg ({};
                    .[$pkg] = (
                      reduce ($d[$pkg] | keys[]) as $pname ({};
                        .[$pname] = (($repo_existing[$pkg] // {})[$pname] // true)
                      )
                    )
                  )
              ' > "$RUNNER_TEMP/merged_${slug}.json"

              jq --arg repo "$repo" \
                 --slurpfile merged "$RUNNER_TEMP/merged_${slug}.json" \
                 '.[$repo] = $merged[0]' \
                 "$RUNNER_TEMP/patches_base.json" > "$RUNNER_TEMP/patches_next.json"
              mv "$RUNNER_TEMP/patches_next.json" "$RUNNER_TEMP/patches_base.json"
            done <<< "$REPO_PAIRS"

            ACTIVE_REPOS="$(jq -c '[.patch_repos | to_entries[] | .value.repo] | unique' config.json)"
            jq --argjson active "$ACTIVE_REPOS" \
              'with_entries(select(.key as $k | $active | index($k) != null))' \
              "$RUNNER_TEMP/patches_base.json" > patches.json.tmp
            mv patches.json.tmp patches.json

            fi # end REPO_PAIRS guard
  ```

- [ ] **Step 4: Replace state.json write — new `patches` map structure (lines ~1643-1687)**

  Replace the `jq` state update block with:

  ```bash
            # Build patches map for state.json: { "owner/repo": { branch, version } }
            # Use first() to avoid duplicate outputs when multiple apps share one repo.
            PATCHES_MAP="$(echo "$REPO_VERSIONS" | jq -c \
              --argjson config "$(jq -c '.' config.json)" \
              'to_entries | map({
                key: .key,
                value: {
                  branch: (first($config.patch_repos | to_entries[] | select(.value.repo == .key) | .value.branch) // "main" | ascii_downcase),
                  version: .value
                }
              }) | from_entries' 2>/dev/null || echo '{}')"

            jq --argjson patches_map "$PATCHES_MAP" \
               --arg cli "${{ needs.check-versions.outputs.cli-version }}" \
               --arg cli_branch "${{ needs.check-versions.outputs.cli-branch }}" \
               --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
               --arg run_id "${{ github.run_id }}" \
               --arg sha "${{ github.sha }}" \
               --argjson run_number "${{ github.run_number }}" \
               '. as $s
               | (
                   ((.build_history // [])
                    + [{
                        "timestamp": $timestamp,
                        "patches": $patches_map,
                        "cli_version": $cli,
                        "cli_branch": $cli_branch,
                        "status": "success",
                        "run_id": $run_id,
                        "run_number": $run_number,
                        "commit": $sha
                    }])
                   | if length > 100 then .[-100:] else . end
                 ) as $history
               | {
                   "patches": $patches_map,
                   "cli_branch": $cli_branch,
                   "cli_version": $cli
                 }
               + ($s | del(
                   .patches,
                   .patches_branch,
                   .patches_version,
                   .cli_branch,
                   .cli_version,
                   .last_build,
                   .status,
                   .build_history
                 ))
               + {
                   "last_build": $timestamp,
                   "status": "success",
                   "build_history": $history
                 }' state.json > state.json.tmp && mv state.json.tmp state.json
  ```

  Note: `del(.patches_branch, .patches_version)` ensures the old flat keys are removed after migration.

- [ ] **Step 5: Update commit message (line ~1708)**

  Replace:
  ```bash
            git commit -m "chore: update state and patches config - patches ${{ needs.check-versions.outputs.patches-branch }}/${{ needs.check-versions.outputs.patches-version }}, cli ${{ needs.check-versions.outputs.cli-branch }}/${{ needs.check-versions.outputs.cli-version }}"
  ```

  With:
  ```bash
            git commit -m "chore: update state and patches config - cli ${{ needs.check-versions.outputs.cli-branch }}/${{ needs.check-versions.outputs.cli-version }}"
  ```

- [ ] **Step 6: Validate with actionlint**

  ```bash
  docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .github/workflows/morphe-build.yml
  ```

  Expected: no errors.

- [ ] **Step 7: Validate config.json and patches.json**

  ```bash
  jq '.' config.json > /dev/null && echo "config.json valid"
  jq '.' patches.json > /dev/null && echo "patches.json valid"
  ```

- [ ] **Step 8: Commit**

  ```bash
  git add .github/workflows/morphe-build.yml
  git commit -m "feat: update update-state and create-release for multi-repo patches structure"
  ```

---

## Chunk 6: Migration run and smoke test

### Task 6: Run update-patches to migrate patches.json and verify end-to-end

- [ ] **Step 1: Push all changes to the remote**

  ```bash
  git push origin main
  ```

- [ ] **Step 2: Run the update-patches workflow manually**

  Go to GitHub Actions → "Update patches.json from upstream repos" → "Run workflow"

  Expected: workflow succeeds, patches.json is committed in repo-keyed format:
  ```json
  {
    "MorpheApp/morphe-patches": {
      "com.google.android.youtube": { "Hide ads": true, ... },
      ...
    }
  }
  ```

- [ ] **Step 3: Pull the committed patches.json**

  ```bash
  git pull origin main
  jq 'keys' patches.json
  # Expected: ["MorpheApp/morphe-patches"] (or whatever repos you have configured)
  jq 'to_entries[0].value | keys' patches.json
  # Expected: app package IDs
  ```

- [ ] **Step 4: Validate patches.json structure**

  ```bash
  # Check repo-keyed top level
  jq -e 'keys | map(select(contains("/"))) | length > 0' patches.json

  # Check each repo has app entries with boolean patch values
  jq -e 'to_entries[] | .value | to_entries[] | .value | to_entries[] | .value | type == "boolean"' patches.json
  ```

  Expected: all commands exit 0.

- [ ] **Step 5: Run the build workflow manually (dispatch)**

  Go to GitHub Actions → "Build Morphe-patched apps" → "Run workflow"

  Expected:
  - `check-versions` outputs `matrix-include` with per-app entries
  - `build` job runs for each app, downloads per-repo `.mpp`, reads repo-keyed `patches.json`
  - Patched APKs produced with names like `youtube-v1.20.0-dev.3-v20.44.38.apk`
  - `update-state` writes new `state.json` with `patches` map
  - `state.json` no longer has top-level `patches_version`/`patches_branch` keys

- [ ] **Step 6: Verify state.json after build**

  ```bash
  git pull origin main
  jq '.patches' state.json
  # Expected: { "MorpheApp/morphe-patches": { "branch": "dev", "version": "v1.20.x" } }
  jq 'has("patches_version")' state.json
  # Expected: false
  ```

- [ ] **Step 7: Update CLAUDE.md to reflect new config structure**

  In `CLAUDE.md`, update the `config.json Structure` example under the Configuration section to show `patch_repos` + `cli` instead of `branches`. Update the key files table if needed.

  ```bash
  # Validate CLAUDE.md edits don't break JSON examples
  jq '.' config.json > /dev/null && echo "ok"
  ```

- [ ] **Step 8: Commit CLAUDE.md update**

  ```bash
  git add CLAUDE.md
  git commit -m "docs: update CLAUDE.md for multi-repo patch config structure"
  git push origin main
  ```
