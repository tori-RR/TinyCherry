---
name: gh-create-pr
description: Create or update GitHub pull requests with the correct destination and a concise change description and verification record.
---

# GitHub PR Creation

1. Verify the destination repository and head/base branches. For TinyCherry, the default destination is the fork's `main`. Use Cherry Studio upstream only when requested. Inspect the diff against the verified base and use `pnpm change:scope --base <verified-base-ref>` when a scope report helps.
2. Draft a concise body explaining what changes, why, and what was verified on this revision. Use `.github/pull_request_template.md` as a starting point. Add issue links, compatibility notes, or an Agent Note when useful. Follow the destination repository's requirements for upstream PRs.
3. Push the head to the intended remote if needed for the authorized PR. Use the `gh-stack` skill only when the task uses a stack. For an active release or backport, follow the [release workflow](../../../docs/dev/contrib/release-workflow.md) for its base, title, markers, and release-note format.
4. Write the body to a temporary file and inspect it before creating or updating the PR. Show a preview when requested. Verify the PR URL, destination, and branches after publishing, then remove the temporary body file.

```bash
gh pr create --repo <owner/repo> --base <base> --head <head> --title "<title>" --body-file <body-file>
```

Use `--draft` when requested. If a check was skipped, pending, or unavailable, report it as such.
