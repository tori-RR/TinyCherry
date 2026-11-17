import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import test from 'node:test'

import { checkDependencyGraph, checkInstalledStore, hasRetiredRuntimeSurface } from '../exit-gate.mjs'
import { root } from '../process.mjs'

await test('exit gate rejects optional, peer and transitive retired runtime dependencies', () => {
  const problems = checkDependencyGraph([
    { importers: { '.': { optionalDependencies: { electron: { version: '1.0.0' } } } } },
    {
      packages: { 'retained@1.0.0': { peerDependencies: { '@electron/toolkit': '*' } } },
      snapshots: { 'retained@1.0.0': { dependencies: { 'electron-updater': '1.0.0' } }, 'app-builder-lib@1.0.0': {} }
    }
  ])
  assert.equal(problems.length, 4)
})
await test('installed dependency checks resolve relative stores from node_modules and also support absolute stores', () => {
  const base = resolve(root, '.cache/desktop-unit-tests')
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(resolve(base, 'store-'))
  const cleanup = () => {
    if (!realpathSync(directory).startsWith(realpathSync(base) + sep)) throw new Error('Fixture escaped test base')
    rmSync(directory, { recursive: true })
  }
  try {
    const store = resolve(directory, 'node_modules/.pnpm')
    mkdirSync(resolve(store, 'electron@1.0.0'), { recursive: true })
    mkdirSync(resolve(store, 'electron-to-chromium@1.0.0'))
    assert.deepEqual(checkInstalledStore(directory, '.pnpm'), ['Retired installed package: electron@1.0.0'])
    assert.deepEqual(checkInstalledStore(directory, store), checkInstalledStore(directory))
  } finally {
    cleanup()
  }
})
await test('the browser compatibility database is not an Electron desktop runtime', () => {
  assert.deepEqual(checkDependencyGraph([{ packages: { 'electron-to-chromium@1.0.0': {} } }]), [])
})
await test('exit gate checks executable/type syntax while allowing comments and fixture text', () => {
  assert.equal(hasRetiredRuntimeSurface('// window.electron is retired\nconst text="window.electron"'), false)
  assert.equal(hasRetiredRuntimeSurface('window["electron"].ipcRenderer.send("fixture")'), true)
  assert.equal(hasRetiredRuntimeSurface('type View = Electron.WebviewTag'), true)
  assert.equal(hasRetiredRuntimeSurface('import { app } from "electron/main"'), true)
})
