import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConversationCompletedEvent } from '@main/ai/streamManager'
import type { ApprovalRequestedEvent } from '@main/ai/types'
import { BaseService } from '@main/core/lifecycle'
import { type WindowInfo, WindowType } from '@main/core/window/types'

const mocks = vi.hoisted(() => ({
  agentSessionGetById: vi.fn(),
  agentApprovalListener: undefined as ((event: ApprovalRequestedEvent) => void) | undefined,
  applicationGet: vi.fn(),
  broadcastToType: vi.fn(),
  completionListener: undefined as ((event: ConversationCompletedEvent) => void) | undefined,
  electronNotifications: [] as Array<{
    options: { title: string; message: string }
    click?: () => void
    show: ReturnType<typeof vi.fn<() => void>>
  }>,
  focusOrOpen: vi.fn(() => Promise.resolve()),
  getWindowInfosByType: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  send: vi.fn(),
  showMainWindow: vi.fn(),
  streamApprovalListener: undefined as ((event: ApprovalRequestedEvent) => void) | undefined,
  topicGetById: vi.fn()
}))

vi.mock('@application', () => ({ application: { get: mocks.applicationGet } }))
vi.mock('@data/services/AgentSessionService', () => ({
  agentSessionService: { getById: mocks.agentSessionGetById }
}))
vi.mock('@data/services/TopicService', () => ({ topicService: { getById: mocks.topicGetById } }))
vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ error: mocks.loggerError, warn: mocks.loggerWarn }) }
}))
vi.mock('@main/i18n', () => ({
  t: (key: string) =>
    ({
      'agent.session.new': 'New task',
      'chat.conversation.new': 'New Chat',
      'notification.action_required.agent': 'Agent needs your input',
      'notification.action_required.assistant': 'Assistant needs your input',
      'notification.completion.agent': 'Agent task complete',
      'notification.completion.assistant': 'Assistant response complete'
    })[key] ?? key
}))
vi.mock('electron', () => ({
  Notification: class {
    private readonly state: (typeof mocks.electronNotifications)[number]

    constructor(options: { title: string; message: string }) {
      this.state = { options, show: vi.fn() }
      mocks.electronNotifications.push(this.state)
    }

    on(event: string, listener: () => void) {
      if (event === 'click') this.state.click = listener
      return this
    }

    show() {
      this.state.show()
    }
  }
}))

const { NotificationService } = await import('../NotificationService')

const mainWindowInfo = (overrides: Partial<WindowInfo> = {}): WindowInfo => ({
  id: 'main-1',
  type: WindowType.Main,
  title: 'Cherry Studio',
  isVisible: false,
  isFocused: false,
  createdAt: 1,
  ...overrides
})

function emitCompletion(overrides: Partial<ConversationCompletedEvent> = {}): void {
  mocks.completionListener?.({
    topicId: 'topic-1',
    turnId: 'turn-1',
    completedAt: 100,
    responseText: 'I checked the implementation. Here is the final answer.',
    ...overrides
  })
}

function emitApproval(overrides: Partial<ApprovalRequestedEvent> = {}, source: 'stream' | 'agent' = 'stream'): void {
  const listener = source === 'stream' ? mocks.streamApprovalListener : mocks.agentApprovalListener
  listener?.({
    topicId: 'topic-1',
    approvalId: 'approval-1',
    requestedAt: 200,
    ...overrides
  })
}

describe('NotificationService', () => {
  let service: InstanceType<typeof NotificationService>

  async function initService(): Promise<void> {
    service = new NotificationService()
    await service._doInit()
  }

  beforeEach(async () => {
    BaseService.resetInstances()
    vi.clearAllMocks()
    mocks.electronNotifications.length = 0
    mocks.agentApprovalListener = undefined
    mocks.completionListener = undefined
    mocks.streamApprovalListener = undefined
    mocks.getWindowInfosByType.mockImplementation((type: WindowType) =>
      type === WindowType.Main ? [mainWindowInfo({ isFocused: true })] : []
    )
    mocks.topicGetById.mockReturnValue({ name: 'Research notes' })
    mocks.agentSessionGetById.mockReturnValue({ name: 'Refactor project' })
    mocks.applicationGet.mockImplementation((name: string) => {
      if (name === 'AiStreamManager') {
        return {
          onApprovalRequested: (listener: (event: ApprovalRequestedEvent) => void) => {
            mocks.streamApprovalListener = listener
            return { dispose: vi.fn() }
          },
          onConversationCompleted: (listener: (event: ConversationCompletedEvent) => void) => {
            mocks.completionListener = listener
            return { dispose: vi.fn() }
          }
        }
      }
      if (name === 'AgentSessionRuntimeService') {
        return {
          onApprovalRequested: (listener: (event: ApprovalRequestedEvent) => void) => {
            mocks.agentApprovalListener = listener
            return { dispose: vi.fn() }
          }
        }
      }
      if (name === 'ConversationNavigationService') return { focusOrOpen: mocks.focusOrOpen }
      if (name === 'WindowManager') return { getWindowInfosByType: mocks.getWindowInfosByType }
      if (name === 'IpcApiService') return { send: mocks.send, broadcastToType: mocks.broadcastToType }
      if (name === 'MainWindowService') return { showMainWindow: mocks.showMainWindow }
      throw new Error(`Unexpected application.get(${name})`)
    })

    await initService()
  })

  it('sends one presentation-ready event to the focused full-chrome window', () => {
    mocks.getWindowInfosByType.mockImplementation((type: WindowType) =>
      type === WindowType.Main
        ? [mainWindowInfo()]
        : [
            mainWindowInfo({
              id: 'sub-1',
              type: WindowType.SubWindow,
              title: 'Detached chat',
              isVisible: true,
              isFocused: true
            })
          ]
    )

    emitCompletion()

    expect(mocks.send).toHaveBeenCalledOnce()
    expect(mocks.send).toHaveBeenCalledWith('sub-1', 'notification.conversation', {
      id: 'task-completion:turn-1',
      kind: 'task-completion',
      type: 'success',
      title: 'Research notes',
      conversationName: 'Research notes',
      message: 'Here is the final answer.',
      timestamp: 100,
      actionKey: 'conversation.open',
      meta: { conversationType: 'assistant', conversationId: 'topic-1' },
      source: 'assistant'
    })
    expect(mocks.electronNotifications).toHaveLength(0)
  })

  it('sends a presentation-ready approval event to the focused full-chrome window', () => {
    mocks.getWindowInfosByType.mockImplementation((type: WindowType) =>
      type === WindowType.Main ? [mainWindowInfo({ isFocused: true })] : []
    )

    emitApproval()

    expect(mocks.send).toHaveBeenCalledWith('main-1', 'notification.conversation', {
      id: 'approval-request:approval-1',
      kind: 'approval-request',
      type: 'warning',
      title: 'Assistant needs your input',
      conversationName: 'Research notes',
      message: 'Research notes',
      timestamp: 200,
      actionKey: 'conversation.open',
      meta: { conversationType: 'assistant', conversationId: 'topic-1' },
      source: 'assistant'
    })
    expect(mocks.electronNotifications).toHaveLength(0)
  })

  it('uses the session name as title and only the last sentence as body', () => {
    emitCompletion({
      topicId: 'agent-session:session-1',
      responseText: 'I checked every call site. The refactor is complete.'
    })

    expect(mocks.send).toHaveBeenCalledWith(
      'main-1',
      'notification.conversation',
      expect.objectContaining({
        title: 'Refactor project',
        message: 'The refactor is complete.'
      })
    )
  })

  it.each([
    ['已经定位问题。现在可以正常使用了！', '现在可以正常使用了！'],
    ['第一句。最后一句没有句末标点', '最后一句没有句末标点'],
    ['Checked the value. The result is 3.14.', 'The result is 3.14.'],
    ['First sentence! Are we done?', 'Are we done?'],
    ['前面的说明。\n\n最后一句。\n  ', '最后一句。'],
    ['处理完毕。他说：“可以发布了。”', '他说：“可以发布了。”'],
    ['Only one sentence', 'Only one sentence']
  ])('shows only the last sentence of %s', (responseText, expected) => {
    emitCompletion({ responseText })
    expect(mocks.send).toHaveBeenCalledWith(
      'main-1',
      'notification.conversation',
      expect.objectContaining({ title: 'Research notes', message: expected })
    )
  })

  it.each([
    ['topic-1', 'Assistant response complete'],
    ['agent-session:session-1', 'Agent task complete']
  ])('uses a generic completion title when %s has no name', (topicId, title) => {
    mocks.topicGetById.mockReturnValue({ name: '  ' })
    mocks.agentSessionGetById.mockReturnValue({ name: '' })
    emitCompletion({ topicId })
    expect(mocks.send).toHaveBeenCalledWith(
      'main-1',
      'notification.conversation',
      expect.objectContaining({ title, message: 'Here is the final answer.' })
    )
  })

  it.each([undefined, '', '   '])('falls back to the conversation name without reply text (%s)', (responseText) => {
    emitCompletion({ responseText })
    expect(mocks.send).toHaveBeenCalledWith(
      'main-1',
      'notification.conversation',
      expect.objectContaining({ message: 'Research notes' })
    )
  })

  it('logs a name lookup failure and keeps notifying with the localized generic name', () => {
    mocks.getWindowInfosByType.mockImplementation((type: WindowType) =>
      type === WindowType.Main ? [mainWindowInfo({ isFocused: true })] : []
    )
    mocks.agentSessionGetById.mockImplementation(() => {
      throw new Error('missing')
    })

    emitCompletion({ topicId: 'agent-session:missing', responseText: undefined })

    expect(mocks.send).toHaveBeenCalledWith(
      'main-1',
      'notification.conversation',
      expect.objectContaining({
        title: 'Agent task complete',
        message: 'Agent task complete'
      })
    )
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Failed to resolve conversation name for notification',
      expect.objectContaining({ target: { conversationType: 'agent', conversationId: 'missing' } })
    )
  })

  it('does not notify when no full-chrome window is focused', () => {
    mocks.getWindowInfosByType.mockImplementation((type: WindowType) =>
      type === WindowType.Main ? [mainWindowInfo()] : []
    )
    emitApproval({ approvalId: 'approval-disabled' })
    expect(mocks.electronNotifications).toHaveLength(0)
  })
})
