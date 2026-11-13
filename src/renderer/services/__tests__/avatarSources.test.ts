import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ipcApi } from '@renderer/ipc'

import { loadAvatarObjectUrl } from '../avatarSources'

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))
beforeEach(() => {
  const BrowserUrl = URL
  vi.stubGlobal(
    'URL',
    class extends BrowserUrl {
      static createObjectURL = vi.fn(() => 'blob:avatar-1')
      static revokeObjectURL = vi.fn()
    }
  )
  vi.mocked(ipcApi.request).mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native avatar entries', () => {
  it('reads a registered entry into a revocable blob URL without resolving a file path', async () => {
    vi.mocked(ipcApi.request).mockResolvedValue({ content: new Uint8Array([0, 127, 255]), mime: 'image/webp' } as never)
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar-1')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const avatar = await loadAvatarObjectUrl('avatar-1')
    expect(ipcApi.request).toHaveBeenCalledExactlyOnceWith('file.read', {
      handle: { kind: 'entry', entryId: 'avatar-1' },
      options: { mode: 'full', encoding: 'binary' }
    })
    expect(create.mock.calls[0][0]).toMatchObject({ type: 'image/webp', size: 3 })
    expect(avatar.src).toBe('blob:avatar-1')
    avatar.dispose()
    avatar.dispose()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:avatar-1')
  })

  it('never creates a URL for an unreadable entry or a non-image response', async () => {
    const create = vi.spyOn(URL, 'createObjectURL')
    vi.mocked(ipcApi.request).mockRejectedValueOnce(new Error('FILE_EDIT_PERMISSION'))
    await expect(loadAvatarObjectUrl('unregistered')).rejects.toThrow('FILE_EDIT_PERMISSION')
    vi.mocked(ipcApi.request).mockResolvedValueOnce({ content: new Uint8Array([65]), mime: 'text/html' } as never)
    await expect(loadAvatarObjectUrl('not-image')).rejects.toThrow('EVOSTACK_INVALID_AVATAR_IMAGE')
    expect(create).not.toHaveBeenCalled()
  })
})
