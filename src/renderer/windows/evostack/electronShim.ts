import { ipcRenderer } from './transport'

export { ipcRenderer } from './transport'
export const contextBridge = {
  exposeInMainWorld(name: string, value: unknown): void {
    Object.defineProperty(window, name, { value, configurable: true })
  }
}
export const webUtils = {
  getPathForFile(_file: File): never {
    throw new Error('EVOSTACK_NOT_MIGRATED: file attachments')
  }
}
export const webFrame = {
  insertCSS(css: string): void {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
  },
  setZoomFactor(factor: number): void {
    void ipcRenderer.invoke('evostack:zoom', factor)
  },
  setZoomLevel(level: number): void {
    void ipcRenderer.invoke('evostack:zoom', 1.2 ** level)
  }
}
export const clipboard = {
  readText: () => navigator.clipboard.readText(),
  writeText: (text: string) => navigator.clipboard.writeText(text)
}
