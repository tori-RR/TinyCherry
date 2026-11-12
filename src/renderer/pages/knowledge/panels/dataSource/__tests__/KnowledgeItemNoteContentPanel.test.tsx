import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PosixRelativeFilePath } from '@shared/utils/file'

import KnowledgeItemNoteContentPanel from '../KnowledgeItemNoteContentPanel'
import { createNoteItem } from './testUtils'

const mockUseQuery = vi.fn()
const runtime = vi.hoisted(() => ({ isEvoStack: false }))

vi.mock('@renderer/utils/platform', () => ({
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))

vi.mock('@data/hooks/useDataApi', () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args)
}))

vi.mock('@renderer/utils/time', () => ({
  formatRelativeTime: () => '刚刚'
}))

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined
  },
  useTranslation: () => ({
    i18n: {
      language: 'zh-CN'
    },
    t: (key: string) =>
      (
        ({
          'common.back': '返回',
          'common.loading': '加载中',
          'knowledge.data_source.actions.preview_source': '预览原文',
          'knowledge.data_source.filters.note': '笔记'
        }) as Record<string, string>
      )[key] ?? key
  })
}))

describe('KnowledgeItemNoteContentPanel', () => {
  beforeEach(() => {
    runtime.isEvoStack = false
    vi.clearAllMocks()
    mockUseQuery.mockReturnValue({
      data: createNoteItem({ id: 'note-1', content: '第一行标题\n第二行完整正文内容' }),
      isLoading: false,
      error: undefined
    })
  })

  it('shows the native user title while keeping its UUID snapshot and full note body', () => {
    runtime.isEvoStack = true
    const note = createNoteItem({ id: 'note-1', source: '柠檬协议', content: '完整笔记正文' })
    const snapshot = '019d0f00-0000-7000-8000-000000000001.md' as PosixRelativeFilePath
    note.data.relativePath = snapshot
    mockUseQuery.mockReturnValue({ data: note, isLoading: false, error: undefined })

    render(<KnowledgeItemNoteContentPanel itemId="note-1" onBack={vi.fn()} />)

    expect(screen.getByText('柠檬协议')).toBeInTheDocument()
    expect(screen.getByText('完整笔记正文')).toBeInTheDocument()
    expect(screen.queryByText(snapshot.replace(/\.md$/, ''))).not.toBeInTheDocument()
    expect(note.data.relativePath).toBe(snapshot)
  })

  it("renders the note's full original content and fetches the item by id", () => {
    render(<KnowledgeItemNoteContentPanel itemId="note-1" onBack={vi.fn()} />)

    expect(mockUseQuery).toHaveBeenCalledWith('/knowledge-items/:id', {
      params: { id: 'note-1' },
      enabled: true
    })
    // The whole body is present and untruncated — the reason a note needed its own view. The
    // header title only carries the first line, so matching the second line targets the body.
    expect(screen.getByText('第二行完整正文内容', { exact: false })).toHaveTextContent('第一行标题')
  })

  it('invokes onBack when the back control is pressed', () => {
    const onBack = vi.fn()
    render(<KnowledgeItemNoteContentPanel itemId="note-1" onBack={onBack} />)

    fireEvent.click(screen.getByRole('button', { name: '返回' }))

    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('shows a loading state while the item is being fetched', () => {
    mockUseQuery.mockReturnValue({ data: undefined, isLoading: true, error: undefined })

    render(<KnowledgeItemNoteContentPanel itemId="note-1" onBack={vi.fn()} />)

    // Both the placeholder title and the body render the loading label while the item resolves.
    expect(screen.getAllByText('加载中').length).toBeGreaterThan(0)
  })
})
