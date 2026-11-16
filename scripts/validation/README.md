# Validation tooling

`pnpm check --plan` explains the checks and Vitest projects selected by `plan.mjs`.
`pnpm check` executes that plan serially for the default `tauri` target;
`pnpm check:all` runs that target's full gate. Use `--target electron` only for the
separate Electron compatibility inventory. `ci.yml` explicitly selects `--target tauri`.
`lint` only checks lint rules, `lint:fix` applies lint fixes, and `format` formats files.

## Upstream synchronization

Follow the required [upstream synchronization workflow](../../docs/dev/contrib/upstream-sync.md)
before promoting or pushing an upstream integration. `pnpm upstream:verify --base
<target-sha> --upstream <upstream-ref>` validates the committed, clean candidate with
a fresh frozen dependency installation, static checks, the Tauri target's shared tests
on Windows, package contracts, drift/policy checks, native packaging, and final
i18n checks after all local tests. Existing dependencies are backed up under ignored
`.cache/` before installation, restored on installation failure, and retained as a
reported backup on success. Exact-SHA manual runs of both `ci.yml` and
`evostack-windows.yml` remain mandatory before promotion. Results stay under ignored `.cache/` and bind the
commit/tree to the `tauri` target, check set, Node version, and package hashes. Source or artifact
changes require a new result. `pnpm upstream:check` verifies that result;
`pnpm upstream:merge --ref <candidate>` performs validated fast-forward promotion.
Install the dedicated pre-push hook with `pnpm upstream:hooks` in each synchronization
checkout; it verifies every actual non-deletion ref update.

## Change selection

The default comparison is the merge base of `origin/main` and HEAD, plus staged,
unstaged, and untracked files. `--base <parent>` supports stacked branches.
`--committed --base <commit> --head <commit>` compares exact commits for CI;
renames include both old and new paths. Missing history falls back to full validation.

Ordinary Markdown under docs, agent notes, and changesets, root Markdown, source
READMEs, the generated `docs/dev/sources-index.json`, and translation-pairing `.i18n.yaml` sidecars select format and documentation checks. Runtime Markdown under resources
retains full checks. Skill files select the skill gate as well. Unknown inputs,
root configuration, workflow changes, and the planner itself select all tasks.

Source changes select their project and known consumers within the chosen target.
Shared changes select all projects in that target. Renderer `.ts`, `.tsx`, and `.css` changes, including colocated tests, select
the existing UI `theme:check` command in the repository group. This runs in `basic-checks`
without selecting the UI test project or a package-test job. Renderer JSON, test setup,
and mock files outside `src/renderer/` do not add this check. UI package changes retain
their existing project and consumer tests. Source changes retain full lint and i18n scans because imports and translation
references cross file boundaries. Test-only changes omit only scanners that exclude
those paths: catalog coverage ignores `__tests__` but still reads adjacent main tests;
hardcoded detection ignores `__tests__` and `.test.ts(x)`, but not adjacent `.spec.ts(x)`.
Unused-key analysis stays selected because the renderer catalog reads test sources too.
Unclassified/configuration inputs still select the target's full checks. The planner
selects whole projects, except for the explicit shared preload bridge and tooling
inventories; it does not claim that file-level affected tests cover runtime dependencies.

The Tauri inventory retains `renderer`, `shared`, `ui`, `file-preview`,
`provider-registry`, `web-search`, and `remote-protocol`. It also retains
`src/preload/__tests__/preload.test.ts`, because the native entry imports the original
preload bridge through native Electron API shims, and a maintained list of shared
tooling tests from the `scripts` project. Web-search metadata and protocol schemas
are shared inputs; their inclusion does not establish native search or remote Agent support.
Pure provider-filter and computer-tool definitions under `src/main` remain native
generation inputs without bringing in the Electron backend.

## Execution

`--group repository|lint|types|i18n|main|renderer|packages|platform|checks|tests` restricts an
existing plan. `main` selects the shared preload bridge for Tauri; `platform` belongs
to Electron compatibility. `--shard=N/M` forwards Vitest's built-in sharding option; `--max-workers N`
sets an explicit positive worker limit. `--plan --json`
prints a machine-readable plan. Test invocations specify explicit projects;
compilers run serially. Local Vitest defaults to two workers, overridable
through the direct Vitest command or project wrappers' `--maxWorkers` option.
`--max-workers=N` bounds workers without changing the selected tests; the local upstream gate uses two workers with CI lint semantics.
The preload bridge and shared tooling list run separately from unrestricted project
invocations, so selecting their containing projects cannot accidentally run the
entire legacy inventory.

Required workspace packages are built before typechecks and tests. CI setup marks a
successful installation with `VALIDATION_WORKSPACE_PREPARED=true`, so later groups
reuse those exports in the same job. Unprepared local validation still builds them;
Electron main tests still rebuild SQLite for Node. Do not run Electron development and Node tests concurrently in one
worktree. Use isolated worktrees and dependency installations for concurrent agents.

`VALIDATION_PLAN` lets CI execute the exact plan from its classification job.
An explicit `--all` overrides that environment plan; the upstream gate also clears
inherited plan/prepared-workspace flags and sets `CI=true`.
`--github-output` emits that plan and selected job groups without installing dependencies.
Unknown targets, tasks or groups fail before execution. Summary validation rejects failed,
cancelled, missing, or unexpectedly skipped jobs selected by the plan.

## CI

PRs compare the checked-out merge commit with its first parent, so earlier commits
remain covered. Pushes compare the event's before/after range. CI runs only on pushes,
pull requests, and manual dispatch; manual dispatch runs the full plan. Concurrency groups are isolated by event and
PR number or full ref. New PR runs replace earlier runs for that PR; new manual
runs replace earlier manual runs for the same ref. Pushes are not cancelled,
because a later push's affected plan does not cover the earlier push's range.
Pull requests targeting a parent stack branch also run CI.

`Cancel closed PR CI` requests cancellation of unfinished PR and feature-branch
manual CI after a PR closes. It reads current PR state and runs only trusted
inline API calls, without checking out PR code. Cleanup matches the head repository
and branch, considers runs created during the PR's lifetime, and stops if the PR
reopens or another PR on that head remains open. Pushes, schedules, completed runs,
reruns started after closure, and manual runs on the default or `release/v*`
branches remain untouched.

Repository, typecheck, lint and i18n groups share one dependency installation in
`basic-checks`, with separate plan conditions and step outcomes; later groups still
run after an earlier group fails. The classification job first checks workflows and
formatting with the pinned tools, without installing workspace dependencies. Failed
planning or preflight prevents heavy jobs from starting; required gates still report
the failure.

The stable `main-test-shard` job runs only the shared preload bridge on Windows,
without sharding. Renderer uses three Windows Vitest shards with fail-fast disabled.
The separate Windows package job runs the shared packages and the explicit tooling
inventory. There is no Electron platform-contract job in Tauri CI. Ubuntu jobs perform
static checks, classification, and result aggregation; they do not run Linux application
tests. Manual full CI covers the complete Tauri target.

`electron-compat.yml` is a separate Windows-only manual workflow using
`pnpm check --all --target electron`. It retains the complete legacy Vitest inventory,
including Electron main/preload, AI engines, Agent runtimes, remote transport and
desktop controller tests. Its results do not block Tauri mainline validation.

`evostack-windows.yml` separately validates Go race behavior, the native build, IPC
contracts, and Portable startup for relevant `main`/`evostack` pushes and pull requests,
as well as manual dispatch. Protected promotion and pushes require the exact SHA's latest
manual run of both workflows to succeed. Electron compatibility success cannot replace
either result. The local upstream gate runs all Tauri-related Vitest coverage through
`pnpm check --target tauri --all --group tests --max-workers=2`, then checks
the Web Search and Provider Registry package contracts before packaging.
The native build validates Go/Rust, real temporary SQLite databases, JSON-RPC and
renderer contracts, and actual packaged Tauri startup. Synthetic computer-tool tests
do not send desktop input and do not establish real-action acceptance; native Agent
and MCP execution are not covered. The separate Electron regression workflow is
Windows-only and manual-only; it validates configuration consumed by selected cases
without requiring unrelated CherryIN or embedding fields.

The required `basic-checks`, `general-test`, and `render-test` names remain stable.
Their verifier requires classification to succeed, checks every planned job, and
accepts a skipped dependency only when the plan explicitly excludes it. The basic
gate also checks all four group outcomes in the same job, rejecting missing or
unexpectedly skipped work even if that job reports success. Provider generation,
changeset policy, and catalog edit guards remain CI checks.

## Performance observations

The `CI Performance` workflow is disabled in repository Actions settings; its
collection scripts remain available for on-demand analysis. When enabled, the
workflow runs after CI completes and reads job/step timestamps through the GitHub
API. It checks out only the default branch, never the measured PR's code, and needs
no dependency installation. It has read-only permissions and is not a required
check; collection failures do not fail the CI gate.

The classification/preflight job declares its dependency-store cache state as
`not-used`; transient formatter downloads are not dependency-store cache hits.

The summary and 30-day JSON artifact preserve initial queue time, execution window,
total elapsed time, and the sum of job durations. The latter is runner time, not billed
minutes; the execution window includes later waits. Per-job created/start/end timestamps,
created-to-start scheduling waits, execution durations and P50/P90/max distributions expose
later queues. Run-to-job-creation time includes dependencies and orchestration, not isolated
dependency wait; scheduling intervals do not establish a runner-capacity cause. Without
the measured dependency graph, no critical path is inferred. Missing/inconsistent times
remain unavailable with sample counts; parallel intervals are not summed as wall time.
Wait and total elapsed metrics are omitted for reruns because timestamps can span attempts.
Existing JSON fields and baseline keys are retained. Individual step durations support
installation/cache analysis.

Baseline P50/P90 values use matching successful runs from the latest 20 successful
runs of the same CI workflow/event, before the measured run. Comparisons require the
same task/project scope hash, executed jobs, runner labels, and known cache states.
Exact dependency-store hits are marked; misses, fallback restores, or missing cache
instrumentation remain unknown and are excluded from baselines. Cache state here
refers only to the pnpm store, not to every build/runtime cache. Old workflows without
scope metadata are reported without comparison. Failed/cancelled runs never become
baseline samples. The report shows sample size and applies no regression threshold.

This observes ordinary CI work without rerunning tests. Controlled repeated benchmarks
and local 1/2/4-worktree contention tests remain separate from this observer.
