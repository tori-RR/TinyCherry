import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyChat } from './verify-chat.mjs'

const [port, profile, revision] = process.argv.slice(2)
assert(/^\d+$/.test(port) && profile && revision)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const expectedVersion = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version
const deadline = Date.now() + 60_000
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
let pageLoads = 0
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
  } else if (message.method === 'Page.loadEventFired') {
    pageLoads++
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
  assert(
    !result.exceptionDetails,
    result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'Renderer evaluation failed'
  )
  return result.result.value
}
const until = async (expression) => {
  while (Date.now() < deadline) {
    const value = await evaluate(expression)
    if (value) return value
    await pause()
  }
  throw new Error(`Packaged renderer interaction timed out: ${expression.slice(0, 160)}`)
}
try {
  await command('Runtime.enable', {})
  await command('Page.enable', {})
  await until('Boolean(window.api?.ipcApi?.request && document.querySelector("#root h1"))')
  const bridge = await evaluate(`({
    nativePostMessage: typeof window.ipc?.postMessage === 'function',
    receiver: typeof window.__TINYCHERRY_RECEIVE__ === 'function',
    retiredBridgeAbsent: typeof window.__TAURI__ === 'undefined'
  })`)
  assert.deepEqual(bridge, { nativePostMessage: true, receiver: true, retiredBridgeAbsent: true })
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
  const windowOperation = async (route) =>
    evaluate(`(async () => {
      const result = await window.api.ipcApi.request(${JSON.stringify(route)});
      if (!result.ok) throw Error(result.error?.message ?? 'Native window operation failed');
      return result.data ?? null;
    })()`)
  assert.equal(await windowOperation('window.is_maximized'), false, 'Fresh window should be restored')
  await windowOperation('window.maximize')
  await until(`window.api.ipcApi.request('window.is_maximized').then(result => result.ok && result.data === true)`)
  await windowOperation('window.unmaximize')
  await until(`window.api.ipcApi.request('window.is_maximized').then(result => result.ok && result.data === false)`)
  const locales = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/renderer/i18n/locales')
  const localeCatalogs = readdirSync(locales)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(locales, file), 'utf8')))
  const labels = localeCatalogs.map((locale) => locale['onboarding.skip'])
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
  const journeys = await verifyChat({ evaluate, command, until, localeCatalogs })
  const screenshot = await command('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(profile, 'workspace-chat.png'), Buffer.from(screenshot.data, 'base64'))
  const settingsOpened = await evaluate(`(() => {
    const event = new CustomEvent('cherry:open-main-route', {
      cancelable: true, detail: { path: '/settings/provider?id=chatgpt-sub&filter=all' }
    });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })()`)
  assert(settingsOpened, 'Main window did not open ChatGPT Sub settings')
  const continueLabels = localeCatalogs
    .map((locale) => locale['settings.provider.chatgpt_sub.continue'])
    .filter(Boolean)
  await until(`[...document.querySelectorAll('[data-testid="chatgpt-sub-auth"] button')].some(
    button => !button.disabled && ${JSON.stringify(continueLabels)}.includes(button.textContent.trim())
  )`)
  const chatGPTSignIn = await evaluate(`(async () => {
    const input = { providerId: 'chatgpt-sub', requestId: crypto.randomUUID() };
    const start = await window.api.ipcApi.request('oauth.chatgpt.start', input);
    if (!start.ok) return false;
    try {
      const authorization = new URL(start.data.authorizationUrl);
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      return authorization.origin === 'https://auth.openai.com' &&
        authorization.searchParams.get('client_id') === 'dynamic_agent_client' &&
        callback.hostname === '127.0.0.1' && callback.pathname === '/auth/callback';
    } finally {
      const cancelled = await window.api.ipcApi.request('oauth.chatgpt.cancel', input);
      if (!cancelled.ok) throw Error('Could not close the synthetic ChatGPT sign-in');
    }
  })()`)
  assert(chatGPTSignIn, 'ChatGPT Sub did not prepare an official browser authorization')
  const storageKey = '__tinycherry_gpui_reload_probe__'
  const storageOrigin = await evaluate(`(() => {
    localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(revision)});
    return location.origin;
  })()`)
  assert.equal(storageOrigin, 'http://tauri.localhost', 'Browser storage must retain the preceding host origin')
  const previousLoads = pageLoads
  await command('Page.reload', {})
  while (pageLoads === previousLoads && Date.now() < deadline) await pause()
  assert(pageLoads > previousLoads, 'The packaged page did not finish reloading')
  await until('Boolean(window.api?.ipcApi?.request && document.querySelector(\'[data-ui~="app.content"]\'))')
  assert.equal(
    await evaluate(`window.api.preference.get('app.onboarding.provider_setup.status')`),
    'skipped',
    'Reloaded renderer did not reconnect to the persisted profile'
  )
  const stored = await evaluate(`(() => {
    const value = localStorage.getItem(${JSON.stringify(storageKey)});
    localStorage.removeItem(${JSON.stringify(storageKey)});
    return value;
  })()`)
  assert.equal(stored, revision, 'Renderer reload did not retain origin-scoped browser storage')
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
    nativeBridge: bridge,
    maximizeRestore: true,
    rendererReload: true,
    browserStorageRetained: true,
    chatGPTSignIn,
    contracts,
    journeys
  }
  writeFileSync(join(profile, 'renderer-ui-smoke.json'), JSON.stringify(result, null, 2))
  process.stdout.write('Packaged React ready and Set Up Later → workspace persistence passed\n')
} catch (error) {
  try {
    const state = await evaluate(
      `({url:location.href,text:document.body.innerText.slice(0,6000),dataTrace:window.__EVOSTACK_SMOKE_DATA_TRACE__,editors:[...document.querySelectorAll('textarea,[contenteditable]')].map(node=>({tag:node.tagName,editable:node.getAttribute('contenteditable'),parent:node.parentElement?.outerHTML.slice(0,1000)}))})`
    )
    writeFileSync(join(profile, 'renderer-failure.json'), JSON.stringify({ state, errors }, null, 2))
    const capture = await command('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(profile, 'renderer-failure.png'), Buffer.from(capture.data, 'base64'))
    console.error('Synthetic renderer failure state:', JSON.stringify({ state, errors }))
  } catch {
    /* Preserve the original verification failure if the owned renderer closed. */
  }
  throw error
} finally {
  socket.close()
  for (const request of pending.values()) clearTimeout(request.timer)
}
