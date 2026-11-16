---
description: Required validation and promotion workflow for integrating an upstream release into TinyCherry
---

# Sync an Upstream Release

English | [中文](upstream-sync.zh.md)

Upstream integration requires complete validation of the final candidate commit before promotion. Use this workflow for release synchronization, including updates that retain TinyCherry-specific feature removals or native adaptations.

## Prepare the candidate

Use the Node version in `.node-version` and the pnpm version in `package.json`. Install dependencies with the lockfile frozen. The local native package gate requires Windows x64 and the toolchain documented in [EvoStack](../../../native/evostack/README.md). Provide actionlint matching the CI version through `PATH` or `.cache/upstream-validation/tools/actionlint.exe`. Install and authenticate `gh` for the origin repository and actual GitHub push destination.

Install the validation hook in each checkout used for synchronization:

```shell
pnpm upstream:hooks
```

This installs a dedicated pre-push hook and preserves the existing prek commit and checkout hooks. An unfamiliar existing pre-push hook must be resolved before installation can continue.

Fetch the target branch and the chosen official release tag, then create a synchronization branch from the target. Use a candidate name such as `codex/upstream-vX.Y.Z`; `main`, `evostack`, and `release/*` are protected promotion targets. Record the resolved target and upstream commit IDs; do not use a moving branch as the review baseline. In the commands below, replace `TARGET_SHA`, `UPSTREAM_SHA`, and `CANDIDATE_BRANCH` with those recorded values and the synchronization branch name.

Complete the adaptation on that branch. Review these boundaries before committing:

- Retained features and deliberately removed features, including corresponding tests and dependencies.
- TinyCherry branding, application paths, onboarding, navigation, and existing interactions.
- Shared types, IPC registrations, runtime facades, database migrations, and generated registries.
- Upstream-only publishing and notification jobs, manual-only Electron E2E, Windows test runners, fork configuration, and case-specific secrets.
- Documentation, locale catalogs, package contents, and the upstream release's changed behavior.

Fix supported behavior and update obsolete expectations for removed features. Keep the checks for retained behavior active. Run generation and formatting, finish all parallel edits, and commit the final candidate before validating it.

## Validate the frozen commit

```shell
pnpm upstream:verify --base TARGET_SHA --upstream UPSTREAM_SHA
```

The gate requires a clean worktree and no unfinished merge or rebase. It sets `CI=true` and clears inherited `VALIDATION_PLAN` and `VALIDATION_WORKSPACE_PREPARED`. After verifying the pinned Node and pnpm environment, it backs up any existing `node_modules` under ignored `.cache/` and creates a fresh installation with `--frozen-lockfile`. An installation failure restores the previous dependency tree. Successful backups are retained and reported; they are not silently deleted. `--all` takes precedence over an inherited affected plan.

The local gate checks workflow syntax and fork boundaries, catalog and release policies, generated provider/locale drift, static checks, the native renderer's shared TypeScript tests on Windows, package contracts, and the full native package build. The validation target is fixed to `tauri`; the static, runtime-test, and package-contract phases use these commands:

```shell
pnpm check --target tauri --all --group checks
pnpm check --target tauri --all --group tests --max-workers=2
pnpm --filter @cherrystudio/web-search test:package
pnpm --filter @cherrystudio/provider-registry test:package
```

Local actionlint disables its ShellCheck and Pyflakes integrations; ShellCheck runs in CI's Ubuntu tooling container. After all local tests and generation finish, the gate runs the final i18n checks again. Native validation covers Go/Rust, real temporary SQLite databases, JSON-RPC and renderer contracts, and a packaged Tauri startup. The native package must identify the candidate commit. Synthetic computer-tool contracts do not prove real desktop actions; this gate does not establish native Agent or MCP execution support.

Runtime tests use Windows runners. The Tauri target retains renderer/shared tests, portable UI, preview, provider and protocol packages, consumed web-search metadata, relevant tooling, and the original preload bridge used by the native entry. Pure provider-filter and computer-tool definitions under `src/main` remain generation inputs; the Electron backend is not the native backend. Ubuntu jobs perform static tooling and report aggregation without running Linux application tests. Retained macOS/Linux sources do not imply hosted acceptance for those systems.

Each step checks the same HEAD, Git tree, index, and worktree. A source change, staged edit, or non-ignored untracked file stops validation. Review any generated drift, commit the corrected result, and restart the gate. Do not edit the candidate while validation is running.

Only a complete successful run writes a local result under `.cache/upstream-validation/receipts/`. It binds the commit and tree to the `tauri` target, check set, Node version, and native artifact hashes. A failed run invalidates the result for that commit. Keep results and diagnostic logs ignored; the root README remains a product introduction.

Run validation, `pnpm upstream:check`, and `git push` in the same environment using `.node-version`. If the system default Node differs, activate the project Node version before continuing; retain the result and validation hook.

Verify the result immediately before publishing the candidate:

```shell
pnpm upstream:check
git push origin HEAD
```

The installed pre-push hook reads Git's actual ref updates and checks every non-deletion ref. A valid result for the current checkout cannot authorize a different unvalidated commit. Ignored cache and log files may change without invalidating the source check.

## Complete platform CI

The initial candidate push uses the local gate. Dispatch both required workflows on that branch:

```shell
gh workflow run ci.yml --ref CANDIDATE_BRANCH
gh workflow run evostack-windows.yml --ref CANDIDATE_BRANCH
```

Check that both runs belong to the exact candidate SHA. `ci.yml` must use its full `tauri` plan; `evostack-windows.yml` must finish its Go race, native build, contract, and startup checks. Wait for all required jobs and aggregate checks to succeed. Promotion requires each workflow's latest `workflow_dispatch` run for that SHA in the origin repository to be completed and successful. Pushes to `main`, `evostack`, or `release/*` require both results in the repository identified by the actual push remote URL. An affected-only run, another SHA's result, success in only one workflow, or a successful Electron compatibility run cannot satisfy this requirement. These results establish Windows acceptance only.

The native workflow also runs for relevant pushes to `main` and `evostack`, and pull requests targeting those branches. The full Electron unit-test inventory runs separately with `pnpm check --all --target electron` in the manual Windows compatibility workflow. Electron E2E is also Windows-only and manual, with no daily schedule. Neither compatibility workflow blocks Tauri mainline validation or replaces native acceptance. E2E preflight checks only the provider fields used by the selected cases. Local/startup scenarios do not require unrelated CherryIN or embedding configuration. The existing mock mode supports only its declared focused tasks, not `all`.

If CI requires a correction, commit it and repeat local validation before publishing the new candidate. Earlier focused tests or an earlier candidate's green run do not validate a changed final commit.

## Promote the validated commit

Refresh the remote target and confirm that the local target matches it. If the target advanced beyond the candidate's base, update the synchronization branch and repeat validation and full CI for the new candidate.

Switch to the target branch, then use the promotion wrapper:

```shell
pnpm upstream:check --ref CANDIDATE_BRANCH
pnpm upstream:merge --ref CANDIDATE_BRANCH
pnpm upstream:check
git push origin main
```

The wrapper requires a valid candidate result, unchanged artifacts, a clean checkout, a candidate descended from the current target, and successful exact-candidate runs of both required workflows. It uses `git merge --ff-only`, preserving the validated candidate SHA and its package identity. A merge that needs conflict resolution must return to candidate preparation.

Use the wrapper for upstream promotion: Git's `pre-merge-commit` hook does not run for fast-forward merges. The local pre-push hook still checks the actual commit being pushed. These local tools do not configure GitHub branch protection or replace the platform CI requirement.

After pushing the target, verify its remote SHA and CI result. A new commit, rebase, merge commit, changed artifact, or post-commit formatter change requires a new valid result and a package built for the final SHA.
