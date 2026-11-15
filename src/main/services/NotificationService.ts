import { application } from '@application'
import { type CreateNotificationRecordInput, notificationRecordService } from '@data/services/NotificationRecordService'
import { loggerService } from '@logger'
import { BaseService, DependsOn, Injectable, Phase, ServicePhase } from '@main/core/lifecycle'
import { t } from '@main/i18n'
import { getFullChromeWindowInfos } from '@main/utils/fullChromeWindows'
import { NotificationTaskResultSchema, type TaskResultNotificationInput } from '@shared/data/types/notification'
import type { ConversationNotification, NotificationSource } from '@shared/types/notification'
import { redactSecretText, redactSecretTokens } from '@shared/utils/redaction'

const logger = loggerService.withContext('NotificationService')

@Injectable('NotificationService')
@DependsOn(['ConversationNavigationService'])
@ServicePhase(Phase.WhenReady)
export class NotificationService extends BaseService {
  protected onInit(): void {
    const purge = () => {
      try {
        notificationRecordService.purgeExpired()
      } catch (error) {
        logger.warn('Failed to expire notification history', { error })
      }
    }
    purge()
    this.registerInterval(purge, 24 * 60 * 60 * 1000)
  }

  public async publish(
    input: CreateNotificationRecordInput,
    options: { source?: NotificationSource; completion?: boolean; recordOnly?: boolean } = {}
  ): Promise<boolean> {
    let committed = false
    try {
      const preferences = application.get('PreferenceService')
      const enabled = preferences.get(`app.notification.center.${input.category}.enabled`)
      const result = input.target?.result
      const completion = input.kind === 'task-completion' || input.kind === 'queue-completion'
      const active =
        enabled &&
        (completion || !!result) &&
        input.target?.kind === 'conversation' &&
        getFullChromeWindowInfos().some((window) => window.isFocused) &&
        (await application.get('ConversationNavigationService').isActiveInFocusedWindow(input.target))
      const suppressed = !enabled || (active && (completion || result?.status === 'succeeded'))
      const recordOnly = options.recordOnly || result?.status === 'cancelled' || (!!result && active)
      const initial = {
        ...input,
        readAt: result && recordOnly ? Date.now() : input.readAt
      }
      const record = result
        ? notificationRecordService.consumeTaskResult(input.eventKey, suppressed ? null : initial)
        : suppressed
          ? null
          : notificationRecordService.create(initial)
      if (!record) return true
      committed = true
      if (recordOnly) return true
      const windows = getFullChromeWindowInfos()
      const focused = windows.find((window) => window.isFocused)
      if (focused && (options.completion || result || input.category === 'usage')) {
        application.get('IpcApiService').send(focused.id, 'notification.present', record)
      }
      return true
    } catch (error) {
      logger.warn('Failed to publish notification', { error, eventKey: input.eventKey })
      return committed
    }
  }

  /** Persists an authoritative outcome through the existing notification delivery policy. */
  public async publishTaskResult(input: TaskResultNotificationInput): Promise<boolean> {
    try {
      if (!input.resultId.trim() || !Number.isSafeInteger(input.finishedAt) || input.finishedAt < 0) return false
      const result = NotificationTaskResultSchema.parse(input)
      if (result.errorSummary) {
        result.errorSummary = Array.from(redactSecretTokens(redactSecretText(result.errorSummary)))
          .slice(0, 500)
          .join('')
      }
      return this.publish(
        {
          eventKey: `task-result:${JSON.stringify([result.source, input.resultId])}`,
          category: 'system',
          kind: 'task-result',
          title: {
            succeeded: t('notification.result.succeeded'),
            failed: t('notification.result.failed'),
            interrupted: t('notification.result.interrupted'),
            cancelled: t('notification.result.cancelled')
          }[result.status],
          message: result.errorSummary ? `${result.name}: ${result.errorSummary}` : result.name,
          createdAt: input.finishedAt,
          target: { ...input.target, result }
        },
        { source: 'assistant', completion: result.status === 'succeeded' }
      )
    } catch (error) {
      logger.warn('Invalid task result notification', { error })
      return false
    }
  }

  public deliverConversationNotification(notification: ConversationNotification): void {
    const focusedWindow = getFullChromeWindowInfos().find((window) => window.isFocused)
    if (focusedWindow) {
      application.get('IpcApiService').send(focusedWindow.id, 'notification.conversation', notification)
    }
  }
}
