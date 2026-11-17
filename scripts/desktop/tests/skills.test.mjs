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
    cleanup(directory)
  }
}
function cleanup(directory) {
  if (!realpathSync(directory).startsWith(realpathSync(base) + sep)) throw new Error('Fixture escaped test base')
  rmSync(directory, { recursive: true })
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

for (const ancestor of ['.agents', '.claude'])
  await test(`skill sync rejects a ${ancestor} junction ancestor before any write`, () =>
    fixture((directory) => {
      const project = resolve(directory, 'project')
      const external = resolve(directory, 'external')
      const ordinary = ancestor === '.agents' ? '.claude' : '.agents'
      mkdirSync(resolve(project, ordinary, ordinary === '.agents' ? 'skills/one' : 'skills'), { recursive: true })
      mkdirSync(resolve(external, ancestor === '.agents' ? 'skills/one' : 'skills'), { recursive: true })
      symlinkSync(external, resolve(project, ancestor), 'junction')
      const outside = resolve(external, 'skills/.gitignore')
      const inside = resolve(project, ordinary, 'skills/.gitignore')
      writeFileSync(outside, 'external private content')
      writeFileSync(inside, 'internal original content')
      assert.equal(lstatSync(resolve(project, ancestor, 'skills')).isSymbolicLink(), false)
      for (const apply of [false, true])
        assert.throws(() => syncSkills(project, ['one'], ignores, { apply }), /ancestor|ordinary skill directory/)
      assert.equal(readFileSync(outside, 'utf8'), 'external private content')
      assert.equal(readFileSync(inside, 'utf8'), 'internal original content')
      assert(!lstatSync(resolve(project, '.claude/skills/one'), { throwIfNoEntry: false }))
    }))

await test('opening the project through a root junction uses its canonical managed paths', () =>
  fixture((directory) => {
    const project = resolve(directory, 'project')
    for (const path of ['.agents/skills/one', '.claude/skills']) mkdirSync(resolve(project, path), { recursive: true })
    symlinkSync(resolve(project, '.agents/skills/one'), resolve(project, '.claude/skills/one'), 'junction')
    const alias = resolve(directory, 'project-alias')
    symlinkSync(project, alias, 'junction')
    const changes = syncSkills(alias, ['one'], ignores, { apply: true })
    assert(changes.every((path) => path.startsWith(realpathSync(project) + sep)))
    assert.equal(readFileSync(resolve(project, '.agents/skills/.gitignore'), 'utf8'), ignores.agents)
    assert.equal(readFileSync(resolve(project, '.claude/skills/.gitignore'), 'utf8'), ignores.claude)
  }))

await test('a second ignore write failure restores both originals and removes the newly created link', () =>
  fixture((directory) => {
    let writes = 0
    assert.throws(
      () =>
        syncSkills(directory, ['one'], ignores, {
          apply: true,
          link: (_, target) => symlinkSync(resolve(directory, '.agents/skills/one'), target, 'junction'),
          write: (path, content) => {
            if (++writes === 2) throw new Error('SYNTHETIC_SECOND_IGNORE_WRITE_FAILURE')
            writeFileSync(path, content)
          }
        }),
      (error) => {
        assert(error instanceof AggregateError)
        assert.match(error.errors[0].message, /SECOND_IGNORE_WRITE_FAILURE/)
        assert.equal(error.errors.length, 1)
        return true
      }
    )
    assert.equal(writes, 4)
    assert.equal(readFileSync(resolve(directory, '.agents/skills/.gitignore'), 'utf8'), 'original agents')
    assert.equal(readFileSync(resolve(directory, '.claude/skills/.gitignore'), 'utf8'), 'original claude')
    assert(!lstatSync(resolve(directory, '.claude/skills/one'), { throwIfNoEntry: false }))
  }))

await test('an ignore restore failure reports both errors without claiming complete preservation', () =>
  fixture((directory) => {
    let writes = 0
    assert.throws(
      () =>
        syncSkills(directory, [], ignores, {
          apply: true,
          write: (path, content) => {
            writes++
            if (writes === 2) throw new Error('SYNTHETIC_WRITE_FAILURE')
            if (writes === 4) throw new Error('SYNTHETIC_RESTORE_FAILURE')
            writeFileSync(path, content)
          }
        }),
      (error) => {
        assert(error instanceof AggregateError)
        assert.match(error.errors[0].message, /SYNTHETIC_WRITE_FAILURE/)
        assert.match(error.errors[1].message, /SYNTHETIC_RESTORE_FAILURE/)
        assert.doesNotMatch(error.message, /original targets were preserved/)
        return true
      }
    )
    assert.equal(readFileSync(resolve(directory, '.agents/skills/.gitignore'), 'utf8'), ignores.agents)
    assert.equal(readFileSync(resolve(directory, '.claude/skills/.gitignore'), 'utf8'), 'original claude')
  }))
