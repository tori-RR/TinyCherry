import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from 'yaml'

import { changedFiles } from './plan.mjs'

const upstreamGuard = "github.repository == 'CherryHQ/cherry-studio'"
const requiredCiJobs = [
  'changes',
  'basic-checks',
  'main-test-shard',
  'renderer-test-shard',
  'package-test',
  'general-test',
  'render-test'
]

function requireWindowsJob(job, name) {
  const runner = job?.['runs-on']
  const axis = typeof runner === 'string' && runner.match(/^\$\{\{\s*matrix\.(\w+)\s*\}\}$/)?.[1]
  const matrix = job?.strategy?.matrix
  const runners = axis
    ? [
        ...(Array.isArray(matrix?.[axis]) ? matrix[axis] : []),
        ...(matrix?.include ?? []).filter((entry) => Object.hasOwn(entry, axis)).map((entry) => entry[axis])
      ]
    : [runner]
  if (
    !Array.isArray(runners) ||
    !runners.length ||
    runners.some((value) => typeof value !== 'string' || !value.startsWith('windows-'))
  ) {
    throw new Error(`${name} must execute tests on Windows runners only`)
  }
}

// The owner check must be a mandatory top-level conjunction, never bypassed by OR.
function requiresUpstreamRepository(condition) {
  if (typeof condition !== 'string') return false
  const expression = condition.trim().replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const terms = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index]
    if (character === "'") {
      if (quoted && expression[index + 1] === "'") index++
      else quoted = !quoted
      continue
    }
    if (quoted) continue
    if (character === '(') depth++
    if (character === ')') depth--
    if (depth < 0) return false
    if (depth !== 0) continue
    if (expression.slice(index, index + 2) === '||') return false
    if (expression.slice(index, index + 2) === '&&') {
      terms.push(expression.slice(start, index).trim())
      start = index + 2
      index++
    }
  }
  if (quoted || depth !== 0) return false
  terms.push(expression.slice(start).trim())
  return terms.includes(upstreamGuard)
}

export function checkWorkflowPolicy(root) {
  const registry = parse(readFileSync(join(root, '.github/workflows/sync-registry-data.yml'), 'utf8'))
  const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'))
  for (const [name, job] of [
    ['sync-registry-data.sync', registry.jobs?.sync],
    ['ci.notify', ci.jobs?.notify]
  ]) {
    if (!requiresUpstreamRepository(job?.if)) throw new Error(`${name} must require the upstream repository guard`)
  }
  for (const name of requiredCiJobs) {
    const job = ci.jobs?.[name]
    if (!job || !Array.isArray(job.steps) || job.steps.length === 0)
      throw new Error(`Required CI job is missing: ${name}`)
    if (job.if === false || job.if === 'false' || /github\.(?:repository|repository_owner)\b/.test(job.if ?? ''))
      throw new Error(`Required CI job must remain enabled for forks: ${name}`)
  }
  for (const name of ['main-test-shard', 'renderer-test-shard', 'package-test']) {
    requireWindowsJob(ci.jobs[name], `ci.${name}`)
  }
  if (Object.hasOwn(ci.on?.workflow_dispatch?.inputs ?? {}, 'target')) {
    throw new Error('Main CI must use the fixed Tauri target')
  }
  const validationCommands = Object.values(ci.jobs).flatMap((job) =>
    (job.steps ?? []).flatMap((step) =>
      (step.run ?? '').split('\n').filter((line) => /\b(?:pnpm check|node scripts\/validation\/run\.mjs)\b/.test(line))
    )
  )
  if (!validationCommands.length || validationCommands.some((line) => !/--target tauri(?:\s|$)/.test(line))) {
    throw new Error('Main CI must use the fixed Tauri target')
  }
  const compatibility = parse(readFileSync(join(root, '.github/workflows/electron-compat.yml'), 'utf8'))
  if (
    Object.keys(compatibility.on ?? {}).join(',') !== 'workflow_dispatch' ||
    !Object.keys(compatibility.jobs ?? {}).length
  ) {
    throw new Error('Electron compatibility validation must remain manual-only')
  }
  for (const [name, job] of Object.entries(compatibility.jobs ?? {})) {
    requireWindowsJob(job, `electron-compat.${name}`)
  }
  const e2e = parse(readFileSync(join(root, '.github/workflows/e2e-regression-test.yml'), 'utf8'))
  if (Object.keys(e2e.on ?? {}).join(',') !== 'workflow_dispatch') {
    throw new Error('Full Electron E2E must remain manual-only')
  }
  requireWindowsJob(e2e.jobs?.test, 'e2e.test')
  const native = parse(readFileSync(join(root, '.github/workflows/evostack-windows.yml'), 'utf8'))
  for (const event of ['push', 'pull_request']) {
    if (!native.on?.[event]?.branches?.includes('main')) {
      throw new Error(`EvoStack native validation must include main ${event} events`)
    }
  }
  if (!Object.hasOwn(native.on ?? {}, 'workflow_dispatch')) {
    throw new Error('EvoStack native validation must allow exact-commit manual dispatch')
  }
  requireWindowsJob(native.jobs?.portable, 'evostack.portable')
  const qa = parse(readFileSync(join(root, '.github/workflows/qa-ondemand.yml'), 'utf8'))
  const platforms = qa.on?.workflow_dispatch?.inputs?.platform?.options
  if (!Array.isArray(platforms) || platforms.length !== 1 || platforms[0] !== 'windows') {
    throw new Error('On-demand QA must offer the Windows test target only')
  }
}

export function checkCatalogPolicy(root, base) {
  const files = changedFiles(root, base, 'HEAD', false)
  const dataChanged = files.some((file) => file.startsWith('packages/provider-registry/data/'))
  const sourceChanged = files.some(
    (file) =>
      file.startsWith('packages/provider-registry/src/') || file.startsWith('packages/provider-registry/scripts/')
  )
  if (dataChanged && !sourceChanged)
    throw new Error('Generated provider catalog changed without provider source or scripts; regenerate from source')
}
