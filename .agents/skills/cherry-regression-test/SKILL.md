---
name: cherry-regression-test
description: Run selected legacy Electron regression scenarios through the repository's manual Windows Playwright workflow. Use for an explicitly requested Electron compatibility check or named cherry-regression-test task; this workflow does not validate the Tauri application.
---

# Cherry Regression Test

Run the requested Playwright scenarios against one driver-owned Electron process
on Windows. Use this compatibility workflow separately from Tauri mainline validation.
Select the requested module or focused task; do not dispatch the full suite for an
ordinary change or treat an Electron result as native acceptance.

## CI contract

Use the manual-only, Windows-only `.github/workflows/e2e-regression-test.yml` entry point. It:

1. Resolves a trusted branch or release tag.
2. Initializes an isolated directory under the GitHub runner temporary folder.
3. Installs the application and code tools under test.
4. Launches one owned Electron process with CDP enabled.
5. Runs selected cases in `tests/e2e/regression/phases/*.test.ts` in manifest order.
6. Continues after a failed phase so later results are still collected.
7. Produces English Windows and aggregate reports, then enforces the verdict.
8. Stops only the Electron process recorded in the isolated run directory.

Do not add an LLM tool loop, MCP control server, turn limit, or a second
Electron launch for each test. Restart only where the case contract verifies
persistence or switches from the clean startup profile to the authenticated profile.

Native acceptance requires the exact candidate SHA's successful `ci.yml` Tauri
validation and `evostack-windows.yml` native build, contract and startup checks.
Electron Agent/MCP scenarios do not establish native Agent/MCP execution support.
Synthetic native computer-tool contracts do not prove real desktop actions.

## Configuration

Read `scripts/e2e/regression/config.ts` and resolve the selected cases before
checking their configuration. Preflight requires only fields those cases consume:

- Custom-provider chat requires the OpenAI and Anthropic endpoint URLs, shared API key and chat model.
- CherryIN chat/image cases require the account, password and matching model.
- Startup and local-only cases require neither provider's unrelated fields.

Embedding configuration is declared separately, but current cases do not consume it,
so even `all` does not require it. A helper accessing an actually missing field still
fails explicitly. Never print credentials, write them to fixtures, attach them to
Playwright artifacts, or pass them to an unrelated action.

## Test organization

Read [scenario organization](../../../tests/e2e/regression/README.md) and the
[controller contract](../../../scripts/e2e/regression/README.md) before making changes.

Register each case from the manifest:

```ts
test(...caseDefinition('S-01'), async ({ mainWindow }) => {
  // Assert the user-visible outcome.
})
```

`cases.ts` owns case IDs, titles, task tags, phases and capability requirements.
The workflow delegates task selection to the controller. Prefer accessible roles,
labels, placeholders, test IDs and visible text. Native dialogs and cross-application
interactions use the repository-owned helpers in `systemAutomation.ts`.

Record assertions in Playwright. The custom reporter writes case and phase status
into `run.json` and feeds Markdown/JUnit reports. Executor errors and interrupted
phases block a passing verdict. Do not enable credential-bearing Playwright Trace.
A passing result does not depend on a model's judgment.

## Focused execution

For the create-and-save Notes flow, initialize with `--task notes-smoke` (`N-01`).
`--task notes` selects all implemented Notes cases across phases. With the selected
run initialized and its owned Electron process running:

```powershell
$runDir = Join-Path $PWD '.cache/e2e-regression/notes-smoke'
pnpm exec tsx scripts/e2e/regression/cli.ts run-phase `
  --run-dir $runDir --phase basicFeatures
```

Enumeration is read-only. Set an absolute run path; no initialized run directory
or running Electron process is required for `--list`:

```powershell
$env:CHERRY_TEST_RUN_DIR = Join-Path $PWD '.cache/e2e-regression/list'
pnpm test:e2e:regression --list
```

Do not call regression cleanup for an instance owned by `cherry-electron-dev`.
Cleanup is only for an application record created by this driver.

## Verification when changing the framework

Run focused controller tests and enumerate Playwright cases:

```powershell
pnpm exec vitest run --project scripts scripts/e2e/regression
$env:CHERRY_TEST_RUN_DIR = Join-Path $PWD '.cache/e2e-regression/list'
pnpm test:e2e:regression --list
pnpm typecheck:e2e
pnpm test:lint
```

These checks do not prove desktop permissions, external model availability or a
successful E2E run. Do not use `pnpm test` or `pnpm build:check` for this focused change.
