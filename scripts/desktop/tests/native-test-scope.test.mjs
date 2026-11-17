import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

import { root } from '../process.mjs'

const nativeFile = 'src/renderer/data/__tests__/DataApiService.nativeMutation.test.ts'
function collectWithoutBackend(project) {
  const env = { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' }
  delete env.EVOSTACK_BACKEND_EXECUTABLE
  const result = spawnSync(
    process.execPath,
    [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--project', project, nativeFile],
    { cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true }
  )
  assert.ifError(result.error)
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

await test('ordinary renderer tests do not collect native backend integration cases', () => {
  const result = collectWithoutBackend('renderer')
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /No test files found/)
  assert.doesNotMatch(result.output, /EVOSTACK_BACKEND_EXECUTABLE is required/)
})

await test('the native contract project cannot silently pass without its backend', () => {
  const result = collectWithoutBackend('native-contract')
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /No projects (?:matched|were found)/)
})
