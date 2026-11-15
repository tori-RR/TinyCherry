import type { MessageExportTarget } from '@renderer/types/messageExport'

import type { MessageListActions, MessageMenuExportOptions } from './types'

export const messageExportTargets: {
  target: MessageExportTarget
  option: keyof MessageMenuExportOptions
  labelKey: string
  group: 'file' | 'external'
  commandId: string
  action: keyof MessageListActions
}[] = [
  {
    target: 'markdown',
    option: 'markdown',
    labelKey: 'chat.topics.export.md.label',
    group: 'file',
    commandId: 'message.exportMarkdown',
    action: 'exportMessageAsMarkdown'
  },
  {
    target: 'markdown-reason',
    option: 'markdown_reason',
    labelKey: 'chat.topics.export.md.reason',
    group: 'file',
    commandId: 'message.exportMarkdownReason',
    action: 'exportMessageAsMarkdown'
  },
  {
    target: 'word',
    option: 'docx',
    labelKey: 'chat.topics.export.word',
    group: 'file',
    commandId: 'message.exportWord',
    action: 'exportToWord'
  },
  {
    target: 'obsidian',
    option: 'obsidian',
    labelKey: 'chat.topics.export.obsidian',
    group: 'external',
    commandId: 'message.exportObsidian',
    action: 'exportToObsidian'
  }
]
