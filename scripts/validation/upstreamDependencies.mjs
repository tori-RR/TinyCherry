import { lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

function within(root, location) {
  const path = relative(root, location)
  if (isAbsolute(path) || path === '..' || path.startsWith('../') || path.startsWith('..\\')) {
    throw new Error('Dependency installation path escapes the repository')
  }
}

function directory(root, location, optional = false) {
  within(root, resolve(location))
  const entry = lstatSync(location, { throwIfNoEntry: false })
  if (!entry && optional) return false
  if (!entry?.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('Dependency installation requires a regular directory, not a symbolic link')
  }
  within(root, realpathSync(location))
  return true
}

function backupDirectory(root) {
  let location = root
  for (const segment of ['.cache', 'upstream-validation', 'dependency-backups']) {
    location = join(location, segment)
    const entry = lstatSync(location, { throwIfNoEntry: false })
    if (!entry) mkdirSync(location)
    within(root, realpathSync(location))
    if (!statSync(location).isDirectory()) throw new Error('Dependency cache must be a directory')
  }
  return location
}

function moveDirectory(root, from, to) {
  // Resolve both absolute endpoints before a Windows directory rename; never merge trees.
  directory(root, from)
  within(root, resolve(to))
  within(root, realpathSync(resolve(to, '..')))
  if (lstatSync(to, { throwIfNoEntry: false })) throw new Error('Refusing to overwrite an existing dependency backup')
  renameSync(from, to)
}

export function installFreshDependencies(root, installCallback) {
  const repository = realpathSync(root)
  const modules = join(repository, 'node_modules')
  const hadModules = directory(repository, modules, true)
  const session = mkdtempSync(join(backupDirectory(repository), 'install-'))
  within(repository, realpathSync(session))
  const backup = join(session, 'node_modules')
  const partial = join(session, 'failed-node_modules')
  if (hadModules) moveDirectory(repository, modules, backup)
  try {
    installCallback()
    directory(repository, modules)
  } catch (cause) {
    let quarantine = null
    try {
      if (directory(repository, modules, true)) {
        moveDirectory(repository, modules, partial)
        quarantine = relative(repository, partial)
      }
      if (hadModules) moveDirectory(repository, backup, modules)
    } catch (recovery) {
      throw new AggregateError(
        [cause, recovery],
        `Fresh dependency installation failed and automatic recovery stopped; preserve ${relative(repository, session)} and review node_modules`,
        { cause }
      )
    }
    throw new Error(
      `Fresh dependency installation failed; ${hadModules ? 'previous dependencies restored' : 'no previous dependencies'}${quarantine ? `; partial installation preserved at ${quarantine}` : ''}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    )
  }
  return { backup: hadModules ? relative(repository, backup) : null, quarantine: null }
}
