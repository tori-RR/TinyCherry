import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { installUpstreamHook } from '../validation/install-upstream-hook.mjs'
import {
  assertSnapshot,
  captureSnapshot,
  invalidateReceipt,
  UPSTREAM_ARTIFACTS,
  UPSTREAM_CHECKS,
  verifyReceipt,
  writeReceipt
} from '../validation/upstreamState.mjs'

const temporary = resolve('.cache/upstream-state-tests')
const directories: string[] = []
const environment = { ...process.env }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete environment[key]
const git = (root: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function fixture() {
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(join(temporary, 'repo-'))
  directories.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Validation Fixture')
  git(root, 'config', 'user.email', 'fixture@users.noreply.github.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(root, '.gitignore'), '.cache/\nnative/evostack/dist/\n')
  writeFileSync(join(root, 'source.txt'), 'source one\n')
  git(root, 'add', '.gitignore', 'source.txt')
  git(root, 'commit', '--no-verify', '-qm', 'fixture')
  mkdirSync(join(root, '.cache'))
  for (const artifact of UPSTREAM_ARTIFACTS) {
    const path = join(root, artifact)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `synthetic fixture: ${artifact}`)
  }
  return root
}

const receiptFile = (root: string, head = git(root, 'rev-parse', 'HEAD')) =>
  join(root, '.cache/upstream-validation/receipts', `${head}.json`)
const approve = (root: string) => {
  const snapshot = captureSnapshot(root)
  return writeReceipt(root, snapshot, { base: snapshot.head, upstream: snapshot.head, checks: UPSTREAM_CHECKS })
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    expect(directory.startsWith(temporary + sep)).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('upstream validation source state', () => {
  it('captures the committed head and tree', () => {
    const root = fixture()
    expect(captureSnapshot(root)).toEqual({
      head: git(root, 'rev-parse', 'HEAD'),
      tree: git(root, 'rev-parse', 'HEAD^{tree}')
    })
  })

  it.each(['tracked', 'staged', 'untracked'])('rejects %s changes', (kind) => {
    const root = fixture()
    writeFileSync(join(root, kind === 'untracked' ? 'new.txt' : 'source.txt'), 'changed\n')
    if (kind === 'staged') git(root, 'add', 'source.txt')
    expect(() => captureSnapshot(root)).toThrow('clean worktree')
  })

  it('allows ignored logs but invalidates a changed committed head', () => {
    const root = fixture()
    const snapshot = captureSnapshot(root)
    writeFileSync(join(root, '.cache', 'run.log'), 'ignored evidence\n')
    expect(() => assertSnapshot(root, snapshot)).not.toThrow()
    git(root, 'commit', '--no-verify', '--allow-empty', '-qm', 'new identity')
    expect(() => assertSnapshot(root, snapshot)).toThrow('Source changed')
  })

  it.each(['MERGE_HEAD', 'rebase-merge', 'rebase-apply'])('rejects an active %s in the actual gitdir', (operation) => {
    const root = fixture()
    const path = resolve(root, git(root, 'rev-parse', '--git-path', operation))
    if (operation === 'MERGE_HEAD') writeFileSync(path, git(root, 'rev-parse', 'HEAD'))
    else mkdirSync(path)
    expect(() => captureSnapshot(root)).toThrow('Finish the Git operation')
  })

  it('checks operation state inside a linked worktree gitdir', () => {
    const root = fixture()
    const linked = join(root, '.cache', 'linked')
    git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD')
    expect(() => captureSnapshot(linked)).not.toThrow()
    writeFileSync(resolve(linked, git(linked, 'rev-parse', '--git-path', 'MERGE_HEAD')), git(root, 'rev-parse', 'HEAD'))
    expect(() => captureSnapshot(linked)).toThrow('Finish the Git operation')
  })
})

describe('upstream validation receipts', () => {
  it('rejects missing and unreadable evidence', () => {
    const root = fixture()
    expect(() => verifyReceipt(root)).toThrow('Missing or unreadable')
    mkdirSync(dirname(receiptFile(root)), { recursive: true })
    writeFileSync(receiptFile(root), '{broken')
    expect(() => verifyReceipt(root)).toThrow('Missing or unreadable')
  })

  it('records complete relative artifact hashes without machine paths', () => {
    const root = fixture()
    const receipt = approve(root)
    expect(verifyReceipt(root)).toEqual(receipt)
    expect(receipt.checks).toEqual(UPSTREAM_CHECKS)
    expect(receipt.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual(UPSTREAM_ARTIFACTS)
    expect(receipt.artifacts.every((artifact: { sha256: string }) => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true)
    expect(readFileSync(receiptFile(root), 'utf8')).not.toContain(root)
    expect(git(root, 'status', '--porcelain')).toBe('')
    invalidateReceipt(root, receipt.head)
    expect(existsSync(receiptFile(root))).toBe(false)
    expect(() => verifyReceipt(root)).toThrow('Missing or unreadable')
  })

  it('does not write receipts for partial or reordered checks', () => {
    const root = fixture()
    const snapshot = captureSnapshot(root)
    for (const checks of [UPSTREAM_CHECKS.slice(1), [...UPSTREAM_CHECKS].reverse()]) {
      expect(() => writeReceipt(root, snapshot, { base: snapshot.head, upstream: snapshot.head, checks })).toThrow(
        'every upstream'
      )
    }
    expect(existsSync(receiptFile(root))).toBe(false)
  })

  it.each(['schema', 'head', 'tree', 'nodeVersion', 'checks', 'artifacts', 'base', 'upstream'])(
    'rejects corrupt %s evidence',
    (field) => {
      const root = fixture()
      const receipt = approve(root)
      const changed = {
        ...receipt,
        [field]: field === 'checks' ? UPSTREAM_CHECKS.slice(1) : field === 'artifacts' ? [] : 'invalid'
      }
      writeFileSync(receiptFile(root), JSON.stringify(changed))
      expect(() => verifyReceipt(root)).toThrow()
    }
  )

  it('rejects dirty sources after validation', () => {
    const root = fixture()
    approve(root)
    writeFileSync(join(root, 'source.txt'), 'post-validation source change\n')
    expect(() => verifyReceipt(root)).toThrow('clean worktree')
  })

  it('rejects mutated, missing and redirected artifacts', () => {
    const root = fixture()
    const receipt = approve(root)
    writeFileSync(join(root, UPSTREAM_ARTIFACTS[0]), 'changed executable')
    expect(() => verifyReceipt(root)).toThrow('artifacts changed')
    rmSync(join(root, UPSTREAM_ARTIFACTS[0]))
    expect(() => verifyReceipt(root)).toThrow('Missing regular')
    const forged = {
      ...receipt,
      artifacts: [{ ...receipt.artifacts[0], path: '../foreign.exe' }, ...receipt.artifacts.slice(1)]
    }
    writeFileSync(join(root, UPSTREAM_ARTIFACTS[0]), `synthetic fixture: ${UPSTREAM_ARTIFACTS[0]}`)
    writeFileSync(receiptFile(root), JSON.stringify(forged))
    expect(() => verifyReceipt(root)).toThrow('artifacts changed')
  })

  it('verifies the requested ref rather than silently substituting HEAD', () => {
    const root = fixture()
    const approved = approve(root)
    git(root, 'branch', 'approved', approved.head)
    git(root, 'commit', '--no-verify', '--allow-empty', '-qm', 'different commit with the same source tree')
    expect(() => verifyReceipt(root)).toThrow('Missing or unreadable')
    expect(verifyReceipt(root, 'approved').head).toBe(approved.head)
  })
})

describe('upstream pre-push hook installation', () => {
  it('installs idempotently and preserves existing unrelated hooks', () => {
    const root = fixture()
    const hooks = resolve(root, git(root, 'rev-parse', '--git-path', 'hooks'))
    writeFileSync(join(hooks, 'pre-commit'), 'existing prek hook\n')
    installUpstreamHook(root)
    const installed = readFileSync(join(hooks, 'pre-push'), 'utf8')
    expect(installed).toContain('exec node "$ROOT/scripts/validation/upstream.mjs" --pre-push --remote-url "$2"')
    installUpstreamHook(root)
    expect(readFileSync(join(hooks, 'pre-push'), 'utf8')).toBe(installed)
    expect(readFileSync(join(hooks, 'pre-commit'), 'utf8')).toBe('existing prek hook\n')
    expect(relative(root, hooks)).toBe(join('.git', 'hooks'))
  })

  it('refuses to overwrite an unfamiliar pre-push hook', () => {
    const root = fixture()
    const hook = resolve(root, git(root, 'rev-parse', '--git-path', 'hooks/pre-push'))
    writeFileSync(hook, '#!/bin/sh\necho owned by another tool\n')
    expect(() => installUpstreamHook(root)).toThrow('not managed by TinyCherry')
    expect(readFileSync(hook, 'utf8')).toContain('another tool')
  })

  it('refuses a pre-push symlink without modifying its target', () => {
    const root = fixture()
    const target = join(root, '.cache', 'external-hook')
    writeFileSync(target, '#!/bin/sh\necho preserve target\n')
    const hook = resolve(root, git(root, 'rev-parse', '--git-path', 'hooks/pre-push'))
    symlinkSync(target, hook, 'file')
    expect(() => installUpstreamHook(root)).toThrow('symbolic-link pre-push')
    expect(lstatSync(hook).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('preserve target')
  })

  it('preserves external core.hooksPath and does not create new directories there', () => {
    const root = fixture()
    const external = join(root, '.cache', 'uncreated-external-hooks')
    git(root, 'config', 'core.hooksPath', external)
    expect(() => installUpstreamHook(root)).toThrow('outside the Git common directory')
    expect(existsSync(external)).toBe(false)
    mkdirSync(external)
    writeFileSync(join(external, 'pre-push'), '#!/bin/sh\necho external hook\n')
    expect(() => installUpstreamHook(root)).toThrow('outside the Git common directory')
    expect(readFileSync(join(external, 'pre-push'), 'utf8')).toContain('external hook')
  })

  it('installs shared hooks for a linked worktree inside its common Git directory', () => {
    const root = fixture()
    const linked = join(root, '.cache', 'linked')
    git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD')
    installUpstreamHook(linked)
    const hook = resolve(linked, git(linked, 'rev-parse', '--git-path', 'hooks/pre-push'))
    expect(readFileSync(hook, 'utf8')).toContain('TinyCherry upstream validation hook (managed)')
    expect(hook).toBe(resolve(root, git(root, 'rev-parse', '--git-path', 'hooks/pre-push')))
  })
})
