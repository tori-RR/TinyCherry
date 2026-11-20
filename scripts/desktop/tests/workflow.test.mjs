import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'

import { parse } from 'yaml'

import { defaultPlanFile } from '../plan-file.mjs'
import { root } from '../process.mjs'
import { validateWorkflow } from '../workflow.mjs'

await test('automatic workflow triggers are rejected in string, array and object forms', () => {
  const workflow = { jobs: { check: { 'runs-on': 'windows-2025' } } }
  for (const on of [
    'push',
    ['pull_request'],
    { push: null },
    { workflow_dispatch: null, pull_request: null },
    { schedule: [{ cron: '0 0 * * *' }] },
    undefined
  ])
    assert.throws(() => validateWorkflow({ ...workflow, on }), /Only manual/)
  for (const on of ['workflow_dispatch', ['workflow_dispatch'], { workflow_dispatch: { inputs: {} } }])
    assert.doesNotThrow(() => validateWorkflow({ ...workflow, on }))
  assert.throws(
    () => validateWorkflow({ on: 'workflow_dispatch', jobs: { check: { 'runs-on': 'ubuntu-latest' } } }),
    /Unsupported CI runner/
  )
})

await test('only the candidate workflow can run on the exact experimental branch', () => {
  const jobs = { candidate: { 'runs-on': 'windows-2025' } }
  const on = { push: { branches: ['GPT/GPUI'] }, workflow_dispatch: {} }
  assert.doesNotThrow(() => validateWorkflow({ on, jobs }, 'desktop-build.yml'))
  assert.throws(() => validateWorkflow({ on, jobs }, 'ci.yml'), /Only manual/)
  for (const push of [
    {},
    { branches: ['main'] },
    { branches: ['GPT/**'] },
    { branches: ['GPT/GPUI', 'main'] },
    { branches: ['GPT/GPUI'], tags: ['*'] },
    { 'branches-ignore': ['main'] }
  ])
    assert.throws(() => validateWorkflow({ on: { ...on, push }, jobs }, 'desktop-build.yml'), /Only manual/)
  assert.throws(() => validateWorkflow({ on: { ...on, pull_request: {} }, jobs }, 'desktop-build.yml'), /Only manual/)
})

await test('shipped workflows have scoped triggers and selected checks transfer only the plan artifact', () => {
  const directory = resolve(root, '.github/workflows')
  for (const name of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = parse(readFileSync(resolve(directory, name), 'utf8'))
    validateWorkflow(workflow, name)
    assert(
      !/\$\{\{[^}]*\.outputs\.plan\s*\}\}/.test(JSON.stringify(workflow)),
      'Full plans cannot enter expression contexts'
    )
    assert(!/--plan\s/.test(JSON.stringify(workflow)), 'Plan content cannot enter native command arguments')
  }
  const workflow = parse(readFileSync(resolve(directory, 'ci.yml'), 'utf8'))
  assert.deepEqual(Object.keys(workflow.jobs.plan.outputs), ['desktop', 'go', 'rust'])
  const steps = workflow.jobs.desktop.steps
  assert.equal(steps.find((step) => step.uses?.startsWith('actions/setup-go@')).if, "needs.plan.outputs.go == 'true'")
  assert.equal(
    steps.find((step) => step.name === 'Prepare Rust toolchain when selected').if,
    "needs.plan.outputs.rust == 'true'"
  )
  const upload = workflow.jobs.plan.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
  const download = workflow.jobs.desktop.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(upload.with.path, defaultPlanFile, 'Only the generated plan may be uploaded')
  assert.equal(upload.with['include-hidden-files'], true)
  assert.equal(download.with.name, upload.with.name)
  assert.equal(download.with.path.replaceAll('\\', '/'), dirname(defaultPlanFile).replaceAll('\\', '/'))
})
