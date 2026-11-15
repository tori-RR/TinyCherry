import { act, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TabsContext, type TabsContextValue } from '@renderer/hooks/tab'
import type * as PlatformModule from '@renderer/utils/platform'

import { ConversationNotificationRuntime } from '../ConversationNotificationRuntime'

const mocks = vi.hoisted(() => ({
  isEvoStack: false,
  ipcHandlers: new Map<string, (payload: any) => void>(),
  ipcRequest: vi.fn(() => Promise.resolve()),
  loggerError: vi.fn(),
  toastClose: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastInfo: vi.fn(),
  toastError: vi.fn()
}))
vi.mock('@renderer/utils/platform', async (original) => ({
  ...(await original<typeof PlatformModule>()),
  get isEvoStack() {
    return mocks.isEvoStack
  }
}))

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: mocks.loggerError }) }
}))
vi.mock('@renderer/ipc', () => ({
  ipcApi: { request: mocks.ipcRequest },
  useIpcOn: (event: string, handler: (payload: any) => void) => mocks.ipcHandlers.set(event, handler)
}))
vi.mock('@renderer/services/toast', () => ({
  toast: {
    closeToast: mocks.toastClose,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    info: mocks.toastInfo,
    error: mocks.toastError
  }
}))

function tabsContext(activeTab?: TabsContextValue['activeTab']): TabsContextValue {
  return {
    tabs: activeTab ? [activeTab] : [],
    activeTabId: activeTab?.id ?? '',
    activeTab,
    isLoading: false,
    addTab: vi.fn(),
    closeTab: vi.fn(),
    closeTabs: vi.fn(),
    setActiveTab: vi.fn(),
    updateTab: vi.fn(),
    openTab: vi.fn(() => 'new-tab'),
    pinTab: vi.fn(),
    unpinTab: vi.fn(),
    reorderTabs: vi.fn(),
    detachTab: vi.fn(),
    attachTab: vi.fn()
  }
}

function renderRuntime(context: TabsContextValue): void {
  const wrapper = ({ children }: { children: ReactNode }) => <TabsContext value={context}>{children}</TabsContext>
  render(<ConversationNotificationRuntime />, { wrapper })
}

function conversationNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-request:approval-1',
    kind: 'approval-request',
    type: 'warning',
    title: 'Research notes',
    message: 'Here is the final answer.',
    conversationName: 'Research notes',
    timestamp: 100,
    actionKey: 'conversation.open',
    meta: { conversationType: 'assistant', conversationId: 'topic-2' },
    source: 'assistant',
    ...overrides
  }
}

function emitNotification(payload = conversationNotification()): void {
  const handler = mocks.ipcHandlers.get('notification.conversation')
  if (!handler) throw new Error('Missing conversation-notification handler')
  act(() => handler(payload))
}

describe('ConversationNotificationRuntime', () => {
  beforeEach(() => {
    mocks.isEvoStack = false
    mocks.ipcHandlers.clear()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([
    { native: true, focused: true, visibility: 'visible', sameConversation: true, reads: 1 },
    { native: true, focused: false, visibility: 'visible', sameConversation: true, reads: 0 },
    { native: true, focused: true, visibility: 'hidden', sameConversation: true, reads: 0 },
    { native: true, focused: true, visibility: 'visible', sameConversation: false, reads: 0 },
    { native: false, focused: true, visibility: 'visible', sameConversation: true, reads: 0 }
  ] as const)(
    'acknowledges a newly presented native result only while its conversation is being viewed ($native/$focused/$visibility/$sameConversation)',
    async ({ native, focused, visibility, sameConversation, reads }) => {
      mocks.isEvoStack = native
      vi.spyOn(document, 'hasFocus').mockReturnValue(focused)
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(visibility)
      renderRuntime(tabsContext({ id: 'active', type: 'route', url: '/app/chat?topicId=topic-1', title: 'Current' }))
      vi.mocked(mockDataApiService.post).mockClear()
      await act(async () =>
        mocks.ipcHandlers.get('notification.present')?.({
          id: 'result-1',
          category: 'system',
          kind: 'task-result',
          title: 'Done',
          message: 'Finished',
          target: {
            kind: 'conversation',
            conversationType: 'assistant',
            conversationId: sameConversation ? 'topic-1' : 'other-topic'
          }
        })
      )
      expect(mockDataApiService.post).toHaveBeenCalledTimes(reads)
      if (reads)
        expect(mockDataApiService.post).toHaveBeenCalledWith('/notifications/read-conversation', {
          body: { conversationType: 'assistant', conversationId: 'topic-1' }
        })
      expect(mocks.toastSuccess).toHaveBeenCalledTimes(sameConversation ? 0 : 1)
    }
  )

  it.each([
    ['assistant', '/app/chat?topicId='],
    ['agent', '/app/agents?sessionId=']
  ] as const)(
    'reads only the visible active %s conversation on entry and window return',
    async (conversationType, prefix) => {
      let focused = false
      vi.spyOn(document, 'hasFocus').mockImplementation(() => focused)
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      const view = (url: string) => (
        <TabsContext value={tabsContext({ id: 'current', type: 'route', url, title: 'Current' })}>
          <ConversationNotificationRuntime />
        </TabsContext>
      )
      const rendered = render(view(`${prefix}first`))
      expect(mockDataApiService.post).not.toHaveBeenCalled()
      focused = true
      await act(() => window.dispatchEvent(new Event('focus')))
      expect(mockDataApiService.post).toHaveBeenLastCalledWith('/notifications/read-conversation', {
        body: { conversationType, conversationId: 'first' }
      })
      rendered.rerender(view(`${prefix}second`))
      expect(mockDataApiService.post).toHaveBeenLastCalledWith('/notifications/read-conversation', {
        body: { conversationType, conversationId: 'second' }
      })
      vi.mocked(mockDataApiService.post).mockClear()
      await act(() => window.dispatchEvent(new Event('focus')))
      expect(mockDataApiService.post).toHaveBeenCalledTimes(1)
      expect(mockDataApiService.post).toHaveBeenLastCalledWith('/notifications/read-conversation', {
        body: { conversationType, conversationId: 'second' }
      })
      rendered.rerender(view('/settings/notifications'))
      vi.mocked(mockDataApiService.post).mockClear()
      await act(() => window.dispatchEvent(new Event('focus')))
      expect(mockDataApiService.post).not.toHaveBeenCalled()
    }
  )

  it.each(['failed', 'interrupted'])('shows a %s result as an error with its snapshot identity', (status) => {
    renderRuntime(tabsContext())
    act(() =>
      mocks.ipcHandlers.get('notification.present')?.({
        id: 'result-1',
        kind: 'task-result',
        category: 'system',
        title: 'Task failed',
        message: 'Safe error',
        target: {
          kind: 'conversation',
          conversationType: 'agent',
          conversationId: 'session-1',
          result: { status, source: 'agent', name: 'Saved task', actor: { name: 'Saved agent', emoji: '🤖' } }
        }
      })
    )
    const options = mocks.toastError.mock.calls[0][0]
    render(
      <>
        {options.title}
        {options.description}
      </>
    )
    expect(screen.getByText('Saved agent')).toBeInTheDocument()
    expect(screen.getByText('Safe error')).toBeInTheDocument()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('presents task notifications without registering audio playback', () => {
    vi.stubGlobal(
      'AudioContext',
      class {
        constructor() {
          throw new Error('Audio unavailable')
        }
      }
    )
    renderRuntime(tabsContext())
    expect(mocks.ipcHandlers.has('notification.completion_sound')).toBe(false)
    act(() =>
      mocks.ipcHandlers.get('notification.present')?.({
        id: 'record-1',
        category: 'system',
        kind: 'task-completion',
        title: 'Done',
        message: 'Finished',
        target: null
      })
    )
    expect(mocks.loggerError).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).toHaveBeenCalledWith(expect.objectContaining({ key: 'record-1' }))
  })

  it('activates persisted notifications through the main process when their toast is clicked', async () => {
    renderRuntime(tabsContext())
    act(() =>
      mocks.ipcHandlers.get('notification.present')?.({
        id: 'record-1',
        category: 'system',
        kind: 'task-completion',
        title: 'Done',
        message: 'Seven tasks finished',
        target: { kind: 'conversation', conversationType: 'agent', conversationId: 'agent-1' }
      })
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'record-1', description: 'Seven tasks finished' })
    )
    await act(() => mocks.toastSuccess.mock.calls[0][0].onClick())
    expect(mocks.ipcRequest).toHaveBeenCalledWith('notification.activate', { id: 'record-1' })
  })

  it('bounds a long notification preview without breaking Unicode or its navigation action', async () => {
    renderRuntime(tabsContext())
    const title = 'Task '.repeat(30).trim()
    const message = '结果😀'.repeat(70)
    act(() =>
      mocks.ipcHandlers.get('notification.present')?.({
        id: 'long-record',
        category: 'system',
        kind: 'task-completion',
        title,
        message,
        target: null
      })
    )
    const shown = mocks.toastSuccess.mock.calls[0][0]
    render(
      <>
        {shown.title}
        {shown.description}
        {shown.icon}
      </>
    )
    expect(Array.from(screen.getByTitle(title).textContent ?? '')).toHaveLength(61)
    expect(Array.from(screen.getByTitle(message).textContent ?? '')).toHaveLength(120)
    expect(screen.getByTitle(message).textContent).not.toContain('…')
    expect(screen.getByTitle(message).textContent).not.toContain('\uFFFD')
    await act(() => shown.onClick())
    expect(mocks.ipcRequest).toHaveBeenCalledWith('notification.activate', { id: 'long-record' })
  })

  it('does not show a completion toast for the conversation already being viewed', () => {
    renderRuntime(tabsContext({ id: 'active', type: 'route', url: '/app/chat?topicId=topic-2', title: 'Current' }))
    act(() =>
      mocks.ipcHandlers.get('notification.present')?.({
        id: 'record-1',
        category: 'system',
        kind: 'task-completion',
        title: 'Done',
        message: 'Finished',
        target: { kind: 'conversation', conversationType: 'assistant', conversationId: 'topic-2' }
      })
    )
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
  })

  it('presents usage warnings without trying to open a conversation directly', async () => {
    renderRuntime(tabsContext())
    act(() =>
      mocks.ipcHandlers.get('notification.present')?.({
        id: 'budget-1',
        category: 'usage',
        kind: 'daily-budget',
        title: 'Budget',
        message: '80% used',
        target: { kind: 'settings', tab: 'usage' }
      })
    )
    expect(mocks.toastWarning).toHaveBeenCalledWith(expect.objectContaining({ description: '80% used' }))
    await act(() => mocks.toastWarning.mock.calls[0][0].onClick())
    expect(mocks.ipcRequest).toHaveBeenCalledWith('notification.activate', { id: 'budget-1' })
  })

  it('does not interrupt the user when the target conversation is already active', () => {
    renderRuntime(
      tabsContext({
        id: 'active',
        type: 'route',
        url: '/app/chat?topicId=topic-2',
        title: 'Research notes'
      })
    )

    emitNotification()

    expect(mocks.toastWarning).not.toHaveBeenCalled()
  })

  it('opens the target conversation when the user clicks the card', () => {
    renderRuntime(
      tabsContext({ id: 'active', type: 'route', url: '/app/chat?topicId=topic-1', title: 'Current topic' })
    )

    emitNotification()

    void act(() => mocks.toastWarning.mock.calls[0][0].onClick())
    expect(mocks.toastWarning).toHaveBeenCalledWith(expect.objectContaining({ title: 'Research notes' }))
    expect(mocks.toastClose).toHaveBeenCalledWith('approval-request:approval-1')
    expect(mocks.ipcRequest).toHaveBeenCalledWith('navigation.focus_or_open_conversation', {
      target: { conversationType: 'assistant', conversationId: 'topic-2' },
      title: 'Research notes'
    })
  })
})
import { mockDataApiService } from '@test-mocks/renderer/DataApiService'
