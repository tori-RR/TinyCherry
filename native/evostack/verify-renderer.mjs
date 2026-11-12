import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [port, profile, revision] = process.argv.slice(2)
assert(/^\d+$/.test(port) && profile && revision)
const deadline = Date.now() + 30_000
const pause = () => new Promise((resolve) => setTimeout(resolve, 100))
let target
while (Date.now() < deadline) {
  try {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((r) =>
      r.json()
    )
    const matches = list.filter((item) => item.url === 'http://tauri.localhost/windows/evostack/index.html')
    if (matches.length === 1) {
      target = matches[0]
      break
    }
  } catch {
    /* The owned WebView may still be starting. */
  }
  await pause()
}
assert(target, 'The isolated packaged renderer did not become available')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    socket.close()
    reject(new Error('Owned renderer socket did not open'))
  }, 5000)
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
    (error) => {
      clearTimeout(timer)
      reject(error)
    },
    { once: true }
  )
})
let next = 0
const pending = new Map()
const errors = []
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data))
  if (message.id) {
    const reply = pending.get(message.id)
    if (!reply) return
    clearTimeout(reply.timer)
    pending.delete(message.id)
    if (message.error) reply.reject(new Error(message.error.message))
    else reply.resolve(message.result)
  } else if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails
    const text = details.exception?.description ?? details.text
    if (!text.includes('ResizeObserver loop')) errors.push(text)
  }
})
const command = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++next
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Renderer ${method} timed out`))
    }, 5000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  assert(!result.exceptionDetails, result.exceptionDetails?.text ?? 'Renderer evaluation failed')
  return result.result.value
}
const until = async (expression) => {
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await pause()
  }
  throw new Error('Packaged renderer interaction timed out')
}
try {
  await command('Runtime.enable', {})
  await until('Boolean(window.api?.ipcApi?.request && document.querySelector("#root h1"))')
  const owner = await evaluate(
    `(async()=>{const r=await window.api.ipcApi.request('app.get_info');if(!r.ok)throw Error('App info failed');return r.data.userDataPath})()`
  )
  assert.equal(resolve(owner).toLowerCase(), resolve(profile).toLowerCase(), 'CDP belongs to another profile')
  const locales = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/renderer/i18n/locales')
  const labels = readdirSync(locales)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(locales, file), 'utf8'))['onboarding.skip'])
  const before = await evaluate(`window.api.preference.get('app.onboarding.provider_setup.status')`)
  assert.equal(before, 'pending')
  const clicked = await evaluate(
    `(()=>{const labels=${JSON.stringify(labels)};const buttons=[...document.querySelectorAll('button')].filter(b=>!b.disabled&&b.getBoundingClientRect().width>0&&labels.includes(b.textContent.trim()));if(buttons.length!==1)throw Error('Expected one visible Set Up Later button');buttons[0].click();return true})()`
  )
  assert(clicked)
  await until('Boolean(document.querySelector(\'[data-ui~="app.content"]\'))')
  const after = await evaluate(`window.api.preference.get('app.onboarding.provider_setup.status')`)
  assert.equal(after, 'skipped')
  assert.deepEqual(errors, [], 'Unexpected renderer error')
  const result = {
    passed: true,
    revision,
    profileVerified: true,
    rendererReady: true,
    clickedSetUpLater: true,
    before,
    after,
    workspaceVisible: true
  }
  writeFileSync(join(profile, 'renderer-ui-smoke.json'), JSON.stringify(result, null, 2))
  process.stdout.write('Packaged React ready and Set Up Later → workspace persistence passed\n')
} finally {
  socket.close()
  for (const request of pending.values()) clearTimeout(request.timer)
}
