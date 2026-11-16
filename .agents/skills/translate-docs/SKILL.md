---
name: translate-docs
description: Translate explicitly requested TinyCherry documents while preserving their technical meaning and structure.
---

# Translate documentation

Read the source document and owning implementation. Preserve identifiers, code fences, tables, links, conditions and failure behavior. Keep terminology consistent with current product UI. Report source defects separately or fix both sides when authorized.

Update only the requested documents and their existing counterparts. Verify meaning section by section and run `pnpm check` for affected text and links. No global bilingual corpus, sidecar generation or publishing gate is required.
