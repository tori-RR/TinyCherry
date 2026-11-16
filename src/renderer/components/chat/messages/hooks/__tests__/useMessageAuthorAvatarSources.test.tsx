import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MessageListItem } from '@renderer/components/chat/messages/types'
import type * as PlatformModule from '@renderer/utils/platform'

import { useMessageAuthorAvatarSources } from '../useMessageAuthorAvatarSources'

const native = vi.hoisted(() => ({ enabled: true, request: vi.fn(), create: vi.fn(), revoke: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: native.request } }))
vi.mock('@renderer/utils/platform', async (original) => ({
  ...(await original<typeof PlatformModule>()),
  get isEvoStack() {
    return native.enabled
  }
}))

function messages(...ids: string[]): MessageListItem[] {
  return ids.map((id, index) => ({
    id: `message-${index}`,
    topicId: 'topic',
    messageSnapshot: { avatarFileId: id }
  })) as MessageListItem[]
}
const image = { content: new Uint8Array([1, 2, 3]), mime: 'image/webp' }

beforeEach(() => {
  native.enabled = true
  native.request.mockReset()
  native.create.mockReset()
  native.revoke.mockReset()
  let nextUrl = 0
  native.create.mockImplementation(() => `blob:history-${++nextUrl}`)
  const BrowserUrl = URL
  vi.stubGlobal(
    'URL',
    class extends BrowserUrl {
      static createObjectURL = native.create
      static revokeObjectURL = native.revoke
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('message author avatar sources', () => {
  it('loads each native snapshot once and releases all sources with its message list', async () => {
    native.request.mockResolvedValue(image)
    const { result, rerender, unmount } = renderHook(({ items }) => useMessageAuthorAvatarSources(items, 'list-1'), {
      initialProps: { items: messages('avatar-a', 'avatar-a', 'avatar-b') }
    })
    await waitFor(() => expect(result.current.size).toBe(2))
    expect(native.request.mock.calls.map(([, input]) => input.handle)).toEqual([
      { kind: 'entry', entryId: 'avatar-a' },
      { kind: 'entry', entryId: 'avatar-b' }
    ])
    expect([...result.current.values()]).toEqual(['blob:history-1', 'blob:history-2'])
    rerender({ items: messages('avatar-a', 'avatar-b') })
    expect(native.request).toHaveBeenCalledTimes(2)
    unmount()
    expect(native.revoke.mock.calls.map(([src]) => src)).toEqual(['blob:history-1', 'blob:history-2'])
  })

  it('disposes an obsolete list read instead of adding it to the new list', async () => {
    let resolveOld!: (value: unknown) => void
    native.request
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        })
      )
      .mockResolvedValue(image)
    const { result, rerender, unmount } = renderHook(({ key, items }) => useMessageAuthorAvatarSources(items, key), {
      initialProps: { key: 'old-list', items: messages('old-avatar') }
    })
    rerender({ key: 'new-list', items: messages('new-avatar') })
    await waitFor(() => expect(result.current.get('new-avatar')).toBe('blob:history-1'))
    await act(async () => resolveOld(image))
    expect(result.current.has('old-avatar')).toBe(false)
    expect(native.revoke).toHaveBeenCalledExactlyOnceWith('blob:history-2')
    unmount()
    expect(native.revoke).toHaveBeenLastCalledWith('blob:history-1')
  })

  it('bounds binary reads and stops pending work when the list unmounts', async () => {
    const pending: Array<(value: unknown) => void> = []
    native.request.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const { unmount } = renderHook(() => useMessageAuthorAvatarSources(messages('a', 'b', 'c', 'd', 'e', 'f'), 'list'))
    expect(native.request).toHaveBeenCalledTimes(4)
    unmount()
    await act(async () => pending.forEach((resolve) => resolve(image)))
    expect(native.request).toHaveBeenCalledTimes(4)
    expect(native.revoke).toHaveBeenCalledTimes(4)
  })

  it('does not adopt resources from the discarded StrictMode effect', async () => {
    const pending: Array<(value: unknown) => void> = []
    native.request.mockImplementation(() => new Promise((resolve) => pending.push(resolve)))
    const { result, unmount } = renderHook(() => useMessageAuthorAvatarSources(messages('avatar'), 'list'), {
      reactStrictMode: true
    })
    expect(pending).toHaveLength(2)
    await act(async () => pending[0](image))
    expect(result.current.size).toBe(0)
    expect(native.revoke).toHaveBeenCalledExactlyOnceWith('blob:history-1')
    await act(async () => pending[1](image))
    expect(result.current.get('avatar')).toBe('blob:history-2')
    unmount()
    expect(native.revoke).toHaveBeenLastCalledWith('blob:history-2')
  })
})
