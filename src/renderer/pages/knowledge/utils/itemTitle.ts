import { getKnowledgeItemDisplayTitle, type KnowledgeItemTitleSource } from '@shared/data/types/knowledge'
export function getKnowledgeDisplayTitle(item: KnowledgeItemTitleSource): string {
  // Native snapshots use UUID filenames; the source retains the user's title.
  return getKnowledgeItemDisplayTitle({ ...item, data: { ...item.data, relativePath: undefined } })
}
