import { IpcChannel } from '@shared/IpcChannel'

import { nativeTransport } from '../gpui/transport'
import type { DesktopEvent } from './contracts'

/**
 * Low-level IpcApi bridge exposed at `window.api.ipcApi`.
 *
 * Generic by design: adding a request route or an event needs ZERO changes here.
 * All events share the single `IpcApi_Event` channel and are demultiplexed by
 * name. The typed, error-unwrapping facade lives in `src/renderer/ipc`; this is
 * the raw transport that crosses the desktop boundary.
 */
export const ipcApi = {
  request: (route: string, input?: unknown, meta?: unknown): Promise<unknown> =>
    nativeTransport.request(IpcChannel.IpcApi_Request, route, input, meta),

  on: (event: string, callback: (payload: unknown) => void): (() => void) => {
    const listener = (_e: DesktopEvent, name: string, payload: unknown) => {
      if (name === event) callback(payload)
    }
    return nativeTransport.subscribe(IpcChannel.IpcApi_Event, listener)
  }
}
