import { reportRendererReady } from './rendererReady'
import { installHostTransport } from './transport'

await installHostTransport()
await import('../../../preload/preload')
await import('../main/entryPoint')
void reportRendererReady().catch((error) => globalThis.reportError(error))
