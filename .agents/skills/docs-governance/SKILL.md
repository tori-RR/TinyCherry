---
name: docs-governance
description: Maintain TinyCherry product and module documentation against current Tauri, Rust and Go behavior.
---

# Documentation

Read the applicable repository rules, owning source and module README. Put architecture and migration status in `docs/desktop.md`; put module contracts beside their code. Keep one home per fact and use links for shared context.

Describe current behavior, failures, data ownership and validation limits. Keep the root product README minimal. Private preferences, environment details, audit attachments and evaluation logs do not belong in public documentation.

Check changed text, local links and formatting with `pnpm check`. Documentation-only changes do not require native compilation. Keep existing translations consistent when changing a paired document, but do not run a corpus-wide bilingual or publishing gate.
