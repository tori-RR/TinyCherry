import type { NoteDraft, NoteItem, NoteSourceMode } from '../types'
import NoteCreateContent from './NoteCreateContent'
interface NoteSourceContentProps {
  mode: NoteSourceMode
  onModeChange: (mode: NoteSourceMode) => void
  selectedNotes: NoteItem[]
  onToggle: (note: NoteItem) => void
  onSelectionChange: (notes: NoteItem[]) => void
  draft: NoteDraft
  onDraftTitleChange: (title: string) => void
  onDraftContentChange: (content: string) => void
}
const NoteSourceContent = ({ draft, onDraftTitleChange, onDraftContentChange }: NoteSourceContentProps) => (
  <NoteCreateContent draft={draft} onTitleChange={onDraftTitleChange} onContentChange={onDraftContentChange} />
)
export default NoteSourceContent
