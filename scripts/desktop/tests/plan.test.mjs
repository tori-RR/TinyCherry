import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlan, validatePlan, verifyResults } from '../../validation/plan.mjs'
import { runSelectedChecks } from '../checks.mjs'

await test('documentation alone does not select native compilation or tests', () => {
  const plan = createPlan(['README.md', 'docs/desktop.md'])
  assert.deepEqual(plan.tasks, ['format', 'docs'])
  assert.equal(plan.desktop, false)
  verifyResults(plan, { plan: 'success', desktop: 'skipped' })
  assert.throws(() => verifyResults(plan, { plan: 'failure', desktop: 'skipped' }))
})
await test('contracts, native code and build inputs require an actual packaged startup', () => {
  for (const file of [
    'src/platform/gpui/transport.ts',
    'src/shared/ipc/schemas/ai.ts',
    'native/evostack/backend/chat.go',
    'native/evostack/src-gpui/src/host.rs',
    'package.json'
  ]) {
    const plan = createPlan([file])
    for (const task of ['build', 'contracts', 'smoke']) assert(plan.tasks.includes(task), `${file}: ${task}`)
  }
})
await test('renderer changes stay scoped; workflows receive their own syntax check', () => {
  const renderer = createPlan(['src/renderer/components/chat/Chat.tsx'])
  assert(renderer.tasks.includes('types'))
  assert(!renderer.go)
  assert(!renderer.rust)
  const workflow = createPlan(['.github/workflows/ci.yml'])
  assert(workflow.tasks.includes('workflow'))
  assert(workflow.go, 'actionlint is installed with Go')
})
await test('runtime text and provider catalog select their generated Go consumers before suffix rules', () => {
  for (const file of [
    'resources/skills/fixture/SKILL.md',
    'resources/skills/fixture/nested/guide.txt',
    'resources/code-cli-skills/fixture/help.txt',
    'packages/provider-registry/data/providers.json'
  ]) {
    const plan = createPlan([file])
    for (const task of ['go', 'build', 'contracts', 'smoke']) assert(plan.tasks.includes(task), `${file}: ${task}`)
    assert(plan.go && plan.rust && plan.desktop)
    validatePlan(plan)
  }
  assert.deepEqual(createPlan(['.agents/skills/fixture/SKILL.md']).tasks, ['format', 'docs'])
})
await test('native-only plans execute their selected desktop tests between build and final verification', async () => {
  for (const file of ['native/evostack/backend/chat.go', 'native/evostack/src-gpui/src/host.rs']) {
    const calls = []
    const plan = createPlan([file])
    await runSelectedChecks(plan, {
      once: (_, action) => action(),
      build: async () => calls.push('build'),
      smoke: async (record = true) => calls.push(record ? 'verified' : 'startup'),
      task: async (name, selected) => calls.push(name === 'ts' ? `ts:${selected.projects.join(',')}` : name),
      contracts: async (built) => {
        assert(built)
        calls.push('contracts')
      }
    })
    assert(calls.includes('ts:desktop'), file)
    assert.equal(calls.filter((name) => name === 'build').length, 1)
    assert(calls.indexOf('startup') < calls.indexOf('ts:desktop'))
    assert(calls.indexOf('contracts') < calls.indexOf('verified'))
  }
})
await test('deleted, renamed and mixed runtime inputs cannot narrow verification to docs', () => {
  const plan = createPlan(['docs/desktop.md', 'resources/skills/old/SKILL.md', 'resources/skills/new/SKILL.md'])
  assert(plan.tasks.includes('docs') && plan.tasks.includes('contracts'))
  assert(createPlan(['new-toolchain.toml']).tasks.includes('smoke'))
  const valid = createPlan(['src/renderer/fixture.ts'])
  assert.throws(() => validatePlan({ ...valid, go: true }), /Invalid/)
  assert.throws(() => validatePlan({ ...valid, tasks: valid.tasks.filter((task) => task !== 'ts') }), /Invalid/)
})
await test('unknown paths fail closed and a failed or cancelled selected job is never green', () => {
  const plan = createPlan(['new-toolchain.toml'])
  assert(plan.tasks.includes('smoke'))
  assert(plan.projects.includes('desktop'))
  for (const result of ['failure', 'cancelled', 'skipped'])
    assert.throws(() => verifyResults(plan, { plan: 'success', desktop: result }))
  assert.throws(() => validatePlan({ ...plan, target: 'retired' }))
  assert.throws(() => validatePlan({ ...plan, tasks: ['fake-success'] }))
})
