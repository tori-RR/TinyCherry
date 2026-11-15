import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HEADER = '# TinyCherry upstream validation hook (managed)'
const CONTENT = `#!/bin/sh
${HEADER}
ROOT=$(git rev-parse --show-toplevel) || exit $?
exec node "$ROOT/scripts/validation/upstream.mjs" --pre-push --remote-url "$2"
`

export function installUpstreamHook(root) {
  const common = realpathSync(
    resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
  )
  const file = resolve(
    root,
    execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], { cwd: root, encoding: 'utf8' }).trim()
  )
  const existing = lstatSync(file, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a symbolic-link pre-push hook')
  let ancestor = dirname(file)
  while (!existsSync(ancestor)) ancestor = dirname(ancestor)
  const destination = relative(common, resolve(realpathSync(ancestor), relative(ancestor, file)))
  if (
    isAbsolute(destination) ||
    destination === '..' ||
    destination.startsWith('../') ||
    destination.startsWith('..\\')
  ) {
    throw new Error('Preserve hooks outside the Git common directory; review external hook integration manually')
  }
  if (existing) {
    const previous = readFileSync(file, 'utf8')
    if (previous === CONTENT) return
    if (!previous.startsWith(`#!/bin/sh\n${HEADER}\n`)) {
      throw new Error('An existing pre-push hook is not managed by TinyCherry; preserve it and review hook integration')
    }
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, CONTENT)
  chmodSync(file, 0o755)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  installUpstreamHook(root)
  process.stdout.write('Installed the TinyCherry upstream pre-push validation hook\n')
}
