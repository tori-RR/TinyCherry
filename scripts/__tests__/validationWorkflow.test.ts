import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { createPlan } from '../validation/plan.mjs'

const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
const verify = (gate: string, jobs: unknown, steps?: unknown) =>
  spawnSync(process.execPath, ['scripts/validation/verify.mjs', gate], {
    env: { ...process.env, VALIDATION_JOBS: JSON.stringify(jobs), VALIDATION_STEPS: JSON.stringify(steps) }
  }).status
const directories: string[] = []

function stubEnvironment(directory: string, values: NodeJS.ProcessEnv) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'))
  return { ...inherited, ...values, PATH: `${directory}${delimiter}${process.env.PATH}` }
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Windows Tauri validation', () => {
  it('keeps push, PR and manual CI without a daily schedule', () => {
    expect(Object.hasOwn(workflow.on, 'schedule')).toBe(false)
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch', 'push', 'pull_request'])
  })

  it('runs shared tests on Windows and keeps static tooling on Linux', () => {
    const jobs = Object.values(workflow.jobs) as {
      'runs-on': string
      steps: { uses?: string }[]
      strategy?: { matrix: { os?: string[]; shard?: number[] } }
    }[]
    const runners = jobs
      .filter((job) => job.steps.some((step) => step.uses === './.github/actions/setup-validation'))
      .flatMap((job) => {
        const matrix = job.strategy?.matrix
        return matrix?.os ?? Array.from({ length: matrix?.shard?.length ?? 1 }, () => job['runs-on'])
      })

    expect(runners.sort()).toEqual([
      'ubuntu-latest',
      'windows-2022',
      'windows-2022',
      'windows-2022',
      'windows-2022',
      'windows-2022'
    ])
  })

  it('runs the complete selected package group without shard filters', () => {
    const job = workflow.jobs['package-test']
    expect(job.steps.find((step: { run?: string }) => step.run?.startsWith('pnpm check')).run).toBe(
      'pnpm check --target tauri --group packages --max-workers=2'
    )
  })

  it('runs the reused preload bridge without sharding a single test file', () => {
    const job = workflow.jobs['main-test-shard']
    expect(job.name).toBe('preload-bridge')
    expect(job.strategy).toBeUndefined()
    expect(job.steps.find((step: { run?: string }) => step.run?.startsWith('pnpm check')).run).toBe(
      'pnpm check --target tauri --group main --max-workers=2'
    )
    expect(workflow.jobs['general-test'].needs).toContain('main-test-shard')
  })

  it('covers all three renderer shards without cancelling siblings on failure', () => {
    const job = workflow.jobs['renderer-test-shard']
    expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { shard: [1, 2, 3] } })
    expect(job.steps.find((step: { run?: string }) => step.run?.startsWith('pnpm check')).run).toBe(
      'pnpm check --target tauri --group renderer --shard=${{ matrix.shard }}/3 --max-workers=2'
    )
    expect(workflow.jobs['render-test'].needs).toContain('renderer-test-shard')
  })

  it('fixes main CI to Tauri and keeps the full Electron suite manual and separate', () => {
    expect(workflow.on.workflow_dispatch?.inputs).toBeUndefined()
    const plan = workflow.jobs.changes.steps.find((step: { id?: string }) => step.id === 'plan').run
    for (const command of plan.split('\n').filter((line: string) => line.includes('scripts/validation/run.mjs')))
      expect(command).toContain('--target tauri')
    for (const job of Object.values(workflow.jobs) as { steps: { run?: string }[] }[])
      for (const step of job.steps.filter((entry) => entry.run?.startsWith('pnpm check ')))
        expect(step.run).toContain('--target tauri')
    expect(workflow.jobs['platform-test']).toBeUndefined()
    const legacy = parse(readFileSync('.github/workflows/electron-compat.yml', 'utf8'))
    expect(Object.keys(legacy.on)).toEqual(['workflow_dispatch'])
    expect(legacy.jobs.compatibility['runs-on']).toMatch(/^windows-/)
    expect(legacy.jobs.compatibility.steps.map((step: { run?: string }) => step.run)).toEqual(
      expect.arrayContaining([
        'pnpm check --target electron --all --group checks',
        'pnpm check --target electron --all --group tests --max-workers=2',
        'pnpm check --target electron --all --group platform --max-workers=2'
      ])
    )
  })
})

describe('CI preparation and preflight', () => {
  it.each([0, 7])('marks workspace exports prepared only after installation succeeds: exit %s', (exitCode) => {
    const action = parse(readFileSync('.github/actions/setup-validation/action.yml', 'utf8'))
    const install = action.runs.steps.find((step: { name?: string }) => step.name === 'Install dependencies')
    const cwd = mkdtempSync(join(tmpdir(), 'cherry-ci-install-'))
    directories.push(cwd)
    writeFileSync(join(cwd, 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$COMMAND_LOG"\nexit "$INSTALL_EXIT"\n', {
      mode: 0o755
    })
    const envFile = join(cwd, 'environment')
    const argumentsFile = join(cwd, 'arguments')
    const store = join(cwd, '.pnpm-store')
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', install.run], {
      env: stubEnvironment(cwd, {
        INSTALL_EXIT: String(exitCode),
        GITHUB_ENV: envFile,
        STORE_DIR: store,
        COMMAND_LOG: argumentsFile
      })
    })
    expect(result.status).toBe(exitCode)
    expect(readFileSync(argumentsFile, 'utf8').trim().split('\n')).toEqual([
      'install',
      '--frozen-lockfile',
      '--store-dir',
      store
    ])
    expect(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '').toBe(
      exitCode === 0 ? 'VALIDATION_WORKSPACE_PREPARED=true\n' : ''
    )
  })

  it('checks formatting without installing workspace dependencies', () => {
    const format = workflow.jobs.changes.steps.find((step: { name?: string }) => step.name === 'Check formatting')
    const cwd = mkdtempSync(join(tmpdir(), 'cherry-ci-preflight-'))
    directories.push(cwd)
    const log = join(cwd, 'arguments')
    writeFileSync(join(cwd, 'pnpm'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$COMMAND_LOG"\n', { mode: 0o755 })
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', format.run], {
      env: stubEnvironment(cwd, { COMMAND_LOG: log })
    })
    expect(result.status).toBe(0)
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual([
      'dlx',
      `oxfmt@${manifest.devDependencies.oxfmt}`,
      '--check',
      '.'
    ])
    const setup = workflow.jobs['basic-checks'].steps.find((step: { id?: string }) => step.id === 'dependencies')
    expect(
      new Function('needs', 'cancelled', `return (${setup.if})`)(
        { changes: { result: 'failure', outputs: { repository: 'true', types: 'true', lint: 'true', i18n: 'true' } } },
        () => false
      )
    ).toBe(false)
  })
})

describe('CI validation planning', () => {
  it('uses the whole PR and push range even when the last commit only changes docs', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cherry-ci-plan-'))
    directories.push(cwd)
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
    const commit = (message: string) => {
      git('add', '.')
      git('-c', 'commit.gpgsign=false', 'commit', '-qm', message)
      return git('rev-parse', 'HEAD')
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('remote', 'add', 'origin', cwd)
    cpSync('scripts/validation', join(cwd, 'scripts/validation'), { recursive: true })
    const base = commit('base')
    git('checkout', '-qb', 'feature')
    mkdirSync(join(cwd, 'src/renderer'), { recursive: true })
    writeFileSync(join(cwd, 'src/renderer/app.ts'), 'export const value = 1')
    commit('renderer change')
    writeFileSync(join(cwd, 'README.md'), 'docs')
    commit('docs')
    git('checkout', 'main')
    git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', 'feature', '-m', 'merge')
    const script = workflow.jobs.changes.steps.find((step: { id?: string }) => step.id === 'plan').run
    const run = (event: string, before = base) => {
      const output = join(cwd, '.git', 'validation-output')
      writeFileSync(output, '')
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
        cwd,
        env: { ...process.env, VALIDATION_PLAN: '', EVENT_NAME: event, BEFORE_SHA: before, GITHUB_OUTPUT: output }
      })
      return JSON.parse(
        readFileSync(output, 'utf8')
          .split('\n')
          .find((line) => line.startsWith('plan='))!
          .slice(5)
      )
    }
    for (const event of ['pull_request', 'push']) {
      const plan = run(event)
      expect(plan.projects).toContain('renderer')
      expect(plan.projects).not.toContain('main')
    }
    const manualPlan = run('workflow_dispatch')
    expect(manualPlan).toMatchObject({ target: 'tauri', platform: false })
    expect(manualPlan.projects).toContain('preload')
    expect(manualPlan.projects).not.toContain('main')
    expect(run('push', '0000000000000000000000000000000000000000').projects).toContain('preload')
    git('checkout', '-qb', 'docs-only', base)
    writeFileSync(join(cwd, 'README.md'), 'docs only')
    commit('docs only')
    expect(run('push').projects).toEqual([])
  })

  it('fails test gates on missing classification and failed, cancelled, skipped or missing dependencies', () => {
    for (const [name, gate] of [
      ['general-test', 'general'],
      ['render-test', 'renderer']
    ]) {
      const job = workflow.jobs[name]
      const jobs = Object.fromEntries(job.needs.map((dependency: string) => [dependency, { result: 'success' }]))
      jobs.changes = { result: 'success', outputs: { plan: JSON.stringify(createPlan(['package.json'])) } }
      expect(verify(gate, jobs)).toBe(0)
      for (const dependency of job.needs) {
        for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
          jobs[dependency].result = result
          expect(verify(gate, jobs)).not.toBe(0)
        }
        jobs[dependency].result = 'success'
      }
      jobs.changes.outputs.plan = JSON.stringify(createPlan(['README.md']))
      for (const dependency of job.needs.filter((id: string) => id !== 'changes')) jobs[dependency].result = 'skipped'
      expect(verify(gate, jobs)).toBe(0)
    }
  })

  it('requires the reused bridge and shared packages without reviving old platform contracts', () => {
    const jobs = Object.fromEntries(
      workflow.jobs['general-test'].needs.map((dependency: string) => [dependency, { result: 'success' }])
    )
    jobs.changes = {
      result: 'success',
      outputs: { plan: JSON.stringify(createPlan(['packages/web-search/src/providers/tavily.ts'])) }
    }
    expect(verify('general', jobs)).toBe(0)
    for (const dependency of ['main-test-shard', 'package-test']) {
      jobs[dependency].result = 'skipped'
      expect(verify('general', jobs)).not.toBe(0)
      jobs[dependency].result = 'success'
    }
  })

  it('uses actual step outcomes to reject every unsuccessful or missing planned basic group', () => {
    const jobs = {
      changes: {
        result: 'success' as string | undefined,
        outputs: { plan: JSON.stringify(createPlan(['package.json'])) }
      }
    }
    const steps: Record<string, { outcome?: string; conclusion?: string }> = Object.fromEntries(
      ['repository-result', 'type-checks', 'lint-checks', 'i18n-checks'].map((id) => [id, { outcome: 'success' }])
    )
    expect(verify('basic', jobs, steps)).toBe(0)
    for (const id of Object.keys(steps)) {
      for (const outcome of ['failure', 'cancelled', 'skipped', undefined]) {
        steps[id] = { outcome, conclusion: 'success' }
        expect(verify('basic', jobs, steps)).not.toBe(0)
      }
      const saved = steps[id]
      delete steps[id]
      expect(verify('basic', jobs, steps)).not.toBe(0)
      steps[id] = { ...saved, outcome: 'success' }
    }
    for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
      jobs.changes.result = result
      expect(verify('basic', jobs, steps)).not.toBe(0)
    }
    jobs.changes.result = 'success'
    expect(verify('basic', jobs)).not.toBe(0)
    expect(verify('basic', {}, steps)).not.toBe(0)
    jobs.changes.outputs.plan = JSON.stringify(createPlan(['README.md']))
    for (const id of ['type-checks', 'lint-checks', 'i18n-checks']) steps[id].outcome = 'skipped'
    expect(verify('basic', jobs, steps)).toBe(0)
    jobs.changes.outputs.plan = JSON.stringify({
      target: 'tauri',
      tasks: ['types-tauri'],
      projects: [],
      platform: false
    })
    steps['repository-result'].outcome = 'skipped'
    steps['type-checks'].outcome = 'success'
    expect(verify('basic', jobs, steps)).toBe(0)
    jobs.changes.outputs.plan = JSON.stringify(createPlan(['package.json'], undefined, 'electron'))
    expect(verify('basic', jobs, steps)).not.toBe(0)
  })
})

describe('basic checks in one runner', () => {
  const job = workflow.jobs['basic-checks']
  it('shares one install and verifies outcomes in the same required job without suppressing failures', () => {
    expect(job.needs).toBe('changes')
    expect(
      job.steps.filter((step: { uses?: string }) => step.uses === './.github/actions/setup-validation')
    ).toHaveLength(1)
    expect(job.steps.some((step: Record<string, unknown>) => step['continue-on-error'])).toBe(false)
    expect(job.steps.find((step: { id?: string }) => step.id === 'repository-result').if).toContain(
      "steps.repository-checks.outcome == 'success'"
    )
    const gate = job.steps.find((step: { run?: string }) => step.run === 'node scripts/validation/verify.mjs basic')
    expect(gate.env.VALIDATION_STEPS).toBe('${{ toJSON(steps) }}')
    expect(
      new Function('cancelled', 'success', `return (${gate.if})`)(
        () => false,
        () => false
      )
    ).toBe(true)
    expect(
      new Function('cancelled', 'success', `return (${gate.if})`)(
        () => true,
        () => false
      )
    ).toBe(false)
  })

  it.each([
    ['types', 'type-checks'],
    ['lint', 'lint-checks'],
    ['i18n', 'i18n-sync'],
    ['i18n', 'i18n-checks'],
    ['repository', 'repository-checks']
  ])('preserves %s selection and readiness for %s', (group, id) => {
    const needs = { changes: { outputs: { [group]: 'true' } } }
    const step = job.steps.find((step: { id?: string }) => step.id === id)
    if (id !== 'i18n-sync') expect(step.run).toBe(`pnpm check --target tauri --group ${group}`)
    const condition = step.if.replaceAll('steps.i18n-sync', "steps['i18n-sync']")
    const selected = (outcome: string, cancelled: boolean) =>
      new Function('needs', 'steps', 'cancelled', 'success', `return (${condition})`)(
        needs,
        { dependencies: { outcome }, 'i18n-sync': { outcome } },
        () => cancelled,
        () => false
      )
    expect(selected('success', false)).toBe(true)
    needs.changes.outputs[group] = 'false'
    expect(selected('success', false)).toBe(false)
    if (group !== 'repository') {
      needs.changes.outputs[group] = 'true'
      expect(condition).toContain('!cancelled()')
      expect(selected('failure', false)).toBe(false)
      expect(selected('success', true)).toBe(false)
    }
  })
})

// A failed dependency must still reach its gate; a cancelled workflow must not allocate another runner.
describe('required gate scheduling', () => {
  it.each([
    ['successful dependencies', 'success', 'pull_request', false, false, true],
    ['failed dependencies', 'failure', 'pull_request', false, false, true],
    ['skipped dependencies', 'skipped', 'pull_request', false, false, true],
    ['workflow cancellation', 'success', 'pull_request', false, true, false],
    ['draft pull request', 'success', 'pull_request', true, false, false],
    ['manual validation', 'success', 'workflow_dispatch', false, false, true]
  ])('handles %s with the upstream cancellation condition', (_name, dependency, event, draft, cancelled, expected) => {
    for (const name of ['basic-checks', 'general-test', 'render-test']) {
      const condition = workflow.jobs[name].if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      expect(condition).toContain('!cancelled()')
      const selected = new Function('github', 'cancelled', 'success', `return (${condition})`)(
        { event_name: event, event: { pull_request: { draft } } },
        () => cancelled,
        () => dependency === 'success'
      )
      expect(selected).toBe(expected)
    }
  })
})
