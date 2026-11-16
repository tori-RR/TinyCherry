import assert from 'node:assert/strict'
import test from 'node:test'

import { createPlan, validatePlan, verifyResults } from '../../validation/plan.mjs'

await test('documentation alone does not select native compilation or tests', () => {
  const plan = createPlan(['README.md', 'docs/desktop.md'])
  assert.deepEqual(plan.tasks, ['format', 'docs'])
  assert.equal(plan.desktop, false)
  verifyResults(plan, { plan: 'success', desktop: 'skipped' })
  assert.throws(() => verifyResults(plan, { plan: 'failure', desktop: 'skipped' }))
})
await test('contracts, native code and build inputs require an actual packaged startup', () => {
  for (const file of [
    'src/platform/tauri/transport.ts',
    'src/shared/ipc/schemas/ai.ts',
    'native/evostack/backend/chat.go',
    'native/evostack/src-tauri/src/host.rs',
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
  assert(!workflow.go)
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
