import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  assertFullCiRun,
  checkPush,
  mergeUpstream,
  validationEnvironment,
  validationSteps,
  verifyUpstream
} from '../validation/upstream.mjs'
import {
  captureSnapshot,
  UPSTREAM_ARTIFACTS,
  UPSTREAM_CHECKS,
  verifyReceipt,
  writeReceipt
} from '../validation/upstreamState.mjs'

const directories: string[] = []
const revision = 'a'.repeat(40)
const previous = 'b'.repeat(40)
const missing = '0'.repeat(40)

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cherry-upstream-validation-'))
  directories.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  const commit = () => {
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'validation fixture')
    return git('rev-parse', 'HEAD')
  }
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'core.autocrlf', 'false')
  write('.gitignore', '/.cache/\n/native/evostack/dist/\n')
  write('source.ts', 'export const value = 1\n')
  const base = commit()
  git('tag', 'official-version')
  write('source.ts', 'export const value = 2\n')
  const head = commit()
  for (const artifact of UPSTREAM_ARTIFACTS) write(artifact, `synthetic artifact for ${head}: ${artifact}\n`)
  const options = { base, upstream: 'official-version' }
  const receipt = join(root, '.cache/upstream-validation/receipts', `${head}.json`)
  const seedReceipt = () => writeReceipt(root, captureSnapshot(root), { base, upstream: base, checks: UPSTREAM_CHECKS })
  return { root, base, head, options, receipt, write, commit, seedReceipt }
}

describe('upstream validation plan and environment', () => {
  it('includes the complete plan and scans translations after native packaging', () => {
    const steps = validationSteps(previous)
    const ids = steps.map(([id]) => id)
    expect(ids).toEqual(UPSTREAM_CHECKS)
    expect(steps.find(([id]) => id === 'static-checks')?.[1]).toEqual(['check', '--all', '--group', 'checks'])
    expect(steps[0][0]).toBe('environment')
    expect(steps[1]).toEqual(['dependencies', ['install', '--frozen-lockfile']])
    expect(steps.find(([id]) => id === 'platform-tests')?.[1]).toEqual([
      'check',
      '--all',
      '--group',
      'platform',
      '--max-workers=2'
    ])
    expect(steps.find(([id]) => id === 'dependency-imports')?.[1]).toContain(
      "await import('@earendil-works/pi-ai'); await import('@earendil-works/pi-coding-agent')"
    )
    for (const id of ['migration-drift', 'provider-id-drift', 'locale-drift'])
      expect(ids.indexOf(id)).toBeLessThan(ids.indexOf('static-checks'))
    expect(ids.indexOf('final-i18n')).toBeGreaterThan(ids.indexOf('native-package'))
    expect(steps.at(-1)?.[1]).toEqual(['check', '--all', '--group', 'i18n'])
  })

  it('clears inherited subset/prepared flags and creates all temporary paths inside the repository', () => {
    const { root } = fixture()
    const original = {
      VALIDATION_PLAN: '{"projects":[]}',
      VALIDATION_WORKSPACE_PREPARED: 'true',
      CI: 'false',
      TRANSLATION_BASE_LOCALE: 'zh-cn',
      PATH: 'owned-path',
      TEMP: 'external-temp'
    }
    const env = validationEnvironment(root, original)
    expect(env).not.toHaveProperty('VALIDATION_PLAN')
    expect(env).not.toHaveProperty('VALIDATION_WORKSPACE_PREPARED')
    expect(env).toMatchObject({ CI: 'true', TRANSLATION_BASE_LOCALE: 'en-us', PATH: 'owned-path' })
    expect(original.TEMP).toBe('external-temp')
    expect(original.VALIDATION_WORKSPACE_PREPARED).toBe('true')
    for (const key of ['TEMP', 'TMP', 'npm_config_cache', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME']) {
      const location = relative(root, env[key])
      expect(isAbsolute(location)).toBe(false)
      expect(location.startsWith('..')).toBe(false)
      expect(existsSync(env[key])).toBe(true)
    }
    expect(env.npm_config_store_dir).toBe(join(root, '.pnpm-store'))
  })

  it('removes every case alias before overriding Windows environment keys', () => {
    const { root } = fixture()
    const env = validationEnvironment(root, {
      NPM_CONFIG_CACHE: 'external-uppercase-cache',
      npm_CONFIG_cache: 'external-mixed-cache',
      npm_config_cache: 'external-lowercase-cache',
      NPM_CONFIG_STORE_DIR: 'external-store',
      validation_plan: '{"projects":[]}',
      Validation_Workspace_Prepared: 'true',
      ci: 'false'
    })
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'npm_config_cache')).toEqual(['npm_config_cache'])
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'npm_config_store_dir')).toEqual([
      'npm_config_store_dir'
    ])
    expect(Object.keys(env).filter((key) => /^validation_(plan|workspace_prepared)$/i.test(key))).toEqual([])
    expect(env.npm_config_cache).toBe(join(root, '.cache/upstream-validation/npm'))
    expect(env.npm_config_store_dir).toBe(join(root, '.pnpm-store'))
    expect(env.CI).toBe('true')
    expect(env).not.toHaveProperty('ci')
  })
})

describe('upstream validation execution', () => {
  it('issues a receipt only after every check finishes against the same clean source', () => {
    const f = fixture()
    f.seedReceipt()
    const checks: string[] = []
    const result = verifyUpstream(f.root, f.options, (id: string) => {
      expect(existsSync(f.receipt)).toBe(false)
      checks.push(id)
      if (id === 'native-package') f.write(UPSTREAM_ARTIFACTS[0], `rebuilt artifact for ${f.head}\n`)
    })
    expect(checks).toEqual(UPSTREAM_CHECKS)
    expect(result.head).toBe(f.head)
    expect(verifyReceipt(f.root, f.head).head).toBe(f.head)
    expect(JSON.parse(readFileSync(f.receipt, 'utf8')).checks).toEqual(checks)
  })

  it.each(['static-checks', 'native-package', 'final-i18n'])(
    'fails closed and removes the old receipt when %s fails',
    (failure) => {
      const f = fixture()
      f.seedReceipt()
      const checks: string[] = []
      expect(() =>
        verifyUpstream(f.root, f.options, (id: string) => {
          checks.push(id)
          if (id === failure) throw new Error(`failed ${failure}`)
        })
      ).toThrow(`failed ${failure}`)
      expect(checks.at(-1)).toBe(failure)
      expect(existsSync(f.receipt)).toBe(false)
    }
  )

  it.each(['unstaged', 'committed'])(
    'rejects a concurrent %s source change instead of running later steps or issuing evidence',
    (change) => {
      const f = fixture()
      f.seedReceipt()
      const checks: string[] = []
      expect(() =>
        verifyUpstream(f.root, f.options, (id: string) => {
          checks.push(id)
          if (id === 'static-checks') {
            f.write('source.ts', 'export const value = 3\n')
            if (change === 'committed') f.commit()
          }
        })
      ).toThrow(/clean worktree|Source changed/)
      expect(checks.at(-1)).toBe('static-checks')
      expect(existsSync(f.receipt)).toBe(false)
    }
  )

  it('invalidates an old receipt even when validation is rejected before its first check', () => {
    const f = fixture()
    f.seedReceipt()
    f.write('source.ts', 'export const value = 3\n')
    const runner = vi.fn()
    expect(() => verifyUpstream(f.root, f.options, runner)).toThrow('clean worktree')
    expect(runner).not.toHaveBeenCalled()
    expect(existsSync(f.receipt)).toBe(false)
  })
})

describe('Git pre-push gate', () => {
  it('checks each actual source commit, including a non-HEAD commit and multiple destination refs', () => {
    const f = fixture()
    const checker = vi.fn((_root: string, head: string) => ({ head }))
    const ciChecker = vi.fn()
    const lines = [
      `refs/heads/older ${f.base} refs/heads/codex/upstream-candidate ${missing}`,
      `HEAD ${f.head} refs/heads/main ${f.base}`,
      `refs/heads/evostack ${f.base} refs/heads/evostack ${missing}`,
      `refs/heads/release ${f.head} refs/heads/release/v2.2.3 ${f.base}`,
      `refs/tags/version ${f.base} refs/tags/version ${missing}`
    ]
    checkPush(f.root, lines.join('\n'), checker, ciChecker)
    expect(checker.mock.calls).toEqual([f.base, f.head, f.base, f.head, f.base].map((head) => [f.root, head]))
    expect(ciChecker.mock.calls).toEqual([f.head, f.base, f.head].map((head) => [f.root, head]))
  })

  it('allows a first candidate push using local evidence without requiring an existing cloud run', () => {
    const { root } = fixture()
    const checker = vi.fn((_root: string, head: string) => ({ head }))
    const ciChecker = vi.fn()
    checkPush(root, `HEAD ${revision} refs/heads/codex/upstream-candidate ${missing}`, checker, ciChecker)
    expect(checker).toHaveBeenCalledWith(root, revision)
    expect(ciChecker).not.toHaveBeenCalled()
  })

  it('does not validate deleted refs and accepts an empty no-op push', () => {
    const { root } = fixture()
    const checker = vi.fn()
    const ciChecker = vi.fn()
    checkPush(root, `(delete) ${missing} refs/heads/main ${previous}\n`, checker, ciChecker)
    checkPush(root, '', checker, ciChecker)
    expect(checker).not.toHaveBeenCalled()
    expect(ciChecker).not.toHaveBeenCalled()
  })

  it.each([
    'invalid',
    `HEAD not-a-sha refs/heads/main ${missing}`,
    `HEAD ${revision} refs/heads/main`,
    `HEAD ${revision} refs/heads/main ${missing} extra`,
    `HEAD ${revision} refs/heads/main invalid-sha`,
    `HEAD ${revision} main ${missing}`
  ])('rejects malformed pre-push input: %s', (input) => {
    const { root } = fixture()
    expect(() =>
      checkPush(
        root,
        input,
        vi.fn(() => ({ head: revision })),
        vi.fn()
      )
    ).toThrow('Invalid Git pre-push')
  })

  it('propagates missing local evidence and cloud failures to block the entire push', () => {
    const { root } = fixture()
    expect(() =>
      checkPush(root, `HEAD ${revision} refs/heads/codex/upstream-candidate ${missing}`, () => {
        throw new Error('missing evidence')
      })
    ).toThrow('missing evidence')
    expect(() =>
      checkPush(
        root,
        `HEAD ${revision} refs/heads/main ${previous}`,
        () => ({ head: revision }),
        () => {
          throw new Error('cloud failure')
        }
      )
    ).toThrow('cloud failure')
  })
})

describe('exact-commit full CI promotion gate', () => {
  const success = { headSha: revision, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }

  it('accepts the latest successful full dispatch for the exact commit', () => {
    expect(() => assertFullCiRun([success], revision)).not.toThrow()
    expect(() => assertFullCiRun([success, { ...success, conclusion: 'failure' }], revision)).not.toThrow()
  })

  it.each(
    [
      [],
      [{ ...success, headSha: previous }],
      [{ ...success, event: 'push' }],
      [{ ...success, conclusion: 'cancelled' }],
      [{ ...success, status: 'in_progress', conclusion: null }],
      [{ ...success, conclusion: 'failure' }, success],
      [{ ...success, status: 'in_progress', conclusion: null }, success],
      [
        { ...success, event: 'push' },
        { ...success, conclusion: 'failure' }
      ]
    ].map((runs) => ({ runs }))
  )('rejects missing, mismatched, affected-only or superseded evidence %#', ({ runs }) => {
    expect(() => assertFullCiRun(runs, revision)).toThrow('latest full CI dispatch for this exact commit')
  })
})

describe('validated fast-forward promotion', () => {
  it('passes project-local dependency and temporary paths into the real post-merge hook', () => {
    const f = fixture()
    f.seedReceipt()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8' }).trim()
    git('checkout', '--detach', f.base)
    const keys = [
      'CI',
      'TRANSLATION_BASE_LOCALE',
      'VALIDATION_PLAN',
      'VALIDATION_WORKSPACE_PREPARED',
      'npm_config_store_dir',
      'npm_config_cache',
      'npm_config_devdir',
      'TEMP',
      'TMP',
      'PREK_HOME',
      'XDG_CACHE_HOME',
      'XDG_STATE_HOME',
      'XDG_DATA_HOME'
    ]
    f.write(
      '.cache/post-merge-environment.cjs',
      `const fs = require('node:fs'); fs.writeFileSync('.cache/post-merge-environment.json', JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, process.env[key]]))))\n`
    )
    const hook = join(f.root, '.git', 'hooks', 'post-merge')
    const node = process.execPath.replaceAll('\\', '/').replaceAll("'", "'\\''")
    writeFileSync(hook, `#!/bin/sh\nexec '${node}' '.cache/post-merge-environment.cjs'\n`)
    chmodSync(hook, 0o755)
    vi.stubEnv('TEMP', 'external-temp')
    vi.stubEnv('npm_config_store_dir', 'external-store')
    vi.stubEnv('VALIDATION_PLAN', '{"projects":[]}')
    vi.stubEnv('VALIDATION_WORKSPACE_PREPARED', 'true')
    const ci = vi.fn()
    mergeUpstream(f.root, f.head, ci)
    expect(ci).toHaveBeenCalledExactlyOnceWith(f.root, f.head)
    expect(git('rev-parse', 'HEAD')).toBe(f.head)
    expect(verifyReceipt(f.root).head).toBe(f.head)
    const env = JSON.parse(readFileSync(join(f.root, '.cache/post-merge-environment.json'), 'utf8'))
    expect(env).toMatchObject({ CI: 'true', TRANSLATION_BASE_LOCALE: 'en-us' })
    expect(env).not.toHaveProperty('VALIDATION_PLAN')
    expect(env).not.toHaveProperty('VALIDATION_WORKSPACE_PREPARED')
    expect(relative(f.root, env.npm_config_store_dir)).toBe('.pnpm-store')
    for (const key of keys.filter(
      (key) =>
        ![
          'CI',
          'TRANSLATION_BASE_LOCALE',
          'VALIDATION_PLAN',
          'VALIDATION_WORKSPACE_PREPARED',
          'npm_config_store_dir'
        ].includes(key)
    )) {
      const location = relative(f.root, env[key])
      expect(isAbsolute(location)).toBe(false)
      expect(location.startsWith('..')).toBe(false)
      expect(location.startsWith(join('.cache', 'upstream-validation'))).toBe(true)
    }
  })
})
