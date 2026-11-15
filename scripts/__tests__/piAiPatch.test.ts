import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const patchPath = 'patches/@earendil-works__pi-ai@1.5.2.patch'
const fixtureRoot = resolve(process.cwd(), '.cache/pi-ai-patch-tests')
// These are the final four lines and offsets of the published 1.5.2 files. All three end without LF.
const originals = [
  {
    file: 'dist/index.js',
    padding: 21,
    tail: [
      'export { uuidv7 } from "./utils/uuid.js";',
      'export * from "./utils/validation.js";',
      'export { PI_AI_VERSION } from "./utils/version.js";',
      '//# sourceMappingURL=index.js.map'
    ]
  },
  {
    file: 'dist/index.d.ts',
    padding: 33,
    tail: [
      'export { uuidv7 } from "./utils/uuid.ts";',
      'export * from "./utils/validation.ts";',
      'export { PI_AI_VERSION } from "./utils/version.ts";',
      '//# sourceMappingURL=index.d.ts.map'
    ]
  },
  {
    file: 'dist/utils/estimate.d.ts',
    padding: 13,
    tail: [
      'export declare function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number;',
      'export declare function estimateMessageTokens(message: Message): number;',
      'export declare function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate;',
      '//# sourceMappingURL=estimate.d.ts.map'
    ]
  }
]
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory)
    if (!target.startsWith(fixtureRoot + sep)) throw new Error('Patch fixture cleanup escaped the test root')
    rmSync(target, { recursive: true, force: true })
  }
})

function eofPatch() {
  const sections = readFileSync(patchPath, 'utf8')
    .split(/(?=^diff --git )/m)
    .filter((section) =>
      originals.some(({ file }) => section.split('\n')[0].trim() === `diff --git a/${file} b/${file}`)
    )
  expect(sections).toHaveLength(originals.length)
  return sections.join('')
}

function fixture(patch: string) {
  mkdirSync(fixtureRoot, { recursive: true })
  const root = mkdtempSync(join(fixtureRoot, 'raw-eof-'))
  directories.push(root)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  for (const { file, padding, tail } of originals) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(
      join(root, file),
      [...Array.from({ length: padding }, (_, index) => `// padding ${index}`), ...tail].join('\n')
    )
  }
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'published EOF fixture')
  writeFileSync(join(root, 'fix.patch'), patch)
  return { root, git }
}

describe('pi-ai published EOF patch compatibility', () => {
  it('applies all three EOF-sensitive hunks using standard Git and exports the nested tool hook only once', () => {
    const { root, git } = fixture(eofPatch())
    for (const { file } of originals) expect(readFileSync(join(root, file), 'utf8').endsWith('\n')).toBe(false)
    git('apply', '--check', 'fix.patch')
    git('apply', 'fix.patch')
    expect(git('diff', '--name-only').split('\n').sort()).toEqual(originals.map(({ file }) => file).sort())
    for (const { file } of originals) expect(readFileSync(join(root, file), 'utf8').endsWith('\n')).toBe(false)
    for (const file of ['dist/index.js', 'dist/index.d.ts']) {
      const result = readFileSync(join(root, file), 'utf8')
      expect(result.match(/^export \{ retainNestedToolCall \} from "\.\/nested-tool-records\.js";$/gm)).toHaveLength(1)
    }
    expect(readFileSync(join(root, 'dist/utils/estimate.d.ts'), 'utf8')).toContain(
      'export declare function estimateSystemCharacters(promptCharacters: number, toolCharacters: number): number;'
    )
    const syntax = spawnSync(process.execPath, ['--check', 'dist/index.js'], { cwd: root, encoding: 'utf8' })
    expect(syntax.status, syntax.stderr).toBe(0)
  })

  it('rejects the same hunks when their missing-terminal-newline metadata is lost', () => {
    const patch = eofPatch()
      .replace(
        /^-\/\/# sourceMappingURL=([^\n]+)\n\\ No newline at end of file\n\+\/\/# sourceMappingURL=\1\n/gm,
        ' //# sourceMappingURL=$1\n'
      )
      .replace(/^\\ No newline at end of file\n/gm, '')
    const { root, git } = fixture(patch)
    const result = spawnSync('git', ['apply', '--check', 'fix.patch'], { cwd: root, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/patch failed|does not apply/)
    expect(git('diff', '--name-only')).toBe('')
  })
})
