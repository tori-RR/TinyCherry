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
  if (!message || typeof message.channel !== 'string' || !Array.isArray(message.args)) {
    globalThis.reportError(new Error('EVOSTACK_INVALID_EVENT'))
    return
  }
  if (message.channel === IpcChannel.Cache_Sync) observeCache(message.args[0])
  if (message.channel === 'evostack:backend-exited') {
    for (const topicId of [...activeTopics]) {
      dispatch({
        channel: IpcChannel.IpcApi_Event,
        args: [
          'ai.stream.error',
          {
            topicId,
            isTopicDone: true,
            error: { name: 'Error', message: 'EVOSTACK_BACKEND_EXITED: reopen the application to continue' }
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
    const route = channel === IpcChannel.IpcApi_Request ? args[0] : undefined
    if (
      (route === 'file.edit.write' || route === 'file.write_if_unchanged') &&
      args[1] &&
      typeof args[1] === 'object'
    ) {
      const input = args[1] as { data?: unknown }
      if (input.data instanceof Uint8Array) args = [args[0], { ...input, data: Array.from(input.data) }]
    }
    const value = await core().invoke<any>('ipc_request', { channel, args })
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
  await core().invoke('subscribe', { events })
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
      listeners.clear()
      activeTopics.clear()
    },
    { once: true }
  )
}
