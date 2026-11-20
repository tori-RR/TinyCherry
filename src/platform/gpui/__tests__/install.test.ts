import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const business = vi.hoisted(() => ({ install: vi.fn() }))
vi.mock('../../desktop-api/api', () => ({ installBusinessApi: business.install }))

interface RequestFrame {
  id: number
  session: string
  command: string
  args: Record<string, unknown>
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  vi.stubGlobal('location', new URL('http://tauri.localhost/windows/evostack/index.html'))
  vi.stubGlobal('desktop', undefined)
  business.install.mockReset()
})

afterEach(() => {
  window.dispatchEvent(new Event('pagehide'))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

function host() {
  const frames: RequestFrame[] = []
  vi.stubGlobal('ipc', { postMessage: (frame: string) => frames.push(JSON.parse(frame)) })
  return {
    frames,
    reply(frame: RequestFrame, result: unknown) {
      window.__TINYCHERRY_RECEIVE__?.({ session: frame.session, id: frame.id, result })
    }
  }
}

describe('GPUI renderer bootstrap', () => {
  it('awaits subscription acknowledgement before requesting metadata and installing the business API', async () => {
    const native = host()
    const { capabilityNames } = await import('../../desktop-api/capabilities')
    const { installDesktopApi } = await import('../install')
    const ready = installDesktopApi()
    expect(native.frames.map((frame) => frame.command)).toEqual(['subscribe'])
    expect(window.__TINYCHERRY_RECEIVE__).toBeTypeOf('function')
    expect(window.desktop).toBeUndefined()
    expect(business.install).not.toHaveBeenCalled()

    native.reply(native.frames[0], null)
    await vi.waitFor(() => expect(native.frames).toHaveLength(2))
    expect(native.frames[1]).toMatchObject({
      command: 'desktop_info',
      session: native.frames[0].session,
      args: {}
    })
    expect(window.desktop).toBeUndefined()
    expect(business.install).not.toHaveBeenCalled()

    const info = {
      platform: 'win32',
      arch: 'x64',
      version: '2.2.2',
      revision: 'bootstrap-test',
      protocol: 1,
      capabilities: Object.fromEntries(capabilityNames.map((name) => [name, false]))
    }
    native.reply(native.frames[1], info)
    await ready
    expect(window.desktop.info).toEqual(info)
    expect(business.install).toHaveBeenCalledOnce()
    expect(native.frames.map((frame) => frame.command)).toEqual(['subscribe', 'desktop_info'])
  })

  it('does not proceed to metadata or business startup after subscription failure', async () => {
    const native = host()
    const { installDesktopApi } = await import('../install')
    const ready = installDesktopApi()
    const { session, id } = native.frames[0]
    window.__TINYCHERRY_RECEIVE__?.({ session, id, error: 'EVOSTACK_RENDERER_SESSION_EXPIRED' })
    await expect(ready).rejects.toThrow('EVOSTACK_RENDERER_SESSION_EXPIRED')
    expect(native.frames.map((frame) => frame.command)).toEqual(['subscribe'])
    expect(window.desktop).toBeUndefined()
    expect(business.install).not.toHaveBeenCalled()
  })
})
