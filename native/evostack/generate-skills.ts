import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const root = fileURLToPath(new URL('../../', import.meta.url))
const skills: object[] = []
for (const source of ['resources/skills', 'resources/code-cli-skills']) {
  for (const entry of readdirSync(join(root, source), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    const directory = join(root, source, entry.name)
    const files: Record<string, string> = {}
    let size = 0
    for (const name of readdirSync(directory, { recursive: true }).sort()) {
      const file = join(directory, name)
      const info = lstatSync(file)
      if (info.isSymbolicLink()) throw new Error(`Bundled skill contains a symbolic link: ${file}`)
      if (!info.isFile()) continue
      size += info.size
      if (info.size > 1024 * 1024 || size > 8 * 1024 * 1024)
        throw new Error(`Bundled skill exceeds size limit: ${file}`)
      files[name.replaceAll('\\', '/')] = readFileSync(file).toString('base64')
    }
    const markdown = Buffer.from(files['SKILL.md'] ?? '', 'base64').toString('utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
    if (!frontmatter) throw new Error(`Bundled skill has no frontmatter: ${directory}`)
    const metadata = parse(frontmatter[1])
    if (typeof metadata.name !== 'string' || typeof metadata.description !== 'string')
      throw new Error(`Invalid skill metadata: ${directory}`)
    const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    skills.push({
      folderName: entry.name,
      name: metadata.name,
      description: metadata.description,
      version: metadata.version == null ? null : String(metadata.version),
      sourceTags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag: unknown) => typeof tag === 'string') : [],
      contentHash: `sha256:${hash}`,
      files
    })
  }
}
const output = fileURLToPath(new URL('backend/generated/', import.meta.url))
mkdirSync(output, { recursive: true })
writeFileSync(join(output, 'skills.json'), JSON.stringify(skills))
