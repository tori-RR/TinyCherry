import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { installUpstreamHook } from './install-upstream-hook.mjs'
import { installFreshDependencies } from './upstreamDependencies.mjs'
import { checkCatalogPolicy, checkWorkflowPolicy } from './upstreamPolicy.mjs'
import {
  assertSnapshot,
  captureSnapshot,
  invalidateReceipt,
  UPSTREAM_CHECKS,
  verifyReceipt,
  writeReceipt
} from './upstreamState.mjs'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const commit = (root, ref) => git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])

export function validationEnvironment(root, original = process.env) {
  const env = { ...original, CI: 'true', TRANSLATION_BASE_LOCALE: 'en-us' }
  delete env.VALIDATION_PLAN
  delete env.VALIDATION_WORKSPACE_PREPARED
  // Native packaging prepares its own Go/Cargo caches; pnpm must also stay in the workspace.
  env.npm_config_store_dir = path.join(root, '.pnpm-store')
  env.npm_config_verify_store_integrity = 'true'
  const cache = path.join(root, '.cache/upstream-validation')
  for (const name of ['tmp', 'npm', 'cache', 'state', 'data']) mkdirSync(path.join(cache, name), { recursive: true })
  env.TEMP = env.TMP = path.join(cache, 'tmp')
  env.npm_config_cache = path.join(cache, 'npm')
  env.npm_config_devdir = path.join(cache, 'node-gyp')
  env.PREK_HOME = path.join(cache, 'prek')
  env.XDG_CACHE_HOME = path.join(cache, 'cache')
  env.XDG_STATE_HOME = path.join(cache, 'state')
  env.XDG_DATA_HOME = path.join(cache, 'data')
  return env
}

export function validationSteps(base) {
  return [
    ['environment'],
    ['dependencies', ['install', '--frozen-lockfile']],
    ['git-hooks', ['exec', 'prek', 'install']],
    [
      'dependency-imports',
      [
        'exec',
        'node',
        '--input-type=module',
        '-e',
        "await import('@earendil-works/pi-ai'); await import('@earendil-works/pi-coding-agent')"
      ]
    ],
    ['workflow-policy'],
    ['actionlint'],
    ['catalog-policy'],
    ['changeset-policy', ['changeset:check']],
    ['provider-compatibility', ['--filter', '@cherrystudio/provider-registry', 'compat:policy', '--', base]],
    ['changesets', ['changeset', 'status', `--since=${base}`]],
    ['migration-drift', ['db:migrations:generate']],
    ['provider-id-drift', ['gen:system-provider-ids']],
    ['locale-drift', ['i18n:sync']],
    ['static-checks', ['check', '--all', '--group', 'checks']],
    ['platform-tests', ['check', '--all', '--group', 'platform', '--max-workers=2']],
    [
      'gate-tests',
      [
        'exec',
        'vitest',
        'run',
        '--project',
        'scripts',
        'scripts/__tests__/validationPlan.test.ts',
        'scripts/__tests__/upstreamWorkflow.test.ts',
        'scripts/__tests__/upstreamState.test.ts',
        'scripts/__tests__/upstreamValidation.test.ts',
        'scripts/__tests__/upstreamDependencies.test.ts',
        'scripts/__tests__/piAiPatch.test.ts',
        '--maxWorkers',
        '2'
      ]
    ],
    ['native-package'],
    ['final-i18n', ['check', '--all', '--group', 'i18n']]
  ]
}

function execute(command, args, root, env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with ${result.status ?? result.signal}`)
}

function pnpm(args, root, env) {
  const executable = env.npm_execpath
  if (!executable) throw new Error('Run this command through pnpm upstream:verify')
  const script = /\.[cm]?js$/.test(executable)
  execute(script ? process.execPath : executable, script ? [executable, ...args] : args, root, env)
}

function runStep(id, args, context) {
  const { root, base, env } = context
  if (id === 'dependencies') {
    const result = installFreshDependencies(root, () => pnpm(args, root, env))
    if (result.backup) process.stdout.write(`[upstream] dependency backup retained: ${result.backup}\n`)
    return
  }
  if (args) return pnpm(args, root, env)
  if (id === 'workflow-policy') return checkWorkflowPolicy(root)
  if (id === 'catalog-policy') return checkCatalogPolicy(root, base)
  if (id === 'environment') {
    const node = readFileSync(path.join(root, '.node-version'), 'utf8').trim().replace(/^v/, '')
    if (process.versions.node !== node) throw new Error(`Use the CI Node version: ${node}`)
    const expected = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
      .packageManager.split('@')[1]
      .split('+')[0]
    const executable = env.npm_execpath
    if (!executable) throw new Error('Run through pnpm upstream:verify')
    const version = execFileSync(
      /\.[cm]?js$/.test(executable) ? process.execPath : executable,
      /\.[cm]?js$/.test(executable) ? [executable, '--version'] : ['--version'],
      { cwd: root, env, encoding: 'utf8' }
    ).trim()
    if (version !== expected) throw new Error(`Use pnpm ${expected}`)
    if (process.platform !== 'win32')
      throw new Error('The upstream release gate requires Windows x64 Portable validation')
    installUpstreamHook(root)
    return
  }
  if (id === 'actionlint') {
    const cached = path.join(
      root,
      '.cache/upstream-validation/tools',
      process.platform === 'win32' ? 'actionlint.exe' : 'actionlint'
    )
    const executable = existsSync(cached) ? cached : 'actionlint'
    const expected = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').match(
      /docker:\/\/rhysd\/actionlint:([\d.]+)/
    )?.[1]
    const version = execFileSync(executable, ['--version'], { cwd: root, env, encoding: 'utf8' }).split(/\r?\n/)[0]
    if (!expected || version !== expected) throw new Error(`Install the CI actionlint version: ${expected}`)
    // The Linux CI container also owns shellcheck; local Windows validation checks workflow syntax.
    return execute(executable, ['-shellcheck=', '-pyflakes='], root, env)
  }
  if (id === 'native-package') {
    return execute(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'native/evostack/build.ps1'],
      root,
      env
    )
  }
  throw new Error(`Unknown upstream check: ${id}`)
}

export function verifyUpstream(root, options, runner = runStep) {
  invalidateReceipt(root, commit(root, 'HEAD'))
  const snapshot = captureSnapshot(root)
  if (!options.base || !options.upstream) throw new Error('Supply --base <target commit> and --upstream <official tag>')
  const base = commit(root, options.base)
  const upstream = commit(root, options.upstream)
  execute('git', ['merge-base', '--is-ancestor', base, snapshot.head], root, process.env)
  const env = validationEnvironment(root)
  const checks = []
  for (const [id, args] of validationSteps(base)) {
    assertSnapshot(root, snapshot)
    process.stdout.write(`\n[upstream] ${id}\n`)
    runner(id, args, { root, base, upstream, env })
    assertSnapshot(root, snapshot)
    checks.push(id)
  }
  if (JSON.stringify(checks) !== JSON.stringify(UPSTREAM_CHECKS)) throw new Error('Incomplete upstream validation plan')
  writeReceipt(root, snapshot, { base, upstream, checks })
  return snapshot
}

export function assertFullCiRun(runs, revision) {
  const run = runs.find((item) => item.headSha === revision && item.event === 'workflow_dispatch')
  if (!run || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('The latest full CI dispatch for this exact commit must complete successfully before promotion')
  }
}

export function verifyFullCi(root, revision, remoteUrl) {
  const origin = remoteUrl ?? git(root, ['remote', 'get-url', 'origin'])
  const repository = origin.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/
  )?.[1]
  if (!repository) throw new Error('The promotion gate requires a GitHub origin repository')
  const runs = JSON.parse(
    execFileSync(
      'gh',
      [
        'run',
        'list',
        '--repo',
        repository,
        '--workflow',
        'ci.yml',
        '--commit',
        revision,
        '--event',
        'workflow_dispatch',
        '--limit',
        '20',
        '--json',
        'headSha,event,status,conclusion'
      ],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  )
  assertFullCiRun(runs, revision)
}

export function checkPush(root, input, checker = verifyReceipt, ciChecker = verifyFullCi) {
  const refs = input.trim().split(/\r?\n/).filter(Boolean)
  for (const line of refs) {
    const fields = line.split(/\s+/)
    if (
      fields.length !== 4 ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[1]) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(fields[3]) ||
      !fields[2].startsWith('refs/') ||
      spawnSync('git', ['check-ref-format', fields[2]], { cwd: root, stdio: 'ignore' }).status !== 0
    ) {
      throw new Error('Invalid Git pre-push ref input')
    }
    if (/^0+$/.test(fields[1])) continue
    const receipt = checker(root, fields[1])
    if (/^refs\/heads\/(?:main|evostack|release\/.*)$/.test(fields[2])) {
      ciChecker(root, receipt.head)
    }
  }
}

export function mergeUpstream(root, ref, ciChecker = verifyFullCi) {
  if (!ref) throw new Error('Supply --ref <validated candidate>')
  const before = captureSnapshot(root)
  const candidate = commit(root, ref)
  verifyReceipt(root, candidate)
  ciChecker(root, candidate)
  assertSnapshot(root, before)
  // Fast-forward preserves the tested commit and the native executables' embedded revision.
  execute('git', ['merge', '--ff-only', '--no-edit', candidate], root, validationEnvironment(root))
  verifyReceipt(root, 'HEAD')
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      upstream: { type: 'string' },
      ref: { type: 'string' },
      check: { type: 'boolean' },
      merge: { type: 'boolean' },
      'pre-push': { type: 'boolean' },
      'remote-url': { type: 'string' }
    }
  })
  if ([values.check, values.merge, values['pre-push']].filter(Boolean).length > 1)
    throw new Error('Choose one operation')
  if (values['pre-push'])
    return checkPush(repositoryRoot, readFileSync(0, 'utf8'), verifyReceipt, (root, revision) =>
      verifyFullCi(root, revision, values['remote-url'])
    )
  if (values.check) return verifyReceipt(repositoryRoot, values.ref ?? 'HEAD')
  if (values.merge) return mergeUpstream(repositoryRoot, values.ref)
  const result = verifyUpstream(repositoryRoot, values)
  process.stdout.write(`[upstream] local validation passed: ${result.head}; full CI is required before promotion\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`[upstream] ${error.message}\nRun pnpm upstream:verify after the final commit.\n`)
    process.exitCode = 1
  }
}
