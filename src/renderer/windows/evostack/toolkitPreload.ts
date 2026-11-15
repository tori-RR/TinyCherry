import { contextBridge, webFrame, webUtils } from './electronShim'
import { hostProcess, ipcRenderer } from './transport'

type Listener = Parameters<typeof ipcRenderer.on>[1]
function unsupported(): never {
  throw new Error('EVOSTACK_UNSUPPORTED_SYNC_IPC')
}
export const electronAPI = {
  ipcRenderer: {
    invoke: ipcRenderer.invoke,
    send: ipcRenderer.send,
    on(channel: string, listener: Listener): () => void {
      ipcRenderer.on(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    once(channel: string, listener: Listener): () => void {
      ipcRenderer.once(channel, listener)
      return () => ipcRenderer.removeListener(channel, listener)
    },
    removeListener: ipcRenderer.removeListener,
    removeAllListeners: ipcRenderer.removeAllListeners,
    sendTo: unsupported,
    sendSync: unsupported,
    sendToHost: unsupported,
    postMessage: unsupported
  },
  webFrame,
  webUtils,
  process: hostProcess
}
export function exposeElectronAPI(): void {
  contextBridge.exposeInMainWorld('electron', electronAPI)
}
