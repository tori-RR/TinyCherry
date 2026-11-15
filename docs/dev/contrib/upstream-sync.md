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
- Upstream-only publishing and notification jobs, fork configuration, and required secrets.
- Documentation, locale catalogs, package contents, and the upstream release's changed behavior.

Fix supported behavior and update obsolete expectations for removed features. Keep the checks for retained behavior active. Run generation and formatting, finish all parallel edits, and commit the final candidate before validating it.

## Validate the frozen commit

```shell
pnpm upstream:verify --base TARGET_SHA --upstream UPSTREAM_SHA
```

The gate requires a clean worktree and no unfinished merge or rebase. It sets `CI=true` and clears inherited `VALIDATION_PLAN` and `VALIDATION_WORKSPACE_PREPARED`. After verifying the pinned Node and pnpm environment, it backs up any existing `node_modules` under ignored `.cache/` and creates a fresh installation with `--frozen-lockfile`. An installation failure restores the previous dependency tree. Successful backups are retained and reported; they are not silently deleted. `--all` takes precedence over an inherited affected plan.

The local gate follows the same platform division as CI. It checks workflow syntax and fork boundaries, catalog and release policies, generated migration/provider/locale drift, all static checks, the Windows platform-test inventory, gate/planner regression tests, and the full native package build. The static and platform phases use these commands:

```shell
pnpm check --all --group checks
pnpm check --all --group platform --max-workers 2
```

Local actionlint disables its ShellCheck and Pyflakes integrations; ShellCheck runs in the full Linux CI container. After all local tests and generation finish, the gate runs the final i18n checks again. The native package must identify the candidate commit and pass its startup and contract checks.

The Linux test projects stay in the full Linux CI suite, and the Windows/macOS runners retain their platform contracts. Do not change product behavior or rewrite unrelated POSIX fixtures merely to run a Linux-owned suite on Windows. Fix genuine defects on the platform that owns the test.

Each step checks the same HEAD, Git tree, index, and worktree. A source change, staged edit, or non-ignored untracked file stops validation. Review any generated drift, commit the corrected result, and restart the gate. Do not edit the candidate while validation is running.

Only a complete successful run writes a local result under `.cache/upstream-validation/receipts/`. It binds the commit and tree to the check set, Node version, and native artifact hashes. A failed run invalidates the result for that commit. Keep results and diagnostic logs ignored; the root README remains a product introduction.

Run validation, `pnpm upstream:check`, and `git push` in the same environment using `.node-version`. If the system default Node differs, activate the project Node version before continuing; retain the result and validation hook.

Verify the result immediately before publishing the candidate:

```shell
pnpm upstream:check
git push origin HEAD
```

The installed pre-push hook reads Git's actual ref updates and checks every non-deletion ref. A valid result for the current checkout cannot authorize a different unvalidated commit. Ignored cache and log files may change without invalidating the source check.

## Complete platform CI

The initial candidate push uses the local gate. Dispatch full CI on that branch:

```shell
gh workflow run ci.yml --ref CANDIDATE_BRANCH
```

Check that the run belongs to the exact candidate SHA and uses the full plan: all configured Linux test projects, including main/package/renderer tests, and the Windows/macOS platform contracts. Wait for all required jobs and their aggregate checks to succeed. Promotion requires the latest `workflow_dispatch` CI run for that SHA in the origin repository to be completed and successful. Pushes to `main`, `evostack`, or `release/*` require that result in the repository identified by the actual push remote URL. An affected-only run or another SHA's result cannot satisfy this requirement. Local Windows validation establishes only the behavior exercised on Windows; the other platform runners supply their own evidence.

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

The wrapper requires a valid candidate result, unchanged artifacts, a clean checkout, a candidate descended from the current target, and the exact candidate's successful full CI run. It uses `git merge --ff-only`, preserving the validated candidate SHA and its package identity. A merge that needs conflict resolution must return to candidate preparation.

Use the wrapper for upstream promotion: Git's `pre-merge-commit` hook does not run for fast-forward merges. The local pre-push hook still checks the actual commit being pushed. These local tools do not configure GitHub branch protection or replace the platform CI requirement.

After pushing the target, verify its remote SHA and CI result. A new commit, rebase, merge commit, changed artifact, or post-commit formatter change requires a new valid result and a package built for the final SHA.
