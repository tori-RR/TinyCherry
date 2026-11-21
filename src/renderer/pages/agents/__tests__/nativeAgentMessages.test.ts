import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import type { CherryUIMessage } from '@shared/data/types/message'

import {
  acknowledgeNativeSubmission,
  mergeNativeAgentMessages,
  nativeSubmissionId,
  readNativeAgentDraft,
  writeNativeAgentDraft
} from '../nativeAgentMessages'

const cache = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@data/CacheService', () => ({
  cacheService: { get: (key: string) => cache.get(key), set: (key: string, value: unknown) => cache.set(key, value) }
}))

function row(id: string, role: 'user' | 'assistant', text: string, date: string): AgentSessionMessageEntity {
  return {
    id,
    sessionId: 'session',
    role,
    data: { parts: [{ type: 'text', text }] },
    status: 'success',
    modelId: null,
    messageSnapshot: null,
    stats: null,
    searchableText: text,
    runtimeResumeToken: null,
    createdAt: date,
    updatedAt: date
  }
}

describe('native work submission reconciliation', () => {
  beforeEach(() => cache.clear())

  it('reuses an uncertain submission id after a view remount, but makes a new id after acknowledgement', () => {
    writeNativeAgentDraft('a', '  Create a report  ')
    const first = nativeSubmissionId('a', 'Create a report')
    expect(nativeSubmissionId('a', 'Create a report')).toBe(first)
    expect(nativeSubmissionId('b', 'Create a report')).not.toBe(first)
    acknowledgeNativeSubmission('a', first)
    expect(readNativeAgentDraft('a').text).toBe('')
    expect(nativeSubmissionId('a', 'Create a report')).not.toBe(first)
  })

  it('does not erase a newer draft when an old submission resolves', () => {
    writeNativeAgentDraft('a', 'first task')
    const first = nativeSubmissionId('a', 'first task')
    writeNativeAgentDraft('a', 'another task')
    acknowledgeNativeSubmission('a', first)
    expect(readNativeAgentDraft('a').text).toBe('another task')
  })

  it('keeps durable messages ahead of stale reservations and overlays the live reply without duplicating it', () => {
    const history = [
      row('a1', 'assistant', 'saved', '2026-01-01T00:00:02Z'),
      row('u1', 'user', 'request', '2026-01-01T00:00:01Z')
    ]
    const reservations: CherryUIMessage[] = [
      { id: 'a1', role: 'assistant', parts: [], metadata: { status: 'pending' } }
    ]
    expect(mergeNativeAgentMessages(history, reservations, [])[1].parts).toEqual([{ type: 'text', text: 'saved' }])
    const result = mergeNativeAgentMessages(history, reservations, [
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'live' }], metadata: { status: 'pending' } }
    ])
    expect(result.map((message) => message.id)).toEqual(['u1', 'a1'])
    expect(result[1].parts).toEqual([{ type: 'text', text: 'live' }])
    expect(result[1].metadata?.createdAt).toBe('2026-01-01T00:00:02Z')
  })
})
