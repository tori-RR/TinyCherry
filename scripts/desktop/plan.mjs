import { parseArgs } from 'node:util'

import { changedFiles, createPlan } from '../validation/plan.mjs'
import { defaultPlanFile, writePlanFile, writePlanOutputs } from './plan-file.mjs'

const { values } = parseArgs({
  options: { base: { type: 'string' }, all: { type: 'boolean' }, output: { type: 'string', default: defaultPlanFile } }
})
let plan
try {
  plan =
    values.all || !values.base
      ? createPlan([], 'Explicit full validation')
      : createPlan(changedFiles(process.cwd(), values.base, 'HEAD', false))
} catch {
  plan = createPlan([], 'Comparison history unavailable')
}
writePlanFile(values.output, plan)
if (process.env.GITHUB_OUTPUT) writePlanOutputs(process.env.GITHUB_OUTPUT, plan)
process.stdout.write(
  `${JSON.stringify({ target: plan.target, changedFiles: plan.files.length, tasks: plan.tasks, projects: plan.projects, file: values.output })}\n`
)
