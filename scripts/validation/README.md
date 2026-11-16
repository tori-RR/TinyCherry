# Verification selection

`plan.mjs` selects current Tauri checks by changed paths. Documentation selects link/whitespace checks. Renderer changes select static and component tests. Shared contracts, native code and toolchain inputs select a compiled candidate, contracts and real packaged startup. Unknown paths select complete verification. Deleted and renamed paths participate in selection.

The root commands are implemented in [../desktop](../desktop/README.md). There is one current product target, no scheduled CI, no compatibility application, no installation in Git hooks and no public-package release policy gate.
