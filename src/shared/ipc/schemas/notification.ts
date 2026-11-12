import type { ConversationNotification } from '@shared/types/notification'

/** In-app conversation feedback, sent only to a focused full-chrome window. */
export type NotificationEventSchemas = {
  'notification.conversation': ConversationNotification
}
