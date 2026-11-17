/** The CLI and tests share the actual candidate/check ordering. */
export async function runSelectedChecks(plan, { once, build, smoke, task, contracts }) {
  const tasks = new Set(plan.tasks)
  let needsBuild = tasks.has('build')
  for (const name of plan.tasks) {
    if (['build', 'contracts', 'smoke'].includes(name)) continue
    if (needsBuild && ['types', 'ts', 'go', 'vet', 'race', 'rust'].includes(name)) {
      await build()
      needsBuild = false
      if (tasks.has('smoke')) await smoke(false)
    }
    await once(name, () => task(name, plan))
  }
  if (needsBuild) {
    await build()
    if (tasks.has('smoke')) await smoke(false)
  }
  if (tasks.has('contracts')) await once('contracts', () => contracts(tasks.has('build')))
  if (tasks.has('smoke')) await smoke()
}
