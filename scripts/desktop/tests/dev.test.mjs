import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import test from 'node:test'

import { root } from '../process.mjs'

const base = resolve(root, '.cache/dev-lifecycle-tests')
mkdirSync(base, { recursive: true })
function scenario(name) {
  const directory = mkdtempSync(resolve(base, 'dev-'))
  const cleanup = () => {
    if (!realpathSync(directory).startsWith(realpathSync(base) + sep)) throw new Error('Fixture escaped test base')
    rmSync(directory, { recursive: true })
  }
  try {
    const result = spawnSync(
      process.execPath,
      [
        '--no-warnings',
        '--experimental-loader',
        './scripts/desktop/tests/fixtures/dev-loader.mjs',
        './scripts/desktop/tests/fixtures/dev-runner.mjs'
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, TINYCHERRY_DEV_TEST_ROOT: directory, TINYCHERRY_DEV_TEST_SCENARIO: name }
      }
    )
    assert(!result.error, result.error?.message)
    const marker = result.stdout.split('\n').find((line) => line.startsWith('DEV_TEST_RESULT '))
    assert(marker, `${name}: ${result.stdout}\n${result.stderr}`)
    const state = JSON.parse(marker.slice('DEV_TEST_RESULT '.length))
    assert.equal(state.liveOwned, 0, name)
    assert.equal(state.cleanup, 1, name)
    assert.equal(state.handlersReleased, true, name)
    return { ...result, state }
  } finally {
    cleanup()
  }
}

for (const [name, message, launches] of [
  ['initial-generation-failure', 'SYNTHETIC_INITIAL_GENERATION_FAILURE', 0],
  ['initial-go-failure', 'SYNTHETIC_INITIAL_GO_FAILURE', 0],
  ['vite-before-ready', 'SYNTHETIC_VITE_FAILURE', 0],
  ['vite-before-ready-zero', 'Owned Vite exited during development', 0],
  ['restart-generation-failure', 'SYNTHETIC_RESTART_GENERATION_FAILURE', 1],
  ['restart-go-failure', 'SYNTHETIC_RESTART_GO_FAILURE', 1],
  ['host-failure', 'SYNTHETIC_HOST_FAILURE', 1]
])
  await test(`dev propagates ${name} after owned cleanup`, () => {
    const { status, state } = scenario(name)
    assert.equal(status, 1, name)
    assert(state.messages.includes(message), JSON.stringify(state))
    assert.equal(state.launches, launches, 'No new host may launch after failure')
  })

await test('dev preserves the first operational error alongside a cleanup error', () => {
  const { status, state } = scenario('restart-go-failure-cleanup-failure')
  assert.equal(status, 1)
  assert(state.messages.includes('SYNTHETIC_RESTART_GO_FAILURE'), JSON.stringify(state))
  assert(state.messages.includes('SYNTHETIC_CLEANUP_FAILURE'), JSON.stringify(state))
  assert.equal(state.launches, 1)
})
for (const [name, launches] of [
  ['cancel-generation', 0],
  ['cancel-go', 0],
  ['cancel-readiness', 0],
  ['restart-cancel-generation', 1],
  ['restart-cancel-go', 1]
])
  await test(`dev treats ${name} as cancellation without launching a host`, () => {
    const { status, state } = scenario(name)
    assert.equal(status, 0, JSON.stringify(state))
    assert.deepEqual(state.messages, [])
    assert.equal(state.launches, launches)
  })
await test('normal owned host closure is successful and closes the dev server', () => {
  const { status, state } = scenario('normal-close')
  assert.equal(status, 0)
  assert.deepEqual(state.messages, [])
  assert.equal(state.launches, 1)
})
for (const name of ['restart-go-source', 'restart-rust-source'])
  await test(`dev rebuilds after ${name} and releases both owned generations`, () => {
    const { status, state } = scenario(name)
    assert.equal(status, 0, JSON.stringify(state))
    assert.deepEqual(state.messages, [])
    assert.equal(state.launches, 2)
    assert.equal(state.goBuilds, 2)
    assert.equal(state.stopped, 1)
  })
