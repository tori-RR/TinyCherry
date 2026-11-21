import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

import { root } from './process.mjs'

export function validateWorkflow(workflow, name = 'workflow') {
  const triggers =
    typeof workflow.on === 'string'
      ? [workflow.on]
      : Array.isArray(workflow.on)
        ? workflow.on
        : Object.keys(workflow.on ?? {})
  const manual = triggers.length === 1 && triggers[0] === 'workflow_dispatch'
  const candidateBranches = ['GPT/GPUI', 'GPT/CandyBack']
  const branches = workflow.on?.push?.branches
  const experimentalPush =
    name === 'desktop-build.yml' &&
    JSON.stringify([...triggers].sort()) === JSON.stringify(['push', 'workflow_dispatch']) &&
    JSON.stringify(Object.keys(workflow.on.push ?? {})) === JSON.stringify(['branches']) &&
    Array.isArray(branches) &&
    branches.length > 0 &&
    new Set(branches).size === branches.length &&
    branches.every((branch) => candidateBranches.includes(branch))
  if (!manual && !experimentalPush)
    throw new Error(`Only manual dispatch or explicitly named desktop candidate branches are allowed: ${name}`)
  for (const job of Object.values(workflow.jobs ?? {}))
    if (job['runs-on'] !== 'windows-2025') throw new Error(`Unsupported CI runner: ${name}`)
}

export function checkWorkflows() {
  const directory = resolve(root, '.github/workflows')
  const names = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
  if (JSON.stringify(names) !== JSON.stringify(['ci.yml', 'desktop-build.yml']))
    throw new Error('Only current desktop workflows may be active')
  for (const name of names) {
    const workflow = parse(readFileSync(resolve(directory, name), 'utf8'))
    validateWorkflow(workflow, name)
  }
  execFileSync(
    process.env.ACTIONLINT ?? 'actionlint',
    ['-shellcheck=', '-pyflakes=', ...names.map((name) => resolve(directory, name))],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  )
}
