import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installFreshDependencies } from '../validation/upstreamDependencies.mjs'

const temporary = resolve('.cache/upstream-dependency-tests')
const directories: string[] = []

function fixture(withModules = true) {
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(join(temporary, 'repo-'))
  directories.push(root)
  if (withModules) {
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'node_modules', 'old-copy.txt'), 'retain the previous dependency tree')
  }
  return root
}

function sessions(root: string) {
  return join(root, '.cache', 'upstream-validation', 'dependency-backups')
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    expect(directory.startsWith(temporary + sep)).toBe(true)
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('fresh upstream dependency installation', () => {
  it('installs without seeing the old modules and retains a rollback backup', () => {
    const root = fixture()
    const result = installFreshDependencies(root, () => {
      expect(existsSync(join(root, 'node_modules'))).toBe(false)
      mkdirSync(join(root, 'node_modules'))
      writeFileSync(join(root, 'node_modules', 'fresh.txt'), 'fresh copy')
    })
    expect(result.backup).toMatch(/^\.cache[\\/]upstream-validation[\\/]dependency-backups[\\/]install-/)
    expect(readFileSync(join(root, result.backup, 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
    expect(readFileSync(join(root, 'node_modules', 'fresh.txt'), 'utf8')).toBe('fresh copy')
    expect(existsSync(join(root, 'node_modules', 'old-copy.txt'))).toBe(false)
  })

  it('quarantines a failed partial installation and restores the original tree', () => {
    const root = fixture()
    const cause = new Error('frozen installation rejected')
    expect(() =>
      installFreshDependencies(root, () => {
        mkdirSync(join(root, 'node_modules'))
        writeFileSync(join(root, 'node_modules', 'partial.txt'), 'retain partial data')
        throw cause
      })
    ).toThrow('previous dependencies restored')
    expect(readFileSync(join(root, 'node_modules', 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
    expect(existsSync(join(root, 'node_modules', 'partial.txt'))).toBe(false)
    const session = join(sessions(root), readdirSync(sessions(root))[0])
    expect(readFileSync(join(session, 'failed-node_modules', 'partial.txt'), 'utf8')).toBe('retain partial data')
    expect(existsSync(join(session, 'node_modules'))).toBe(false)
  })

  it('restores the original tree when installation fails before creating modules', () => {
    const root = fixture()
    expect(() =>
      installFreshDependencies(root, () => {
        throw new Error('install failed early')
      })
    ).toThrow('install failed early')
    expect(readFileSync(join(root, 'node_modules', 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
  })

  it('installs normally when there is no previous dependency tree', () => {
    const root = fixture(false)
    const result = installFreshDependencies(root, () => {
      mkdirSync(join(root, 'node_modules'))
      writeFileSync(join(root, 'node_modules', 'fresh.txt'), 'fresh copy')
    })
    expect(result).toEqual({ backup: null, quarantine: null })
    expect(readFileSync(join(root, 'node_modules', 'fresh.txt'), 'utf8')).toBe('fresh copy')
  })

  it('preserves partial data on a failed first installation', () => {
    const root = fixture(false)
    expect(() =>
      installFreshDependencies(root, () => {
        mkdirSync(join(root, 'node_modules'))
        writeFileSync(join(root, 'node_modules', 'partial.txt'), 'first partial copy')
        throw new Error('first installation failed')
      })
    ).toThrow('no previous dependencies')
    expect(existsSync(join(root, 'node_modules'))).toBe(false)
    const session = join(sessions(root), readdirSync(sessions(root))[0])
    expect(readFileSync(join(session, 'failed-node_modules', 'partial.txt'), 'utf8')).toBe('first partial copy')
  })

  it('rejects a node_modules junction without touching its target', () => {
    const root = fixture(false)
    const foreign = fixture()
    symlinkSync(join(foreign, 'node_modules'), join(root, 'node_modules'), 'junction')
    const install = vi.fn()
    expect(() => installFreshDependencies(root, install)).toThrow('regular directory')
    expect(install).not.toHaveBeenCalled()
    expect(lstatSync(join(root, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(foreign, 'node_modules', 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
  })

  it.each(['.cache', '.cache/upstream-validation', '.cache/upstream-validation/dependency-backups'])(
    'rejects an escaping %s junction before moving modules',
    (location) => {
      const root = fixture()
      const foreign = fixture(false)
      if (location !== '.cache') mkdirSync(dirname(join(root, location)), { recursive: true })
      symlinkSync(foreign, join(root, location), 'junction')
      const install = vi.fn()
      expect(() => installFreshDependencies(root, install)).toThrow('escapes the repository')
      expect(install).not.toHaveBeenCalled()
      expect(readFileSync(join(root, 'node_modules', 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
      expect(existsSync(join(foreign, 'upstream-validation'))).toBe(false)
      expect(existsSync(join(foreign, 'dependency-backups'))).toBe(false)
    }
  )

  it('preserves both trees if the failed installer replaces modules with a junction', () => {
    const root = fixture()
    const foreign = fixture()
    expect(() =>
      installFreshDependencies(root, () => {
        symlinkSync(join(foreign, 'node_modules'), join(root, 'node_modules'), 'junction')
        throw new Error('partial install changed the root')
      })
    ).toThrow('automatic recovery stopped')
    expect(lstatSync(join(root, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(foreign, 'node_modules', 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
    const session = join(sessions(root), readdirSync(sessions(root))[0])
    expect(readFileSync(join(session, 'node_modules', 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
  })

  it('stops recovery instead of overwriting unexpected quarantine contents', () => {
    const root = fixture()
    expect(() =>
      installFreshDependencies(root, () => {
        mkdirSync(join(root, 'node_modules'))
        writeFileSync(join(root, 'node_modules', 'partial.txt'), 'partial tree')
        const session = join(sessions(root), readdirSync(sessions(root))[0])
        mkdirSync(join(session, 'failed-node_modules'))
        writeFileSync(join(session, 'failed-node_modules', 'keep.txt'), 'unfamiliar data')
        throw new Error('installation failed')
      })
    ).toThrow('automatic recovery stopped')
    const session = join(sessions(root), readdirSync(sessions(root))[0])
    expect(readFileSync(join(session, 'failed-node_modules', 'keep.txt'), 'utf8')).toBe('unfamiliar data')
    expect(readFileSync(join(session, 'node_modules', 'old-copy.txt'), 'utf8')).toContain('previous dependency tree')
    expect(readFileSync(join(root, 'node_modules', 'partial.txt'), 'utf8')).toBe('partial tree')
  })
})
