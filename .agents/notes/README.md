# Decision notes

Notes preserve rationale, alternatives and verification; they are optional. Current behavior belongs in the [desktop architecture](../../docs/desktop.md) or the owning module README. Read source before applying an old conclusion.

Search by domain, mechanism and rejected alternatives before adding a record. Prefer updating the existing owner. A new note needs a date, background, decision/proposal, tradeoffs and actual verification. Keep proposals distinct from implemented behavior, link successors and preserve unique reasons when superseding a decision. Only an explicit user decision rejects a pending feature. Directory names alone do not establish product approval or execution authority.

The historical `proposed/`, `implemented/` and `rejected/` trees remain available. Their bilingual files, AC IDs and sidecars describe their original process; new work does not require that process. There is no mandatory bilingual triplet, transition checker, Spec PR or stack approval workflow. Use the current [documentation skill](../skills/docs-governance/SKILL.md) and [desktop checks](../../scripts/desktop/README.md).

No historical feature proposal was deleted in the Tauri cleanup. Agent/MCP, voice, attachment and file-editing proposals may still contain useful requirements; their current migration status is tracked in `docs/desktop.md`. The old developer guides and their exact paths can be recovered from `3b84a66575dcb132f7c832957de67a2cffbd05fa`. The application pre-migration reference remains `7d7a171fe7d164a7fb9dd6625a2868004bb7897c`.

Retired developer entries: `agent-notes` (merged into `docs-governance`), `create-skill`, `gh-create-issue`, `gh-stack` and `translate-docs` (specified translations are handled with documentation). The Electron E2E guides/config and unused setup-validation action also live only in that history. Retained safety/ownership decisions and application resource skills are unaffected.
