import { lstatSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** Explicit opt-in only. Existing files, directories and unexpected links are never replaced. */
export function syncSkills(directory, names, ignores, { apply = false, link = symlinkSync } = {}) {
  const sources = resolve(directory, '.agents/skills')
  const targets = resolve(directory, '.claude/skills')
  const stat = (path) => lstatSync(path, { throwIfNoEntry: false })
  for (const path of [sources, targets]) {
    const entry = stat(path)
    if (!entry?.isDirectory() || entry.isSymbolicLink())
      throw new Error(`Expected an ordinary skill directory: ${path}`)
  }
  const pending = []
  for (const name of names) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Invalid skill name: ${name}`)
    const source = resolve(sources, name)
    const entry = stat(source)
    if (!entry?.isDirectory() || entry.isSymbolicLink()) throw new Error(`Missing ordinary skill source: ${source}`)
    const target = resolve(targets, name)
    const existing = stat(target)
    if (existing) {
      if (!existing.isSymbolicLink() || resolve(dirname(target), readlinkSync(target)) !== source)
        throw new Error(`Skill conflict; preserved without changes: ${target}`)
    } else pending.push({ target, source: `../../.agents/skills/${name}` })
  }
  const files = [
    { path: resolve(sources, '.gitignore'), content: ignores.agents },
    { path: resolve(targets, '.gitignore'), content: ignores.claude }
  ]
    .map((file) => {
      const entry = stat(file.path)
      if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error(`Skill conflict: ${file.path}`)
      return { ...file, before: entry ? readFileSync(file.path) : null }
    })
    .filter((file) => file.before?.toString('utf8') !== file.content)
  const changes = [...pending.map(({ target }) => target), ...files.map(({ path }) => path)]
  if (!apply) return changes
  const created = [],
    written = []
  try {
    for (const { target, source } of pending) {
      link(source, target, 'dir')
      created.push(target)
    }
    for (const file of files) {
      written.push(file)
      writeFileSync(file.path, file.content)
    }
  } catch (error) {
    const failures = [error]
    for (const file of written.reverse()) {
      try {
        if (file.before) writeFileSync(file.path, file.before)
        else unlinkSync(file.path)
      } catch (restore) {
        failures.push(restore)
      }
    }
    for (const target of created.reverse()) {
      try {
        unlinkSync(target)
      } catch (restore) {
        failures.push(restore)
      }
    }
    throw new AggregateError(failures, 'Skill synchronization failed; original targets were preserved')
  }
  return changes
}
