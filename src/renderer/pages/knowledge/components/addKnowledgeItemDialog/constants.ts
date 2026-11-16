import type { KnowledgeItemType } from '@shared/data/types/knowledge'

import type { SourceTabDefinition } from './types'
export const DEFAULT_SOURCE_TYPE: KnowledgeItemType = 'file'
// Curated, user-facing format list for the upload hint. Deliberately not derived from
// `knowledgeSupportedFileExts`: that list carries the internal `.draftsexport` identifier and
// redundant synonyms (markdown/md/mdx, html/htm) that read as noise in the UI.
export const KNOWLEDGE_SUPPORTED_FILE_TYPES = 'MD, TXT, CSV, JSON, HTML'
const sourceTypes: ReadonlyArray<SourceTabDefinition> = [
  { value: 'file', labelKey: 'knowledge.data_source.add_dialog.sources.file' },
  { value: 'note', labelKey: 'knowledge.data_source.add_dialog.sources.note' },
  { value: 'directory', labelKey: 'knowledge.data_source.add_dialog.sources.directory' },
  { value: 'url', labelKey: 'knowledge.data_source.add_dialog.sources.url' }
]
export const KNOWLEDGE_DATA_SOURCE_TYPES = sourceTypes.filter((source) => source.value !== 'directory')
