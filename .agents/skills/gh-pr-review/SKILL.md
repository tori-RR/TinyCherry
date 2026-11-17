---
name: gh-pr-review
description: Review TinyCherry code, commits, branches, pull requests and architecture documentation against its React, Tauri, Rust and Go boundaries.
---

# TinyCherry review

A review request authorizes analysis and reporting. Apply fixes or publish GitHub feedback only when the user requests those actions. Never infer product approval from existing implementation, tests or a PR label. Follow decisions already established by the user; identify unresolved behavior changes without deciding them on their behalf.

Resolve the requested scope and inspect its actual files/diff. Preserve unrelated local changes. Read the root rules, [architecture](../../../docs/desktop.md), owning module README and [desktop commands](../../../scripts/desktop/README.md). For a PR, verify its repository, base and exact head before reviewing.

## Current ownership

| Area | Review sources and boundaries |
| --- | --- |
| React UI | `src/renderer/`; keep layout and saved preferences, validate subscriptions, effects, stop/error states and rendering cost |
| Renderer desktop access | `src/platform/desktop-api/` and typed DataApi/IpcApi facades; business code uses these APIs |
| Tauri transport | `src/platform/tauri/`; validate cross-process messages, events, cancellation and capability failures |
| Native host | `native/evostack/src-tauri/`; origin checks, window/profile ownership, bounded IPC and helper cleanup |
| Backend | `native/evostack/backend/`; SQLite transactions, Windows DPAPI credential storage, chat/context boundaries, providers, cancellation and projections |
| Build and validation | `scripts/desktop/`, `scripts/validation/`; generated inputs, exact candidate bytes, strict verify/package and manual-only CI |

Trace a proposed shared API to its real production consumers before judging placement. Preserve app-specific approval, revocation, profile locking, key protection and owned-helper cleanup. Unsupported features remain unavailable; migration status lives in `docs/desktop.md`. Existing historical notes provide rationale, not proof of current behavior.

Use the smallest checks that resolve a meaningful uncertainty. `pnpm validation:plan --base <verified-ref>` explains selection; `pnpm check`, `pnpm test` and `pnpm verify` own the current checks. Ordinary TS projects exclude `native-contract`; native contracts require a real synthetic backend fixture. Never use real profiles, credentials, chats or desktop input in tests. For React performance work, consult the local client-focused `vercel-react-best-practices` references only where relevant.

Report concrete findings first, with severity, trigger, consequence and an exact source location. Distinguish a reproduced bug, a source-supported risk and a product decision. Describe verification actually run and material gaps. Source inspection or Linux probes do not establish Windows GUI or packaged acceptance. If there are no actionable findings, say so without inventing cleanup work.
