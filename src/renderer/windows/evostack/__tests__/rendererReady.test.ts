import { afterEach, describe, expect, it, vi } from 'vitest'

import { reportRendererReady } from '../rendererReady'

const host = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@platform/tauri/transport', () => ({ nativeTransport: { request: host.invoke } }))

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('native renderer readiness', () => {
  it('waits for the interactive React welcome instead of accepting a boot spinner', async () => {
    const invoke = host.invoke.mockReset().mockResolvedValue(undefined)
    document.body.innerHTML = '<div id="root"><img alt="boot" /></div>'
    const ready = reportRendererReady()
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
    document.getElementById('root')!.innerHTML = '<h1>Welcome</h1><button>Configure</button>'
    await ready
    expect(invoke).toHaveBeenCalledExactlyOnceWith('evostack:renderer-ready', 'onboarding')
    document.getElementById('root')!.append(document.createElement('div'))
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('recognizes an existing-profile workspace and cancels when the page closes during boot', async () => {
    const invoke = host.invoke.mockReset().mockResolvedValue(undefined)
    document.body.innerHTML = '<div id="root"><main data-ui="app.content"></main></div>'
    await reportRendererReady()
    expect(invoke).toHaveBeenCalledWith('evostack:renderer-ready', 'workspace')
    invoke.mockClear()
    document.getElementById('root')!.replaceChildren()
    const closed = reportRendererReady()
    window.dispatchEvent(new Event('pagehide'))
    await expect(closed).rejects.toThrow('EVOSTACK_RENDERER_CLOSED')
    document.getElementById('root')!.innerHTML = '<main data-ui="app.content"></main>'
    await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })
})
