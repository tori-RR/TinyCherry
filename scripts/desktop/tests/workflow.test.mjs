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

await test('every shipped workflow is manual-only and selected checks transfer only the plan artifact', () => {
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
  assert.deepEqual(Object.keys(workflow.jobs.plan.outputs), ['desktop'])
  const upload = workflow.jobs.plan.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
  const download = workflow.jobs.desktop.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(upload.with.path, defaultPlanFile, 'Only the generated plan may be uploaded')
  assert.equal(upload.with['include-hidden-files'], true)
  assert.equal(download.with.name, upload.with.name)
  assert.equal(download.with.path.replaceAll('\\', '/'), dirname(defaultPlanFile).replaceAll('\\', '/'))
})
