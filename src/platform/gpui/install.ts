import { installBusinessApi } from '../desktop-api/api'
import { desktopInfoSchema } from '../desktop-api/capabilities'
import type { DesktopInfo } from '../desktop-api/contracts'
import { invokeHost } from './bridge'
import { nativeTransport, installHostTransport } from './transport'

export async function installDesktopApi(): Promise<void> {
  await installHostTransport()
  const info: DesktopInfo = desktopInfoSchema.parse(await invokeHost<unknown>('desktop_info'))
  window.desktop = {
    info,
    environment: { NODE_ENV: import.meta.env.MODE },
    request: nativeTransport.request,
    notify: nativeTransport.notify,
    listen(channel, listener) {
      return nativeTransport.subscribe(channel, listener)
    },
    listenOnce(channel, listener) {
      return nativeTransport.subscribeOnce(channel, listener)
    },
    appearance: {
      insertCSS(css) {
        const style = document.createElement('style')
        style.textContent = css
        document.head.append(style)
      },
      setZoomFactor(factor) {
        return nativeTransport.request<void>('evostack:zoom', factor)
      },
      setZoomLevel(level) {
        return nativeTransport.request<void>('evostack:zoom', 1.2 ** level)
      }
    }
  }
  installBusinessApi()
}
