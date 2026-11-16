import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

/** Only the pinned native executable and notices are packaged; its JS SDK is unused. */
export function helperDirectory() {
  const require = createRequire(import.meta.url)
  const file = require.resolve('@cherrystudio/computer-use-win32-x64/package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  if (
    pkg.version !== '0.1.11' ||
    pkg.name !== '@cherrystudio/computer-use-win32-x64' ||
    !pkg.os.includes('win32') ||
    !pkg.cpu.includes('x64')
  )
    throw new Error('Incompatible Windows computer-use helper')
  const directory = dirname(file)
  for (const name of ['runtime/open-computer-use.exe', 'LICENSE', 'THIRD_PARTY_NOTICES.md'])
    if (!statSync(resolve(directory, name)).isFile()) throw new Error(`Missing helper file: ${name}`)
  return directory
}
if (process.argv[1]?.endsWith('helper.mjs')) process.stdout.write(helperDirectory())
