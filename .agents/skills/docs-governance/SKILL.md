---
name: docs-governance
description: Maintain TinyCherry product/module documentation and optional decision notes against current Tauri, Rust and Go behavior; translate specified documents when requested.
---

# Documentation and decisions

Read the applicable root rules, owning source and module README. Put current architecture and migration status in `docs/desktop.md`, module contracts beside their code, and durable decision rationale in optional `.agents/notes/` records. Keep one home per current fact. The root product README stays minimal; private preferences, machine details and evaluation logs belong in ignored local records.

Before adding a decision note, search for an existing owner and relevant alternatives. A useful note records date, background, decision or proposal, tradeoffs and actual verification. User decisions and approval come from the current task or an explicit recorded decision, never from the note's directory alone. Preserve unique rationale when superseding a note, and link its successor. Historical proposed features remain pending unless explicitly rejected. See [the notes guide](../../notes/README.md).

Describe current behavior, failures, ownership and limits. Maintain paired translations when editing a pair; translate only requested documents and preserve technical meaning. New notes need no mandatory bilingual triplet, AC machinery, lifecycle gate or Spec PR. Existing historical translations/sidecars may remain untouched.

Check changed text and local links with current desktop documentation checks. Documentation-only checks do not compile native code. When code changed, select its actual tests through [desktop commands](../../../scripts/desktop/README.md); do not cite obsolete documentation scripts.
