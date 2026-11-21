import { afterEach, describe, expect, it, vi } from 'vitest'

import { isDesktopRouteAvailable } from '../capabilities'

afterEach(() => vi.unstubAllGlobals())

describe('restored desktop workspaces', () => {
  it('opens agents and every saved painting provider link only when the host implements them', () => {
    vi.stubGlobal('desktop', { info: { capabilities: { agents: true, painting: true } } })
    for (const route of ['/app/agents?sessionId=retained', '/app/paintings', '/app/paintings/zhipu#history']) {
      expect(isDesktopRouteAvailable(route)).toBe(true)
    }
    expect(isDesktopRouteAvailable('/app/agents-unrelated')).toBe(false)
    expect(isDesktopRouteAvailable('/app/paintings-unrelated')).toBe(false)
    vi.stubGlobal('desktop', { info: { capabilities: { agents: false, painting: false } } })
    expect(isDesktopRouteAvailable('/app/agents')).toBe(false)
    expect(isDesktopRouteAvailable('/app/paintings/zhipu')).toBe(false)
    expect(isDesktopRouteAvailable('/app/chat')).toBe(true)
  })
})
