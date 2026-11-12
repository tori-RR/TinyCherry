import { useMemo } from 'react'

import type { MessageListActions, MessageListMeta } from '@renderer/components/chat/messages/types'
import useAvatar from '@renderer/hooks/useAvatar'

export function useMessageHeaderCapabilities(): Pick<MessageListMeta, 'userProfile'> &
  Pick<MessageListActions, 'openUserProfile'> {
  const avatar = useAvatar()
  return useMemo(() => ({ userProfile: { avatar }, openUserProfile: undefined }), [avatar])
}
