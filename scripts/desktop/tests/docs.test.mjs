import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import test from 'node:test'

import { checkDocs } from '../docs.mjs'
import { root } from '../process.mjs'

const base = resolve(root, '.cache/docs-unit-tests')
mkdirSync(base, { recursive: true })
function cleanup(directory) {
  if (!realpathSync(directory).startsWith(realpathSync(base) + sep)) throw new Error('Invalid fixture path')
  rmSync(directory, { recursive: true })
}
await test('documentation accepts Windows line endings and rejects actual trailing spaces or missing links', () => {
  const directory = mkdtempSync(resolve(base, 'text-'))
  try {
    writeFileSync(resolve(directory, 'README.md'), '# Fixture\r\n\r\nA paragraph.\r\n')
    assert.doesNotThrow(() => checkDocs(directory, ['README.md']))
    writeFileSync(resolve(directory, 'README.md'), 'Trailing space \r\n')
    assert.throws(() => checkDocs(directory, ['README.md']), /Trailing whitespace/)
    writeFileSync(resolve(directory, 'README.md'), '[missing](absent.md)\r\n')
    assert.throws(() => checkDocs(directory, ['README.md']), /Missing local/)
  } finally {
    cleanup(directory)
  }
})
