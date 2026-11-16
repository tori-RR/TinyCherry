# Desktop commands

The root `dev`, `build`, `start`, `package`, `check`, `test` and `verify` commands serve one Tauri/Rust/Go application. Build creates a complete candidate; verify tests that candidate; package archives the same bytes. Start validates an existing candidate and never installs or rebuilds it.

Development uses an isolated project-local profile and an owned loopback Vite server. Production retains the portable profile next to the executable. Tests use synthetic, disposable profiles. Neither command imports an old desktop database.

Checks are selected by the changed paths. Documentation does not start Go, Rust or a WebView. Cross-process contracts and build inputs select native contracts and real packaged startup. Ordinary Go race checks run once; `verify --stress` requests ten iterations.

GitHub Actions runs only when started manually. `Desktop Checks (Manual)` accepts an optional base commit/ref; leaving it blank selects complete checks. `Windows Desktop Candidate` always verifies and packages a complete candidate. Pushes, pull requests and schedules do not start either workflow.

`pnpm validation:plan --base <ref>` writes `.cache/validation/plan.json`; omit the base to select complete checks. Run it with `pnpm verify --plan-file .cache/validation/plan.json` (or `pnpm check --plan-file ...` for static checks). CI uploads only this plan file and downloads it in the dependent job. Job outputs contain three boolean flags; CI never passes path lists or reasons through outputs, environment variables or command-line JSON. Invalid/missing plan files fail instead of silently skipping verification.

`pnpm check:staged` checks staged source formatting and lint on request. Installation, checkout and merge do not install dependencies or Git hooks. A fresh root command creates a local `.gitignore` from the generic template only when no local policy exists.

Before installing in a fresh checkout, copy `.gitignore.template` to `.gitignore` if that local file is absent. Static workflow checks require the pinned `actionlint` executable on PATH or in `ACTIONLINT`; native verification also requires Go, Rust/MSVC, WebView2 and a MinGW-w64 compiler for the Go race detector.
