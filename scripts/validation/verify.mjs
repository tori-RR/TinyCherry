import { validatePlan, verifyResults } from './plan.mjs'

const jobs = JSON.parse(process.env.VALIDATION_JOBS)
if (jobs.changes?.result !== 'success') throw new Error('Change classification did not succeed')
// Required main gates always verify a Tauri plan; compatibility has its own workflow.
const plan = validatePlan(JSON.parse(jobs.changes.outputs.plan), 'tauri')
const mapping = {
  basic: { repository: 'repository-result', lint: 'lint-checks', types: 'type-checks', i18n: 'i18n-checks' },
  general: { main: 'main-test-shard', packages: 'package-test' },
  renderer: { renderer: 'renderer-test-shard' }
}[process.argv[2]]
if (!mapping) throw new Error('Unknown validation gate')
const steps = process.argv[2] === 'basic' ? JSON.parse(process.env.VALIDATION_STEPS) : null
verifyResults(
  plan,
  Object.fromEntries(
    Object.entries(mapping).map(([group, id]) => [group, steps ? steps[id]?.outcome : jobs[id]?.result])
  ),
  Object.keys(mapping)
)
process.stdout.write('All planned validation jobs succeeded.\n')
