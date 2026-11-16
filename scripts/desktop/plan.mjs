import { appendFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { changedFiles, createPlan } from '../validation/plan.mjs'

const { values } = parseArgs({ options: { base: { type: 'string' }, all: { type: 'boolean' } } })
let plan
try {
  plan =
    values.all || !values.base
      ? createPlan([], 'Explicit full validation')
      : createPlan(changedFiles(process.cwd(), values.base, 'HEAD', false))
} catch {
  plan = createPlan([], 'Comparison history unavailable')
}
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `plan=${JSON.stringify(plan)}\ndesktop=${plan.desktop}\ngo=${plan.go}\nrust=${plan.rust}\n`
  )
process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
