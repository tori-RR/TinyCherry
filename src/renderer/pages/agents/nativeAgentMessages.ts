import { cacheService } from '@data/CacheService'
import type { AgentSessionMessageEntity } from '@shared/data/api/schemas/agentSessionMessages'
import type { CacheAgentComposerDraft } from '@shared/data/cache/cacheValueTypes'
import type { CherryUIMessage } from '@shared/data/types/message'

const DRAFT_TTL = 24 * 60 * 60 * 1000
const draftKey = (sessionId: string) => `agent.composer_draft.${sessionId}` as const

export function readNativeAgentDraft(sessionId: string): CacheAgentComposerDraft {
  return (
    cacheService.get(draftKey(sessionId)) ?? {
      text: '',
      tokens: [],
      files: [],
      knowledgeBaseIds: [],
      workspaceKey: '',
      agentId: ''
    }
  )
}

export function writeNativeAgentDraft(sessionId: string, text: string) {
  cacheService.set(draftKey(sessionId), { ...readNativeAgentDraft(sessionId), text }, DRAFT_TTL)
}

export function nativeSubmissionId(sessionId: string, text: string): string {
  const draft = readNativeAgentDraft(sessionId)
  if (draft.nativeSubmission?.text === text) return draft.nativeSubmission.requestId
  const requestId = crypto.randomUUID()
  cacheService.set(draftKey(sessionId), { ...draft, nativeSubmission: { requestId, text } }, DRAFT_TTL)
  return requestId
}

export function acknowledgeNativeSubmission(sessionId: string, requestId: string) {
  const draft = readNativeAgentDraft(sessionId)
  if (draft.nativeSubmission?.requestId !== requestId) return
  const { nativeSubmission, ...remaining } = draft
  cacheService.set(
    draftKey(sessionId),
    { ...remaining, text: draft.text.trim() === nativeSubmission.text ? '' : draft.text },
    DRAFT_TTL
  )
}

export function toNativeAgentUIMessage(row: AgentSessionMessageEntity): CherryUIMessage {
  return {
    id: row.id,
    role: row.role,
    parts: row.data.parts ?? [],
    metadata: {
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      modelId: row.modelId ?? undefined,
      messageSnapshot: row.messageSnapshot ?? undefined,
      stats: row.stats ?? undefined
    }
  }
}

/** Persisted history owns ordering; reservations and the projection update a message by its stable id. */
export function mergeNativeAgentMessages(
  newestFirstHistory: readonly AgentSessionMessageEntity[],
  reservations: readonly CherryUIMessage[],
  projection: readonly CherryUIMessage[]
): CherryUIMessage[] {
  const messages = new Map<string, CherryUIMessage>()
  for (const row of [...newestFirstHistory].reverse()) messages.set(row.id, toNativeAgentUIMessage(row))
  for (const message of reservations) {
    if (!messages.has(message.id)) messages.set(message.id, message)
  }
  for (const message of projection) {
    const previous = messages.get(message.id)
    messages.set(message.id, { ...message, metadata: { ...previous?.metadata, ...message.metadata } })
  }
  return [...messages.values()].sort((a, b) => (a.metadata?.createdAt ?? '').localeCompare(b.metadata?.createdAt ?? ''))
}
