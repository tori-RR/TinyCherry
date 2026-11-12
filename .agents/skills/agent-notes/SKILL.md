---
name: agent-notes
description: Record or review an optional TinyCherry decision note, including proposed, implemented, rejected, and superseding decisions.
---

# Agent Notes

Use this workflow when a decision is worth recording. See the [Agent Notes guide](../../notes/README.md) for note format and pairing.

1. Search for an existing note on the decision. Update its owner when appropriate and preserve unique rationale when linking a successor.
2. Use `proposed/` for a decision still being discussed or implemented, or `implemented/` for a verified decision already delivered. An explicit rejection can move an existing proposal to `rejected/`.
3. For a proposal, agree on observable behavior and verification in the relevant discussion. Use a separate Spec PR or a stack only if useful for the work.
4. When moving a note, move its English, Chinese, and sidecar files together. Record the evidence actually run across all relevant changes. Use `pnpm agent-notes:check-transition --base <verified-proposal-ref>` for a lifecycle move and check the affected pair and note format.
