import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyMessageProjectionUpdate, type MessageProjectionView } from '@shared/ai/messageProjection'

import { isTrustedHostUrl } from '../transport'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, failed) => {
    resolve = done
    reject = failed
  })
  return { promise, resolve, reject }
}

function fakeHost(
  invoke: (command: string, args: any) => unknown,
  subscribe: () => Promise<unknown> = async () => undefined
) {
  class Channel {
    static instances: Channel[] = []
    onmessage: (message: { channel: string; args: unknown[] }) => void = () => {}
    constructor() {
      Channel.instances.push(this)
    }
  }
  const coreInvoke = vi.fn((command: string, args: unknown) =>
    command === 'subscribe' ? subscribe() : invoke(command, args)
  )
  vi.stubGlobal('__TAURI__', { core: { invoke: coreInvoke, Channel } })
  return { channels: Channel.instances, coreInvoke }
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('location', new URL('http://tauri.localhost/windows/evostack/index.html'))
})

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('EvoStack transport', () => {
  it('waits for one event subscription before sending queued requests', async () => {
    const ready = deferred<void>()
    const invoke = vi.fn().mockResolvedValue({ ok: true })
    const host = fakeHost(invoke, () => ready.promise)
    const { nativeTransport } = await import('../transport')
    const first = nativeTransport.request('ipc-api:request', 'fixture.first')
    const second = nativeTransport.request('ipc-api:request', 'fixture.second')
    expect(host.channels).toHaveLength(1)
    expect(invoke).not.toHaveBeenCalled()
    ready.resolve()
    await Promise.all([first, second])
    expect(host.coreInvoke.mock.calls.filter(([command]) => command === 'subscribe')).toHaveLength(1)
    expect(invoke.mock.calls.map(([, args]) => args.args[0])).toEqual(['fixture.first', 'fixture.second'])
  })

  it('does not retry a failed transport subscription or deliver its queued mutation', async () => {
    const invoke = vi.fn()
    const host = fakeHost(invoke, async () => {
      throw new Error('subscription failed')
    })
    const { nativeTransport } = await import('../transport')
    await expect(nativeTransport.request('ipc-api:request', 'fixture.write')).rejects.toThrow('subscription failed')
    await expect(nativeTransport.request('ipc-api:request', 'fixture.write')).rejects.toThrow('subscription failed')
    expect(host.coreInvoke).toHaveBeenCalledOnce()
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(['pagehide', 'backend-exited'])(
    'does not flush queued mutations after %s during subscription',
    async (reason) => {
      const ready = deferred<void>()
      const invoke = vi.fn()
      const host = fakeHost(invoke, () => ready.promise)
      const { nativeTransport } = await import('../transport')
      const request = nativeTransport.request('ipc-api:request', 'fixture.write')
      if (reason === 'pagehide') window.dispatchEvent(new Event('pagehide'))
      else host.channels[0].onmessage({ channel: 'evostack:backend-exited', args: [] })
      ready.resolve()
      await expect(request).rejects.toThrow(
        reason === 'pagehide' ? 'EVOSTACK_RENDERER_CLOSED' : 'EVOSTACK_BACKEND_EXITED'
      )
      expect(invoke).not.toHaveBeenCalled()
    }
  )

  it('encodes only the owned nested avatar bytes and preserves subarray boundaries and caller objects', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true })
    fakeHost(invoke)
    const { nativeTransport } = await import('../transport')
    const avatar = Object.freeze({ kind: 'image', data: new Uint8Array([1, 127, 255, 2]).subarray(1, 3) })
    const input = Object.freeze({ assistantId: 'assistant-1', avatar })
    const result = await nativeTransport.request('ipc-api:request', 'assistant.set_avatar', input)
    expect(result).toEqual({ ok: true, data: undefined })
    expect(invoke).toHaveBeenCalledExactlyOnceWith('ipc_request', {
      channel: 'ipc-api:request',
      args: ['assistant.set_avatar', { assistantId: 'assistant-1', avatar: { kind: 'image', data: [127, 255] } }]
    })
    expect(input.avatar).toBe(avatar)
    expect(input.avatar.data).toBeInstanceOf(Uint8Array)
    await nativeTransport.request('ipc-api:request', 'assistant.set_avatar', {
      assistantId: 'assistant-1',
      avatar: { kind: 'emoji', emoji: '🍒' }
    })
    expect(invoke.mock.calls.at(-1)?.[1].args[1].avatar).toEqual({ kind: 'emoji', emoji: '🍒' })
  })

  it('terminates each live projection once on backend loss while retaining its latest partial text', async () => {
    const baseline: MessageProjectionView = {
      kind: 'topic',
      topicId: 'topic-1',
      revision: 4,
      executions: [{ executionId: 'provider::model', attemptId: 7, messageId: 'reply-1', status: 'active' }],
      messages: [
        {
          id: 'reply-1',
          role: 'assistant',
          metadata: { status: 'pending' },
          parts: [{ type: 'text', text: 'Hello', state: 'streaming' }]
        }
      ]
    }
    const attach = deferred<unknown>()
    const invoke = vi.fn((_, args) =>
      args.args[0] === 'ai.projection.attach' ? attach.promise : Promise.resolve({ ok: true })
    )
    const host = fakeHost(invoke)
    const { nativeTransport, installHostTransport } = await import('../transport')
    await installHostTransport()
    const events = vi.fn()
    nativeTransport.subscribe('ipc-api:event', events)
    const cache = vi.fn()
    nativeTransport.subscribe('cache:sync', cache)
    const request = nativeTransport.request('ipc-api:request', 'ai.projection.attach', {
      target: { kind: 'topic', topicId: 'topic-1' },
      subscriptionId: 'lease-1'
    })
    await Promise.resolve()
    const update = {
      kind: 'topic',
      topicId: 'topic-1',
      revision: 5,
      executions: baseline.executions,
      patches: [{ type: 'append', messageId: 'reply-1', part: 0, text: ' world' }],
      order: ['reply-1']
    }
    host.channels[0].onmessage({
      channel: 'ipc-api:event',
      args: ['ai.projection.changed', { subscriptionId: 'lease-1', update }]
    })
    attach.resolve({ ok: true, data: baseline })
    await request
    host.channels[0].onmessage({ channel: 'evostack:backend-exited', args: [] })
    host.channels[0].onmessage({ channel: 'evostack:backend-exited', args: [] })
    const terminal = events.mock.calls.filter(
      ([, route, value]) => route === 'ai.projection.changed' && value.update.revision === 6
    )
    expect(terminal).toHaveLength(1)
    const latest = applyMessageProjectionUpdate(baseline, update)!
    const lost = applyMessageProjectionUpdate(latest, terminal[0][2].update)!
    if (lost.kind !== 'topic') throw new Error('Expected topic projection')
    expect(lost.executions).toEqual([{ ...baseline.executions[0], status: 'unresolved' }])
    expect(lost.messages[0].parts).toEqual([
      { type: 'text', text: 'Hello world', state: 'done' },
      { type: 'data-error', data: { name: 'Error', message: expect.stringContaining('EVOSTACK_BACKEND_EXITED') } }
    ])
    expect(cache.mock.calls.map(([, value]) => value)).toContainEqual(
      expect.objectContaining({
        key: 'topic.stream.statuses.topic-1',
        value: { status: 'error', activeExecutions: [], awaitingApprovalAnchors: [] }
      })
    )
    const calls = invoke.mock.calls.length
    await expect(nativeTransport.request('ipc-api:request', 'ai.stream.open', {})).rejects.toThrow(
      'EVOSTACK_BACKEND_EXITED'
    )
    expect(invoke).toHaveBeenCalledTimes(calls)
    await nativeTransport.request('ipc-api:request', 'window.close')
    expect(invoke).toHaveBeenCalledTimes(calls + 1)
  })

  it('rejects late replies after backend loss without replaying or reviving the request', async () => {
    const response = deferred<unknown>()
    const invoke = vi.fn(() => response.promise)
    const host = fakeHost(invoke)
    const { nativeTransport, installHostTransport } = await import('../transport')
    await installHostTransport()
    const request = nativeTransport.request('ipc-api:request', 'fixture.write')
    await Promise.resolve()
    host.channels[0].onmessage({ channel: 'evostack:backend-exited', args: [] })
    response.resolve({ ok: true })
    await expect(request).rejects.toThrow('EVOSTACK_BACKEND_EXITED')
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('clears a detached lease before its late attach baseline can become live', async () => {
    const baseline = deferred<unknown>()
    const invoke = vi.fn((_, args) =>
      args.args[0] === 'ai.projection.attach' ? baseline.promise : Promise.resolve({ ok: true })
    )
    const host = fakeHost(invoke)
    const { nativeTransport, installHostTransport } = await import('../transport')
    await installHostTransport()
    const events = vi.fn()
    nativeTransport.subscribe('ipc-api:event', events)
    const input = { target: { kind: 'topic', topicId: 'topic-1' }, subscriptionId: 'lease-1' }
    const attached = nativeTransport.request('ipc-api:request', 'ai.projection.attach', input)
    await Promise.resolve()
    await nativeTransport.request('ipc-api:request', 'ai.projection.detach', {
      subscriptionId: input.subscriptionId,
      target: { topicId: 'topic-1', kind: 'topic' }
    })
    baseline.resolve({
      ok: true,
      data: { kind: 'topic', topicId: 'topic-1', revision: 1, messages: [], executions: [{ status: 'active' }] }
    })
    await attached
    host.channels[0].onmessage({ channel: 'evostack:backend-exited', args: [] })
    expect(events).not.toHaveBeenCalled()
  })

  it('passes notification and data invalidation envelopes through without synthesizing success', async () => {
    const host = fakeHost(vi.fn())
    const { nativeTransport, installHostTransport } = await import('../transport')
    await installHostTransport()
    const callback = vi.fn()
    nativeTransport.subscribe('ipc-api:event', callback)
    const invalidation = vi.fn()
    nativeTransport.subscribe('data-api:data-changed', invalidation)
    const record = {
      id: 'saved-notification',
      category: 'system',
      target: { kind: 'conversation', conversationType: 'assistant', conversationId: 'topic-1' }
    }
    host.channels[0].onmessage({ channel: 'ipc-api:event', args: ['notification.present', record] })
    expect(callback).toHaveBeenCalledWith(expect.any(Object), 'notification.present', record)
    const changed = { resource: '/notifications', action: 'created' }
    host.channels[0].onmessage({ channel: 'data-api:data-changed', args: [changed] })
    expect(invalidation).toHaveBeenCalledWith(expect.any(Object), changed)
  })

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
    fakeHost(invoke)
    const { nativeTransport } = await import('../transport')
    const fs = { readText: (path: string) => nativeTransport.request('fs:readText', path) }

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
    fakeHost(invoke)
    const { nativeTransport } = await import('../transport')

    await expect(nativeTransport.request('fs:readText', 'C:\\private.txt')).rejects.toThrow(
      'File is outside a registered skill'
    )
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('rejects malformed bytes and undecodable text through the original text facade', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { content: [256] } })
      .mockResolvedValueOnce({ ok: true, data: { content: [0xff] } })
    fakeHost(invoke)
    const { nativeTransport } = await import('../transport')

    await expect(nativeTransport.request('fs:readText', 'C:\\fixture\\SKILL.md')).rejects.toThrow(
      'EVOSTACK_INVALID_BINARY_RESPONSE'
    )
    await expect(nativeTransport.request('fs:readText', 'C:\\fixture\\SKILL.md')).rejects.toThrow()
  })

  it('preserves file bytes across JSON without changing unrelated DTO arrays', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ ok: true, data: { data: [0, 127, 255], baseline: { contentHash: 'sha256:abcd' } } })
    fakeHost(invoke)
    const { nativeTransport } = await import('../transport')
    const read = await nativeTransport.request('ipc-api:request', 'file.edit.read', { editId: 'fixture' })
    expect(read.data.data).toEqual(new Uint8Array([0, 127, 255]))
    expect(read.data.baseline.contentHash).toBe('sha256:abcd')
    const input = { editId: 'fixture', data: new Uint8Array([0, 127, 255]) }
    await nativeTransport.request('ipc-api:request', 'file.edit.write', input)
    expect(invoke).toHaveBeenLastCalledWith('ipc_request', {
      channel: 'ipc-api:request',
      args: ['file.edit.write', { editId: 'fixture', data: [0, 127, 255] }]
    })
    expect(input.data).toBeInstanceOf(Uint8Array)
    const other = await nativeTransport.request('ipc-api:request', 'fixture.read')
    expect(other.data.data).toEqual([0, 127, 255])
  })

  it('rejects malformed binary replies rather than silently truncating bytes', async () => {
    fakeHost(vi.fn().mockResolvedValue({ ok: true, data: { content: [-1, 256] } }))
    const { nativeTransport } = await import('../transport')
    await expect(nativeTransport.request('ipc-api:request', 'file.read', {})).rejects.toThrow(
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
    fakeHost(invoke)
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
    const { installHostTransport, nativeTransport } = await import('../transport')
    await Promise.all([installHostTransport(), installHostTransport()])
    const channel = Channel.instances[0]
    expect(invoke).toHaveBeenCalledTimes(1)
    const callback = vi.fn()
    nativeTransport.subscribeOnce('fixture', callback)
    nativeTransport.subscribe('fixture', callback)

    channel.onmessage({ channel: 'fixture', args: ['first'] })
    channel.onmessage({ channel: 'fixture', args: ['second'] })
    expect(callback.mock.calls.map(([, value]) => value)).toEqual(['first', 'first', 'second'])
    window.dispatchEvent(new Event('pagehide'))
    channel.onmessage({ channel: 'fixture', args: ['after-unload'] })
    expect(callback).toHaveBeenCalledTimes(3)
  })
})
