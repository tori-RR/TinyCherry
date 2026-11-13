import * as z from 'zod'

import type { NotificationRecord } from '@shared/data/types/notification'
import type { ConversationNotification } from '@shared/types/notification'

import { defineRoute } from '../define'

export const notificationRequestSchemas = {
  'notification.activate': defineRoute({ input: z.object({ id: z.string().min(1) }), output: z.void() })
}

/** In-app feedback; TinyCherry does not expose the retired OS notification sender. */
export type NotificationEventSchemas = {
  'notification.conversation': ConversationNotification
  'notification.present': NotificationRecord
  'notification.completion_sound': { id: string }
  'notification.open': { id: string }
}
