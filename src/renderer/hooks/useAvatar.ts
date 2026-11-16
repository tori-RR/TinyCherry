import { useEffect, useState } from 'react'

import { usePreference } from '@data/hooks/usePreference'
import UserAvatar from '@renderer/assets/images/avatar.svg'
import { type AvatarObjectUrl, loadAvatarObjectUrl } from '@renderer/services/avatarSources'
import type { FileEntryId } from '@shared/data/types/file'
import { STORED_FILE_REF_PREFIX } from '@shared/data/types/file'
/** The `file_entry` id of an uploaded avatar (`file:<id>`), or undefined for emoji / default. */
function avatarStoredId(avatar: string | undefined): FileEntryId | undefined {
  if (!avatar || !avatar.startsWith(STORED_FILE_REF_PREFIX) || avatar.startsWith('file://')) return undefined
  return avatar.slice(STORED_FILE_REF_PREFIX.length)
}
/**
 * The user avatar as a render-ready value: a native blob URL or Electron file
 * URL for an uploaded image, the emoji glyph verbatim, or the bundled default.
 *
 * An uploaded avatar is stored in the `app.user.avatar` preference as a
 * `file:<id>` ref. Unlike a provider / mini-app logo (resolved main-side onto
 * the DTO's `logoSrc`), the avatar is a preference with no DTO, so its id is
 * resolved here through the file IPC — never by reconstructing a disk path,
 * which would break in windows that don't mount `app.path.files`.
 */
export default function useAvatar(): string {
  const [avatar] = usePreference('app.user.avatar')
  const [resolved, setResolved] = useState<{
    id: FileEntryId
    src: string
  }>()
  const storedId = avatarStoredId(avatar)
  useEffect(() => {
    if (!storedId) {
      setResolved(undefined)
      return
    }
    let active = true
    let ownedUrl: AvatarObjectUrl | undefined
    {
      void loadAvatarObjectUrl(storedId)
        .then((source) => {
          if (!active) {
            source.dispose()
            return
          }
          ownedUrl = source
          setResolved({ id: storedId, src: source.src })
        })
        .catch(() => {
          if (active) setResolved(undefined)
        })
      return () => {
        active = false
        ownedUrl?.dispose()
      }
    }
  }, [storedId])
  if (storedId) return (resolved?.id === storedId ? resolved.src : undefined) ?? UserAvatar
  if (avatar?.startsWith('file://')) return UserAvatar
  return avatar || UserAvatar
}
