import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { resolve, sep } from 'node:path'
import test from 'node:test'

import { root } from '../process.mjs'
import { syncSkills } from '../skills.mjs'

const base = resolve(root, '.cache/skills-sync-tests')
mkdirSync(base, { recursive: true })
const ignores = { agents: 'new agents\n', claude: 'new claude\n' }
function fixture(action) {
  const directory = mkdtempSync(resolve(base, 'sync-'))
  try {
    for (const path of ['.agents/skills/one', '.agents/skills/two', '.claude/skills'])
      mkdirSync(resolve(directory, path), { recursive: true })
    writeFileSync(resolve(directory, '.agents/skills/.gitignore'), 'original agents')
    writeFileSync(resolve(directory, '.claude/skills/.gitignore'), 'original claude')
    action(directory)
  } finally {
    if (!realpathSync(directory).startsWith(realpathSync(base) + sep)) throw new Error('Fixture escaped test base')
    rmSync(directory, { recursive: true })
  }
}
await test('skill sync defaults to dry run without creating links or rewriting ignore lists', () =>
  fixture((directory) => {
    assert.equal(syncSkills(directory, ['one'], ignores).length, 3)
    assert(!existsSync(resolve(directory, '.claude/skills/one')))
    assert.equal(readFileSync(resolve(directory, '.agents/skills/.gitignore'), 'utf8'), 'original agents')
  }))
await test('ordinary file and directory collisions preserve all content and stop before any mutation', () => {
  for (const kind of ['file', 'directory'])
    fixture((directory) => {
      const target = resolve(directory, '.claude/skills/two')
      if (kind === 'directory') mkdirSync(target)
      const privateFile = kind === 'directory' ? resolve(target, 'private.txt') : target
      writeFileSync(privateFile, 'synthetic private content')
      for (const apply of [false, true])
        assert.throws(() => syncSkills(directory, ['one', 'two'], ignores, { apply }), /conflict/)
      assert.equal(readFileSync(privateFile, 'utf8'), 'synthetic private content')
      assert(!existsSync(resolve(directory, '.claude/skills/one')))
    })
})
await test('a failed link creation rolls back only newly created links and preserves original ignore lists', () =>
  fixture((directory) => {
    let count = 0
    assert.throws(
      () =>
        syncSkills(directory, ['one', 'two'], ignores, {
          apply: true,
          link: (_, target) => {
            if (++count === 2) throw new Error('Synthetic missing link privilege')
            symlinkSync(resolve(directory, '.agents/skills/one'), target, 'junction')
          }
        }),
      /synchronization failed/
    )
    assert.equal(count, 2, 'the failure must occur after the first new link was created')
    assert(!lstatSync(resolve(directory, '.claude/skills/one'), { throwIfNoEntry: false }))
    assert.equal(readFileSync(resolve(directory, '.claude/skills/.gitignore'), 'utf8'), 'original claude')
  }))
await test('unexpected links are preserved and a successful apply leaves an existing correct link untouched', () =>
  fixture((directory) => {
    const target = resolve(directory, '.claude/skills/one')
    symlinkSync(resolve(directory, '.agents/skills/two'), target, 'junction')
    assert.throws(() => syncSkills(directory, ['one'], ignores, { apply: true }), /conflict/)
    assert.equal(realpathSync(target), realpathSync(resolve(directory, '.agents/skills/two')))
    syncSkills(directory, ['two'], ignores, {
      apply: true,
      link: (_, path) => symlinkSync(resolve(directory, '.agents/skills/two'), path, 'junction')
    })
    const correct = resolve(directory, '.claude/skills/two')
    const before = lstatSync(correct).mtimeMs
    syncSkills(directory, ['two'], ignores, { apply: true })
    assert.equal(lstatSync(correct).mtimeMs, before)
    assert.equal(readFileSync(resolve(directory, '.agents/skills/.gitignore'), 'utf8'), ignores.agents)
  }))
