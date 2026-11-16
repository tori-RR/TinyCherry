import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import test from 'node:test'

import { currentCandidate, hash, isBuildInput, productFiles, sourceIdentity, validateCandidate } from '../candidate.mjs'
import { root } from '../process.mjs'

const base = resolve(root, '.cache/desktop-unit-tests')
mkdirSync(base, { recursive: true })
function cleanFixture(directory) {
  if (!realpathSync(directory).startsWith(realpathSync(base) + sep)) throw new Error('Fixture escaped test directory')
  rmSync(directory, { recursive: true })
}
function fixture(action) {
  const directory = mkdtempSync(resolve(base, 'candidate-'))
  try {
    for (const name of productFiles) writeFileSync(resolve(directory, name), `synthetic ${name}`)
    const manifest = {
      schema: 1,
      target: 'windows-x64',
      protocol: 1,
      version: '0.0.0-test',
      revision: 'fixture',
      sourceHash: 'test-source',
      files: productFiles.map((name) => ({
        name,
        bytes: readFileSync(resolve(directory, name)).length,
        sha256: hash(resolve(directory, name))
      }))
    }
    writeFileSync(resolve(directory, 'candidate.json'), JSON.stringify(manifest))
    action(directory, manifest)
  } finally {
    cleanFixture(directory)
  }
}
await test('candidate manifest binds every allowed file to source and exact bytes', () =>
  fixture((directory, manifest) => {
    assert.equal(validateCandidate(directory, manifest).revision, 'fixture')
    assert.throws(() => validateCandidate(directory, { ...manifest, revision: 'other' }))
    writeFileSync(resolve(directory, 'open-computer-use.exe'), 'tampered')
    assert.throws(() => validateCandidate(directory, manifest), /changed/)
  }))
await test('profiles and unexpected files cannot enter a candidate or ZIP allowlist', () =>
  fixture((directory) => {
    mkdirSync(resolve(directory, 'evostack-data'))
    assert.throws(() => validateCandidate(directory), /unexpected files/)
  }))
await test('manifest traversal and pointer traversal are rejected before execution', () =>
  fixture((directory, manifest) => {
    manifest.files[0].name = '../private.sqlite3'
    writeFileSync(resolve(directory, 'candidate.json'), JSON.stringify(manifest))
    assert.throws(() => validateCandidate(directory), /file list/)
    writeFileSync(resolve(directory, 'current.json'), JSON.stringify({ directory: '../../outside' }))
    assert.throws(() => currentCandidate(directory), /pointer/)
  }))
await test('generated caches and profiles are not source identity inputs on clean clones', () => {
  for (const file of [
    'native/evostack/.cache/go/cache',
    'native/evostack/dist/portable/evostack-data/evostack.sqlite3',
    'node_modules/foo',
    'packages/ui/node_modules/foo'
  ])
    assert.equal(isBuildInput(file), false, file)
  for (const file of [
    'src/platform/tauri/install.ts',
    'native/evostack/src-tauri/Cargo.lock',
    'native/evostack/backend/go.mod',
    'pnpm-lock.yaml',
    'build/renderer.config.ts'
  ])
    assert.equal(isBuildInput(file), true, file)
})
await test('start rejects a missing candidate without compiling or creating a pointer', () => {
  assert.throws(() => currentCandidate(base), /run pnpm build first/)
})
await test('source identity remains clean with generated outputs before a fresh clone has a local ignore file', () => {
  const directory = mkdtempSync(resolve(base, 'source-'))
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid'
      }
    }).trim()
  try {
    mkdirSync(resolve(directory, 'src'))
    writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ version: '0.0.0-test' }))
    writeFileSync(resolve(directory, 'src/index.ts'), 'export const fixture = true\n')
    git('init', '-q')
    git('add', '--', 'package.json', 'src/index.ts')
    const tree = git('write-tree')
    const revision = git('-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'Synthetic source fixture')
    git('update-ref', 'HEAD', revision)
    const original = sourceIdentity(directory)
    for (const folder of [
      'node_modules/generated',
      'native/evostack/.cache/synthetic',
      'native/evostack/dist/portable/evostack-data'
    ]) {
      mkdirSync(resolve(directory, folder), { recursive: true })
      writeFileSync(resolve(directory, folder, 'fixture.txt'), 'synthetic output')
    }
    assert.deepEqual(sourceIdentity(directory), original)
    writeFileSync(resolve(directory, 'src/index.ts'), 'export const fixture = false\n')
    assert.notEqual(sourceIdentity(directory).sourceHash, original.sourceHash)
    assert.equal(sourceIdentity(directory).revision, `${revision}-dirty`)
  } finally {
    cleanFixture(directory)
  }
})
