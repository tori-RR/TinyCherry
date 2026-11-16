import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const temporary = resolve('.cache/evostack-workflow-tests')
const directories: string[] = []
const environment = { ...process.env }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete environment[key]
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function fixture() {
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(join(temporary, 'repo-'))
  directories.push(root)
  const native = join(root, 'native/evostack')
  mkdirSync(native, { recursive: true })
  copyFileSync('native/evostack/verify-source.ps1', join(native, 'verify-source.ps1'))
  writeFileSync(join(root, '.gitignore'), '.cache/\nnative/evostack/dist/\n')
  writeFileSync(join(root, 'source.txt'), 'committed source\n')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '.')
  git(
    root,
    '-c',
    'user.name=Build Fixture',
    '-c',
    'user.email=fixture@users.noreply.github.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '-qm',
    'fixture'
  )
  return root
}

const verify = (root: string, revision = git(root, 'rev-parse', 'HEAD')) =>
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'native/evostack/verify-source.ps1'),
      '-ExpectedRevision',
      revision
    ],
    { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )

function checkRuntime(machine: string | null, user: string | null) {
  const literal = (value: string | null) => (value === null ? '$null' : `'${value.replaceAll("'", "''")}'`)
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `function Get-ItemPropertyValue {
        param($LiteralPath, $Name, $ErrorAction)
        if ($Name -ne 'pv') { throw 'Unexpected registry value' }
        switch ($LiteralPath) {
          'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' { return ${literal(machine)} }
          'HKCU:\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' { return ${literal(user)} }
          default { throw 'Unexpected registry location' }
        }
      }
      & '${resolve('native/evostack/check-webview2.ps1').replaceAll("'", "''")}'`
    ],
    { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    expect(directory.startsWith(temporary + sep)).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('EvoStack Windows source identity', () => {
  it('accepts the exact committed revision and ignored generated output', () => {
    const root = fixture()
    mkdirSync(join(root, '.cache'))
    mkdirSync(join(root, 'native/evostack/dist'))
    writeFileSync(join(root, '.cache/run.log'), 'ignored evidence\n')
    writeFileSync(join(root, 'native/evostack/dist/package.zip'), 'synthetic ignored artifact\n')
    expect(() => verify(root)).not.toThrow()
  })

  it.each(['tracked', 'staged', 'untracked'])('rejects %s source drift', (kind) => {
    const root = fixture()
    writeFileSync(join(root, kind === 'untracked' ? 'new.txt' : 'source.txt'), 'changed source\n')
    if (kind === 'staged') git(root, 'add', 'source.txt')
    expect(() => verify(root)).toThrow('clean source worktree')
  })

  it('rejects a different external revision', () => {
    expect(() => verify(fixture(), 'f'.repeat(40))).toThrow('does not match ExpectedRevision')
  })

  it('requires a full revision instead of a mutable branch or dirty label', () => {
    const root = fixture()
    expect(() => verify(root, 'main')).toThrow()
    expect(() => verify(root, git(root, 'rev-parse', 'HEAD') + '-dirty')).toThrow()
  })
})

describe('EvoStack Windows workflow', () => {
  it('checks the full renderer and native TypeScript inputs before packaging', () => {
    const build = readFileSync('native/evostack/build.ps1', 'utf8')
    for (const config of ['tsconfig.web.json', 'tsconfig.tauri.json']) {
      expect(build).toContain(`Invoke-EvoStep { pnpm exec tsc --noEmit -p ${config} --composite false }`)
    }
  })

  it('covers every native input on main and evostack, including future build helpers and Markdown resources', () => {
    const workflow = parse(readFileSync('.github/workflows/evostack-windows.yml', 'utf8'))
    for (const event of ['push', 'pull_request']) {
      expect(workflow.on[event]).toEqual({ branches: ['main', 'evostack'] })
    }
    expect(Object.hasOwn(workflow.on, 'workflow_dispatch')).toBe(true)
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.portable['runs-on']).toMatch(/^windows-/)
    expect(workflow.jobs.portable.env.EVOSTACK_EXPECTED_REVISION).toBe('${{ github.sha }}')
  })

  it('requires the externally identified build and clean source before uploading', () => {
    const workflow = parse(readFileSync('.github/workflows/evostack-windows.yml', 'utf8'))
    const steps = workflow.jobs.portable.steps
    const build = steps.findIndex((step: { run?: string }) =>
      step.run?.includes('./native/evostack/build.ps1 -ExpectedRevision $env:EVOSTACK_EXPECTED_REVISION')
    )
    const sourceChecks = steps.flatMap((step: { run?: string }, index: number) =>
      step.run?.includes('./native/evostack/verify-source.ps1 -ExpectedRevision $env:EVOSTACK_EXPECTED_REVISION')
        ? [index]
        : []
    )
    const upload = steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/upload-artifact@'))
    expect(build).toBeGreaterThan(-1)
    expect(sourceChecks).toHaveLength(2)
    expect(sourceChecks[0]).toBeLessThan(build)
    expect(sourceChecks[1]).toBeGreaterThan(build)
    expect(upload).toBeGreaterThan(sourceChecks[1])
    for (const step of steps) {
      expect(step['continue-on-error']).toBeUndefined()
      expect(step.if).toBeUndefined()
    }
    expect(steps[build].run).not.toContain('SkipChecks')
  })
})

describe('WebView2 Runtime prerequisite', () => {
  it.each([
    ['157.0.4341.46', null],
    [null, '157.0.4341.46'],
    ['0.0.0.0', '157.0.4341.46']
  ])('accepts an installed Runtime in machine %s or user %s registration', (machine, user) => {
    expect(checkRuntime(machine, user)).toContain('WebView2 Runtime detected: 157.0.4341.46')
  })

  it.each([
    [null, null],
    ['0.0.0.0', ''],
    ['invalid-version', null]
  ])('rejects missing or invalid Runtime registrations (%s, %s)', (machine, user) => {
    expect(() => checkRuntime(machine, user)).toThrow('WebView2 Evergreen Runtime is required')
  })
})
