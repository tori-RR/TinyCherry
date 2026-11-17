import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, watch } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sourceIdentity } from './candidate.mjs'
import { helperDirectory } from './helper.mjs'
import { native, pnpm, run, stopAll, stopChild, windows } from './process.mjs'

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
  let stopping = false
  const compileGo = async () => {
    if (stopping) return false
    await pnpm(['exec', 'tsx', '--tsconfig', 'tsconfig.web.json', 'native/evostack/generate-contract.ts'], { env })
      .completion
    if (stopping) return false
    await run(
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
    if (stopping) return false
    copyFileSync(
      resolve(helperDirectory(), 'runtime/open-computer-use.exe'),
      resolve(directory, 'open-computer-use.exe')
    )
    return true
  }
  let watcher,
    restartTimer,
    tauri,
    stopPromise,
    restarting = false
  const stop = () => {
    if (!stopPromise) {
      stopping = true
      clearTimeout(restartTimer)
      watcher?.close()
      stopPromise = stopAll()
    }
    return stopPromise
  }
  const interrupt = () => {
    void stop().catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  try {
    if (!(await compileGo())) return
    const vite = pnpm(['exec', 'vite', '--config', 'native/evostack/vite.config.mts'], { env })
    let viteError
    // A server failure after readiness must also close our host and sidecar.
    void vite.completion
      .then(
        () => {
          if (!stopping) viteError = new Error('Owned Vite exited during development')
        },
        (error) => {
          if (!stopping) viteError = error
        }
      )
      .then(() => {
        if (viteError) return stop()
      })
      .catch((error) => {
        viteError = error
        process.exitCode = 1
      })
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
    const launch = () => pnpm(['exec', 'tauri', 'dev'], { cwd: native, env })
    tauri = launch()
    let restart = Promise.resolve()
    watcher = watch(resolve(native, 'backend'), { recursive: true }, (_, name) => {
      if (!name || /^(generated|\.cache)[/\\]/.test(name) || !/\.(go|mod|sum)$/.test(name)) return
      clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        restart = restart
          .then(async () => {
            if (stopping) return
            restarting = true
            console.log('Go source changed: closing the owned dev host before rebuilding')
            await stopChild(tauri)
            await compileGo()
            if (!stopping) tauri = launch()
            restarting = false
          })
          .catch((error) => {
            console.error(error.message)
            interrupt()
          })
      }, 350)
    })
    console.log(
      'Dev profile is isolated. React uses HMR; Go changes restart this dev host. Ctrl+C closes owned processes.'
    )
    while (!stopping) {
      const current = tauri
      await current.completion.catch((error) => {
        if (!stopping && !restarting && current === tauri) throw error
      })
      await restart
      if (current === tauri) break
    }
    if (viteError) throw viteError
  } finally {
    await stop()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await dev()
