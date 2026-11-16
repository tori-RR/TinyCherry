import { useEffect, useMemo, useState } from 'react'

import type { MessageListItem } from '@renderer/components/chat/messages/types'
import { type AvatarObjectUrl, loadAvatarObjectUrl } from '@renderer/services/avatarSources'
import type { FileEntryId } from '@shared/data/types/file'
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
    {
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
              } catch {}
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
  }, [ids, session])
  return resolved.session === session ? resolved.sources : session.sources
}
