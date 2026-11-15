import { ipcRenderer } from './transport'

// Report the retained React surface, rather than just a WebView/window handle.
export function reportRendererReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const root = document.getElementById('root')
    if (!root) return reject(new Error('EVOSTACK_RENDERER_ROOT_MISSING'))
    const stop = () => {
      observer.disconnect()
      clearTimeout(timer)
      window.removeEventListener('pagehide', closed)
    }
    const closed = () => {
      stop()
      reject(new Error('EVOSTACK_RENDERER_CLOSED'))
    }
    const check = () => {
      const phase = root.querySelector('[data-ui~="app.content"]')
        ? 'workspace'
        : root.querySelector('h1') && root.querySelector('button:not([disabled])')
          ? 'onboarding'
          : undefined
      if (!phase) return
      stop()
      void ipcRenderer.invoke('evostack:renderer-ready', phase).then(() => resolve(), reject)
    }
    const observer = new MutationObserver(check)
    const timer = setTimeout(() => {
      stop()
      reject(new Error('EVOSTACK_RENDERER_READY_TIMEOUT'))
    }, 30_000)
    window.addEventListener('pagehide', closed, { once: true })
    observer.observe(root, { childList: true, subtree: true })
    check()
  })
}
