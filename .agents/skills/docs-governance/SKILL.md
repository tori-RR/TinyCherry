---
name: docs-governance
description: Use when writing, restructuring, auditing, or reviewing Cherry Studio repository documentation, READMEs, JSDoc, comments, Agent instructions, or paired English/Chinese docs, including source-linked documentation impact checks.
---

# Documentation Governance

Require an explicit scope. Read the applicable `AGENTS.md`, then the owning source or module README before judging prose.

## Place the fact

- Cross-cutting and multi-module behavior belongs under `docs/dev/references/<domain>/`.
- Repository process belongs under `docs/dev/contrib/`.
- Module-private behavior belongs beside the module.
- Record durable rationale and rejected alternatives in the owning document or an optional Agent Note.
- Standing agent orders belong in the narrowest applicable `AGENTS.md` and link their rationale.

Keep one home per fact. A domain README owns its subject and summarizes children with links; it does not copy their implementation detail. A tutorial leads through ordered actions to an observable result. A reference supports lookup and states current behavior.

## Inspect code impact

When documented behavior or a contract changes, inspect the owning docs. Use `pnpm change:scope --base <verified-ref>` or `pnpm docs:affected --base <verified-ref>` when the affected scope is unclear. Review suggested documents against actual behavior before editing.

Reference docs describe current reality. Preserve behavior, failure, timing, ownership, modality, exceptions, and consequences. Remove implementation narration, reasoning transcripts, review history, duplicated rationale, status inventories, and catalogs whose source or generator already owns them.

## Generated and paired docs

Reference docs carry `description` and `sources`; contrib and governance docs carry `description`. Never hand-edit `docs/dev/README.md`, `docs/dev/sources-index.json`, or `docs/dev/i18n/terminology.md`.

For an in-scope pair, read [the pairing contract](../../../docs/dev/i18n/README.md), [translation rules](../../../docs/dev/i18n/translation-rules.md), and [terminology](../../../docs/dev/i18n/terminology.md). Update the counterpart minimally and re-record only after semantic review. Use `translate-docs` for new pairs or batch translation.

## Validation

Check changed text, links, and formatting. Run `pnpm docs:check` when edits affect repository documentation checks, and `pnpm skills:check` for skill metadata or links. Run focused checks for any executable behavior changed.
