import { act, render, screen, waitFor } from '@testing-library/react'
import { useCallback, useMemo } from 'react'
import { SWRConfig } from 'swr'
import useSWRInfinite from 'swr/infinite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ExecutionFinishEvent } from '@renderer/hooks/useExecutionOverlay'
import type { Topic } from '@renderer/types/topic'
import { sharedMessageToUIMessage } from '@renderer/utils/message/messageProjection'
import type { ActiveExecution, AiStreamOpenResponse } from '@shared/ai/transport'
import type { BranchMessagesResponse, CherryUIMessage, Message } from '@shared/data/types/message'

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  executions: [] as ActiveExecution[],
  liveAssistants: [] as CherryUIMessage[],
  dispose: vi.fn(),
  onFinish: undefined as ((executionId: string, event: ExecutionFinishEvent) => void) | undefined
}))

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: (...args: unknown[]) => mocks.open(...args) } }))
vi.mock('@renderer/hooks/useChatWithHistory', () => ({
  useChatWithHistory: () => ({
    regenerate: vi.fn(),
    stop: vi.fn(),
    setMessages: vi.fn(),
    activeExecutions: []
  })
}))
vi.mock('@renderer/hooks/useConversationErrorToasts', () => ({
  useConversationErrorToasts: () => ({ track: vi.fn(), onFinish: vi.fn() })
}))
vi.mock('@renderer/hooks/useExecutionOverlay', () => ({
  useExecutionOverlay: (
    _topicId: string,
    executions: ActiveExecution[],
    _messages: CherryUIMessage[],
    options: { onFinish?: (executionId: string, event: ExecutionFinishEvent) => void }
  ) => {
    mocks.executions = executions
    mocks.onFinish = options.onFinish
    return { overlay: {}, liveAssistants: mocks.liveAssistants, disposeOverlay: mocks.dispose, reset: vi.fn() }
  }
}))
vi.mock('../hooks/useChatWriteActions', () => ({ useChatWriteActions: () => ({ actions: {} }) }))

import { useChatRuntimeState } from '../useChatRuntimeState'

const topicId = 'topic-late-open'
const messageId = '01a1c18c-ee19-71e9-8e09-b226b651ebec'
const completedText = '知识引用已收到，暗号为 EVO-KB-7319。'
let serverMessage: Message
let latestRuntime: ReturnType<typeof useChatRuntimeState>
const branchState = vi.fn()

function message(status: Message['status'], text = ''): Message {
  return {
    id: messageId,
    topicId,
    parentId: 'root',
    role: 'assistant',
    data: { parts: text ? [{ type: 'text', text }] : [] },
    searchableText: text,
    status,
    siblingsGroupId: 0,
    modelId: 'provider::model',
    createdAt: '2026-11-10T01:00:00.000Z',
    updatedAt: '2026-11-10T01:00:00.000Z'
  }
}

function RuntimeHost() {
  const topic = useMemo(() => ({ id: topicId }) as Topic, [])
  const { data, mutate } = useSWRInfinite<BranchMessagesResponse>(
    () => ['reservation-test', topicId],
    async () => ({
      items: [{ message: structuredClone(serverMessage) }],
      activeNodeId: messageId,
      assistantId: null,
      rootId: 'root',
      nextCursor: undefined
    }),
    { dedupingInterval: 0 }
  )
  const messages = useMemo(
    () => data?.flatMap((page) => page.items.map((item) => sharedMessageToUIMessage(item.message))) ?? [],
    [data]
  )
  const refresh = useCallback(async () => {
    const pages = await mutate()
    return pages?.flatMap((page) => page.items.map((item) => sharedMessageToUIMessage(item.message))) ?? []
  }, [mutate])
  latestRuntime = useChatRuntimeState({
    topic,
    isHistoryLoading: !data,
    initialMessages: messages,
    uiMessages: messages,
    refresh,
    activeNodeId: data?.[0].activeNodeId ?? null,
    messagesCacheMutate: mutate,
    onBranchLiveStateChange: branchState
  })
  return (
    <>
      {latestRuntime.messages.map((item) => (
        <article key={item.id} data-testid="reply" data-status={item.metadata?.status}>
          {item.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')}
        </article>
      ))}
    </>
  )
}

function renderRuntime() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}>
      <RuntimeHost />
    </SWRConfig>
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ack(attemptId: number): AiStreamOpenResponse {
  return {
    mode: 'started',
    preserveActiveNode: true,
    activeExecutions: [{ executionId: 'provider::model', anchorMessageId: messageId, attemptId, seedFromEmpty: true }],
    reservedMessages: [sharedMessageToUIMessage(message('pending'))]
  }
}

describe('accepted reservation reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.executions = []
    mocks.liveAssistants = []
    mocks.dispose.mockImplementation(() => {
      mocks.liveAssistants = []
    })
    serverMessage = message('success', completedText)
  })

  it('keeps a fast persisted reply visible when its empty open reservation arrives last', async () => {
    const open = deferred<AiStreamOpenResponse>()
    mocks.open.mockReturnValueOnce(open.promise)
    renderRuntime()
    await screen.findByText(completedText)
    let sent!: Promise<boolean>
    act(() => {
      sent = latestRuntime.sendMessage('暗号是什么？')
    })
    await waitFor(() => expect(mocks.open).toHaveBeenCalled())
    // The terminal refresh has already delivered success before the open RPC resolves.
    await act(async () => {
      open.resolve(ack(1))
      await sent
    })
    expect(screen.getByTestId('reply')).toHaveTextContent(completedText)
    expect(screen.getByTestId('reply')).toHaveAttribute('data-status', 'success')
    expect(mocks.executions).toEqual([])
    expect(branchState).toHaveBeenLastCalledWith(null)
  })

  it('keeps a genuine same-message retry pending when the authoritative DB still says pending', async () => {
    mocks.open.mockImplementationOnce(async () => {
      serverMessage = message('pending')
      return ack(2)
    })
    renderRuntime()
    await screen.findByText(completedText)
    await act(async () => {
      await latestRuntime.sendMessage('retry')
    })
    expect(screen.getByTestId('reply')).toHaveAttribute('data-status', 'pending')
    expect(screen.getByTestId('reply')).toBeEmptyDOMElement()
    expect(mocks.executions).toEqual([expect.objectContaining({ attemptId: 2, seedFromEmpty: true })])
  })

  it('hands off a late final reader after the topic terminal was already observed', async () => {
    serverMessage = message('pending')
    mocks.open.mockResolvedValueOnce(ack(3))
    renderRuntime()
    await screen.findByTestId('reply')
    await act(async () => {
      await latestRuntime.sendMessage('fast retry')
    })

    serverMessage = message('success', completedText)
    // Live chunks retain the pending metadata of their reservation. Terminal DB metadata wins
    // only after the last reader also relinquishes its retained snapshot.
    const liveMessage = { ...sharedMessageToUIMessage(serverMessage), metadata: { status: 'pending' as const } }
    mocks.liveAssistants = [liveMessage]
    act(() => {
      mocks.onFinish?.('provider::model', {
        attemptId: 3,
        message: liveMessage,
        isAbort: false,
        isError: false
      })
    })
    await waitFor(() => expect(screen.getByTestId('reply')).toHaveAttribute('data-status', 'success'))
    expect(screen.getByTestId('reply')).toHaveTextContent(completedText)
    expect(mocks.dispose).toHaveBeenCalledWith(messageId)
    expect(mocks.executions).toEqual([])
  })
})
