import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'

export const root = process.env.TINYCHERRY_DEV_TEST_ROOT
export const native = resolve(root, 'native')
const scenario = process.env.TINYCHERRY_DEV_TEST_SCENARIO
export const stats = { generations: 0, goBuilds: 0, launches: 0, stopped: 0, cleanup: 0 }
const active = new Set()
let server
export const state = () => ({ ...stats, liveOwned: active.size })
export function windows() {}
export const sourceIdentity = () => ({ version: '0.0.0-test', revision: 'synthetic' })
export const helperDirectory = () => resolve(root, 'helper')

function child() {
  let finish, fail
  const result = {
    exitCode: null,
    completion: new Promise((res, reject) => {
      finish = res
      fail = reject
    })
  }
  result.completion.catch(() => {})
  result.finish = (error) => {
    if (result.exitCode !== null) return
    result.exitCode = error ? 1 : 0
    active.delete(result)
    if (error) fail(error)
    else finish()
  }
  active.add(result)
  return result
}
function cancelledStage() {
  const result = child()
  setTimeout(() => process.emit('SIGINT'), 30)
  return result
}
export async function run() {
  stats.goBuilds++
  if (scenario === 'initial-go-failure') throw new Error('SYNTHETIC_INITIAL_GO_FAILURE')
  if (scenario.startsWith('restart-go-failure') && stats.goBuilds === 2) throw new Error('SYNTHETIC_RESTART_GO_FAILURE')
  if (scenario === 'cancel-go' || (scenario === 'restart-cancel-go' && stats.goBuilds === 2))
    await cancelledStage().completion
}
export function pnpm(args, { env } = {}) {
  if (args.includes('tsx')) {
    stats.generations++
    const result = child()
    if (scenario === 'cancel-generation' || (scenario === 'restart-cancel-generation' && stats.generations === 2)) {
      setTimeout(() => process.emit('SIGINT'), 30)
      return result
    }
    if (
      scenario === 'initial-generation-failure' ||
      (scenario === 'restart-generation-failure' && stats.generations === 2)
    )
      result.finish(
        new Error(
          scenario === 'initial-generation-failure'
            ? 'SYNTHETIC_INITIAL_GENERATION_FAILURE'
            : 'SYNTHETIC_RESTART_GENERATION_FAILURE'
        )
      )
    else result.finish()
    return result
  }
  if (args.includes('vite')) {
    const result = child()
    const waiting = ['vite-before-ready', 'vite-before-ready-zero', 'cancel-readiness'].includes(scenario)
    server = createServer((_, response) => {
      response.setHeader('X-TinyCherry-Dev-Owner', env.TINYCHERRY_DEV_OWNER)
      response.statusCode = waiting ? 503 : 200
      response.end('synthetic readiness')
    })
    server.once('error', (error) => result.finish(error))
    server.listen(17420, '127.0.0.1')
    if (scenario === 'vite-before-ready') setTimeout(() => result.finish(new Error('SYNTHETIC_VITE_FAILURE')), 50)
    if (scenario === 'vite-before-ready-zero') setTimeout(() => result.finish(), 50)
    if (scenario === 'cancel-readiness') setTimeout(() => process.emit('SIGINT'), 50)
    return result
  }
  if (args.includes('tauri')) {
    stats.launches++
    const result = child()
    if (scenario.startsWith('restart-')) {
      setTimeout(() => writeFileSync(resolve(native, 'backend/changed.go'), 'package main\n// synthetic change\n'), 100)
    } else if (scenario === 'host-failure') {
      setTimeout(() => result.finish(new Error('SYNTHETIC_HOST_FAILURE')), 30)
    } else {
      setTimeout(() => result.finish(), 50)
    }
    return result
  }
  throw new Error('Unexpected test pnpm invocation')
}
export async function stopChild(result) {
  stats.stopped++
  result.finish(new Error('SYNTHETIC_OWNED_STOP'))
}
export async function stopAll() {
  stats.cleanup++
  for (const result of active) result.finish(new Error('SYNTHETIC_OWNED_STOP'))
  if (server?.listening) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
  if (scenario.endsWith('cleanup-failure')) throw new Error('SYNTHETIC_CLEANUP_FAILURE')
}
mkdirSync(resolve(native, 'backend'), { recursive: true })
mkdirSync(resolve(root, 'helper/runtime'), { recursive: true })
writeFileSync(resolve(root, 'helper/runtime/open-computer-use.exe'), 'NONEXECUTABLE FIXTURE')
