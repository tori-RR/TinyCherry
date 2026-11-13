import { activateNotification } from '@main/services/notificationActivation'
import type { notificationRequestSchemas } from '@shared/ipc/schemas/notification'
import type { IpcHandlersFor } from '@shared/ipc/types'

export const notificationHandlers: IpcHandlersFor<typeof notificationRequestSchemas> = {
  'notification.activate': async ({ id }) => activateNotification(id)
}
