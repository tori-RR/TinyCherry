import { execFileSync } from 'node:child_process'

export const testProjects = [
  'renderer',
  'shared',
  'ui',
  'file-preview',
  'provider-registry',
  'web-search',
  'remote-protocol',
  'desktop',
  'tooling'
]
const allTasks = [
  'format',
  'docs',
  'exit',
  'workflow',
  'lint',
  'types',
  'ts',
  'go',
  'vet',
  'race',
  'rust',
  'build',
  'contracts',
  'smoke'
]

/** Selection is by current product boundary, never by a retired desktop target. */
export function createPlan(files, fullReason) {
  const reasons = {}
  const projects = new Set()
  const add = (tasks, reason, tests = []) => {
    for (const task of tasks) (reasons[task] ??= []).push(reason)
    for (const project of tests) projects.add(project)
  }
  const full = (reason) => add(allTasks, reason, testProjects)
  if (fullReason) full(fullReason)
  for (const file of [...new Set(files)].sort()) {
    add(['format'], file)
    if (/\.(?:md|txt)$/.test(file) || file.startsWith('docs/')) {
      add(['docs'], file)
    } else if (/^native\/evostack\/backend\/.*\.go$/.test(file)) {
      add(['go', 'vet', 'race', 'build', 'contracts', 'smoke'], file, ['desktop'])
    } else if (/^native\/evostack\/src-tauri\/src\/.*\.rs$/.test(file)) {
      add(['rust', 'build', 'contracts', 'smoke'], file, ['desktop'])
    } else if (file.startsWith('src/platform/') || file.startsWith('src/shared/')) {
      full(`Cross-process contract: ${file}`)
    } else if (/^src\/renderer\/(?:ipc|data|windows\/evostack)\//.test(file)) {
      add(['exit', 'lint', 'types', 'ts', 'build', 'contracts', 'smoke'], file, ['renderer', 'desktop'])
    } else if (file.startsWith('src/renderer/')) {
      add(['exit', 'lint', 'types', 'ts'], file, ['renderer'])
    } else if (file.startsWith('.github/workflows/') || file.startsWith('scripts/validation/')) {
      add(['exit', 'workflow', 'ts'], file, ['tooling'])
    } else if (file.startsWith('scripts/desktop/')) {
      full(`Build and lifecycle tooling: ${file}`)
    } else if (file.startsWith('packages/')) {
      add(
        ['exit', 'lint', 'types', 'ts'],
        file,
        testProjects.filter((p) => !['desktop', 'tooling'].includes(p))
      )
    } else {
      full(`Conservative fallback: ${file}`)
    }
  }
  const tasks = allTasks.filter((task) => reasons[task])
  return {
    target: 'tauri',
    files: [...new Set(files)].sort(),
    tasks,
    projects: testProjects.filter((project) => projects.has(project)),
    desktop: tasks.some((task) => !['format', 'docs'].includes(task)),
    go: tasks.some((task) => ['go', 'vet', 'race', 'build', 'contracts'].includes(task)),
    rust: tasks.some((task) => ['rust', 'build', 'smoke'].includes(task)),
    reasons: Object.fromEntries(tasks.map((task) => [task, [...new Set(reasons[task])]]))
  }
}

export function validatePlan(plan) {
  if (
    plan?.target !== 'tauri' ||
    !Array.isArray(plan.files) ||
    plan.files.some((file) => typeof file !== 'string' || !file || file.includes('\0')) ||
    !Array.isArray(plan.tasks) ||
    !Array.isArray(plan.projects) ||
    plan.tasks.some((task) => !allTasks.includes(task)) ||
    plan.projects.some((project) => !testProjects.includes(project))
  )
    throw new Error('Invalid Tauri validation plan')
  return plan
}

export function changedFiles(root, base = 'origin/main', head = 'HEAD', local = true) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  const fixedBase = git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim()
  const fixedHead = git('rev-parse', '--verify', '--end-of-options', `${head}^{commit}`).trim()
  const comparison = git('merge-base', fixedBase, fixedHead).trim()
  const files = git('diff', '--name-only', '--no-renames', '-z', comparison, fixedHead).split('\0')
  if (local) {
    files.push(...git('diff', '--name-only', '--no-renames', '-z', 'HEAD').split('\0'))
    files.push(...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'))
  }
  return [...new Set(files.filter(Boolean))]
}

export function verifyResults(plan, results) {
  validatePlan(plan)
  if (results.plan !== 'success') throw new Error('Validation planning failed')
  const expected = plan.desktop ? 'success' : 'skipped'
  if (results.desktop !== expected) throw new Error(`Desktop checks expected ${expected}, received ${results.desktop}`)
}
