import { useMemo } from 'react'

import { useMultiplePreferences, usePreference } from '@data/hooks/usePreference'
import type { MessageMenuConfig } from '@renderer/components/chat/messages/types'
import { defaultMessageMenuExportOptions } from '@renderer/components/chat/messages/types'

const MESSAGE_EXPORT_MENU_PREFERENCE_KEYS = {
  image: 'data.export.menus.image',
  markdown: 'data.export.menus.markdown',
  markdown_reason: 'data.export.menus.markdown_reason',
  obsidian: 'data.export.menus.obsidian',
  docx: 'data.export.menus.docx',
  plain_text: 'data.export.menus.plain_text'
} as const

export function useMessageMenuConfig(): MessageMenuConfig {
  const [enableDeveloperMode] = usePreference('app.developer_mode.enabled')
  const [confirmDeleteMessage] = usePreference('chat.message.confirm_delete')
  const [exportMenuOptions] = useMultiplePreferences(MESSAGE_EXPORT_MENU_PREFERENCE_KEYS)

  return useMemo(
    () => ({
      confirmDeleteMessage,
      enableDeveloperMode,
      exportMenuOptions: {
        ...defaultMessageMenuExportOptions,
        ...exportMenuOptions,
        notion: false,
        yuque: false,
        joplin: false,
        siyuan: false
      }
    }),
    [confirmDeleteMessage, enableDeveloperMode, exportMenuOptions]
  )
}
