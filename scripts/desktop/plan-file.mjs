import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { validatePlan } from '../validation/plan.mjs'

export const defaultPlanFile = '.cache/validation/plan.json'

export function readPlanFile(file) {
  return validatePlan(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')))
}

export function writePlanFile(file, plan, directory = process.cwd()) {
  validatePlan(plan)
  const target = resolve(directory, file)
  const location = relative(directory, target)
  if (
    !location ||
    isAbsolute(location) ||
    location === '..' ||
    location.startsWith('../') ||
    location.startsWith('..\\')
  )
    throw new Error('Validation plan output must stay inside the project')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(plan)}\n`)
  return target
}

/** Job outputs must remain constant-size, independent of paths and reasons. */
export function writePlanOutputs(file, plan) {
  const keys = ['desktop', 'go', 'rust']
  if (keys.some((key) => typeof plan[key] !== 'boolean')) throw new Error('Invalid validation plan flags')
  appendFileSync(file, keys.map((key) => `${key}=${plan[key]}\n`).join(''))
}
