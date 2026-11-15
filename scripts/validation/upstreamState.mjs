import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export const UPSTREAM_CHECKS = Object.freeze([
  'environment',
  'dependencies',
  'git-hooks',
  'dependency-imports',
  'workflow-policy',
  'actionlint',
  'catalog-policy',
  'changeset-policy',
  'provider-compatibility',
  'changesets',
  'migration-drift',
  'provider-id-drift',
  'locale-drift',
  'static-checks',
  'platform-tests',
  'gate-tests',
  'native-package',
  'final-i18n'
])

export const UPSTREAM_ARTIFACTS = Object.freeze([
  'native/evostack/dist/portable/TinyCherry-EvoStack.exe',
  'native/evostack/dist/portable/tinycherry-evostack-backend.exe',
  'native/evostack/dist/portable/open-computer-use.exe',
  'native/evostack/dist/TinyCherry-EvoStack-win-x64-portable.zip'
])

const git = (root, ...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (root, ref) => {
  if (typeof ref !== 'string' || !ref) throw new Error('Expected a Git commit ref')
  return git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
}
const receiptPath = (root, head) => join(root, '.cache/upstream-validation/receipts', `${head}.json`)
const completeChecks = (checks) =>
  Array.isArray(checks) &&
  checks.length === UPSTREAM_CHECKS.length &&
  checks.every((check, index) => check === UPSTREAM_CHECKS[index])

export function captureSnapshot(root) {
  for (const operation of [
    'MERGE_HEAD',
    'rebase-apply',
    'rebase-merge',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'sequencer'
  ]) {
    if (existsSync(resolve(root, git(root, 'rev-parse', '--git-path', operation)))) {
      throw new Error(`Finish the Git operation before validation: ${operation}`)
    }
  }
  if (git(root, 'status', '--porcelain=v1', '--untracked-files=all')) {
    throw new Error('Validation requires a clean worktree, including staged and untracked files')
  }
  return { head: commit(root, 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}') }
}

export function assertSnapshot(root, expected) {
  const actual = captureSnapshot(root)
  if (actual.head !== expected.head || actual.tree !== expected.tree) {
    throw new Error('Source changed since validation began; run the complete validation again')
  }
}

function artifacts(root) {
  const realRoot = realpathSync(root)
  return UPSTREAM_ARTIFACTS.map((path) => {
    const file = join(root, path)
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error(`Missing regular validation artifact: ${path}`)
    const location = relative(realRoot, realpathSync(file))
    if (isAbsolute(location) || location === '..' || location.startsWith('../') || location.startsWith('..\\')) {
      throw new Error(`Validation artifact escapes the repository: ${path}`)
    }
    return { path, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
  })
}

export function invalidateReceipt(root, head) {
  rmSync(receiptPath(root, commit(root, head)), { force: true })
}

export function writeReceipt(root, snapshot, { base, upstream, checks }) {
  if (!completeChecks(checks)) throw new Error('A receipt requires every upstream validation check in order')
  assertSnapshot(root, snapshot)
  const receipt = {
    schema: 1,
    head: snapshot.head,
    tree: snapshot.tree,
    nodeVersion: process.version,
    base: commit(root, base),
    upstream: commit(root, upstream),
    checks: [...checks],
    artifacts: artifacts(root)
  }
  const file = receiptPath(root, snapshot.head)
  // Validation evidence stays local, including in a newly provisioned clone.
  git(root, 'check-ignore', '-q', '--', relative(root, file))
  assertSnapshot(root, snapshot)
  mkdirSync(dirname(file), { recursive: true })
  const pending = `${file}.pending-${process.pid}`
  try {
    writeFileSync(pending, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' })
    assertSnapshot(root, snapshot)
    renameSync(pending, file)
  } finally {
    rmSync(pending, { force: true })
  }
  return receipt
}

export function verifyReceipt(root, ref = 'HEAD') {
  const current = captureSnapshot(root)
  const head = commit(root, ref)
  let receipt
  try {
    receipt = JSON.parse(readFileSync(receiptPath(root, head), 'utf8'))
  } catch {
    throw new Error('Missing or unreadable upstream validation receipt; run the complete validation')
  }
  if (
    receipt?.schema !== 1 ||
    receipt.head !== head ||
    receipt.tree !== git(root, 'rev-parse', `${head}^{tree}`) ||
    receipt.nodeVersion !== process.version ||
    !completeChecks(receipt.checks) ||
    !Array.isArray(receipt.artifacts) ||
    receipt.artifacts.length !== UPSTREAM_ARTIFACTS.length
  ) {
    throw new Error('Stale or invalid upstream validation receipt; run the complete validation')
  }
  for (const field of ['base', 'upstream']) {
    if (receipt[field] !== commit(root, receipt[field])) throw new Error(`Invalid receipt ${field} commit`)
  }
  const actual = artifacts(root)
  if (
    receipt.artifacts.some(
      (artifact, index) => artifact?.path !== actual[index].path || artifact.sha256 !== actual[index].sha256
    )
  ) {
    throw new Error('Validation artifacts changed; rebuild and run the complete validation')
  }
  assertSnapshot(root, current)
  if (commit(root, ref) !== head) throw new Error('The publication ref changed during verification')
  return receipt
}
