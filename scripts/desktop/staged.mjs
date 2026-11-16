import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { prepareEnvironment } from './environment.mjs'
import { pnpm, root } from './process.mjs'

prepareEnvironment()
const files = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
  cwd: root,
  encoding: 'utf8'
})
  .split('\0')
  .filter((file) => file && existsSync(resolve(root, file)))
for (let index = 0; index < files.length; index += 60) {
  const batch = files.slice(index, index + 60)
  const source = batch.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
  const formatted = batch.filter((file) => /\.(?:[cm]?[jt]sx?|json|ya?ml|css|html)$/.test(file))
  if (formatted.length)
    await pnpm(['exec', 'oxfmt', '--check', '--no-error-on-unmatched-pattern', ...formatted]).completion
  if (source.length) await pnpm(['exec', 'oxlint', ...source]).completion
}
