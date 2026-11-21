export interface HostEvent {
  channel: string
  args: unknown[]
}

type HostCommand = 'desktop_info' | 'subscribe' | 'start_dragging' | 'ipc_request'
interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

declare global {
  interface Window {
    ipc?: { postMessage(message: string): void }
    __TINYCHERRY_RECEIVE__?: (message: unknown) => void
  }
}

const MAX_FRAME = 4 * 1024 * 1024
const MAX_PENDING = 128
const REQUEST_TIMEOUT = 60_000
const DIALOG_TIMEOUT = 10 * 60_000
const encoder = new TextEncoder()

function requestTimeout(command: HostCommand, args: Record<string, unknown>): number {
  if (command !== 'ipc_request') return REQUEST_TIMEOUT
  if (args.channel === 'file:selectFolder') return DIALOG_TIMEOUT
  const route = Array.isArray(args.args) ? args.args[0] : undefined
  return args.channel === 'ipc-api:request' &&
    ['painting.file.export', 'skill.install_from_zip', 'skill.install_from_directory'].includes(route)
    ? DIALOG_TIMEOUT
    : REQUEST_TIMEOUT
}

export function isTrustedHostUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) return false
  if (
    typeof __DESKTOP_DEV_ORIGIN__ !== 'undefined' &&
    __DESKTOP_DEV_ORIGIN__ === 'http://127.0.0.1:17420' &&
    url.origin === __DESKTOP_DEV_ORIGIN__
  )
    return true
  // This is the existing WebView2 storage origin, retained across the GPUI/Wry
  // migration so cs_cache_persist (tabs, input history and UI state) stays readable.
  // The protocol name is a compatibility identifier, not a Tauri API dependency.
  return (
    !url.port &&
    ((url.protocol === 'http:' && url.hostname === 'tauri.localhost') ||
      (url.protocol === 'tauri:' && url.hostname === 'localhost'))
  )
}

// Wry supplies the string-only postMessage entry point. Correlation and event
// lifetimes belong to this document, rather than to a framework global or Node.
class HostBridge {
  private readonly session = crypto.randomUUID()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(event: HostEvent) => void>()
  private nextId = 1
  private closed = false
  private readonly postMessage: (message: string) => void

  constructor() {
    if (!isTrustedHostUrl(location.href) || window.top !== window) throw new Error('EVOSTACK_UNTRUSTED_FRONTEND')
    if (typeof window.ipc?.postMessage !== 'function') throw new Error('EVOSTACK_HOST_UNAVAILABLE')
    this.postMessage = window.ipc.postMessage.bind(window.ipc)
    Object.defineProperty(window, '__TINYCHERRY_RECEIVE__', {
      value: this.receive,
      configurable: true,
      writable: false
    })
    window.addEventListener('pagehide', this.close, { once: true })
  }

  invoke<T>(command: HostCommand, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('EVOSTACK_RENDERER_CLOSED'))
    if (this.pending.size >= MAX_PENDING) return Promise.reject(new Error('EVOSTACK_BUSY: request was not queued'))
    if (!Number.isSafeInteger(this.nextId)) return Promise.reject(new Error('EVOSTACK_REQUEST_ID_EXHAUSTED'))
    const id = this.nextId++
    let frame: string
    try {
      frame = JSON.stringify({ id, session: this.session, command, args })
      if (encoder.encode(frame).byteLength >= MAX_FRAME) throw new Error('EVOSTACK_REQUEST_TOO_LARGE')
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new Error('EVOSTACK_REQUEST_TIMEOUT: outcome unknown; no retry'))
        },
        requestTimeout(command, args)
      )
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      try {
        this.postMessage(frame)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  listen(listener: (event: HostEvent) => void): () => void {
    if (this.closed) throw new Error('EVOSTACK_RENDERER_CLOSED')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private readonly receive = (value: unknown): void => {
    if (this.closed || !value || typeof value !== 'object') return
    const message = value as Record<string, unknown>
    // A reload restarts request IDs. The random document session ensures a late
    // result from the previous page cannot settle a new page's request.
    if (message.session !== this.session) return
    if ('event' in message) {
      const event = message.event as HostEvent | null
      if ('id' in message || !event || typeof event.channel !== 'string' || !Array.isArray(event.args)) {
        globalThis.reportError(new Error('EVOSTACK_INVALID_EVENT'))
        return
      }
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch (error) {
          globalThis.reportError(error)
        }
      }
      return
    }
    const id = message.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return
    const request = this.pending.get(id)
    if (!request) return
    this.pending.delete(id)
    clearTimeout(request.timer)
    if (typeof message.error === 'string' && !Object.hasOwn(message, 'result')) request.reject(new Error(message.error))
    else if (Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error')) request.resolve(message.result)
    else request.reject(new Error('EVOSTACK_INVALID_RESPONSE'))
  }

  private readonly close = (): void => {
    this.closed = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('EVOSTACK_RENDERER_CLOSED'))
    }
    this.pending.clear()
    this.listeners.clear()
    if (window.__TINYCHERRY_RECEIVE__ === this.receive) delete window.__TINYCHERRY_RECEIVE__
  }
}

let bridge: HostBridge | undefined
function hostBridge(): HostBridge {
  bridge ??= new HostBridge()
  return bridge
}

export async function invokeHost<T = unknown>(command: HostCommand, args?: Record<string, unknown>): Promise<T> {
  return hostBridge().invoke<T>(command, args)
}

export function onHostEvent(listener: (event: HostEvent) => void): () => void {
  return hostBridge().listen(listener)
}
