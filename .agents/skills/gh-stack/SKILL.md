---
name: gh-stack
description: Manage Cherry Studio stacked branches and pull requests with the GitHub gh-stack extension. Use for planning, creating, inspecting, rebasing, syncing, linking, or recovering a stack of dependent PRs.
metadata:
  author: github
  upstream-version: "0.0.8"
---

# GitHub Stack

Use `gh stack` for branch topology and synchronization when a stack is useful for the task. Use `gh-create-pr` for PR descriptions and verification.

## Availability and prerequisites

This public skill is tracked in `.agents/skills/` and discovered from the repository. Developers do not install a separate agent skill. `pnpm skills:sync` maintains the `.claude/skills/` compatibility symlink.

Run this preflight before the first `gh stack` command in a task:

```bash
command -v gh >/dev/null 2>&1 || {
  echo "GitHub CLI is required: https://cli.github.com/" >&2
  exit 1
}
gh auth status
if ! gh stack --help >/dev/null 2>&1; then
  gh extension install github/gh-stack
fi
gh stack --help >/dev/null
```

If GitHub CLI authentication, extension installation, or the final verification fails, stop and report the failing command. Do not guess stack topology with ad hoc branch comparisons.

Before initializing a stack, avoid extension prompts:

```bash
git config rerere.enabled true
```

When multiple remotes exist, resolve the intended remote and pass `--remote <name>` to commands that accept it. Do not silently change `remote.pushDefault` for the developer.

## Stack model

A stack is a linear dependency chain. The bottom branch is closest to the trunk; each higher branch contains only work that depends on the layer below it.

```text
main
  -> spec
    -> implementation-core
      -> implementation-ui
```

Plan the complete dependency order before creating branches. Put a newly discovered lower-layer change on its owning branch, then rebase the upstack branches; do not hide it in the current layer.

## Agent-safe commands

All commands must be non-interactive:

- Always run `gh stack view --json`; plain `view` opens a TUI.
- Always supply branch names to `init`, `add`, and `checkout`.
- Always use `--auto` with `submit` if that command is explicitly allowed.
- Pass `--remote <name>` to `push`, `submit`, `sync`, or `link` when more than one remote exists.
- Use `git add` and `git commit` so each layer is staged deliberately.

Common operations:

```bash
gh stack init --base main <bottom-branch> [<higher-branch>...]
gh stack add <new-top-branch>
gh stack view --json
gh stack push --remote <remote>
gh stack rebase --upstack --remote <remote>
gh stack sync --remote <remote>
gh stack checkout <branch-or-pr>
gh stack link --remote <remote> <bottom-pr> <higher-pr> [...]
```

Exit code `2` from `gh stack view --json` means only that the current checkout has no matching local stack metadata. It does not prove that an existing PR is standalone on GitHub. In a clean disposable worktree, run `gh stack checkout <pr-number-or-url>` to discover and hydrate remote topology, then rerun `gh stack view --json`. Classify an existing PR as standalone only after remote discovery confirms that it is not attached to a GitHub stack.

Exit code `3` means a conflict, but recovery depends on the command. `gh stack rebase` leaves active recovery state, so resolve the conflict and run `gh stack rebase --continue`, or `gh stack rebase --abort`. `gh stack sync` rolls the attempted rebase back before returning; start a new `gh stack rebase` to resolve that conflict, and do not use `--continue` or `--abort` unless a rebase is active. Exit code `9` means GitHub stacked PRs are unavailable for the repository; stop instead of silently publishing a different PR shape.

## Creating stacked PRs

When authorized to publish a stack, push the branches, create each PR against its parent branch, then link the PRs with `gh stack link --remote <remote> <bottom-pr> <higher-pr> [...]`. Verify the topology with `gh stack view --json`. Use automated submission only when explicitly authorized.

## Changes to an existing stack

When changing a lower layer:

1. Check out that branch explicitly.
2. Make and verify the focused change there.
3. Run `gh stack rebase --upstack --remote <remote>`.
4. Push or sync the stack.
5. For every rewritten live PR, rerun `pnpm change:scope --base <verified-parent-ref>` and only the checks invalidated by that rewritten scope.

After `gh stack sync`, inspect its output and run `gh stack view --json`; a successful command alone is not proof that each PR still has the intended base, scope, or verification.

## Lifecycle boundary

If the stack implements an existing Agent Note, keep it proposed until verification across the relevant layers covers the decision. See the [Agent Notes guide](../../notes/README.md) for the optional lifecycle workflow.
