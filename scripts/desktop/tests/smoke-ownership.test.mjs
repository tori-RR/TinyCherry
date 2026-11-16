import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import test from 'node:test'

import { root } from '../process.mjs'

await test(
  'packaged smoke validates the actual listener owner and rejects foreign instances',
  { skip: process.platform !== 'win32' },
  () => {
    const result = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts/desktop/tests/smoke-ownership.ps1')],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true }
    )
    assert.deepEqual(JSON.parse(result.replace(/^\uFEFF/, '').trim()), [
      'direct browser',
      'port selects one of multiple browser processes',
      'owned descendant browser',
      'normalized profile path',
      'foreign application',
      'foreign profile',
      'profile prefix collision',
      'reused parent PID',
      'renderer is not browser',
      'duplicate profile switches',
      'public listener',
      'split listener ownership',
      'unready listener'
    ])
  }
)
