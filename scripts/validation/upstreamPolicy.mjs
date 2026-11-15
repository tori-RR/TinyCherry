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
  'platform-test',
  'general-test',
  'render-test'
]

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
