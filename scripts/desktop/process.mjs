import { execFileSync, spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const native = resolve(root, 'native/evostack')
export const children = new Set()

export function command(executable, args, options = {}) {
  const child = spawn(executable, args, { cwd: root, env: process.env, stdio: 'inherit', ...options })
  children.add(child)
  child.once('exit', () => children.delete(child))
  child.completion = new Promise((res, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) =>
      code === 0 ? res() : reject(new Error(`${executable} exited: ${code ?? signal}`))
    )
  })
  // A background process can exit while another startup step is running.
  child.completion.catch(() => {})
  return child
}

export const run = async (exe, args, options) => {
  await command(exe, args, options).completion
}

export function pnpm(args, options) {
  const exe = process.env.npm_execpath
  if (!exe) throw new Error('Use the pinned pnpm root command')
  return /\.[cm]?js$/.test(exe) ? command(process.execPath, [exe, ...args], options) : command(exe, args, options)
}

/** Only processes spawned by this invocation are eligible for forced cleanup. */
export async function stopChild(child) {
  if (!children.has(child) || child.exitCode !== null || child.signalCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch {
      // Ctrl+C can terminate the OS process before Node receives its exit
      // event. Await that event below before deciding cleanup has failed.
    }
  } else child.kill('SIGTERM')
  let timeout
  try {
    await Promise.race([
      child.completion.catch(() => {}),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Owned child cleanup timed out')), 5000)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export async function stopAll() {
  const results = await Promise.allSettled([...children].reverse().map(stopChild))
  const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
  if (errors.length) throw new AggregateError(errors, 'Some owned children could not be stopped')
}

export function windows() {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('Desktop build/start currently requires Windows x64; other hosts are unavailable')
}
