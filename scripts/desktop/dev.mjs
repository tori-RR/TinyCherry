import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, watch } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sourceIdentity } from './candidate.mjs'
import { helperDirectory } from './helper.mjs'
import { command, native, pnpm, run, stopAll, stopChild, windows } from './process.mjs'

export async function ensureDevPort() {
  await new Promise((done, fail) => {
    const probe = createServer()
    probe.once('error', (error) => {
      const reason = error.code === 'EADDRINUSE' ? 'is occupied' : `cannot be bound (${error.code})`
      fail(new Error(`Dev port 127.0.0.1:17420 ${reason}; no existing process will be stopped`))
    })
    probe.listen(17420, '127.0.0.1', () => probe.close(done))
  })
}

export async function dev() {
  windows()
  await ensureDevPort()
  const owner = randomUUID()
  const directory = resolve(native, '.cache/target/debug')
  const profile = resolve(native, '.cache/desktop-dev/profile')
  mkdirSync(directory, { recursive: true })
  mkdirSync(profile, { recursive: true })
  const identity = sourceIdentity()
  const env = {
    ...process.env,
    TINYCHERRY_DEV_OWNER: owner,
    TINYCHERRY_EVOSTACK_DATA_DIR: profile,
    EVOSTACK_APP_VERSION: identity.version,
    EVOSTACK_BUILD_REVISION: identity.revision
  }
  let stopping = false,
    failure,
    cleanupFailure,
    notifyStop
  const stopRequested = new Promise((done) => {
    notifyStop = done
  })
  const waitStage = (completion) => Promise.race([completion, stopRequested])
  const compileGo = async () => {
    if (stopping) return false
    await waitStage(
      pnpm(['exec', 'tsx', '--tsconfig', 'tsconfig.web.json', 'native/evostack/generate-contract.ts'], { env })
        .completion
    )
    if (stopping) return false
    await waitStage(
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          resolve(native, 'dev-backend.ps1'),
          '-Directory',
          directory,
          '-Version',
          identity.version,
          '-Revision',
          identity.revision
        ],
        { env }
      )
    )
    if (stopping) return false
    copyFileSync(
      resolve(helperDirectory(), 'runtime/open-computer-use.exe'),
      resolve(directory, 'open-computer-use.exe')
    )
    return true
  }
  const watchers = []
  let restartTimer,
    host,
    stopPromise,
    restarting = false
  const stop = () => {
    if (!stopPromise) {
      stopping = true
      clearTimeout(restartTimer)
      notifyStop()
      stopPromise = Promise.allSettled([
        Promise.resolve().then(() => watchers.forEach((watcher) => watcher.close())),
        Promise.resolve().then(stopAll)
      ]).then((results) => {
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, 'Owned development cleanup failed')
      })
    }
    return stopPromise
  }
  const interrupt = () => {
    // The final collector awaits this same promise and reports cleanup failures.
    void stop().catch(() => {})
  }
  const fail = (error) => {
    failure ??= error
    interrupt()
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const runSession = async () => {
    if (!(await compileGo())) return
    const vite = pnpm(['exec', 'vite', '--config', 'native/evostack/vite.config.mts'], { env })
    // A server failure after readiness must also close our host and sidecar.
    void vite.completion
      .then(
        () => {
          if (!stopping) fail(new Error('Owned Vite exited during development'))
        },
        (error) => {
          if (!stopping) fail(error)
        }
      )
      .catch(fail)
    const deadline = Date.now() + 30_000
    while (true) {
      if (stopping) return
      if (vite.exitCode !== null) throw new Error('Owned Vite exited before readiness')
      try {
        const response = await fetch('http://127.0.0.1:17420/windows/evostack/index.html', {
          signal: AbortSignal.timeout(1000)
        })
        if (response.ok && response.headers.get('X-TinyCherry-Dev-Owner') === owner) break
      } catch {
        /* bounded wait for our server only */
      }
      if (Date.now() > deadline) throw new Error('Owned Vite readiness timed out')
      await new Promise((done) => setTimeout(done, 150))
    }
    if (stopping) return
    const launch = () =>
      command('cargo', ['run', '--locked', '--manifest-path', resolve(native, 'src-gpui/Cargo.toml')], { env })
    host = launch()
    let restart = Promise.resolve()
    const scheduleRestart = () => {
      if (stopping) return
      clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        restart = restart
          .then(async () => {
            if (stopping) return
            restarting = true
            try {
              console.log('Native source changed: closing the owned dev host before rebuilding')
              await waitStage(stopChild(host))
              if (!stopping && (await compileGo())) host = launch()
            } finally {
              restarting = false
            }
          })
          .catch(fail)
      }, 350)
    }
    for (const [directory, source] of [
      ['backend', /^(?!generated\/).*\.(go|mod|sum)$/],
      ['src-gpui', /^(?:src\/.*\.rs|build\.rs|Cargo\.(toml|lock))$/]
    ]) {
      const watcher = watch(resolve(native, directory), { recursive: true }, (_, name) => {
        if (name && source.test(String(name).replaceAll('\\', '/'))) scheduleRestart()
      })
      watcher.on('error', fail)
      watchers.push(watcher)
    }
    console.log(
      'Dev profile is isolated. React uses HMR; Go/Rust changes restart this dev host. Ctrl+C closes owned processes.'
    )
    while (!stopping) {
      const current = host
      await waitStage(current.completion).catch((error) => {
        if (!stopping && !restarting && current === host) throw error
      })
      await restart
      if (current === host) break
    }
  }
  try {
    await runSession()
  } catch (error) {
    failure ??= error
  } finally {
    try {
      await stop()
    } catch (error) {
      cleanupFailure = error
    }
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
  if (failure !== undefined && cleanupFailure !== undefined)
    throw new AggregateError([failure, cleanupFailure], 'Development failed and owned cleanup also failed')
  if (failure !== undefined) throw failure
  if (cleanupFailure !== undefined) throw cleanupFailure
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await dev()
