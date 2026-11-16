import type { WindowApiType } from './api'
import type { DesktopInfo, DesktopEvent } from './contracts'

declare global {
  const __DESKTOP_DEV_ORIGIN__: string | null
  interface Window {
    root: HTMLElement
  }
  interface Window {
    api: WindowApiType
    desktop: {
      info: DesktopInfo
      environment: Readonly<{
        NODE_ENV: string
        CS_DIAGNOSTICS?: string
        CSLOGGER_RENDERER_LEVEL?: string
        CSLOGGER_RENDERER_SHOW_MODULES?: string
      }>
      request<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
      notify(channel: string, ...args: unknown[]): void
      listen<T extends unknown[]>(channel: string, listener: (event: DesktopEvent, ...args: T) => void): () => void
      listenOnce<T extends unknown[]>(channel: string, listener: (event: DesktopEvent, ...args: T) => void): () => void
      appearance: {
        insertCSS(css: string): void
        setZoomFactor(factor: number): Promise<void>
        setZoomLevel(level: number): Promise<void>
      }
    }
  }
}
