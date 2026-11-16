import assert from 'node:assert/strict'
import test from 'node:test'

import { children, command, stopAll, stopChild } from '../process.mjs'

await test('cleanup tolerates owned children exiting before their Node exit event arrives', async () => {
  const child = command(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  // Keep this event loop busy while the OS child exits, like console Ctrl+C.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  await stopChild(child)
  assert(!children.has(child))
})

await test('cleanup terminates its running child and remains idempotent', async () => {
  const child = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await stopAll()
  await stopChild(child)
  assert(!children.has(child))
})
