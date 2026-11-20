# Desktop architecture and migration status

The supported target is Windows x64. React and TypeScript retain the existing layout, components, state and business DTOs. Vite builds the frontend. Tauri 2/Rust owns the window and native integration; Go owns chat, network requests, concurrency and SQLite. JSON-RPC travels over private stdio, with directed Tauri Channels for renderer events.

## Available functionality

| Area | Current implementation |
| --- | --- |
| Chat and models | Provider configuration, compatible Chat Completions, model checks, message branches, context boundaries, streaming, stop and reconnectable projections |
| Nous Portal authentication | Browser device-code sign-in, backend-owned encrypted credentials, token refresh, cancellation and logout; see [Nous Portal sign-in](nous-oauth.md) for client identity and live-service verification limits |
| Knowledge | SQLite FTS5/BM25 for text, Markdown, CSV, JSON, HTML, notes and URLs |
| Prompt and skill management | Persistent prompts and bindings; built-in/local skill catalog, files and enablement |
| Local history | Conversation/assistant archive, restore, permanent deletion and Undo |
| Notifications | Persistent local results, unread state and dismissal |
| Computer Use | Windows helper, per-app approval, revocation, task cancellation and owned-session cleanup |
| Preview | Registered Markdown/files and script-less HTML; uploaded assistant avatars |

Skill management does not enable an Agent execution engine. Computer Use capability does not authorize a particular application. Each control session still requires the existing backend/host grant checks. Background keyboard dispatch remains unavailable until its effect can be verified.

## Pending migration

| Area | Required work before exposure |
| --- | --- |
| Agent runtimes and MCP | Native execution, tool search, permissions and protocol tests |
| Scheduled and remote tasks | Native scheduling, run lifecycle and authenticated remote access |
| Chat attachments | Registered import, ownership, content limits and preview lifecycle |
| Backups and import | Versioned export/import and rollback without reading another profile implicitly |
| Browser and mini apps | Isolated web content, navigation, login state and resource ownership |
| Interactive HTML | Separate untrusted execution surface and explicit consent |
| Search, painting, translation and downloads | Go implementations, cancellation, provider compatibility and error contracts |
| Tray, global shortcuts and extra windows | Rust integration and process/window ownership |
| Knowledge extensions | Embeddings, reranking, directory ingestion, PDF/OCR and group management |
| macOS/Linux | Platform adapters, permissions, secrets, packaging and real host verification |

Pending routes retain saved links and show an unavailable message. Their buttons are excluded from primary navigation without deleting stored preferences. Historical DTOs remain for persisted message rendering; runtime engines and old desktop source are outside the active tree.

The fixed [pre-migration source snapshot](https://github.com/tori-RR/TinyCherry/tree/7d7a171fe7d164a7fb9dd6625a2868004bb7897c) is the reference for future ports. No separate compatibility application or compatibility test driver is maintained.

## Data and platform boundaries

The packaged app retains identifier `com.tinycherry.evostack` and the adjacent `evostack-data` profile. CLI start uses a stable local portable profile independent of candidate folders. Development and smoke checks use separate disposable project-local profiles. API keys remain bound to the same Windows user by DPAPI. This change does not alter database schemas or import another desktop application's profile.

Build/version/protocol/revision information comes from product metadata and compiled host/sidecar identities. Start validates exact candidate hashes and host/sidecar identities, displays its revision and can run the last complete build after source changes. `start --strict-source`, verification and packaging additionally require current source identity. A missing helper, mismatched binary or modified candidate fails explicitly; no fallback runtime or implicit rebuild runs.

## Verification boundaries

Automated checks use synthetic loopback providers and isolated SQLite profiles. The package smoke launches the actual release candidate, waits for React, operates onboarding, and verifies shutdown of its owned sidecar. Helper tests do not send input to unrelated applications. Real provider behavior, Windows IME/accessibility effects and future macOS behavior require explicit additional validation.
