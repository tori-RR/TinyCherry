# Desktop commands

The root `dev`, `build`, `start`, `package`, `check`, `test` and `verify` commands serve one Tauri/Rust/Go application. Build creates a complete candidate; verify tests that candidate; package archives the same bytes. Start validates an existing candidate and never installs or rebuilds it.

Development uses an isolated project-local profile and an owned loopback Vite server. Production retains the portable profile next to the executable. Tests use synthetic, disposable profiles. Neither command imports an old desktop database.

Checks are selected by the changed paths. Documentation does not start Go, Rust or a WebView. Cross-process contracts and build inputs select native contracts and real packaged startup. Ordinary Go race checks run once; `verify --stress` requests ten iterations.

`pnpm check:staged` checks staged source formatting and lint on request. Installation, checkout and merge do not install dependencies or Git hooks. A fresh root command creates a local `.gitignore` from the generic template only when no local policy exists.

Before installing in a fresh checkout, copy `.gitignore.template` to `.gitignore` if that local file is absent. Static workflow checks require the pinned `actionlint` executable on PATH or in `ACTIONLINT`; native verification also requires Go, Rust/MSVC, WebView2 and a MinGW-w64 compiler for the Go race detector.
