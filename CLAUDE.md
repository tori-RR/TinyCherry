# TinyCherry development

TinyCherry targets Windows x64: React/TypeScript in Tauri 2, Rust for system integration, and a private Go sidecar with SQLite. Current capabilities and migration status live in [docs/desktop.md](docs/desktop.md). Future macOS support uses platform adapters, not another desktop runtime.

## Working boundaries

- Read the owning module README and current implementation before changing a contract. Preserve existing behavior, layout and saved preferences unless the task explicitly requests a change. Do not change schema, identifier or profile paths as incidental cleanup.
- Renderer code uses `src/platform/desktop-api` and the typed DataApi/IpcApi facades. Keep transport in `src/platform/tauri` and OS-specific work in the Rust/Go adapters. Do not reintroduce Electron or Electron API emulation; Node remains valid development tooling.
- Validate cross-process input. Preserve profile locking, credential protection, bounded IPC, cancellation, application approval and owned-helper cleanup. Capability flags are not authorization. Never automatically replay mutations, model requests or desktop input.
- Unsupported features stay hidden or show the unavailable route shell; keep their migration status in `docs/desktop.md`.
- Automated tests use synthetic profiles and loopback providers. Synthetic screenshots are allowed; real user databases, keys, browser profiles, chats and sensitive screenshots are not test fixtures or repository content. Tests must not send input to unrelated desktop applications.
- Keep project-owned generated files, caches and test profiles inside the project. Do not implicitly install dependencies or hooks, or change global machine settings.

## Commands and verification

Use the pinned toolchain and the [desktop command guide](scripts/desktop/README.md).

- `pnpm dev` runs the isolated development desktop; `pnpm build` type-checks and compiles a complete candidate.
- `pnpm start` validates and launches the last candidate without installing or rebuilding. `--strict-source` additionally requires the current checkout.
- `pnpm check` selects static checks from the diff. Use `--base <review-base>` for committed changes or `--all` for full static checks; an empty selection is not full verification.
- `pnpm test` runs current tests. `--project` filters only Vitest projects; the native checks still run.
- `pnpm verify` defaults to complete candidate verification and packaging; scoped plans run selected checks. `--stress` opts into ten Go race iterations.
- `pnpm package` archives the same verified, unchanged candidate. Record checks actually run, their revision and material limits.

CI remains manual-only through `workflow_dispatch`. Keep fixes focused and use Conventional Commits. Push only when requested. The root product README stays minimal; private evaluation notes belong in an ignored local log.

Preserve the ignored local `AGENTS.md` and private notes. `AGENTS-og.md` remains an alias to this shared file, not a second copy.
