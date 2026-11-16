import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'

import ts from 'typescript'

import { root } from '../process.mjs'

await test('every desktop type-check resolves protocol entries from this checkout without workspace dist', () => {
  const host = {
    ...ts.sys,
    fileExists(file) {
      const path = file.replaceAll('\\', '/')
      if (/\/(?:packages|node_modules\/@cherrystudio)\/[^/]+\/dist(?:\/|$)/i.test(path)) return false
      return ts.sys.fileExists(file)
    }
  }
  for (const config of [
    'tsconfig.web.json',
    'tsconfig.tauri.json',
    'src/renderer/tsconfig.json',
    'src/shared/tsconfig.json'
  ]) {
    const file = resolve(root, config)
    const { config: value, error } = ts.readConfigFile(file, ts.sys.readFile)
    assert(!error, config)
    const parsed = ts.parseJsonConfigFileContent(value, ts.sys, resolve(file, '..'))
    assert.equal(parsed.errors.length, 0, config)
    for (const entry of ['', '/agent', '/failure', '/configuration']) {
      const specifier = `@cherrystudio/remote-protocol${entry}`
      const resolved = ts.resolveModuleName(
        specifier,
        resolve(root, 'src/shared/ipc/schemas/ai.ts'),
        parsed.options,
        host
      ).resolvedModule
      assert(resolved, `${config}: ${specifier} must resolve without generated output`)
      assert.equal(
        resolved.resolvedFileName.replaceAll('\\', '/'),
        resolve(root, `packages/remote-protocol/src/${entry.slice(1) || 'index'}.ts`).replaceAll('\\', '/')
      )
    }
  }
})
