import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const [port, profile, revision] = process.argv.slice(2)
assert(/^\d+$/.test(port) && profile && revision)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const expectedVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version
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
  const info = await evaluate(
    `(async()=>{const r=await window.api.ipcApi.request('app.get_info');if(!r.ok)throw Error('App info failed');return r.data})()`
  )
  assert.equal(
    resolve(info.userDataPath).toLowerCase(),
    resolve(profile).toLowerCase(),
    'CDP belongs to another profile'
  )
  assert.equal(info.version, expectedVersion, 'Packaged renderer is connected to another app version')
  assert.equal(info.platform, 'win32')
  assert.equal(info.arch, 'x64')
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
  const contracts = await evaluate(`(async()=>{
    const request=async(route,input)=>{const r=await window.api.ipcApi.request(route,input);if(!r.ok)throw Error(route+': '+r.error?.message);return r.data};
    const controls=await request('computer_use.get_controls');
    if(!Array.isArray(controls)||controls.length!==0)throw Error('Fresh profile unexpectedly has desktop controls');
    const enabled=await window.api.preference.get('app.computer_use.agent_control.enabled');
    const approved=await window.api.preference.get('app.computer_use.approved_apps');
    if(enabled!==true||!Array.isArray(approved)||approved.length!==0)throw Error('Fresh profile must enable Computer Use with no remembered apps');
    const approvals=await request('computer_use.get_approvals');
    if(!Array.isArray(approvals)||approvals.length!==0)throw Error('Fresh profile unexpectedly has pending approvals');
    const repl=await window.api.ipcApi.request('computer_use.get_call_apps',{cell:crypto.randomUUID()});
    if(repl.ok||!repl.error?.message?.startsWith('EVOSTACK_NOT_MIGRATED:'))throw Error('Unmigrated REPL was not explicitly gated');
    const topic=await request('ai.temporary_topic.create',{name:'Packaged projection smoke'});
    const target={kind:'topic',topicId:topic.id};const subscriptionId=crypto.randomUUID();
    try{
      const view=await request('ai.projection.attach',{target,subscriptionId});
      if(view?.kind!=='topic'||view.topicId!==topic.id||view.revision!==0||view.messages?.length!==0||view.executions?.length!==0)throw Error('Invalid fresh renderer projection baseline');
      await request('ai.projection.detach',{target,subscriptionId});
      return {nativeControls:true,replExplicitlyGated:true,temporaryTopic:true,projectionBaseline:true};
    }finally{await request('ai.temporary_topic.delete',{id:topic.id})}
  })()`)
  assert.deepEqual(contracts, {
    nativeControls: true,
    replExplicitlyGated: true,
    temporaryTopic: true,
    projectionBaseline: true
  })
  assert.deepEqual(errors, [], 'Unexpected renderer error')
  const result = {
    passed: true,
    revision,
    version: info.version,
    profileVerified: true,
    rendererReady: true,
    clickedSetUpLater: true,
    before,
    after,
    workspaceVisible: true,
    contracts
  }
  writeFileSync(join(profile, 'renderer-ui-smoke.json'), JSON.stringify(result, null, 2))
  process.stdout.write('Packaged React ready and Set Up Later → workspace persistence passed\n')
} finally {
  socket.close()
  for (const request of pending.values()) clearTimeout(request.timer)
}
