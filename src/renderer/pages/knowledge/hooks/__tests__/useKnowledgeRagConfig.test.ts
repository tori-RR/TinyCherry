import { mockUseMutation, MockUseDataApiUtils } from '@test-mocks/renderer/useDataApi'
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { KnowledgeBase } from '@shared/data/types/knowledge'

import { useKnowledgeRagConfig } from '../useKnowledgeRagConfig'

const mockTrigger = vi.fn()
const mockLogger = vi.hoisted(() => ({ error: vi.fn() }))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => mockLogger }
}))

const createKnowledgeBase = (): KnowledgeBase => ({
  orderKey: 'a0',
  id: 'base-1',
  name: 'Text knowledge',
  groupId: null,
  dimensions: null,
  embeddingModelId: null,
  rerankModelId: undefined,
  fileProcessorId: undefined,
  chunkSize: 1024,
  chunkOverlap: 200,
  chunkStrategy: 'structured',
  chunkSeparator: '\\n\\n',
  threshold: 0.2,
  documentCount: 6,
  status: 'completed',
  error: null,
  createdAt: '2026-11-10T01:00:00Z',
  updatedAt: '2026-11-10T01:00:00Z'
})

describe('useKnowledgeRagConfig', () => {
  beforeEach(() => {
    MockUseDataApiUtils.resetMocks()
    vi.clearAllMocks()
    mockUseMutation.mockReturnValue({ trigger: mockTrigger, isLoading: false, error: undefined })
  })

  it('keeps BM25 configuration independent of retired OCR and local-model services', () => {
    const { result } = renderHook(() => useKnowledgeRagConfig(createKnowledgeBase()))

    expect(result.current.initialValues.embeddingModelId).toBeNull()
    expect(result.current.initialValues.rerankModelId).toBeNull()
    expect(result.current.fileProcessorOptions).toEqual([])
  })

  it('persists changed chunking and retrieval settings without adding model or OCR selections', async () => {
    const { result } = renderHook(() => useKnowledgeRagConfig(createKnowledgeBase()))
    await act(async () => {
      await result.current.save({
        ...result.current.initialValues,
        chunkSize: '1536',
        chunkOverlap: '256',
        documentCount: 10
      })
    })

    expect(mockTrigger).toHaveBeenCalledWith({
      params: { id: 'base-1' },
      body: { chunkSize: 1536, chunkOverlap: 256, documentCount: 10 }
    })
  })

  it('propagates save errors so a rejected settings update does not look successful', async () => {
    const error = new Error('save failed')
    mockTrigger.mockRejectedValueOnce(error)
    const { result } = renderHook(() => useKnowledgeRagConfig(createKnowledgeBase()))

    await expect(result.current.save(result.current.initialValues)).rejects.toBe(error)
    expect(mockLogger.error).toHaveBeenCalledWith('Failed to update knowledge RAG config', error, {
      baseId: 'base-1',
      updates: {}
    })
  })
})
