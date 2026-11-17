# Desktop commands

The root `dev`, `build`, `start`, `package`, `check`, `test` and `verify` commands serve one Tauri/Rust/Go application. Build creates a complete candidate; verify tests that candidate; package archives the same bytes. Start validates and launches the last complete candidate, displaying its version/revision without scanning current source. It never installs or rebuilds. `pnpm start --strict-source` also requires the candidate to match the current checkout. Build, verify and package always require that match. Every launch checks file hashes, allowed paths, architecture/protocol and host/backend identities; build-info calls have a bounded timeout.

Candidate promotion atomically replaces `dist/current.json` only after candidate validation. Failed promotion preserves the previous pointer; failed compilation never promotes a partial candidate.

Development uses an isolated project-local profile and an owned loopback Vite server. Production retains the portable profile next to the executable. Tests use synthetic, disposable profiles. Neither command imports an old desktop database.

Development propagates the first generation, compiler, Vite or host failure after owned cleanup. Cleanup errors are reported alongside that failure. Explicit cancellation stops pending stages without launching another host; cancellation alone is not an operational error. The dev lifecycle tests use synthetic process adapters with real local readiness and file watching; they do not certify a live GUI restart or console Ctrl+C.

Checks are selected by the changed paths. Documentation does not start Go, Rust or a WebView. Cross-process contracts and build inputs select native contracts and real packaged startup. Ordinary Go race checks run once; `verify --stress` requests ten iterations.

Ordinary TypeScript projects exclude the native mutation integration suite. The contract phase supplies the staged Go executable and runs that suite through the separate `native-contract` project. A missing executable is an error in that suite; it is not reported as skipped unit tests.

Verification checks packaged startup immediately after building, then runs the selected tests and contracts. It records the exact candidate's verification stamp only after those checks pass. Startup runs once, and packaging archives the same unchanged candidate.

GitHub Actions runs only when started manually. `Desktop Checks (Manual)` accepts an optional base commit/ref; leaving it blank selects complete checks. `Windows Desktop Candidate` always verifies and packages a complete candidate. Pushes, pull requests and schedules do not start either workflow.

`pnpm validation:plan --base <ref>` writes `.cache/validation/plan.json`; omit the base to select complete checks. Run it with `pnpm verify --plan-file .cache/validation/plan.json` (or `pnpm check --plan-file ...` for static checks). CI uploads only this plan file and downloads it in the dependent job. Job outputs contain three boolean flags; CI never passes path lists or reasons through outputs, environment variables or command-line JSON. Invalid/missing plan files fail instead of silently skipping verification.

`pnpm check:staged` checks staged source formatting and lint on request. Installation, checkout and merge do not install dependencies or Git hooks. A fresh root command creates a local `.gitignore` from the generic template only when no local policy exists.

Before installing in a fresh checkout, copy `.gitignore.template` to `.gitignore` if that local file is absent. Static workflow checks require the pinned `actionlint` executable on PATH or in `ACTIONLINT`; native verification also requires Go, Rust/MSVC, WebView2 and a MinGW-w64 compiler for the Go race detector.
