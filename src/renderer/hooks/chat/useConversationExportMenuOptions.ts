import { useMultiplePreferences } from '@data/hooks/usePreference'

const CONVERSATION_EXPORT_MENU_PREFERENCE_KEYS = {
  docx: 'data.export.menus.docx',
  image: 'data.export.menus.image',
  markdown: 'data.export.menus.markdown',
  markdown_reason: 'data.export.menus.markdown_reason',
  obsidian: 'data.export.menus.obsidian',
  plain_text: 'data.export.menus.plain_text'
} as const

export function useConversationExportMenuOptions() {
  const [exportMenuOptions] = useMultiplePreferences(CONVERSATION_EXPORT_MENU_PREFERENCE_KEYS)
  return { ...exportMenuOptions, notion: false, yuque: false, joplin: false, siyuan: false }
}
