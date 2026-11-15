import { isEvoStack } from '@renderer/utils/platform'
import type { KnowledgeItemType } from '@shared/data/types/knowledge'

import type { SourceTabDefinition } from './types'

export const DEFAULT_SOURCE_TYPE: KnowledgeItemType = 'file'

// Curated, user-facing format list for the upload hint. Deliberately not derived from
// `knowledgeSupportedFileExts`: that list carries the internal `.draftsexport` identifier and
// redundant synonyms (markdown/md/mdx, html/htm) that read as noise in the UI.
export const KNOWLEDGE_SUPPORTED_FILE_TYPES = isEvoStack
  ? 'MD, TXT, CSV, JSON, HTML'
  : 'PDF, DOCX, DOC, PPTX, PPT, XLSX, XLS, MD, TXT, CSV, HTML, EPUB'

const sourceTypes: ReadonlyArray<SourceTabDefinition> = [
  { value: 'file', labelKey: 'knowledge.data_source.add_dialog.sources.file' },
  { value: 'note', labelKey: 'knowledge.data_source.add_dialog.sources.note' },
  { value: 'directory', labelKey: 'knowledge.data_source.add_dialog.sources.directory' },
  { value: 'url', labelKey: 'knowledge.data_source.add_dialog.sources.url' }
]

export const KNOWLEDGE_DATA_SOURCE_TYPES = isEvoStack
  ? sourceTypes.filter((source) => source.value !== 'directory')
  : sourceTypes
