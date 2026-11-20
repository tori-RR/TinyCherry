// The caller must validate this CDP listener's process ancestry and isolated profile first.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const [port, profile] = process.argv.slice(2)
assert(/^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && isAbsolute(profile ?? ''))
const directory = join(profile, 'diagnostics')
mkdirSync(directory, { recursive: true })
const report = { collectedAt: new Date().toISOString(), targets: [], events: [], errors: [] }
const short = (value, limit = 2048) => String(value ?? '').slice(0, limit)
const pageUrl = (value) => {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return short(url.href)
  } catch {
    return short(value)
  }
}
const save = () => {
  writeFileSync(join(directory, 'page.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`Owned packaged page diagnostics: ${JSON.stringify(report)}\n`)
}
const watchdog = setTimeout(() => {
  report.errors.push('Page diagnostics reached the 15 second limit')
  save()
  process.exit(1)
}, 15_000)
let socket
let next = 0
const pending = new Map()
const command = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 2000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })

try {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
  assert(response.ok, `Owned CDP target list returned ${response.status}`)
  const targets = await response.json()
  assert(Array.isArray(targets), 'Owned CDP target list is invalid')
  report.targets = targets.slice(0, 16).map(({ type, title, url }) => ({
    type: short(type, 80),
    title: short(title, 256),
    url: pageUrl(url)
  }))
  const target =
    targets.find((item) => item.type === 'page' && item.url === 'http://tauri.localhost/windows/evostack/index.html') ??
    targets.find((item) => item.type === 'page')
  assert(target, 'Owned WebView2 has no page target')
  const debuggerUrl = new URL(target.webSocketDebuggerUrl)
  assert(
    debuggerUrl.protocol === 'ws:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(debuggerUrl.hostname) &&
      debuggerUrl.port === port &&
      debuggerUrl.pathname.startsWith('/devtools/page/') &&
      !debuggerUrl.username &&
      !debuggerUrl.password &&
      !debuggerUrl.search &&
      !debuggerUrl.hash,
    'Owned CDP returned a debugger endpoint outside the validated loopback port'
  )
  socket = new WebSocket(debuggerUrl)
  socket.addEventListener('message', ({ data }) => {
    try {
      const message = JSON.parse(String(data))
      if (message.id) {
        const reply = pending.get(message.id)
        if (!reply) return
        clearTimeout(reply.timer)
        pending.delete(message.id)
        if (message.error) reply.reject(new Error(short(message.error.message)))
        else reply.resolve(message.result)
      } else if (report.events.length < 64) {
        if (message.method === 'Runtime.exceptionThrown') {
          const details = message.params.exceptionDetails
          report.events.push({
            kind: 'exception',
            text: short(details.exception?.description ?? details.text),
            url: pageUrl(details.url),
            line: details.lineNumber,
            column: details.columnNumber
          })
        } else if (message.method === 'Log.entryAdded') {
          const entry = message.params.entry
          report.events.push({
            kind: 'log',
            level: short(entry.level, 40),
            source: short(entry.source, 80),
            text: short(entry.text),
            url: pageUrl(entry.url)
          })
        } else if (
          message.method === 'Runtime.consoleAPICalled' &&
          ['error', 'warning', 'assert'].includes(message.params.type)
        ) {
          report.events.push({
            kind: 'console',
            level: message.params.type,
            text: short(
              message.params.args
                .slice(0, 8)
                .map((arg) => short(arg.value ?? arg.description, 512))
                .join(' ')
            )
          })
        }
      }
    } catch (error) {
      if (report.errors.length < 16) report.errors.push(short(error.message))
    }
  })
  socket.addEventListener('close', () => {
    for (const reply of pending.values()) {
      clearTimeout(reply.timer)
      reply.reject(new Error('Owned page socket closed'))
    }
    pending.clear()
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned page socket did not open')), 2000)
    socket.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
    socket.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('Owned page socket failed'))
      },
      { once: true }
    )
  })
  for (const method of ['Runtime.enable', 'Log.enable', 'Page.enable']) {
    try {
      await command(method)
    } catch (error) {
      report.errors.push(short(error.message))
    }
  }
  const results = await Promise.allSettled([
    command('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const cleanUrl = value => { try { const u = new URL(value); u.search = ''; u.hash = ''; return u.href.slice(0, 2048) } catch { return String(value).slice(0, 2048) } };
        return {
          url: cleanUrl(location.href), title: document.title.slice(0, 256), readyState: document.readyState,
          body: (document.body?.innerText ?? '').slice(0, 4096), rootChildren: document.querySelector('#root')?.childElementCount ?? null,
          bridge: { postMessage: typeof window.ipc?.postMessage, receiver: typeof window.__TINYCHERRY_RECEIVE__, request: typeof window.api?.ipcApi?.request },
          scripts: [...document.scripts].slice(0, 32).map(script => ({ src: cleanUrl(script.src), type: script.type })),
          resources: performance.getEntriesByType('resource').slice(-32).map(resource => ({ url: cleanUrl(resource.name), type: resource.initiatorType, status: resource.responseStatus, bytes: resource.transferSize }))
        };
      })()`
    }),
    command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  ])
  const [documentResult, screenshotResult] = results
  if (documentResult.status === 'fulfilled') {
    report.document = documentResult.value.result?.value
    if (documentResult.value.exceptionDetails)
      report.errors.push(
        short(
          documentResult.value.exceptionDetails.exception?.description ?? documentResult.value.exceptionDetails.text
        )
      )
  } else report.errors.push(short(documentResult.reason.message))
  if (screenshotResult.status === 'fulfilled') {
    const png = Buffer.from(screenshotResult.value.data, 'base64')
    assert(png.length <= 8 * 1024 * 1024, 'Page screenshot exceeds the diagnostic limit')
    writeFileSync(join(directory, 'page.png'), png)
    report.screenshot = 'page.png'
  } else report.errors.push(short(screenshotResult.reason.message))
} catch (error) {
  report.errors.push(short(error.message))
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  save()
  socket?.close()
  // A failed WebView2 close handshake must not delay the original smoke failure.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref()
}
