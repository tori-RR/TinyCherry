import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parse } from 'yaml'

import { root } from './process.mjs'

export function checkWorkflows() {
  const directory = resolve(root, '.github/workflows')
  const names = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
  if (JSON.stringify(names) !== JSON.stringify(['ci.yml', 'desktop-build.yml']))
    throw new Error('Only current desktop workflows may be active')
  for (const name of names) {
    const workflow = parse(readFileSync(resolve(directory, name), 'utf8'))
    if (!workflow.on || workflow.on.schedule) throw new Error(`Unexpected schedule: ${name}`)
    for (const job of Object.values(workflow.jobs ?? {}))
      if (job['runs-on'] !== 'windows-2025') throw new Error(`Unsupported CI runner: ${name}`)
  }
  execFileSync(
    process.env.ACTIONLINT ?? 'actionlint',
    ['-shellcheck=', '-pyflakes=', ...names.map((name) => resolve(directory, name))],
    { cwd: root, stdio: 'inherit', windowsHide: true }
  )
}
