# TinyCherry development

TinyCherry ships one Windows x64 desktop application: React/TypeScript in Tauri 2, Rust for system integration, and a private Go sidecar with SQLite. The app identifier and portable profile schema are stable.

## Working boundaries

- Read the module README before changing its contracts. Preserve the existing React layout and saved preferences.
- Renderer code uses `src/platform/desktop-api` and the typed DataApi/IpcApi facades. Validate data crossing a process boundary. Keep platform-specific code in `src/platform/tauri` and the Rust/Go system adapters.
- Do not add a second desktop runtime, runtime shims, automatic dependency installation, or Git hooks. `pnpm check:staged` optionally checks staged formatting/lint; it installs no hooks.
- Unsupported features stay hidden or show the unavailable route shell. Keep their migration status in [docs/desktop.md](docs/desktop.md). A UI capability flag never grants desktop control.
- Use synthetic profiles and loopback provider fixtures for automated tests. Never copy an existing user database, key, browser profile, screenshot or chat into tests or the repository.
- Preserve profile locking, DPAPI protection, bounded IPC, cancellation, application approval and owned-helper cleanup. Never replay mutations or desktop input automatically.

## Commands and verification

Use the pinned Node and pnpm versions. All generated files, temporary data and caches belong inside the project.

- `pnpm dev`: isolated Vite/Tauri/Go development environment with React HMR.
- `pnpm build`: type-check and compile a complete candidate.
- `pnpm start`: validate and launch that candidate without installing or rebuilding.
- `pnpm check`: selected static checks. `--all` checks current production sources.
- `pnpm test`: current TypeScript, Go and Rust tests; no real provider or desktop input.
- `pnpm verify`: build once, run the current checks, validate contracts, test actual packaged startup and archive the same bytes. `--stress` opts into ten Go race iterations.
- `pnpm package`: archive an already verified, unchanged candidate.

CI has no schedule. `ci.yml` selects Windows checks by changed paths; `desktop-build.yml` is the manual complete candidate workflow. Unknown paths select full verification. Read [scripts/desktop/README.md](scripts/desktop/README.md) for lifecycle and candidate ownership.

Keep fixes focused, verify the changed behavior, and commit using Conventional Commits. Push only when requested. The root README contains the product introduction; private evaluation notes belong in an ignored local log.
