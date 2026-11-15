import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcRequest = vi.fn()
const native = vi.hoisted(() => ({ enabled: false, create: vi.fn(), revoke: vi.fn() }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: (...args: any[]) => ipcRequest(...args) } }))
vi.mock('@renderer/utils/platform', async (original) => ({
  ...(await original<typeof import('@renderer/utils/platform')>()),
  get isEvoStack() {
    return native.enabled
  }
}))

import UserAvatar from '@renderer/assets/images/avatar.svg'

import useAvatar from '../useAvatar'

beforeEach(() => {
  vi.clearAllMocks()
  ipcRequest.mockReset()
  native.enabled = false
  let nextUrl = 0
  native.create.mockImplementation(() => `blob:avatar-${++nextUrl}`)
  const BrowserUrl = URL
  vi.stubGlobal(
    'URL',
    class extends BrowserUrl {
      static createObjectURL = native.create
      static revokeObjectURL = native.revoke
    }
  )
  MockUsePreferenceUtils.resetMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe('useAvatar', () => {
  it('loads native avatar entries as blob URLs and releases them on unmount', async () => {
    native.enabled = true
    ipcRequest.mockResolvedValue({ content: new Uint8Array([1, 2, 3]), mime: 'image/webp' })
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:id-native')
    const { result, unmount } = renderHook(() => useAvatar())
    await waitFor(() => expect(result.current).toBe('blob:avatar-1'))
    expect(ipcRequest).toHaveBeenCalledExactlyOnceWith('file.read', {
      handle: { kind: 'entry', entryId: 'id-native' },
      options: { mode: 'full', encoding: 'binary' }
    })
    unmount()
    expect(native.revoke).toHaveBeenCalledExactlyOnceWith('blob:avatar-1')
  })

  it('disposes late native reads without replacing the current avatar', async () => {
    native.enabled = true
    let resolveOld!: (value: unknown) => void
    let resolveCurrent!: (value: unknown) => void
    ipcRequest
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCurrent = resolve
        })
      )
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:old')
    const { result, rerender, unmount } = renderHook(() => useAvatar())
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:current')
    rerender()
    await act(async () => resolveCurrent({ content: new Uint8Array([2]), mime: 'image/webp' }))
    expect(result.current).toBe('blob:avatar-1')
    await act(async () => resolveOld({ content: new Uint8Array([1]), mime: 'image/webp' }))
    expect(result.current).toBe('blob:avatar-1')
    expect(native.revoke).toHaveBeenCalledExactlyOnceWith('blob:avatar-2')
    unmount()
    expect(native.revoke).toHaveBeenLastCalledWith('blob:avatar-1')
  })

  it('releases native images on avatar changes and never returns a legacy file URL', async () => {
    native.enabled = true
    ipcRequest.mockResolvedValue({ content: new Uint8Array([1]), mime: 'image/webp' })
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:first')
    const { result, rerender } = renderHook(() => useAvatar())
    await waitFor(() => expect(result.current).toBe('blob:avatar-1'))
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', '🙂')
    rerender()
    expect(result.current).toBe('🙂')
    expect(native.revoke).toHaveBeenCalledExactlyOnceWith('blob:avatar-1')
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:///fixture/avatar.webp')
    rerender()
    expect(result.current).toBe(UserAvatar)
    expect(ipcRequest).toHaveBeenCalledOnce()
  })

  it('returns an emoji avatar verbatim without touching the file IPC', () => {
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', '🙂')

    const { result } = renderHook(() => useAvatar())

    expect(result.current).toBe('🙂')
    expect(ipcRequest).not.toHaveBeenCalled()
  })

  it('resolves a file:<id> avatar to a file:// url via file.batch_get_physical_paths', async () => {
    ipcRequest.mockResolvedValue({ 'id-1': '/data/files/id-1.webp' })
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:id-1')

    const { result } = renderHook(() => useAvatar())

    await waitFor(() => expect(result.current).toMatch(/^file:\/\/.*id-1\.webp$/))
    expect(ipcRequest).toHaveBeenCalledWith('file.batch_get_physical_paths', { ids: ['id-1'] })
  })

  it('falls back to the default when the resolved path is missing', async () => {
    ipcRequest.mockResolvedValue({}) // no path for the id
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:id-2')

    const { result } = renderHook(() => useAvatar())

    await waitFor(() => expect(ipcRequest).toHaveBeenCalled())
    expect(result.current).toBe(UserAvatar)
  })

  it('falls back to the default when the file IPC rejects', async () => {
    ipcRequest.mockRejectedValue(new Error('ipc boom'))
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:id-3')

    const { result } = renderHook(() => useAvatar())

    await waitFor(() => expect(ipcRequest).toHaveBeenCalled())
    expect(result.current).toBe(UserAvatar)
  })

  it('keeps the current avatar when an older file resolution completes later', async () => {
    let resolveOld!: (value: Record<string, string>) => void
    let resolveCurrent!: (value: Record<string, string>) => void
    const oldRequest = new Promise<Record<string, string>>((resolve) => {
      resolveOld = resolve
    })
    const currentRequest = new Promise<Record<string, string>>((resolve) => {
      resolveCurrent = resolve
    })
    ipcRequest.mockReturnValueOnce(oldRequest).mockReturnValueOnce(currentRequest)
    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:id-4')

    const { result, rerender } = renderHook(() => useAvatar())
    expect(result.current).toBe(UserAvatar)

    MockUsePreferenceUtils.setPreferenceValue('app.user.avatar', 'file:id-5')
    rerender()
    expect(ipcRequest).toHaveBeenNthCalledWith(2, 'file.batch_get_physical_paths', { ids: ['id-5'] })

    await act(async () => {
      resolveCurrent({ 'id-5': '/data/files/id-5.webp' })
      await currentRequest
    })
    expect(result.current).toBe('file:///data/files/id-5.webp')

    await act(async () => {
      resolveOld({ 'id-4': '/data/files/id-4.webp' })
      await oldRequest
    })
    expect(result.current).toBe('file:///data/files/id-5.webp')
  })
})
