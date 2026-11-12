import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BaseService } from '@main/core/lifecycle'
import type { AdvertisedRemoteEndpoint } from '@shared/data/preference/preferenceTypes'

/**
 * Exercises `ApiGatewayService`'s reconcile-after-settle convergence: a toggle that
 * lands during an in-flight activation must be honoured (no queue, no dropped opposing
 * toggle), and a persistently failing transition must not spin the loop.
 *
 * The inner `ApiGateway` server is mocked so activation timing is controllable; the
 * preference-change handler is captured so the toggle can be driven directly.
 */

const {
  mockStart,
  mockStop,
  mockRebind,
  mockSetShared,
  mockGetActiveUsageContext,
  mockPreferenceSet,
  mockPreferenceSetMultiple,
  captured
} = vi.hoisted(() => ({
  mockStart: vi.fn(),
  mockStop: vi.fn(),
  mockRebind: vi.fn(),
  mockSetShared: vi.fn(),
  mockGetActiveUsageContext: vi.fn(),
  mockPreferenceSet: vi.fn<(key: string, value: boolean | string) => Promise<void>>(),
  mockPreferenceSetMultiple: vi.fn<(updates: Record<string, unknown>) => Promise<void>>(),
  captured: {
    prefHandler: undefined as ((enabled: boolean) => void) | undefined,
    enabledPreference: false,
    hostPreference: '127.0.0.1',
    portPreference: 23333,
    ipv6Addresses: [] as string[],
    advertisedEndpoint: null as AdvertisedRemoteEndpoint | null,
    ipv6Listening: true
  }
}))

vi.mock('../server', () => ({
  ApiGateway: vi.fn(function ApiGatewayMock(endpoint: { host: string; port: number }) {
    let host: string | undefined = endpoint.host
    return {
      start: mockStart,
      stop: mockStop,
      isRunning: () => host !== undefined,
      getPort: () => endpoint.port,
      getHost: () => host,
      getHosts: () => (host ? [host, ...(captured.ipv6Listening ? [host === '0.0.0.0' ? '::' : '::1'] : [])] : []),
      rebind: async (nextHost: string) => {
        host = undefined
        await mockRebind(nextHost)
        host = nextHost
      }
    }
  })
}))

vi.mock('@data/services/ApiGatewayPairedDeviceService', () => ({
  apiGatewayPairedDeviceService: { create: vi.fn() }
}))

vi.mock('systeminformation', () => ({ networkInterfaces: async () => [] }))

vi.mock('node:os', () => ({
  hostname: () => 'desktop',
  networkInterfaces: () => ({
    en0: [
      { address: '192.168.1.8', family: 'IPv4', internal: false },
      ...captured.ipv6Addresses.map((address) => ({ address, family: 'IPv6', internal: false }))
    ]
  })
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    PreferenceService: {
      subscribeChange: vi.fn((_key: string, cb: (enabled: boolean) => void) => {
        captured.prefHandler = cb
        return () => {}
      }),
      get: vi.fn((key: string) => {
        if (key === 'app.language') return 'en-US'
        if (key.endsWith('advertised_endpoint')) return captured.advertisedEndpoint
        return key.endsWith('api_key') ? 'existing-key' : false
      }),
      getMultiple: vi.fn(() => ({
        enabled: captured.enabledPreference,
        host: captured.hostPreference,
        port: captured.portPreference,
        apiKey: 'existing-key'
      })),
      set: mockPreferenceSet,
      setMultiple: mockPreferenceSetMultiple
    },
    CacheService: { setShared: mockSetShared },
    AgentSessionRuntimeService: { getActiveUsageContext: mockGetActiveUsageContext },
    RemoteAccessService: {
      updateDirectEndpoint: vi.fn(),
      closeIngress: vi.fn(),
      createInvitation: vi.fn(async () => ({
        invitationId: 'invitation',
        invitationSecret: 'secret',
        expiresAt: '2026-09-22T00:02:00.000Z',
        desktopIdentity: '12D3KooWDesktop',
        protocolVersions: [1]
      }))
    }
  } as any)
})

import { ApiGatewayService } from '../ApiGatewayService'
import { ApiGateway } from '../server'

let startResolvers: Array<() => void>
let rejectStart: boolean

beforeEach(() => {
  BaseService.resetInstances()
  captured.prefHandler = undefined
  captured.enabledPreference = false
  captured.hostPreference = '127.0.0.1'
  captured.portPreference = 23333
  captured.ipv6Addresses = []
  captured.advertisedEndpoint = null
  captured.ipv6Listening = true
  mockPreferenceSet.mockReset()
  mockPreferenceSet.mockImplementation(async (key, value) => {
    if (key === 'feature.api_gateway.enabled') captured.enabledPreference = value as boolean
    if (key === 'feature.api_gateway.host') captured.hostPreference = value as string
  })
  mockPreferenceSetMultiple.mockReset()
  mockPreferenceSetMultiple.mockImplementation(async (updates) => {
    const host = updates['feature.api_gateway.host']
    const enabled = updates['feature.api_gateway.enabled']
    if (typeof host === 'string') captured.hostPreference = host
    if (typeof enabled === 'boolean') captured.enabledPreference = enabled
  })
  startResolvers = []
  rejectStart = false
  mockStart.mockReset()
  mockStop.mockReset()
  mockRebind.mockReset().mockResolvedValue(undefined)
  mockSetShared.mockClear()
  mockGetActiveUsageContext.mockReset()
  mockGetActiveUsageContext.mockReturnValue({
    agentSessionId: 'session-1',
    source: { type: 'agent', id: 'agent-1', name: 'Original Agent', icon: '🧠' }
  })
  mockStart.mockImplementation(() =>
    rejectStart
      ? Promise.reject(new Error('port in use'))
      : new Promise<void>((resolve) => startResolvers.push(resolve))
  )
  mockStop.mockResolvedValue(undefined)
})

async function startInternalGateway(service: ApiGatewayService) {
  const pending = service.ensureInternalGateway()
  await vi.waitFor(() => expect(startResolvers.length).toBeGreaterThan(0))
  startResolvers.at(-1)!()
  return pending
}

const CHAT_SCOPE = { path: '/v1/chat/completions', model: 'openai:gpt-4o' }

describe('ApiGatewayService internal gateway', () => {
  it('shares bounded permission retries across consumers and returns usable credentials after recovery', async () => {
    const service = new ApiGatewayService()
    const original = Object.assign(new Error('denied'), { code: 'EACCES', syscall: 'listen' })
    mockStart.mockRejectedValueOnce(original).mockRejectedValueOnce(original).mockResolvedValueOnce(undefined)
    const config = service.getCurrentConfig()
    const [internal, scoped] = await Promise.all([
      service.ensureInternalGateway(),
      service.createScopedCredential(CHAT_SCOPE)
    ])

    expect(mockStart).toHaveBeenCalledTimes(3)
    expect(vi.mocked(ApiGateway).mock.calls).toEqual(
      Array.from({ length: 3 }, () => [{ host: '127.0.0.1', port: 0 }, 'internal'])
    )
    expect(scoped.baseUrl).toBe(internal.baseUrl)
    expect(service.getInternalGatewayOrigin()).toBe(internal.baseUrl)
    expect(service.isInternalRequest(new Headers({ 'x-api-key': internal.apiKey }))).toBe(true)
    expect(service.getCredentialScope(new Headers({ 'x-api-key': scoped.apiKey }))).toEqual(CHAT_SCOPE)
    expect(service.getCurrentConfig()).toEqual(config)
    expect(service.isActivated).toBe(false)
  })

  it.each([
    { code: 'EADDRINUSE', syscall: 'listen' },
    { code: 'EACCES', syscall: 'open' },
    { code: 'EAFNOSUPPORT', syscall: 'listen' }
  ])('does not automatically retry unrelated failures: $code / $syscall', async (fields) => {
    const service = new ApiGatewayService()
    const original = Object.assign(new Error('failed'), fields)
    mockStart.mockRejectedValue(original)

    await expect(service.ensureInternalGateway()).rejects.toBe(original)
    expect(mockStart).toHaveBeenCalledTimes(1)
    expect(service.getInternalGatewayOrigin()).toBeUndefined()
  })

  it('reports internal permission recovery to concurrent consumers and allows a later retry without public changes', async () => {
    const service = new ApiGatewayService()
    const original = Object.assign(new Error('denied'), {
      code: 'EACCES',
      syscall: 'listen',
      address: '::1',
      port: 49152
    })
    mockStart.mockRejectedValueOnce(original).mockRejectedValueOnce(original).mockRejectedValueOnce(original)
    const config = service.getCurrentConfig()
    const results = await Promise.allSettled([
      service.ensureInternalGateway(),
      service.createScopedCredential(CHAT_SCOPE)
    ])
    for (const result of results) {
      expect(result.status).toBe('rejected')
      if (result.status === 'rejected') {
        expect(result.reason.message).toContain('internal API Gateway')
        expect(result.reason.message).toContain('::1, requested TCP port 49152')
        expect(result.reason.message).toContain('Retry the request')
        expect(result.reason.cause).toBe(original)
      }
    }
    expect(mockStart).toHaveBeenCalledTimes(3)
    expect(service.getInternalGatewayOrigin()).toBeUndefined()
    expect(service.getCurrentConfig()).toEqual(config)
    expect(mockSetShared).not.toHaveBeenCalled()
    expect(mockPreferenceSet).not.toHaveBeenCalled()
    await expect(startInternalGateway(service)).resolves.toMatchObject({ baseUrl: expect.any(String) })
    expect(service.getInternalGatewayOrigin()).toBeDefined()
  })

  it('serves internal consumers from one loopback listener without enabling the user-facing gateway', async () => {
    const service = new ApiGatewayService()
    await service._doInit()

    const internal = await startInternalGateway(service)
    const scoped = await service.createScopedCredential(CHAT_SCOPE)

    expect(vi.mocked(ApiGateway)).toHaveBeenCalledOnce()
    expect(vi.mocked(ApiGateway)).toHaveBeenCalledWith({ host: '127.0.0.1', port: 0 }, 'internal')
    expect(scoped.baseUrl).toBe(internal.baseUrl)
    expect(service.getInternalGatewayOrigin()).toBe(internal.baseUrl)
    expect(service.isActivated).toBe(false)
    expect(captured.enabledPreference).toBe(false)
  })

  it('retries the internal listener after a failed start', async () => {
    const service = new ApiGatewayService()
    rejectStart = true
    await expect(service.ensureInternalGateway()).rejects.toThrow('port in use')

    rejectStart = false
    await expect(startInternalGateway(service)).resolves.toMatchObject({ baseUrl: expect.any(String) })
    expect(vi.mocked(ApiGateway)).toHaveBeenCalledTimes(2)
  })

  it('recognizes internal credentials in every header dialect and never the user key', async () => {
    const service = new ApiGatewayService()
    const internal = await startInternalGateway(service)
    const scoped = await service.createScopedCredential(CHAT_SCOPE)

    expect(service.isInternalRequest(new Headers({ 'x-api-key': internal.apiKey }))).toBe(true)
    expect(service.isInternalRequest(new Headers({ authorization: `Bearer ${scoped.apiKey}` }))).toBe(true)
    expect(service.isInternalRequest(new Headers({ 'x-goog-api-key': internal.apiKey }))).toBe(true)
    expect(service.isInternalRequest(new Headers({ 'x-api-key': 'existing-key' }))).toBe(false)
    expect(service.isInternalRequest(new Headers())).toBe(false)
  })

  it('binds each scoped credential to its own scope and revokes it on dispose', async () => {
    const service = new ApiGatewayService()
    const internal = await startInternalGateway(service)
    const first = await service.createScopedCredential(CHAT_SCOPE)
    const second = await service.createScopedCredential({ ...CHAT_SCOPE, model: 'cherryai-subscription:qwen3.8-flash' })
    const headers = (apiKey: string) => new Headers({ authorization: `Bearer ${apiKey}` })

    expect(first.apiKey).not.toBe(second.apiKey)
    expect(service.getCredentialScope(headers(first.apiKey))).toEqual(CHAT_SCOPE)
    expect(service.getCredentialScope(headers(second.apiKey))?.model).toBe('cherryai-subscription:qwen3.8-flash')
    expect(service.getCredentialScope(headers(internal.apiKey))).toBeUndefined()

    first.dispose()
    expect(service.isInternalRequest(headers(first.apiKey))).toBe(false)
    expect(service.getCredentialScope(headers(first.apiKey))).toBeUndefined()
    expect(service.isInternalRequest(headers(second.apiKey))).toBe(true)
  })

  it('attributes usage to an Agent session only for the unrestricted internal key', async () => {
    const service = new ApiGatewayService()
    const internal = await startInternalGateway(service)
    const scoped = await service.createScopedCredential(CHAT_SCOPE)
    const sessionHeaders = service.getAgentSessionUsageHeaders('session-1')

    expect(service.resolveAgentSessionUsage(new Headers({ ...sessionHeaders, 'x-api-key': internal.apiKey }))).toEqual({
      agentSessionId: 'session-1',
      source: { type: 'agent', id: 'agent-1', name: 'Original Agent', icon: '🧠' }
    })
    expect(mockGetActiveUsageContext).toHaveBeenCalledWith('session-1')
    expect(service.getAgentSessionId(new Headers({ ...sessionHeaders, 'x-api-key': scoped.apiKey }))).toBeUndefined()
    expect(service.getAgentSessionId(new Headers({ ...sessionHeaders, 'x-api-key': 'existing-key' }))).toBeUndefined()
  })
})

it('keeps the saved public Gateway disabled at boot and serves internal callers on demand', async () => {
  captured.enabledPreference = true
  captured.hostPreference = '0.0.0.0'
  const service = new ApiGatewayService()
  await service._doInit()
  expect(mockStart).not.toHaveBeenCalled()
  expect(captured.prefHandler).toBeUndefined()
  expect(service.isRunning()).toBe(false)
  await startInternalGateway(service)
  expect(mockStart).toHaveBeenCalledOnce()
  expect(service.isRunning()).toBe(false)
})
