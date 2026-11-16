import { installDesktopApi } from '../../../platform/tauri/install'
import { reportRendererReady } from './rendererReady'

await installDesktopApi()

await import('../main/entryPoint')
void reportRendererReady().catch((error) => globalThis.reportError(error))
