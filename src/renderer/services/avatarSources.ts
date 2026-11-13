import { ipcApi } from '@renderer/ipc'

export interface AvatarObjectUrl {
  src: string
  dispose(): void
}

/** Reads a registered avatar entry; the caller owns its page/session lifetime. */
export async function loadAvatarObjectUrl(entryId: string): Promise<AvatarObjectUrl> {
  const file = await ipcApi.request('file.read', {
    handle: { kind: 'entry', entryId },
    options: { mode: 'full', encoding: 'binary' }
  })
  if (!(file.content instanceof Uint8Array) || !file.mime.startsWith('image/'))
    throw new Error('EVOSTACK_INVALID_AVATAR_IMAGE')
  const src = URL.createObjectURL(new Blob([Uint8Array.from(file.content)], { type: file.mime }))
  let disposed = false
  return {
    src,
    dispose() {
      if (disposed) return
      disposed = true
      URL.revokeObjectURL(src)
    }
  }
}
