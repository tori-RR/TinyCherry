# Desktop architecture and migration status

The supported target is Windows x64. React and TypeScript retain the existing layout, components, state and business DTOs. Vite builds the frontend. GPUI/Rust owns the native window and lifecycle; Wry attaches the WebView2 that renders React; Go owns chat, network requests, concurrency and SQLite. JSON-RPC travels over private stdio, with correlated Wry messages and document-scoped renderer events.

## Available functionality

| Area | Current implementation |
| --- | --- |
| Chat and models | Provider configuration, compatible Chat Completions, model checks, message branches, context boundaries, streaming, stop and reconnectable projections |
| Nous Portal and Hermes | Browser device-code sign-in with encrypted credentials and token refresh, plus a separate preset for Hermes Subscription Proxy. See [provider setup](nous-oauth.md) for connection details. |
| ChatGPT Sub | [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) with account-specific models and multi-turn streaming text through the official Responses API. |
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

The packaged app retains the `TinyCherry.exe` identity and the adjacent `evostack-data` profile. CLI start uses a stable local portable profile independent of candidate folders. Development and smoke checks use separate disposable project-local profiles. API keys remain bound to the same Windows user by DPAPI. This change does not alter database schemas or import another desktop application's profile.

Build/version/protocol/revision information comes from product metadata and compiled host/sidecar identities. Start validates exact candidate hashes and host/sidecar identities, displays its revision and can run the last complete build after source changes. `start --strict-source`, verification and packaging additionally require current source identity. A missing helper, mismatched binary or modified candidate fails explicitly; no fallback runtime or implicit rebuild runs.

## Verification boundaries

Automated checks use synthetic loopback providers and isolated SQLite profiles. The package smoke launches the actual release candidate, waits for React, operates onboarding, and verifies shutdown of its owned sidecar. Helper tests do not send input to unrelated applications. Real provider behavior, Windows IME/accessibility effects and future macOS behavior require explicit additional validation.

## GPUI + Wry migration

The active host is `native/evostack/src-gpui`; the active frontend bridge is `src/platform/gpui`. Tauri commands, Channels, configuration and CLI are removed from the active build. The Vite output is embedded in the release executable and served through the retained `tauri` custom protocol. The packaged Windows page uses `http://tauri.localhost/windows/evostack/index.html`; development uses only `http://127.0.0.1:17420`.

Direct native dependencies are pinned to GPUI `0.2.2` and official Wry `0.57.3`, with their resolved graph committed in `Cargo.lock`. Existing `evostack-data/evostack.sqlite3` and `evostack-data/webview` locations are retained. Windows build and packaged smoke must pass for the exact candidate before it is described as verified.

WebView2 construction is scheduled on GPUI's foreground UI executor after the native window and entity exist. The Wry builder runs outside GPUI App/entity update closures, so its nested Win32 message pump does not retain those borrows; a later update installs the completed view. Wry's builder remains synchronous, and WebView2 creation, callbacks and destruction stay on the same UI STA thread. Wry `0.57.3` also propagates environment/controller completion errors to its waiting caller.

The old `tauri` scheme/`http://tauri.localhost` Windows origin is retained for browser-storage compatibility, not as a runtime dependency. Renderer `localStorage`, including `cs_cache_persist`, holds UI state such as open tabs, input history and pane widths separately from SQLite. Preserving both origin and WebView profile keeps that state addressable without a second origin or a storage importer.

| Layer | Responsibility after migration |
| --- | --- |
| GPUI | Application event loop, native window and host lifecycle |
| Wry / WebView2 | React DOM/CSS rendering, browser profile, zoom and page messaging |
| Renderer bridge | Correlated requests, document session isolation and event dispatch through the retained desktop API |
| Rust sidecar supervisor | Version handshake, bounded JSON-RPC pipe, computer helper ownership and shutdown |
| Go | Existing chat, OAuth, business APIs, SQLite schema and network behavior |

The migration preserves the React application and browser styling. It does not convert React components into GPUI-native controls. Windows still uses WebView2, so scrolling, memory use, IME and responsiveness must be compared on the same hardware and profile before making an improvement claim.

### Acceptance on Windows

Run the pinned toolchains and dependencies, then `pnpm verify`. It builds a single candidate and runs source checks, TypeScript tests, Go/Rust tests, contract tests and packaged React interactions. `pnpm package` archives only those verified bytes. A successful unit or cross-compilation check alone does not certify the live Windows GUI.

The packaged smoke validates the Wry bridge, native maximize/restore, renderer reload/reconnection, identity, an isolated WebView profile and owned CDP listener, onboarding, a synthetic provider/chat round trip, partial-output stop, native controls, projection attachment and graceful Go shutdown. The host must be tested on an interactive Windows desktop for the remaining native behaviors:

- Window resize, minimize, maximize/restore, fullscreen, title-bar dragging and close while a reply streams.
- Layout and mouse hit positions at 100%, 125%, 150% and 200% DPI, including moving between monitors with different scaling.
- Chinese/Japanese IME composition, candidate placement, selection, clipboard and focus return from the system browser.
- Light/dark/system theme, WebView background during startup, native zoom and DevTools behavior in the intended build.
- Application reopen with the same existing EvoStack profile, backend exit behavior and absence of orphaned sidecars/helpers.

Use a disposable profile for verification. The migration does not introduce a new database schema or an automatic importer. To compare with the preceding host, keep its complete candidate and a separately copied profile; do not launch two backends against the same profile simultaneously.
