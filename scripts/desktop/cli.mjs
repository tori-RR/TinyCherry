import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { changedFiles, createPlan, testProjects, validatePlan } from '../validation/plan.mjs'
import {
  checkIdentities,
  getHostExecutable,
  hash,
  loadCandidate,
  sourceIdentity,
  validateCandidate
} from './candidate.mjs'
import { runSelectedChecks } from './checks.mjs'
import { dev } from './dev.mjs'
import { checkDocs } from './docs.mjs'
import { prepareEnvironment } from './environment.mjs'
import { checkExit } from './exit-gate.mjs'
import { readPlanFile } from './plan-file.mjs'
import { native, pnpm, root, run, stopAll, windows } from './process.mjs'
import { checkWorkflows } from './workflow.mjs'

prepareEnvironment()
const {
  positionals: [mode],
  values
} = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: 'boolean' },
    base: { type: 'string' },
    plan: { type: 'string' },
    'plan-file': { type: 'string' },
    stress: { type: 'boolean' },
    'strict-source': { type: 'boolean' },
    project: { type: 'string', multiple: true },
    'expected-revision': { type: 'string' }
  }
})
const completed = new Map()
const once = (name, action) => {
  if (!completed.has(name)) completed.set(name, Promise.resolve().then(action))
  return completed.get(name)
}
const execPnpm = (args) => pnpm(args).completion
async function batchedPnpm(prefix, files) {
  for (let index = 0; index < files.length; index += 60) await execPnpm([...prefix, ...files.slice(index, index + 60)])
}
const ps = (file, args = []) =>
  run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(native, file), ...args])
const identity = () => sourceIdentity()
const candidate = (options) => {
  const { directory, manifest } = loadCandidate(options)
  checkIdentities(directory, manifest)
  return { directory, manifest }
}
const selected = () => {
  if (values.plan && values['plan-file']) throw new Error('Choose --plan-file or --plan, not both')
  if (values['plan-file']) return readPlanFile(values['plan-file'])
  if (values.plan) return validatePlan(JSON.parse(values.plan))
  if (values.all) return createPlan([], 'Explicit complete verification')
  return createPlan(changedFiles(root, values.base ?? 'origin/main'))
}
const build = () =>
  once('build', async () => {
    windows()
    await ps('build.ps1', values['expected-revision'] ? ['-ExpectedRevision', values['expected-revision']] : [])
    completed.set('types', Promise.resolve())
    return candidate()
  })
async function types() {
  await execPnpm(['exec', 'tsc', '--noEmit', '-p', 'tsconfig.web.json', '--composite', 'false'])
  await execPnpm(['exec', 'tsc', '--noEmit', '-p', 'tsconfig.tauri.json', '--composite', 'false'])
}
async function tsTests(projects) {
  const names = values.project ?? projects
  if (names.some((name) => !testProjects.includes(name))) throw new Error('Unknown current desktop test project')
  if (names.length) await execPnpm(['exec', 'vitest', 'run', ...names.flatMap((name) => ['--project', name])])
  await run(process.execPath, ['--test', 'scripts/desktop/tests/*.test.mjs'])
}
async function runChecks(plan) {
  const files = plan.files.filter((file) => existsSync(resolve(root, file)))
  const complete = !plan.files.length && plan.tasks.length > 2
  await runSelectedChecks(plan, {
    once,
    build,
    smoke,
    task: async (task) => {
      if (task === 'format')
        await batchedPnpm(
          ['exec', 'oxfmt', '--check', '--no-error-on-unmatched-pattern'],
          complete
            ? [
                'src',
                'scripts/desktop',
                'scripts/validation',
                'scripts/uiContract',
                'build/renderer.config.ts',
                'native/evostack',
                'package.json',
                'pnpm-workspace.yaml',
                'vitest.config.ts',
                '.github/workflows'
              ]
            : files.filter((file) => /\.(?:[cm]?[jt]sx?|json|ya?ml|css|html)$/.test(file))
        )
      if (task === 'docs')
        checkDocs(
          root,
          complete
            ? [
                'docs/desktop.md',
                'native/evostack/README.md',
                'src/renderer/windows/evostack/README.md',
                'scripts/desktop/README.md',
                'scripts/validation/README.md',
                'src/platform/tauri/README.md',
                'src/platform/desktop-api/README.md'
              ]
            : files
        )
      if (task === 'exit') checkExit()
      if (task === 'workflow') checkWorkflows()
      if (task === 'lint')
        await batchedPnpm(
          ['exec', 'oxlint'],
          values.all || !files.length
            ? ['src', 'build', 'scripts/desktop', 'scripts/validation']
            : files.filter((file) => /\.[cm]?[jt]sx?$/.test(file))
        )
      if (task === 'types') await types()
      if (task === 'ts') await tsTests(plan.projects)
      if (['go', 'vet', 'rust', 'race'].includes(task)) {
        windows()
        await ps('test.ps1', ['-Task', task, ...(task === 'race' ? ['-Count', values.stress ? '10' : '1'] : [])])
      }
    },
    contracts: async (built) => {
      const args = built ? ['-Directory', candidate().directory] : []
      await ps('test.ps1', ['-Task', 'contracts', ...args])
    }
  })
}
function verificationPath(directory) {
  return resolve(native, '.cache/verified-candidates', `${hash(resolve(directory, 'candidate.json'))}.json`)
}
async function smoke(record = true) {
  const proof = await once('smoke', async () => {
    windows()
    const { directory, manifest } = candidate()
    await ps('verify-package.ps1', [
      '-Directory',
      directory,
      '-ExpectedVersion',
      manifest.version,
      '-ExpectedRevision',
      manifest.revision
    ])
    validateCandidate(directory, identity())
    return { directory, candidateHash: hash(resolve(directory, 'candidate.json')) }
  })
  if (!record) return
  const { directory } = candidate()
  if (directory !== proof.directory || hash(resolve(directory, 'candidate.json')) !== proof.candidateHash)
    throw new Error('Candidate changed after packaged startup verification')
  const file = verificationPath(directory)
  mkdirSync(resolve(native, '.cache/verified-candidates'), { recursive: true })
  writeFileSync(file, JSON.stringify({ candidateHash: proof.candidateHash, verifiedAt: new Date().toISOString() }))
}
async function pack() {
  windows()
  const { directory, manifest } = candidate()
  const stamp = verificationPath(directory)
  if (!existsSync(stamp)) throw new Error('Candidate has not passed packaged startup; run pnpm verify')
  const verification = JSON.parse(readFileSync(stamp, 'utf8'))
  if (verification.candidateHash !== hash(resolve(directory, 'candidate.json')))
    throw new Error('Candidate has not passed packaged startup; run pnpm verify')
  await ps('package.ps1', ['-Directory', directory, '-ExpectedManifestHash', verification.candidateHash])
  validateCandidate(directory, manifest)
}
async function start() {
  windows()
  const { directory, manifest } = candidate({ requireCurrentSource: values['strict-source'] === true })
  console.log(`Starting candidate ${manifest.version} (${manifest.revision}); pnpm build creates a new candidate.`)
  // Stable across candidate changes; preserves the previous local portable profile.
  const profile = resolve(native, 'dist/portable/evostack-data')
  mkdirSync(profile, { recursive: true })
  await run(resolve(directory, getHostExecutable(manifest)), [], {
    env: { ...process.env, TINYCHERRY_EVOSTACK_DATA_DIR: profile }
  })
}

try {
  if (mode === 'dev') await dev()
  else if (mode === 'build') await build()
  else if (mode === 'start') await start()
  else if (mode === 'package') await pack()
  else if (mode === 'check') {
    const plan = selected()
    plan.tasks = plan.tasks.filter((task) => ['format', 'docs', 'exit', 'workflow', 'lint', 'types'].includes(task))
    await runChecks(plan)
  } else if (mode === 'test') {
    await once('ts', () => tsTests(testProjects))
    for (const task of ['go', 'vet', 'race', 'rust'])
      await ps('test.ps1', ['-Task', task, ...(task === 'race' ? ['-Count', values.stress ? '10' : '1'] : [])])
    await ps('test.ps1', ['-Task', 'contracts'])
  } else if (mode === 'verify') {
    const plan =
      values.plan || values['plan-file'] || values.base ? selected() : createPlan([], 'Complete candidate verification')
    await runChecks(plan)
    if (plan.tasks.includes('build')) await pack()
  } else throw new Error('Use dev, build, start, package, check, test or verify')
} catch (error) {
  const report = (cause) => {
    console.error(cause instanceof Error ? cause.message : cause)
    if (cause instanceof AggregateError) for (const nested of cause.errors) report(nested)
  }
  report(error)
  process.exitCode = 1
} finally {
  await stopAll()
}
