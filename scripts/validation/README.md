# Verification selection

`plan.mjs` selects current Tauri checks by changed paths. Documentation selects link/whitespace checks. Renderer changes select static and component tests. Shared contracts, native code and toolchain inputs select a compiled candidate, contracts and real packaged startup. Unknown paths select complete verification. Deleted and renamed paths participate in selection.

The root commands are implemented in [../desktop](../desktop/README.md). Both Windows workflows are manual-only. The selected plan is a JSON file; cross-job outputs contain boolean flags rather than path lists or reasons. Missing/invalid plan files fail verification. There is one current product target, no compatibility application, no installation in Git hooks and no public-package release policy gate.
