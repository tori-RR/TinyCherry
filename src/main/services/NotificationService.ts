import { application } from '@application'
import { agentSessionService } from '@data/services/AgentSessionService'
import { topicService } from '@data/services/TopicService'
import { loggerService } from '@logger'
import { extractAgentSessionId, isAgentSessionTopic } from '@main/ai/agentSession/topic'
import type { ConversationCompletedEvent } from '@main/ai/streamManager'
import type { ApprovalRequestedEvent } from '@main/ai/types'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { t } from '@main/i18n'
import { getFullChromeWindowInfos } from '@main/utils/fullChromeWindows'
import type { ConversationNavigationTarget } from '@shared/types/navigation'
import { CONVERSATION_NOTIFICATION_ACTION_KEY, type ConversationNotification } from '@shared/types/notification'

const logger = loggerService.withContext('NotificationService')
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })

@Injectable('NotificationService')
@DependsOn(['AgentSessionRuntimeService', 'AiStreamManager'])
@ServicePhase(Phase.WhenReady)
export class NotificationService extends BaseService {
  protected onInit(): void {
    this.registerDisposable(
      application.get('AiStreamManager').onConversationCompleted((event) => this.handleConversationCompleted(event))
    )
    this.registerDisposable(
      application.get('AiStreamManager').onApprovalRequested((event) => this.handleApprovalRequested(event))
    )
    this.registerDisposable(
      application.get('AgentSessionRuntimeService').onApprovalRequested((event) => this.handleApprovalRequested(event))
    )
  }

  private handleConversationCompleted({
    topicId,
    turnId,
    completedAt,
    responseText
  }: ConversationCompletedEvent): void {
    const target = this.resolveConversationTarget(topicId)
    const fallbackTitle =
      target.conversationType === 'agent' ? t('notification.completion.agent') : t('notification.completion.assistant')
    const conversationName = this.resolveConversationName(target, fallbackTitle)
    const lastSentence = [...sentenceSegmenter.segment(responseText?.trim() ?? '')].at(-1)?.segment.trim()
    this.deliverConversationNotification({
      id: `task-completion:${turnId}`,
      kind: 'task-completion',
      type: 'success',
      title: conversationName,
      conversationName,
      message: lastSentence || conversationName,
      timestamp: completedAt,
      actionKey: CONVERSATION_NOTIFICATION_ACTION_KEY,
      meta: target,
      source: 'assistant'
    })
  }

  private handleApprovalRequested({ topicId, approvalId, requestedAt }: ApprovalRequestedEvent): void {
    const target = this.resolveConversationTarget(topicId)
    const title =
      target.conversationType === 'agent'
        ? t('notification.action_required.agent')
        : t('notification.action_required.assistant')
    const conversationName = this.resolveConversationName(target)
    this.deliverConversationNotification({
      id: `approval-request:${approvalId}`,
      kind: 'approval-request',
      type: 'warning',
      title,
      conversationName,
      message: conversationName,
      timestamp: requestedAt,
      actionKey: CONVERSATION_NOTIFICATION_ACTION_KEY,
      meta: target,
      source: 'assistant'
    })
  }

  private deliverConversationNotification(notification: ConversationNotification): void {
    const focusedWindow = getFullChromeWindowInfos().find((window) => window.isFocused)
    if (focusedWindow) {
      application.get('IpcApiService').send(focusedWindow.id, 'notification.conversation', notification)
    }
  }

  private resolveConversationTarget(topicId: string): ConversationNavigationTarget {
    return isAgentSessionTopic(topicId)
      ? { conversationType: 'agent', conversationId: extractAgentSessionId(topicId) }
      : { conversationType: 'assistant', conversationId: topicId }
  }

  private resolveConversationName(
    target: ConversationNavigationTarget,
    fallback = target.conversationType === 'agent' ? t('agent.session.new') : t('chat.conversation.new')
  ): string {
    try {
      const name =
        target.conversationType === 'agent'
          ? agentSessionService.getById(target.conversationId).name
          : topicService.getById(target.conversationId).name
      return name.trim() || fallback
    } catch (error) {
      logger.warn('Failed to resolve conversation name for notification', { target, err: error })
      return fallback
    }
  }
}
