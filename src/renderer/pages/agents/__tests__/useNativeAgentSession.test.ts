import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useNativeAgentSession } from '../useNativeAgentSession'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  refresh: vi.fn().mockResolvedValue([]),
  cache: new Map<string, unknown>(),
  projection: { view: null },
  rows: [],
  pages: []
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: mocks.request } }))
vi.mock('@data/CacheService', () => ({
  cacheService: {
    get: (key: string) => mocks.cache.get(key),
    set: (key: string, value: unknown) => mocks.cache.set(key, value)
  }
}))
vi.mock('@renderer/services/aiTransport', () => ({
  messageProjectionService: { subscribe: () => () => {}, getSnapshot: () => mocks.projection }
}))
vi.mock('@renderer/data/hooks/useDataApi', () => ({
  useDataChange: vi.fn(),
  useInfiniteFlatItems: () => mocks.rows,
  useInfiniteQuery: () => ({
    pages: mocks.pages,
    refresh: mocks.refresh,
    isLoading: false,
    isRefreshing: false,
    hasNext: false,
    loadNext: vi.fn()
  })
}))

describe('native work commands', () => {
  beforeEach(() => {
    mocks.request.mockReset()
    mocks.cache.clear()
    mocks.refresh.mockClear()
  })

  it('retries an uncertain IPC result with the same durable request id and never replays automatically', async () => {
    mocks.request
      .mockRejectedValueOnce(new Error('IPC timeout'))
      .mockResolvedValueOnce({ mode: 'started', reservedMessages: [] })
    const { result } = renderHook(() => useNativeAgentSession('session-a'))
    await act(async () => {
      expect(await result.current.send('Build a report')).toBe(false)
    })
    expect(result.current.error).toBe('IPC timeout')
    expect(mocks.request).toHaveBeenCalledTimes(1)
    await act(async () => {
      expect(await result.current.send('Build a report')).toBe(true)
    })
    const first = mocks.request.mock.calls[0][1]
    const retry = mocks.request.mock.calls[1][1]
    expect(first.requestId).toBe(retry.requestId)
    expect(first.topicId).toBe('agent-session:session-a')
    expect(first.userMessageParts).toEqual([{ type: 'text', text: 'Build a report' }])
  })

  it('binds approval decisions and cancellation to the owning session', async () => {
    mocks.request.mockResolvedValue({ ok: true })
    const { result } = renderHook(() => useNativeAgentSession('session-b'))
    await act(async () => {
      await result.current.respond('approval-id', 'message-id', false)
    })
    expect(mocks.request).toHaveBeenCalledWith('ai.tool.respond_approval', {
      approvalId: 'approval-id',
      approved: false,
      topicId: 'agent-session:session-b',
      anchorId: 'message-id',
      reason: '用户拒绝本次操作'
    })
    await act(async () => {
      await result.current.stop()
    })
    expect(mocks.request).toHaveBeenCalledWith('ai.stream.abort', { topicId: 'agent-session:session-b' })
  })

  it('keeps an undelivered approval as an error instead of claiming success', async () => {
    mocks.request.mockResolvedValue({ ok: false, reason: 'undelivered' })
    const { result } = renderHook(() => useNativeAgentSession('session-c'))
    await expect(result.current.respond('approval-id', 'message-id', true)).rejects.toThrow('审批已失效')
  })
})
