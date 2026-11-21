import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'

import { useDataChange, useInfiniteFlatItems, useInfiniteQuery } from '@renderer/data/hooks/useDataApi'
import { ipcApi } from '@renderer/ipc'
import { messageProjectionService } from '@renderer/services/aiTransport'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { getErrorMessage } from '@renderer/utils/error'
import type { CherryUIMessage } from '@shared/data/types/message'

import { acknowledgeNativeSubmission, mergeNativeAgentMessages, nativeSubmissionId } from './nativeAgentMessages'

/** Native work uses the same durable-message / live-projection boundary as chat. */
export function useNativeAgentSession(sessionId: string) {
  const topicId = buildAgentSessionTopicId(sessionId)
  const target = useMemo(() => ({ kind: 'topic' as const, topicId }), [topicId])
  const projection = useSyncExternalStore(
    useCallback((listener) => messageProjectionService.subscribe(target, listener), [target]),
    useCallback(() => messageProjectionService.getSnapshot(target), [target])
  )
  const history = useInfiniteQuery('/agent-sessions/:sessionId/messages', {
    params: { sessionId },
    limit: 50,
    swrOptions: { keepPreviousData: false, revalidateAll: true, revalidateFirstPage: false }
  })
  const rows = useInfiniteFlatItems(history.pages)
  const [reservations, setReservations] = useState<CherryUIMessage[]>([])
  const [isSubmitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const inFlight = useRef(false)
  const refreshRef = useRef(history.refresh)
  refreshRef.current = history.refresh
  const isRunning =
    projection.view?.kind === 'topic' && projection.view.executions.some((run) => run.status === 'active')
  const messages = useMemo(
    () => mergeNativeAgentMessages(rows, reservations, projection.view?.messages ?? []),
    [rows, reservations, projection.view]
  )

  useDataChange('/agent-sessions/:sessionId/messages', () => {
    void refreshRef.current().catch(() => {})
  })
  // A terminal baseline also covers a reply that finished while this view was unmounted.
  const terminalKey =
    projection.view?.kind === 'topic'
      ? projection.view.executions
          .filter((run) => run.status !== 'active')
          .map((run) => `${run.attemptId}:${run.status}`)
          .join('|')
      : ''
  useEffect(() => {
    if (terminalKey) void refreshRef.current().catch(() => {})
  }, [terminalKey])

  const send = useCallback(
    async (rawText: string): Promise<boolean> => {
      const text = rawText.trim()
      if (!text || inFlight.current || isRunning) return false
      inFlight.current = true
      setSubmitting(true)
      setError(undefined)
      const requestId = nativeSubmissionId(sessionId, text)
      try {
        const response = await ipcApi.request('ai.stream.open', {
          topicId,
          requestId,
          trigger: 'submit-message',
          userMessageParts: [{ type: 'text', text }]
        })
        if (response.mode === 'blocked') {
          throw new Error('message' in response ? response.message : '当前暂停接受任务，请稍后重试。')
        }
        setReservations((previous) => {
          const merged = new Map(previous.map((message) => [message.id, message]))
          for (const message of response.reservedMessages ?? []) merged.set(message.id, message)
          return [...merged.values()]
        })
        acknowledgeNativeSubmission(sessionId, requestId)
        void refreshRef.current().catch(() => {})
        return true
      } catch (cause) {
        setError(getErrorMessage(cause))
        return false
      } finally {
        inFlight.current = false
        setSubmitting(false)
      }
    },
    [isRunning, sessionId, topicId]
  )

  const stop = useCallback(async () => {
    try {
      await ipcApi.request('ai.stream.abort', { topicId })
      void refreshRef.current().catch(() => {})
    } catch (cause) {
      setError(getErrorMessage(cause))
    }
  }, [topicId])

  const respond = useCallback(
    async (approvalId: string, messageId: string, approved: boolean) => {
      const response = await ipcApi.request('ai.tool.respond_approval', {
        approvalId,
        approved,
        topicId,
        anchorId: messageId,
        ...(approved ? {} : { reason: '用户拒绝本次操作' })
      })
      if (!response.ok) throw new Error('此审批已失效或未送达，请刷新任务状态。')
      void refreshRef.current().catch(() => {})
    },
    [topicId]
  )

  return {
    messages,
    isRunning,
    isSubmitting,
    error: error ?? history.error?.message ?? projection.error,
    isLoading: history.isLoading,
    hasOlder: history.hasNext,
    isLoadingOlder: history.isRefreshing,
    loadOlder: history.loadNext,
    refresh: history.refresh,
    send,
    stop,
    respond
  }
}
