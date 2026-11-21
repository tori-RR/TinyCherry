import { describe, expect, it } from 'vitest'

import { AgentTypeSchema } from '@shared/data/api/schemas/agents'
import type { Model } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import { AGENT_RUNTIME_CAPABILITIES } from '../agentRuntimeCapabilities'
import { isNativeAgentModelCompatible, NATIVE_AGENT_TOOLS } from '../nativeAgentRuntime'

const model = { id: 'p::model', providerId: 'p', isEnabled: true, capabilities: [] } as unknown as Model
const provider = {
  id: 'p',
  isEnabled: true,
  authType: 'api-key',
  defaultChatEndpoint: 'openai-chat-completions'
} as Provider

describe('native agent capability boundary', () => {
  it('preserves old runtime identifiers and makes native permissions explicit', () => {
    for (const type of ['native', 'claude-code', 'pi', 'pi-durable']) expect(AgentTypeSchema.parse(type)).toBe(type)
    const caps = AGENT_RUNTIME_CAPABILITIES.native
    expect(caps.permissionModes).toEqual(['default', 'plan'])
    expect(caps.createDefaults.permissionMode).toBe('default')
    expect(caps.mcp).toBe(false)
    expect(caps.skills).toBe(false)
    expect(caps.heartbeat).toBe(false)
    expect(caps.builtinTools().map((tool) => tool.id)).toEqual(NATIVE_AGENT_TOOLS.map((tool) => tool.id))
  })

  it('only offers enabled Chat Completions models, never an unsupported Responses subscription', () => {
    expect(isNativeAgentModelCompatible(provider, model)).toBe(true)
    expect(isNativeAgentModelCompatible(undefined, model)).toBe(false)
    expect(isNativeAgentModelCompatible({ ...provider, isEnabled: false }, model)).toBe(false)
    expect(isNativeAgentModelCompatible(provider, { ...model, isEnabled: false })).toBe(false)
    expect(isNativeAgentModelCompatible({ ...provider, defaultChatEndpoint: 'openai-responses' }, model)).toBe(false)
    expect(isNativeAgentModelCompatible({ ...provider, id: 'chatgpt-sub', authType: 'oauth' }, model)).toBe(false)
    expect(isNativeAgentModelCompatible(provider, { ...model, capabilities: ['embedding'] })).toBe(false)
  })
})
