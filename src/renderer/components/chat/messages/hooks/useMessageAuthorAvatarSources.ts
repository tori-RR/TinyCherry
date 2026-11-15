import { useEffect, useMemo, useState } from 'react'

import type { MessageListItem } from '@renderer/components/chat/messages/types'
import { ipcApi } from '@renderer/ipc'
import { type AvatarObjectUrl, loadAvatarObjectUrl } from '@renderer/services/avatarSources'
import { isEvoStack } from '@renderer/utils/platform'
import type { FileEntryId } from '@shared/data/types/file'
import { toFileUrl } from '@shared/utils/file'

const AVATAR_PATH_BATCH_SIZE = 500

export function useMessageAuthorAvatarSources(
  messages: readonly MessageListItem[],
  listKey = messages[0]?.topicId ?? ''
): ReadonlyMap<string, string> {
  const session = useMemo(
    () => ({
      key: listKey,
      active: true,
      generation: 0,
      requested: new Set<FileEntryId>(),
      sources: new Map<string, string>(),
      ownedUrls: new Map<string, AvatarObjectUrl>(),
      pending: [] as FileEntryId[],
      loading: false
    }),
    [listKey]
  )
  const [resolved, setResolved] = useState({ session, sources: session.sources })
  const ids = useMemo(
    () => [
      ...new Set(
        messages.flatMap((message) =>
          message.messageSnapshot?.avatarFileId ? [message.messageSnapshot.avatarFileId] : []
        )
      )
    ],
    [messages]
  )

  useEffect(() => {
    session.active = true
    return () => {
      session.active = false
      session.generation++
      for (const source of session.ownedUrls.values()) source.dispose()
      session.ownedUrls.clear()
      session.sources.clear()
      session.requested.clear()
      session.pending.length = 0
      session.loading = false
    }
  }, [session])

  useEffect(() => {
    const added = ids.filter((id) => !session.requested.has(id))
    const generation = session.generation
    if (isEvoStack) {
      added.forEach((id) => session.requested.add(id))
      session.pending.push(...added)
      if (session.loading || !session.pending.length) return
      session.loading = true
      void (async () => {
        while (session.active && generation === session.generation && session.pending.length) {
          // Binary entry reads replace a single path lookup: bound requests while loading a long history.
          const batch = session.pending.splice(0, 4)
          await Promise.all(
            batch.map(async (id) => {
              try {
                const source = await loadAvatarObjectUrl(id)
                if (!session.active || generation !== session.generation) {
                  source.dispose()
                  return
                }
                session.ownedUrls.set(id, source)
                session.sources.set(id, source.src)
              } catch {
                // A removed avatar uses the message's existing emoji/default fallback.
              }
            })
          )
          if (session.active && generation === session.generation)
            setResolved({ session, sources: new Map(session.sources) })
        }
      })().finally(() => {
        if (generation === session.generation) session.loading = false
      })
      return
    }
    for (let offset = 0; offset < added.length; offset += AVATAR_PATH_BATCH_SIZE) {
      const batch = added.slice(offset, offset + AVATAR_PATH_BATCH_SIZE)
      batch.forEach((id) => session.requested.add(id))
      void ipcApi
        .request('file.batch_get_physical_paths', { ids: batch })
        .then((paths) => {
          if (!session.active || generation !== session.generation) return
          for (const id of batch) {
            const path = paths[id]
            if (path) session.sources.set(id, toFileUrl(path))
          }
          setResolved({ session, sources: new Map(session.sources) })
        })
        .catch(() => {})
    }
  }, [ids, session])

  return resolved.session === session ? resolved.sources : session.sources
}
