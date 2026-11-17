import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { root, native } from './process.mjs'

export const productFiles = [
  'TinyCherry-EvoStack.exe',
  'tinycherry-evostack-backend.exe',
  'open-computer-use.exe',
  'README.md',
  'LICENSE.txt',
  'computer-use-LICENSE.txt',
  'computer-use-THIRD-PARTY-NOTICES.md',
  'SHA256.json'
]
export const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
export function writeBinaryHashes(directory) {
  const files = productFiles
    .filter((name) => name.endsWith('.exe'))
    .map((name) => ({ name, bytes: lstatSync(resolve(directory, name)).size, sha256: hash(resolve(directory, name)) }))
  writeFileSync(resolve(directory, 'SHA256.json'), `${JSON.stringify(files, null, 2)}\n`)
}
export function isBuildInput(file) {
  return (
    !/^native\/evostack\/backend\/generated\/(?:defaults|skills|computer-tools)\.json$/.test(file) &&
    !/(?:^|\/)(?:\.cache|\.vite|node_modules|dist|\.pnpm-store|\.git|\.tsbuildinfo)(?:\/|$)/.test(file) &&
    /^(?:src\/|native\/evostack\/|packages\/|build\/|resources\/|scripts\/|package\.json$|pnpm-|tsconfig|vitest|\.node-version$|\.npmrc$)/.test(
      file
    )
  )
}

export function sourceIdentity(directory = root) {
  const git = (args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim()
  const head = git(['rev-parse', 'HEAD'])
  const trackedDirty = !!git(['status', '--porcelain=v1', '--untracked-files=no'])
  const inputs = [
    'src',
    'native/evostack',
    'packages',
    'build',
    'resources',
    'scripts',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig*',
    'vitest*',
    '.node-version',
    '.npmrc',
    ':(exclude,glob)**/node_modules/**',
    ':(exclude,glob)**/.cache/**',
    ':(exclude,glob)**/.vite/**',
    ':(exclude,glob)**/dist/**',
    ':(exclude,glob)**/.pnpm-store/**'
  ]
  const otherSource = git(['ls-files', '-z', '--others', '--exclude-standard', '--', ...inputs])
    .split('\0')
    .some(isBuildInput)
  const dirty = trackedDirty || otherSource
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...inputs])
    .split('\0')
    .filter(Boolean)
    .sort()
  const digest = createHash('sha256')
  for (const file of files.filter(isBuildInput)) {
    const path = resolve(directory, file)
    const info = lstatSync(path, { throwIfNoEntry: false })
    digest.update(file).update('\0')
    if (!info) digest.update('deleted')
    else if (info.isSymbolicLink()) throw new Error(`Build input cannot be a symbolic link: ${file}`)
    else if (info.isFile()) digest.update(readFileSync(path))
  }
  const version = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).version
  return {
    version,
    revision: `${head}${dirty ? '-dirty' : ''}`,
    sourceHash: digest.digest('hex'),
    protocol: 1,
    target: 'windows-x64'
  }
}

export function validateCandidate(directory, expected) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'candidate.json'), 'utf8'))
  if (
    manifest.schema !== 1 ||
    manifest.target !== 'windows-x64' ||
    manifest.protocol !== 1 ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Invalid desktop candidate manifest')
  if (expected && ['version', 'revision', 'sourceHash'].some((key) => manifest[key] !== expected[key]))
    throw new Error('Candidate belongs to different source; run pnpm build')
  const names = manifest.files.map((file) => file.name)
  if (JSON.stringify([...names].sort()) !== JSON.stringify([...productFiles].sort()))
    throw new Error('Unexpected candidate file list')
  if (JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify([...productFiles, 'candidate.json'].sort()))
    throw new Error('Candidate contains unexpected files; never package user data')
  for (const file of manifest.files) {
    if (!productFiles.includes(file.name)) throw new Error('Candidate path is not allowed')
    const path = resolve(directory, file.name)
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink() || hash(path) !== file.sha256 || entry.size !== file.bytes)
      throw new Error(`Candidate file changed: ${file.name}`)
  }
  return manifest
}

export function checkIdentities(directory, manifest) {
  for (const name of ['TinyCherry-EvoStack.exe', 'tinycherry-evostack-backend.exe']) {
    const info = JSON.parse(
      execFileSync(resolve(directory, name), ['--evostack-build-info'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024
      })
    )
    if (['version', 'revision', 'protocol'].some((key) => info[key] !== manifest[key]))
      throw new Error(`Candidate version/protocol mismatch: ${name}`)
  }
}

export function currentCandidate(distribution = resolve(native, 'dist')) {
  if (!existsSync(resolve(distribution, 'current.json')))
    throw new Error('No compiled candidate; run pnpm build first. Start never rebuilds automatically.')
  const pointer = JSON.parse(readFileSync(resolve(distribution, 'current.json'), 'utf8').replace(/^\uFEFF/, ''))
  if (typeof pointer.directory !== 'string' || !/^[a-zA-Z0-9-]+$/.test(pointer.directory))
    throw new Error('Invalid candidate pointer')
  const base = realpathSync(resolve(distribution, 'candidates'))
  const distributionPath = relative(realpathSync(distribution), base)
  if (isAbsolute(distributionPath) || distributionPath.startsWith('..'))
    throw new Error('Candidate directory escapes dist')
  const directory = realpathSync(resolve(base, pointer.directory))
  const path = relative(base, directory)
  if (isAbsolute(path) || path.startsWith('..')) throw new Error('Candidate pointer escapes dist/candidates')
  return directory
}

export function loadCandidate({
  requireCurrentSource = true,
  distribution = resolve(native, 'dist'),
  sourceDirectory = root
} = {}) {
  const directory = currentCandidate(distribution)
  const manifest = validateCandidate(directory, requireCurrentSource ? sourceIdentity(sourceDirectory) : undefined)
  return { directory, manifest }
}

export function promoteCandidate(distribution, name, replace = renameSync) {
  if (!/^[a-zA-Z0-9-]+$/.test(name)) throw new Error('Invalid candidate pointer')
  validateCandidate(resolve(distribution, 'candidates', name))
  const pointer = resolve(distribution, 'current.json')
  const pending = resolve(distribution, `current-${randomUUID()}.tmp`)
  try {
    writeFileSync(pending, `${JSON.stringify({ directory: name })}\n`, { flag: 'wx' })
    replace(pending, pointer)
  } finally {
    if (existsSync(pending)) unlinkSync(pending)
  }
}

export function writeManifest(directory, expectedSourceHash) {
  const identity = sourceIdentity()
  if (!expectedSourceHash || identity.sourceHash !== expectedSourceHash)
    throw new Error('Source changed during compilation; candidate was not promoted')
  const files = productFiles.map((name) => ({
    name,
    bytes: lstatSync(resolve(directory, name)).size,
    sha256: hash(resolve(directory, name))
  }))
  const manifest = { schema: 1, ...identity, files }
  checkIdentities(directory, manifest)
  writeFileSync(resolve(directory, 'candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  validateCandidate(directory, identity)
  return manifest
}

if (process.argv[1]?.endsWith('candidate.mjs')) {
  if (process.argv[2] === 'identity') {
    process.stdout.write(JSON.stringify(sourceIdentity()))
  } else {
    const directory = resolve(process.argv[3])
    if (process.argv[2] === 'hashes') writeBinaryHashes(directory)
    else if (process.argv[2] === 'write') writeManifest(directory, process.argv[4])
    else if (process.argv[2] === 'promote') promoteCandidate(directory, process.argv[4])
    else {
      const manifest = validateCandidate(directory)
      checkIdentities(directory, manifest)
    }
  }
}
