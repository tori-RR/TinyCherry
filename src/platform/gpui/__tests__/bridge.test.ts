import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface RequestFrame {
  id: number
  session: string
  command: string
  args: Record<string, unknown>
}

function host() {
  const requests: RequestFrame[] = []
  const postMessage = vi.fn((frame: string) => requests.push(JSON.parse(frame)))
  vi.stubGlobal('ipc', { postMessage })
  const reply = (request: RequestFrame, result: unknown) =>
    window.__TINYCHERRY_RECEIVE__?.({ session: request.session, id: request.id, result })
  return { requests, postMessage, reply }
}

beforeEach(() => {
  vi.stubGlobal('location', new URL('http://tauri.localhost/windows/evostack/index.html'))
})

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.resetModules()
})

describe('Wry document bridge', () => {
  it('correlates out-of-order JSON replies and preserves Unicode and binary DTO arrays', async () => {
    const native = host()
    const { invokeHost } = await import('../bridge')
    const first = invokeHost('ipc_request', { channel: 'fixture', args: ['🍒', [0, 255]] })
    const second = invokeHost('desktop_info')
    expect(native.requests[0]).toMatchObject({
      id: 1,
      command: 'ipc_request',
      args: { channel: 'fixture', args: ['🍒', [0, 255]] }
    })
    expect(native.requests[0].session).toMatch(/^[a-f\d-]{36}$/)
    expect(native.requests[1]).toMatchObject({
      id: 2,
      session: native.requests[0].session,
      command: 'desktop_info',
      args: {}
    })
    native.reply(native.requests[1], { platform: 'win32' })
    await expect(second).resolves.toEqual({ platform: 'win32' })
    native.reply(native.requests[0], { text: 'line\n"quote"\u2028🍒', bytes: [0, 255] })
    await expect(first).resolves.toEqual({ text: 'line\n"quote"\u2028🍒', bytes: [0, 255] })
  })

  it('ignores stale document replies, unknown IDs and duplicate replies', async () => {
    const native = host()
    const { invokeHost } = await import('../bridge')
    const settled = vi.fn()
    const result = invokeHost('desktop_info').then(settled)
    const frame = native.requests[0]
    window.__TINYCHERRY_RECEIVE__?.({ session: 'old-document', id: frame.id, result: 'stale' })
    window.__TINYCHERRY_RECEIVE__?.({ session: frame.session, id: frame.id + 1, result: 'unknown' })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    native.reply(frame, 'current')
    native.reply(frame, 'duplicate')
    await result
    expect(settled).toHaveBeenCalledExactlyOnceWith('current')
  })

  it('rejects host failures and malformed response envelopes', async () => {
    const native = host()
    const { invokeHost } = await import('../bridge')
    const rejected = invokeHost('desktop_info')
    let frame = native.requests.at(-1)!
    window.__TINYCHERRY_RECEIVE__?.({ session: frame.session, id: frame.id, error: 'EVOSTACK_BACKEND_EXITED' })
    await expect(rejected).rejects.toThrow('EVOSTACK_BACKEND_EXITED')
    for (const invalid of [{ error: 7 }, { result: true, error: 'contradictory' }, {}]) {
      const request = invokeHost('desktop_info')
      frame = native.requests.at(-1)!
      window.__TINYCHERRY_RECEIVE__?.({ session: frame.session, id: frame.id, ...invalid })
      await expect(request).rejects.toThrow('EVOSTACK_INVALID_RESPONSE')
    }
  })

  it('rejects timed-out mutations without replay and releases their in-flight slot', async () => {
    vi.useFakeTimers()
    const native = host()
    const { invokeHost } = await import('../bridge')
    const request = invokeHost('ipc_request', { channel: 'preference:set', args: ['theme', 'dark'] })
    const rejected = expect(request).rejects.toThrow('outcome unknown; no retry')
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
    expect(native.postMessage).toHaveBeenCalledOnce()
    native.reply(native.requests[0], 'late success')
    const next = invokeHost('desktop_info')
    native.reply(native.requests[1], 'available')
    await expect(next).resolves.toBe('available')
  })

  it.each([
    { channel: 'file:selectFolder', args: [] },
    { channel: 'ipc-api:request', args: ['painting.file.export', { fileId: 'registered-image' }] },
    { channel: 'ipc-api:request', args: ['skill.install_from_directory'] }
  ])('keeps a user-operated native dialog pending past the network timeout: $channel', async (args) => {
    vi.useFakeTimers()
    const native = host()
    const { invokeHost } = await import('../bridge')
    const settled = vi.fn()
    const request = invokeHost('ipc_request', args).then(settled)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(settled).not.toHaveBeenCalled()
    expect(native.postMessage).toHaveBeenCalledOnce()
    native.reply(native.requests[0], { saved: false })
    await request
    expect(settled).toHaveBeenCalledWith({ saved: false })
  })

  it('bounds outstanding requests and resumes after a reply frees a slot', async () => {
    const native = host()
    const { invokeHost } = await import('../bridge')
    const requests = Array.from({ length: 128 }, () => invokeHost('desktop_info'))
    await expect(invokeHost('desktop_info')).rejects.toThrow('EVOSTACK_BUSY')
    expect(native.postMessage).toHaveBeenCalledTimes(128)
    native.reply(native.requests[0], null)
    await requests[0]
    requests.push(invokeHost('desktop_info'))
    for (const frame of native.requests.slice(1)) native.reply(frame, null)
    await Promise.all(requests)
    expect(native.postMessage).toHaveBeenCalledTimes(129)
  })

  it('measures frame limits in UTF-8 bytes and never sends an oversized request', async () => {
    const native = host()
    const { invokeHost } = await import('../bridge')
    await expect(invokeHost('ipc_request', { channel: 'fixture', args: ['🍒'.repeat(1024 * 1024)] })).rejects.toThrow(
      'EVOSTACK_REQUEST_TOO_LARGE'
    )
    expect(native.postMessage).not.toHaveBeenCalled()
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    await expect(invokeHost('ipc_request', cyclic)).rejects.toThrow()
    expect(native.postMessage).not.toHaveBeenCalled()
  })

  it('propagates synchronous postMessage failures without leaking request slots', async () => {
    const native = host()
    native.postMessage.mockImplementation(() => {
      throw new Error('native pipe closed')
    })
    const { invokeHost } = await import('../bridge')
    for (let count = 0; count < 129; count++)
      await expect(invokeHost('desktop_info')).rejects.toThrow('native pipe closed')
    expect(native.postMessage).toHaveBeenCalledTimes(129)
  })

  it('rejects all pending work on pagehide and ignores later events and replies', async () => {
    const native = host()
    const { invokeHost, onHostEvent } = await import('../bridge')
    const event = vi.fn()
    onHostEvent(event)
    const request = invokeHost('desktop_info')
    const receive = window.__TINYCHERRY_RECEIVE__!
    const frame = native.requests[0]
    window.dispatchEvent(new Event('pagehide'))
    await expect(request).rejects.toThrow('EVOSTACK_RENDERER_CLOSED')
    expect(window.__TINYCHERRY_RECEIVE__).toBeUndefined()
    receive({ session: frame.session, id: frame.id, result: 'late' })
    receive({ session: frame.session, event: { channel: 'fixture', args: [] } })
    expect(event).not.toHaveBeenCalled()
    await expect(invokeHost('desktop_info')).rejects.toThrow('EVOSTACK_RENDERER_CLOSED')
    expect(native.postMessage).toHaveBeenCalledOnce()
  })

  it('delivers current-session events and disposes listeners independently', async () => {
    const native = host()
    const { invokeHost, onHostEvent } = await import('../bridge')
    const first = vi.fn()
    const second = vi.fn()
    const dispose = onHostEvent(first)
    onHostEvent(second)
    const request = invokeHost('subscribe')
    const frame = native.requests[0]
    native.reply(frame, null)
    await request
    const event = { channel: 'ipc-api:event', args: ['ai.projection.changed', {}] }
    window.__TINYCHERRY_RECEIVE__?.({ session: 'old', event })
    expect(first).not.toHaveBeenCalled()
    window.__TINYCHERRY_RECEIVE__?.({ session: frame.session, event })
    dispose()
    window.__TINYCHERRY_RECEIVE__?.({ session: frame.session, event })
    expect(first).toHaveBeenCalledExactlyOnceWith(event)
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('rejects untrusted pages before installing the receiver or sending IPC', async () => {
    const native = host()
    vi.stubGlobal('location', new URL('https://attacker.example'))
    const { invokeHost, isTrustedHostUrl } = await import('../bridge')
    await expect(invokeHost('desktop_info')).rejects.toThrow('EVOSTACK_UNTRUSTED_FRONTEND')
    expect(native.postMessage).not.toHaveBeenCalled()
    expect(window.__TINYCHERRY_RECEIVE__).toBeUndefined()
    for (const url of [
      'malformed',
      'http://tinycherry.localhost/',
      'tinycherry://localhost/',
      'http://tauri.localhost.attacker/',
      'http://user@tauri.localhost/',
      'http://127.0.0.1:17420/'
    ])
      expect(isTrustedHostUrl(url), url).toBe(false)
  })
})
