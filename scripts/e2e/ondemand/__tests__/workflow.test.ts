import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse } from 'yaml'

// Catch dispatch regressions that run a matrix, drop queued requests, or lose the verdict.
it('dispatches one validated platform and retains the machine-readable verdict and evidence', () => {
  const source = readFileSync(resolve(__dirname, '../../../../.github/workflows/qa-ondemand.yml'), 'utf8')
  const workflow = parse(source)
  expect(workflow.env.TZ).toBe('Asia/Shanghai')
  expect(workflow.on.workflow_dispatch.inputs.platform).toMatchObject({ options: ['windows'], default: 'windows' })
  expect(workflow.on.workflow_dispatch.inputs.profile).toMatchObject({
    options: ['clean', 'authenticated'],
    default: 'clean'
  })
  const run = workflow.jobs.test.steps.find((step: { name?: string }) => step.name === 'Run one test')
  expect(run.env.CHERRY_TEST_CUSTOM_PROVIDER_API_KEY).toBe('${{ secrets.CHERRY_TEST_CUSTOM_PROVIDER_API_KEY }}')
  const preflight = workflow.jobs.resolve.steps.find((step: { id?: string }) => step.id === 'ref')
  expect(preflight.env).toEqual(run.env)
  expect(workflow.jobs.test.strategy).toBeUndefined()
  expect(workflow.jobs.test['runs-on']).toBe('${{ needs.resolve.outputs.runner }}')
  expect(workflow.jobs.test.concurrency).toMatchObject({ 'cancel-in-progress': false, queue: 'max' })
  const upload = workflow.jobs.test.steps.find((step: { name?: string }) => step.name === 'Upload evidence')
  expect(upload.with['retention-days']).toBe(30)
  expect(upload.with.name).toContain('short_sha')
  expect(workflow.jobs.test.steps.at(-1).run).toContain('r.exitCode')
  expect(source).not.toContain('inputs.plan }}\n        run:')
  expect(source).not.toContain('run-phase')
  expect(source).not.toContain('startup-smoke')
  const steps = workflow.jobs.test.steps
  const prepare = steps.findIndex((step: { name?: string }) => step.name === 'Prepare branch runtime')
  const execute = steps.findIndex((step: { name?: string }) => step.name === 'Run one test')
  expect(prepare).toBeLessThan(execute)
  expect(steps[prepare].if).toBe("needs.resolve.outputs.mode == 'branch'")
  expect(steps[prepare].run).toContain('exec dotenv -v CHERRY_EDITION=global -- electron-vite build')
})

it.each(['windows', 'macos', 'linux', 'unknown', ''])(
  'validates raw hosted platform %j before resolving or allocating a desktop runner',
  (platform) => {
    const workflow = parse(readFileSync(resolve(__dirname, '../../../../.github/workflows/qa-ondemand.yml'), 'utf8'))
    const preflight = workflow.jobs.resolve.steps.find((step: { id?: string }) => step.id === 'ref')
    const directory = mkdtempSync(join(tmpdir(), 'qa-platform-guard-'))
    const call = join(directory, 'resolve-call')
    const output = join(directory, 'github-output')
    try {
      const result = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-e',
          '-o',
          'pipefail',
          '-c',
          `pnpm() { printf '%s' "$*" > "$RESOLVE_CALL"; }\n${preflight.run}`
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, QA_PLATFORM: platform, RESOLVE_CALL: call, GITHUB_OUTPUT: output }
        }
      )
      expect(result.status, result.stderr).toBe(platform === 'windows' ? 0 : 2)
      expect(existsSync(call)).toBe(platform === 'windows')
      if (platform === 'windows')
        expect(readFileSync(call, 'utf8')).toBe('exec tsx scripts/e2e/ondemand/run.ts resolve')
      else {
        expect(result.stdout).toContain('Hosted QA supports Windows only')
        expect(existsSync(output)).toBe(false)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it('keeps unrelated workflow diagnostics blocking the CI gate', () => {
  const ci = parse(readFileSync(resolve(__dirname, '../../../../.github/workflows/ci.yml'), 'utf8'))
  const lint = ci.jobs.changes.steps.find((step: { name?: string }) => step.name === 'Lint GitHub Actions workflows')
  expect(lint.with?.args ?? '').not.toContain('-ignore')
  const config = parse(readFileSync(resolve(__dirname, '../../../../.github/actionlint.yaml'), 'utf8'))
  expect(Object.keys(config.paths)).toEqual(['.github/workflows/qa-ondemand.yml'])
  const filters = config.paths['.github/workflows/qa-ondemand.yml'].ignore
  expect(filters).toHaveLength(1)
  const ignored = new RegExp(filters[0])
  expect('unexpected key "queue" for "concurrency" section. expected one of "cancel-in-progress", "group"').toMatch(
    ignored
  )
  for (const error of [
    'unexpected key "queue_typo" for "concurrency" section. expected one of "cancel-in-progress", "group"',
    'unexpected key "queue" for "job" section. expected one of "runs-on", "steps"',
    'invalid expression in concurrency group'
  ])
    expect(error).not.toMatch(ignored)
})
