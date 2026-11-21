import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { isNonChatModel } from '@shared/utils/model'

/** Keep this catalog in step with the native backend's explicitly registered tools. */
export const NATIVE_AGENT_TOOLS = [
  { id: 'list_files', label: '列出文件', description: '浏览工作区内的目录和文件', writes: false },
  { id: 'read_file', label: '读取文件', description: '读取工作区内的文本文件', writes: false },
  { id: 'search_files', label: '搜索文件', description: '在工作区内查找文本', writes: false },
  { id: 'write_file', label: '写入文件', description: '经本次确认后创建或写入文件', writes: true },
  { id: 'edit_file', label: '编辑文件', description: '经本次确认后替换文件内容', writes: true },
  { id: 'run_shell', label: '运行命令', description: '逐次确认命令和工作目录后执行', writes: true }
] as const

/** Native work currently uses the tool-capable Chat Completions transport. */
export function isNativeAgentModelCompatible(provider: Provider | undefined, model: Model): boolean {
  return (
    !!provider?.isEnabled &&
    model.isEnabled &&
    !isNonChatModel(model) &&
    !(provider.id === 'chatgpt-sub' && provider.authType === 'oauth') &&
    (!provider.defaultChatEndpoint || provider.defaultChatEndpoint === 'openai-chat-completions')
  )
}
