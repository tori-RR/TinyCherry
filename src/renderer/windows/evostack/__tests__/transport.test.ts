import { afterEach, describe, expect, it, vi } from 'vitest'

import { isTrustedHostUrl } from '../transport'

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('EvoStack transport', () => {
  it.each([
    [Array.from(new TextEncoder().encode('# Cherry 技能 🍒\n')), '# Cherry 技能 🍒\n'],
    [[0xef, 0xbb, 0xbf, 35, 32, 65], '# A'],
    [[0xff, 0xfe, 35, 0, 32, 0, 65, 0], '# A'],
    [[0xfe, 0xff, 0, 35, 0, 32, 0, 65], '# A']
  ])('serves the original fs.readText(path) preview facade through controlled file.read (%#)', async (bytes, text) => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      data: { content: bytes, mime: 'text/markdown', version: { size: bytes.length, mtime: 123 } }
    })
    vi.stubGlobal('__TAURI__', { core: { invoke, Channel: vi.fn() } })
    const { ipcRenderer } = await import('../transport')
    const fs = { readText: (path: string) => ipcRenderer.invoke('fs:readText', path) }

    await expect(fs.readText('C:\\fixture\\SKILL.md')).resolves.toBe(text)
    expect(invoke).toHaveBeenCalledExactlyOnceWith('ipc_request', {
      channel: 'ipc-api:request',
      args: [
        'file.read',
        {
          handle: { kind: 'path', path: 'C:\\fixture\\SKILL.md' },
          options: { mode: 'full', encoding: 'binary' }
        }
      ]
    })
  })

  it('preserves denied-file errors through the original text facade', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'FILE_EDIT_PERMISSION', message: 'File is outside a registered skill' }
    })
    vi.stubGlobal('__TAURI__', { core: { invoke, Channel: vi.fn() } })
    const { ipcRenderer } = await import('../transport')

    await expect(ipcRenderer.invoke('fs:readText', 'C:\\private.txt')).rejects.toThrow(
      'File is outside a registered skill'
    )
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('rejects malformed bytes and undecodable text through the original text facade', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { content: [256] } })
      .mockResolvedValueOnce({ ok: true, data: { content: [0xff] } })
    vi.stubGlobal('__TAURI__', { core: { invoke, Channel: vi.fn() } })
    const { ipcRenderer } = await import('../transport')

    await expect(ipcRenderer.invoke('fs:readText', 'C:\\fixture\\SKILL.md')).rejects.toThrow(
      'EVOSTACK_INVALID_BINARY_RESPONSE'
    )
    await expect(ipcRenderer.invoke('fs:readText', 'C:\\fixture\\SKILL.md')).rejects.toThrow()
  })

  it('preserves file bytes across JSON without changing unrelated DTO arrays', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { data: [0, 127, 255], baseline: { contentHash: 'sha256:abcd' } } })
    vi.stubGlobal('__TAURI__', { core: { invoke, Channel: vi.fn() } })
    const { ipcRenderer } = await import('../transport')
    const read = await ipcRenderer.invoke('ipc-api:request', 'file.edit.read', { editId: 'fixture' })
    expect(read.data.data).toEqual(new Uint8Array([0, 127, 255]))
    expect(read.data.baseline.contentHash).toBe('sha256:abcd')
    const input = { editId: 'fixture', data: new Uint8Array([0, 127, 255]) }
    await ipcRenderer.invoke('ipc-api:request', 'file.edit.write', input)
    expect(invoke).toHaveBeenLastCalledWith('ipc_request', {
      channel: 'ipc-api:request',
      args: ['file.edit.write', { editId: 'fixture', data: [0, 127, 255] }]
    })
    expect(input.data).toBeInstanceOf(Uint8Array)
    const other = await ipcRenderer.invoke('ipc-api:request', 'fixture.read')
    expect(other.data.data).toEqual([0, 127, 255])
  })

  it('rejects malformed binary replies rather than silently truncating bytes', async () => {
    vi.stubGlobal('__TAURI__', {
      core: { invoke: vi.fn().mockResolvedValue({ ok: true, data: { content: [-1, 256] } }), Channel: vi.fn() }
    })
    const { ipcRenderer } = await import('../transport')
    await expect(ipcRenderer.invoke('ipc-api:request', 'file.read', {})).rejects.toThrow(
      'EVOSTACK_INVALID_BINARY_RESPONSE'
    )
  })

  it('accepts only packaged app origins', () => {
    for (const raw of ['http://tauri.localhost/windows/evostack/index.html', 'tauri://localhost/index.html']) {
      expect(isTrustedHostUrl(raw), raw).toBe(true)
    }
    for (const raw of [
      'tauri://attacker/index.html',
      'https://tauri.localhost/',
      'http://tauri.localhost:8123/',
      'tauri://localhost:80/',
      'http://user@tauri.localhost/',
      'http://tauri.localhost.attacker/',
      'file://tauri.localhost/index.html'
    ]) {
      expect(isTrustedHostUrl(raw), raw).toBe(false)
    }
  })

  it('rejects untrusted origins before registering a host channel', async () => {
    vi.stubGlobal('location', new URL('https://tauri.localhost/'))
    const invoke = vi.fn()
    vi.stubGlobal('__TAURI__', { core: { invoke, Channel: vi.fn() } })
    const { installHostTransport } = await import('../transport')

    await expect(installHostTransport()).rejects.toThrow('EVOSTACK_UNTRUSTED_FRONTEND')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('installs once and consumes the exact once registration when a callback is also persistent', async () => {
    vi.stubGlobal('location', new URL('http://tauri.localhost/windows/evostack/index.html'))
    const invoke = vi.fn().mockResolvedValue(undefined)
    class Channel {
      static instances: Channel[] = []
      onmessage: (message: { channel: string; args: unknown[] }) => void = () => {}
      constructor() {
        Channel.instances.push(this)
      }
    }
    vi.stubGlobal('__TAURI__', { core: { invoke, Channel } })
    const { installHostTransport, ipcRenderer } = await import('../transport')
    await Promise.all([installHostTransport(), installHostTransport()])
    const channel = Channel.instances[0]
    expect(invoke).toHaveBeenCalledTimes(1)
    const callback = vi.fn()
    ipcRenderer.once('fixture', callback)
    ipcRenderer.on('fixture', callback)

    channel.onmessage({ channel: 'fixture', args: ['first'] })
    channel.onmessage({ channel: 'fixture', args: ['second'] })
    expect(callback.mock.calls.map(([, value]) => value)).toEqual(['first', 'first', 'second'])
    window.dispatchEvent(new Event('pagehide'))
    channel.onmessage({ channel: 'fixture', args: ['after-unload'] })
    expect(callback).toHaveBeenCalledTimes(3)
  })
})
