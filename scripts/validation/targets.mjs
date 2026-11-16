import { lstatSync } from 'node:fs'
import { join } from 'node:path'

export const VALIDATION_TARGETS = Object.freeze(['tauri', 'electron'])

export const TAURI_PROJECTS = Object.freeze([
  'preload',
  'renderer',
  'ui',
  'file-preview',
  'shared',
  'provider-registry',
  'web-search',
  'scripts',
  'remote-protocol'
])

export const TAURI_TASKS = Object.freeze([
  'format',
  'docs',
  'skills',
  'knowledge',
  'theme',
  'lint',
  'types-web',
  'types-tauri',
  'types-remote-protocol',
  'types-web-search',
  'types-file-preview',
  'i18n-catalog',
  'i18n-unused',
  'i18n-hardcoded'
])

// These are tooling contracts, including the retained manual Electron controller.
// Launch/install/physical desktop adapters and legacy release tests stay in electron.
export const TAURI_TOOLING_TESTS = Object.freeze([
  'scripts/__tests__/validationPlan.test.ts',
  'scripts/__tests__/validationWorkflow.test.ts',
  'scripts/__tests__/evostackWorkflow.test.ts',
  'scripts/__tests__/validationMetrics.test.ts',
  'scripts/__tests__/upstreamWorkflow.test.ts',
  'scripts/__tests__/upstreamValidation.test.ts',
  'scripts/__tests__/upstreamState.test.ts',
  'scripts/__tests__/upstreamDependencies.test.ts',
  'scripts/__tests__/changeset-policy.test.ts',
  'scripts/__tests__/generate-system-provider-ids.test.ts',
  'scripts/__tests__/painting-template-catalog.test.ts',
  'scripts/__tests__/i18n-plurals.test.ts',
  'scripts/__tests__/i18n-main-keys.test.ts',
  'scripts/__tests__/i18n-check-values.test.ts',
  'scripts/__tests__/i18n-check-unused.test.ts',
  'scripts/__tests__/i18n-check-hardcoded-strings.test.ts',
  'scripts/__tests__/i18n-check-hardcoded-strings.catalog.test.ts',
  'scripts/docsGovernance/__tests__/change-scope.test.ts',
  'scripts/docsGovernance/__tests__/find-affected-docs.test.ts',
  'scripts/docsGovernance/__tests__/gen-doc-index.test.ts',
  'scripts/docsGovernance/__tests__/gen-doc-terminology.test.ts',
  'scripts/docsGovernance/__tests__/translation-pairing.test.ts',
  'scripts/docsGovernance/__tests__/verify-doc-frontmatter.test.ts',
  'scripts/docsGovernance/__tests__/verify-doc-structure.test.ts',
  'scripts/generate-cherry-assistant-knowledge/__tests__/guide.test.ts',
  'scripts/generate-cherry-assistant-knowledge/__tests__/manifest.test.ts',
  'scripts/uiContract/__tests__/maintainedAnchors.test.ts',
  'scripts/uiContract/__tests__/transform.test.ts',
  'scripts/uiContract/__tests__/uiDataSlot.test.ts',
  'scripts/lint/__tests__/scroll-area.test.ts',
  'scripts/e2e/regression/__tests__/config.test.ts',
  'scripts/e2e/regression/__tests__/cases.test.ts',
  'scripts/e2e/regression/__tests__/report.test.ts',
  'scripts/e2e/regression/__tests__/reportBundle.test.ts',
  'scripts/e2e/regression/__tests__/taskSelection.test.ts',
  'scripts/e2e/regression/__tests__/mockProvider.test.ts',
  'scripts/e2e/regression/__tests__/redaction.test.ts',
  'scripts/e2e/ondemand/__tests__/plan.test.ts',
  'scripts/e2e/ondemand/__tests__/report.test.ts',
  'scripts/e2e/ondemand/__tests__/workflow.test.ts'
])

export function testInvocations(plan, projects = plan.projects) {
  if (plan.target === 'electron') return [{ projects, files: [] }]
  // Vitest's positional filters apply to every project in an invocation.
  // Isolate the two limited projects so their filters cannot suppress UI tests.
  return [
    { projects: projects.filter((project) => !['preload', 'scripts'].includes(project)), files: [] },
    {
      projects: projects.filter((project) => project === 'preload'),
      files: ['src/preload/__tests__/preload.test.ts']
    },
    { projects: projects.filter((project) => project === 'scripts'), files: TAURI_TOOLING_TESTS }
  ].filter((invocation) => invocation.projects.length)
}

export function assertTestFiles(root, invocations) {
  for (const { files } of invocations)
    for (const file of files)
      if (!lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile())
        throw new Error(`Missing validation test: ${file}`)
}
