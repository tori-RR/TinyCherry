import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import test from 'node:test'

import { createPlan } from '../../validation/plan.mjs'
import { readPlanFile, writePlanFile, writePlanOutputs } from '../plan-file.mjs'
import { native, root } from '../process.mjs'

const base = resolve(root, '.cache/plan-file-tests')
mkdirSync(base, { recursive: true })
function cleanup(directory) {
  if (!realpathSync(directory).startsWith(realpathSync(base) + sep)) throw new Error('Invalid fixture path')
  rmSync(directory, { recursive: true })
}
function fixture(action) {
  const directory = mkdtempSync(resolve(base, 'plan-'))
  try {
    action(directory)
  } finally {
    cleanup(directory)
  }
}

await test('thousands of changed contracts round-trip as a file while job outputs stay bounded', () =>
  fixture((directory) => {
    const plan = createPlan(Array.from({ length: 6000 }, (_, index) => `src/shared/contracts/fixture-${index}.ts`))
    assert(Buffer.byteLength(JSON.stringify(plan), 'utf16le') > 1024 * 1024)
    const file = writePlanFile('selected plan.json', plan, directory)
    assert.deepEqual(readPlanFile(file), plan)
    const output = resolve(directory, 'job-output.txt')
    writePlanOutputs(output, plan)
    const content = readFileSync(output, 'utf8')
    assert(Buffer.byteLength(content, 'utf16le') < 128)
    assert.deepEqual(content.trim().split('\n'), ['desktop=true', 'go=true', 'rust=true'])
    assert(!content.includes('plan='))
    assert(!content.includes('fixture-'))
  }))

await test('missing, malformed and structurally invalid plan files fail explicitly', () =>
  fixture((directory) => {
    const file = resolve(directory, 'plan.json')
    assert.throws(() => readPlanFile(file), /ENOENT/)
    writeFileSync(file, '{broken')
    assert.throws(() => readPlanFile(file), SyntaxError)
    for (const invalid of [{}, { ...createPlan([]), files: [null] }, { ...createPlan([]), tasks: ['fake-success'] }]) {
      writeFileSync(file, JSON.stringify(invalid))
      assert.throws(() => readPlanFile(file), /Invalid Tauri validation plan/)
    }
    const valid = createPlan(['docs/desktop.md'])
    writeFileSync(file, `\uFEFF${JSON.stringify(valid)}`)
    assert.deepEqual(readPlanFile(file), valid)
    assert.throws(() => writePlanFile('../escaped-plan.json', valid, directory), /inside the project/)
  }))

await test('the planner CLI writes a file and never embeds it in Actions outputs or logs', () =>
  fixture((directory) => {
    const file = resolve(directory, 'selected plan.json'),
      output = resolve(directory, 'job-output.txt')
    const result = spawnSync(process.execPath, ['scripts/desktop/plan.mjs', '--all', '--output', file], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output },
      timeout: 15000
    })
    assert.equal(result.status, 0, result.stderr)
    assert(readPlanFile(file).tasks.includes('smoke'))
    assert.equal(JSON.parse(result.stdout).changedFiles, 0)
    assert(result.stdout.length < 4096)
    assert(!result.stdout.includes('reasons'))
    assert(!readFileSync(output, 'utf8').includes('plan='))
  }))

await test('check and verify consume oversized plan files and execute their selected checks', () =>
  fixture((directory) => {
    const document = resolve(directory, 'fixture.md')
    const plan = createPlan([relative(root, document).replaceAll('\\', '/')])
    plan.tasks = ['docs']
    plan.reasons.docs.push('Synthetic comparison detail. '.repeat(80000))
    const file = writePlanFile('selected plan.json', plan, directory)
    assert(Buffer.byteLength(JSON.stringify(plan), 'utf16le') > 1024 * 1024)
    const pointer = resolve(native, 'dist/current.json')
    const before = existsSync(pointer) ? readFileSync(pointer, 'utf8') : null
    const run = (mode) =>
      spawnSync(process.execPath, ['scripts/desktop/cli.mjs', mode, '--plan-file', file], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30000
      })
    writeFileSync(document, '[missing](absent.md)\n')
    const failure = run('check')
    assert.equal(failure.status, 1, failure.stderr)
    assert.match(failure.stderr, /Missing local documentation link/)
    writeFileSync(document, '# Fixture\n')
    const success = run('verify')
    assert.equal(success.status, 0, success.stderr)
    assert.equal(existsSync(pointer) ? readFileSync(pointer, 'utf8') : null, before)
  }))
