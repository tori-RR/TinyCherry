import type { IpcRequestSchemas } from '@shared/ipc/schemas/ipcSchemas'
import type { IpcHandlersFor } from '@shared/ipc/types'

import { aiHandlers } from './ai'
import { appHandlers } from './app'
import { backupHandlers } from './backup'
import { binaryHandlers } from './binary'
import { browserHandlers } from './browser'
import { cherryCloudHandlers } from './cherryCloud'
import { cherryinHandlers } from './cherryin'
import { citationHandlers } from './citation'
import { codeCliHandlers } from './codeCli'
import { computerUseHandlers } from './computerUse'
import { deepSeekHarnessHandlers } from './deepSeekHarness'
import { diagnosticsHandlers } from './diagnostics'
import { doctorHandlers } from './doctor'
import { doctorAgentHandlers } from './doctorAgent'
import { exportHandlers } from './export'
import { externalAppHandlers } from './externalApp'
import { fileHandlers } from './file'
import { hermesDashboardHandlers } from './hermesDashboard'
import { knowledgeHandlers } from './knowledge'
import { mcpHandlers } from './mcp'
import { miniAppHandlers } from './miniApp'
import { navigationHandlers } from './navigation'
import { oauthHandlers } from './oauth'
import { openclawHandlers } from './openclaw'
import { ovmsHandlers } from './ovms'
import { pdfjsHandlers } from './pdfjs'
import { printHandlers } from './print'
import { providerHandlers } from './provider'
import { proxyHandlers } from './proxy'
import { quickAssistantHandlers } from './quickAssistant'
import { selectionHandlers } from './selection'
import { skillHandlers } from './skill'
import { systemHandlers } from './system'
import { tabHandlers } from './tab'
import { toolResultHandlers } from './toolResult'
import { translateHandlers } from './translate'
import { trashHandlers } from './trash'
import { webSearchHandlers } from './webSearch'
import { webviewHandlers } from './webview'
import { windowHandlers } from './window'

type RemovedRoute = Extract<
  keyof IpcRequestSchemas,
  | `api_gateway.${string}`
  | `channel.${string}`
  | `profile.${string}`
  | `screenshot.${string}`
  | `chat.screenshot.${string}`
>

/** All IPC handlers exposed by TinyCherry. Legacy request schemas remain typed for source compatibility. */
export const ipcHandlers = {
  ...aiHandlers,
  ...appHandlers,
  ...backupHandlers,
  ...binaryHandlers,
  ...browserHandlers,
  ...cherryinHandlers,
  ...cherryCloudHandlers,
  ...citationHandlers,
  ...codeCliHandlers,
  ...computerUseHandlers,
  ...deepSeekHarnessHandlers,
  ...diagnosticsHandlers,
  ...doctorHandlers,
  ...doctorAgentHandlers,
  ...exportHandlers,
  ...externalAppHandlers,
  ...fileHandlers,
  ...hermesDashboardHandlers,
  ...knowledgeHandlers,
  ...mcpHandlers,
  ...miniAppHandlers,
  ...navigationHandlers,
  ...oauthHandlers,
  ...openclawHandlers,
  ...ovmsHandlers,
  ...pdfjsHandlers,
  ...printHandlers,
  ...proxyHandlers,
  ...providerHandlers,
  ...quickAssistantHandlers,
  ...selectionHandlers,
  ...skillHandlers,
  ...systemHandlers,
  ...tabHandlers,
  ...translateHandlers,
  ...toolResultHandlers,
  ...trashHandlers,
  ...webSearchHandlers,
  ...webviewHandlers,
  ...windowHandlers
} satisfies Omit<IpcHandlersFor<IpcRequestSchemas>, RemovedRoute>
