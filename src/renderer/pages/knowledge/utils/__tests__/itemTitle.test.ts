import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeItemTitleSource } from '@shared/data/types/knowledge'

import { getKnowledgeDisplayTitle } from '../itemTitle'

const runtime = vi.hoisted(() => ({ isEvoStack: false }))
vi.mock('@renderer/utils/platform', () => ({
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))

beforeEach(() => {
  runtime.isEvoStack = false
})

describe('knowledge display titles', () => {
  const snapshot = '019d0f00-0000-7000-8000-000000000001.md'
  const note: KnowledgeItemTitleSource = {
    type: 'note',
    data: { source: '  柠檬协议\n第二行内容', relativePath: snapshot, content: '# Note body' }
  }

  it('shows the native user title while retaining its managed snapshot path', () => {
    runtime.isEvoStack = true
    expect(getKnowledgeDisplayTitle(note)).toBe('柠檬协议')
    expect(note.data.relativePath).toBe(snapshot)
  })

  it('retains Electron deduplicated snapshot titles', () => {
    expect(getKnowledgeDisplayTitle({ ...note, data: { ...note.data, relativePath: '柠檬协议_2.md' } })).toBe(
      '柠檬协议_2'
    )
  })

  it('uses original native filenames and URLs instead of UUID snapshots', () => {
    runtime.isEvoStack = true
    expect(
      getKnowledgeDisplayTitle({
        type: 'file',
        data: { source: 'C:\\picked\\fixture-import.txt', relativePath: snapshot }
      })
    ).toBe('fixture-import.txt')
    expect(
      getKnowledgeDisplayTitle({
        type: 'url',
        data: { source: 'Web source', url: 'https://example.com/', relativePath: snapshot }
      })
    ).toBe('https://example.com/')
  })
})
