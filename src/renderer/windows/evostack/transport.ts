import {
  applyMessageProjectionUpdate,
  type MessageProjectionUpdate,
  type MessageProjectionView,
  type ProjectionTarget
} from '@shared/ai/messageProjection'
import { IpcChannel } from '@shared/IpcChannel'

type Listener = (event: object, ...args: any[]) => void
interface EventMessage {
  channel: string
  args: unknown[]
}
interface Channel<T> {
  onmessage: (message: T) => void
}
interface TauriCore {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  Channel: new <T>() => Channel<T>
}
declare global {
  interface Window {
    __TAURI__?: { core: TauriCore }
  }
}

const listeners = new Map<string, Array<{ listener: Listener; once: boolean }>>()
const activeTopics = new Set<string>()
interface ProjectionLease {
  target: ProjectionTarget
  view: MessageProjectionView | null
  pending: MessageProjectionUpdate[]
}
const projectionLeases = new Map<string, ProjectionLease>()
const backendLostMessage = 'EVOSTACK_BACKEND_EXITED: reopen the application to continue'
let backendLost = false
let closed = false
let installation: Promise<void> | undefined
export const hostProcess = {
  contextIsolated: false,
  platform: 'win32',
  versions: { tauri: '2', go: 'backend' },
  env: { NODE_ENV: import.meta.env.MODE }
}

function core(): TauriCore {
  if (!window.__TAURI__) throw new Error('EVOSTACK_HOST_UNAVAILABLE')
  return window.__TAURI__.core
}

function dispatch(message: EventMessage): void {
  if (closed) return
  if (!message || typeof message.channel !== 'string' || !Array.isArray(message.args)) {
    globalThis.reportError(new Error('EVOSTACK_INVALID_EVENT'))
    return
  }
  if (message.channel === IpcChannel.Cache_Sync) observeCache(message.args[0])
  if (message.channel === IpcChannel.IpcApi_Event && message.args[0] === 'ai.projection.changed') {
    const event = message.args[1] as { subscriptionId?: string; update?: MessageProjectionUpdate } | undefined
    const lease = event?.subscriptionId && projectionLeases.get(event.subscriptionId)
    if (lease && event?.update) {
      if (lease.view) lease.view = applyMessageProjectionUpdate(lease.view, event.update) ?? lease.view
      else if (lease.pending.length < 100) lease.pending.push(event.update)
      observeProjection(lease)
    }
  }
  if (message.channel === 'evostack:backend-exited') {
    if (backendLost || closed) return
    backendLost = true
    for (const [subscriptionId, lease] of [...projectionLeases]) {
      const view = lease.view
      if (!view || view.kind !== 'topic' || !view.executions.some((execution) => execution.status === 'active'))
        continue
      const affected = new Set(
        view.executions.filter((execution) => execution.status === 'active').map((execution) => execution.messageId)
      )
      dispatch({
        channel: IpcChannel.IpcApi_Event,
        args: [
          'ai.projection.changed',
          {
            subscriptionId,
            update: {
              kind: 'topic',
              topicId: view.topicId,
              revision: view.revision + 1,
              executions: view.executions.map((execution) =>
                execution.status === 'active' ? { ...execution, status: 'unresolved' } : execution
              ),
              patches: view.messages
                .filter((message) => affected.has(message.id))
                .map((message) => ({
                  type: 'message',
                  message: {
                    ...message,
                    metadata: { ...message.metadata, status: 'error' },
                    parts: [
                      ...message.parts.map((part) =>
                        part.type === 'text' || part.type === 'reasoning' ? { ...part, state: 'done' } : part
                      ),
                      { type: 'data-error', data: { name: 'Error', message: backendLostMessage } }
                    ]
                  }
                })),
              order: view.messages.map((message) => message.id)
            }
          }
        ]
      })
    }
    projectionLeases.clear()
    for (const topicId of [...activeTopics]) {
      dispatch({
        channel: IpcChannel.IpcApi_Event,
        args: [
          'ai.stream.error',
          {
            topicId,
            isTopicDone: true,
            error: { name: 'Error', message: backendLostMessage }
          }
        ]
      })
      dispatch({
        channel: IpcChannel.Cache_Sync,
        args: [
          {
            type: 'shared',
            key: `topic.stream.statuses.${topicId}`,
            value: { status: 'error', activeExecutions: [], awaitingApprovalAnchors: [] }
          }
        ]
      })
    }
    activeTopics.clear()
  }
  for (const registration of [...(listeners.get(message.channel) ?? [])]) {
    if (registration.once) {
      const registered = listeners.get(message.channel)
      const index = registered?.indexOf(registration) ?? -1
      if (registered && index >= 0) registered.splice(index, 1)
      if (!registered?.length) listeners.delete(message.channel)
    }
    try {
      registration.listener(Object.freeze({}), ...message.args)
    } catch (error) {
      globalThis.reportError(error)
    }
  }
}

function observeProjection(lease: ProjectionLease): void {
  if (lease.view?.kind === 'topic' && lease.view.executions.some((execution) => execution.status === 'active'))
    activeTopics.add(lease.view.topicId)
}

function sameProjectionTarget(left: ProjectionTarget, right: ProjectionTarget | undefined): boolean {
  if (left.kind === 'topic') return right?.kind === 'topic' && left.topicId === right.topicId
  return right?.kind === 'child' && left.sessionId === right.sessionId && left.toolCallId === right.toolCallId
}

function localWindowRequest(channel: string, route: unknown): boolean {
  return (
    channel === 'evostack:zoom' ||
    (channel === IpcChannel.IpcApi_Request &&
      typeof route === 'string' &&
      ['window.close', 'window.minimize', 'window.maximize', 'window.unmaximize', 'window.is_maximized'].includes(
        route
      ))
  )
}

function observeCache(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const update = value as { key?: string; value?: { status?: string } }
  const prefix = 'topic.stream.statuses.'
  if (!update.key?.startsWith(prefix)) return
  const topicId = update.key.slice(prefix.length)
  if (update.value?.status === 'pending' || update.value?.status === 'streaming') activeTopics.add(topicId)
  else activeTopics.delete(topicId)
}

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<any> {
    await installHostTransport()
    const route = channel === IpcChannel.IpcApi_Request ? args[0] : undefined
    if (closed) throw new Error('EVOSTACK_RENDERER_CLOSED')
    if (backendLost && !localWindowRequest(channel, route)) throw new Error(backendLostMessage)
    if (channel === IpcChannel.Fs_ReadText) {
      if (typeof args[0] !== 'string' || args[0].length === 0) throw new Error('EVOSTACK_INVALID_TEXT_PATH')
      // The retained Markdown/text/HTML previews use this legacy facade. Route it
      // through the same registered-profile file access checks as binary previews.
      const result = await ipcRenderer.invoke(IpcChannel.IpcApi_Request, 'file.read', {
        handle: { kind: 'path', path: args[0] },
        options: { mode: 'full', encoding: 'binary' }
      })
      if (result?.ok !== true) throw new Error(result?.error?.message ?? 'EVOSTACK_TEXT_READ_FAILED')
      const bytes: Uint8Array = result.data.content
      const encoding =
        bytes[0] === 0xff && bytes[1] === 0xfe
          ? 'utf-16le'
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? 'utf-16be'
            : 'utf-8'
      return new TextDecoder(encoding, { fatal: true }).decode(bytes)
    }
    if (
      (route === 'file.edit.write' || route === 'file.write_if_unchanged') &&
      args[1] &&
      typeof args[1] === 'object'
    ) {
      const input = args[1] as { data?: unknown }
      if (input.data instanceof Uint8Array) args = [args[0], { ...input, data: Array.from(input.data) }]
    }
    if (route === 'assistant.set_avatar' && args[1] && typeof args[1] === 'object') {
      const input = args[1] as { avatar?: { kind?: unknown; data?: unknown } }
      if (input.avatar?.kind === 'image' && input.avatar.data instanceof Uint8Array)
        args = [route, { ...input, avatar: { ...input.avatar, data: Array.from(input.avatar.data) } }]
    }
    const projection = args[1] as { target?: ProjectionTarget; subscriptionId?: string } | undefined
    let lease: ProjectionLease | undefined
    if (route === 'ai.projection.attach' && projection?.subscriptionId && projection.target) {
      lease = { target: projection.target, view: null, pending: [] }
      projectionLeases.set(projection.subscriptionId, lease)
    } else if (route === 'ai.projection.detach' && projection?.subscriptionId) {
      const current = projectionLeases.get(projection.subscriptionId)
      if (current && sameProjectionTarget(current.target, projection.target))
        projectionLeases.delete(projection.subscriptionId)
    }
    let value: any
    try {
      value = await core().invoke<any>('ipc_request', { channel, args })
      if (closed) throw new Error('EVOSTACK_RENDERER_CLOSED')
      if (backendLost && !localWindowRequest(channel, route)) throw new Error(backendLostMessage)
    } catch (error) {
      if (lease && projection?.subscriptionId && projectionLeases.get(projection.subscriptionId) === lease)
        projectionLeases.delete(projection.subscriptionId)
      throw error
    }
    if (lease && projection?.subscriptionId && projectionLeases.get(projection.subscriptionId) === lease) {
      if (value?.ok === true && value.data) {
        lease.view = value.data
        for (const update of lease.pending) lease.view = applyMessageProjectionUpdate(lease.view!, update) ?? lease.view
        lease.pending = []
        observeProjection(lease)
      } else projectionLeases.delete(projection.subscriptionId)
    }
    if (value?.ok === true && (route === 'file.read' || route === 'file.edit.read')) {
      const field = route === 'file.read' ? 'content' : 'data'
      const bytes = value.data?.[field]
      if (
        !Array.isArray(bytes) ||
        bytes.length > 4 * 1024 * 1024 ||
        bytes.some((byte: unknown) => !Number.isInteger(byte) || (byte as number) < 0 || (byte as number) > 255)
      ) {
        throw new Error('EVOSTACK_INVALID_BINARY_RESPONSE')
      }
      return { ...value, data: { ...value.data, [field]: Uint8Array.from(bytes) } }
    }
    if (channel === IpcChannel.Cache_GetAllShared && value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value))
        observeCache({ key, value: (entry as { value?: unknown }).value })
    }
    if (channel === IpcChannel.IpcApi_Request && value?.ok === true && !Object.hasOwn(value, 'data')) {
      return { ...value, data: undefined }
    }
    return value
  },
  send(channel: string, ...args: unknown[]): void {
    void ipcRenderer.invoke(channel, ...args).catch((error) => globalThis.reportError(error))
  },
  on(channel: string, listener: Listener) {
    const registered = listeners.get(channel) ?? []
    registered.push({ listener, once: false })
    listeners.set(channel, registered)
    return ipcRenderer
  },
  once(channel: string, listener: Listener) {
    ipcRenderer.on(channel, listener)
    listeners.get(channel)!.at(-1)!.once = true
    return ipcRenderer
  },
  removeListener(channel: string, listener: Listener) {
    const registered = listeners.get(channel)
    const index = registered?.findLastIndex((entry) => entry.listener === listener) ?? -1
    if (registered && index >= 0) registered.splice(index, 1)
    if (!registered?.length) listeners.delete(channel)
    return ipcRenderer
  },
  off(channel: string, listener: Listener) {
    return ipcRenderer.removeListener(channel, listener)
  },
  removeAllListeners(channel?: string) {
    if (channel === undefined) listeners.clear()
    else listeners.delete(channel)
    return ipcRenderer
  }
}

export function isTrustedHostUrl(raw: string): boolean {
  const url = new URL(raw)
  return (
    !url.username &&
    !url.password &&
    !url.port &&
    ((url.protocol === 'http:' && url.hostname === 'tauri.localhost') ||
      (url.protocol === 'tauri:' && url.hostname === 'localhost'))
  )
}

export function installHostTransport(): Promise<void> {
  installation ??= installTransportOnce()
  return installation
}

async function installTransportOnce(): Promise<void> {
  if (!isTrustedHostUrl(location.href)) {
    throw new Error('EVOSTACK_UNTRUSTED_FRONTEND')
  }
  Object.defineProperty(window, 'process', { value: hostProcess, configurable: true })
  Object.defineProperty(window, 'root', { value: document.getElementById('root'), configurable: true })
  const events = new (core().Channel)<EventMessage>()
  events.onmessage = dispatch
  const subscribed = core().invoke('subscribe', { events })
  const handleMouseDown = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (
      event.button !== 0 ||
      !target ||
      target.closest(
        'button,a,input,textarea,select,[contenteditable="true"],[role="button"],[role="tab"],.nodrag,[class*="-webkit-app-region:no-drag"],[style*="-webkit-app-region: no-drag"],[style*="-webkit-app-region:no-drag"]'
      )
    )
      return
    if (target.closest('.drag,[class*="-webkit-app-region:drag"],[style*="-webkit-app-region: drag"]')) {
      void core().invoke('start_dragging')
    }
  }
  document.addEventListener('mousedown', handleMouseDown)
  window.addEventListener(
    'pagehide',
    () => {
      document.removeEventListener('mousedown', handleMouseDown)
      closed = true
      listeners.clear()
      activeTopics.clear()
      projectionLeases.clear()
    },
    { once: true }
  )
  await subscribed
  if (closed) throw new Error('EVOSTACK_RENDERER_CLOSED')
}
