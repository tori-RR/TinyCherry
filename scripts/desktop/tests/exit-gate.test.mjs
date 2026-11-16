import assert from 'node:assert/strict'
import test from 'node:test'

import { checkDependencyGraph, hasRetiredRuntimeSurface } from '../exit-gate.mjs'

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
await test('the browser compatibility database is not an Electron desktop runtime', () => {
  assert.deepEqual(checkDependencyGraph([{ packages: { 'electron-to-chromium@1.0.0': {} } }]), [])
})
await test('exit gate checks executable/type syntax while allowing comments and fixture text', () => {
  assert.equal(hasRetiredRuntimeSurface('// window.electron is retired\nconst text="window.electron"'), false)
  assert.equal(hasRetiredRuntimeSurface('window["electron"].ipcRenderer.send("fixture")'), true)
  assert.equal(hasRetiredRuntimeSurface('type View = Electron.WebviewTag'), true)
  assert.equal(hasRetiredRuntimeSurface('import { app } from "electron/main"'), true)
})
