import type { Client } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { connectMcpTestClient } from '@test-helpers/mcp/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ChannelsModule from '@main/ai/channels'
import type { AgentSessionWorkspaceSource } from '@shared/data/api/schemas/agentWorkspaces'

// Mock TaskService before importing CherryAutonomyTools
const mockCreateTask = vi.fn()
const mockListTasks = vi.fn()
const mockDeleteTask = vi.fn()
const mockGetNotifyAdapters = vi.fn()
const mockGetAgent = vi.fn()
const mockListAgents = vi.fn()
const mockUpdateAgent = vi.fn()
const mockQRCodeToDataURL = vi.fn()
const mockListChannels = vi.fn()
const mockCreateChannel = vi.fn()
const mockCreateChannelAndWaitForQr = vi.fn()
const mockGetChannel = vi.fn()
const mockUpdateChannel = vi.fn()
const mockUpdateChannelAndWaitForQr = vi.fn()
const mockDeleteChannel = vi.fn()
const mockReconnectChannel = vi.fn()
const mockReconnectChannelWithQr = vi.fn()
const mockGetSession = vi.fn()
const mockGetLatestActive = vi.fn()
const mockReadConversation = vi.fn()
const mockFindPersistedToolOutput = vi.fn()
const mockListSessions = vi.fn()
const mockSearchSessions = vi.fn()
const mockSearchSessionMessages = vi.fn()
const mockAcceptSessionDelivery = vi.fn()
const mockCreateSessionWithDelivery = vi.fn()
const mockListSessionDeliveries = vi.fn()
const mockGetInteractionState = vi.fn()

// Task reads stay on AgentTaskService; task commands (create / delete) go
// through the AgentJobsService routed via the application mock below.
vi.mock('@data/services/AgentTaskService', () => ({
  agentTaskService: {
    listTasks: mockListTasks
  }
}))

vi.mock('@data/services/AgentService', () => ({
  agentService: {
    getAgent: mockGetAgent,
    listAgents: mockListAgents,
    updateAgent: mockUpdateAgent
  }
}))

vi.mock('@main/ai/messages/readConversation', () => ({
  readConversation: mockReadConversation
}))
vi.mock('@main/ai/messages/persistedToolOutput', () => ({
  findPersistedToolOutput: mockFindPersistedToolOutput
}))

vi.mock('@data/services/AgentSessionService', () => ({
  agentSessionService: {
    getById: mockGetSession,
    getLatestActive: mockGetLatestActive,
    listAddressableByCursor: mockListSessions,
    searchWithMetadataEvidence: mockSearchSessions
  }
}))

vi.mock('@data/services/AgentSessionMessageService', () => ({
  AgentSessionDeliveryRoutingError: class extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  },
  agentSessionMessageService: {
    acceptSessionDelivery: mockAcceptSessionDelivery,
    createSessionWithDelivery: mockCreateSessionWithDelivery,
    listSessionDeliveries: mockListSessionDeliveries,
    searchRanked: mockSearchSessionMessages
  }
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    AgentJobsService: {
      createTask: mockCreateTask,
      deleteTask: mockDeleteTask
    },
    AgentSessionRuntimeService: {
      getInteractionState: mockGetInteractionState
    },
    AgentSessionDeliveryService: {
      accept: mockAcceptSessionDelivery,
      acceptWithNewSession: mockCreateSessionWithDelivery
    },
    ChannelManager: {
      getNotifyAdapters: mockGetNotifyAdapters,
      getAgentAdapters: mockGetNotifyAdapters,
      getAdapterStatuses: vi.fn().mockReturnValue([])
    }
  } as Parameters<typeof mockApplicationFactory>[0])
})

vi.mock('qrcode', () => ({
  default: { toDataURL: mockQRCodeToDataURL }
}))

vi.mock('@data/services/AgentChannelService', () => ({
  agentChannelService: {
    listChannels: mockListChannels,
    getChannel: mockGetChannel
  }
}))

vi.mock('@main/ai/channels', async (importOriginal) => {
  const actual = await importOriginal<typeof ChannelsModule>()
  return {
    ...actual,
    createAgentChannel: mockCreateChannel,
    createAgentChannelAndWaitForQr: mockCreateChannelAndWaitForQr,
    updateAgentChannel: mockUpdateChannel,
    updateAgentChannelAndWaitForQr: mockUpdateChannelAndWaitForQr,
    deleteAgentChannel: mockDeleteChannel,
    reconnectAgentChannel: mockReconnectChannel,
    reconnectAgentChannelWithQr: mockReconnectChannelWithQr
  }
})

vi.mock('@main/services/MainWindowService', () => ({
  windowService: {
    getMainWindow: vi.fn().mockReturnValue(null)
  }
}))

const { registerAutonomyTools } = await import('../cherryAutonomyTools')
const WORKSPACE_SOURCE = { type: 'system' as const }
const WORKSPACE_PATH = '/tmp/cherry-test-workspace'
const clients: Client[] = []

async function createServer(
  agentId = 'agent_test',
  workspacePath = WORKSPACE_PATH,
  notifyChannelIds: string | string[] | null = 'ch1',
  workspaceSource: AgentSessionWorkspaceSource = WORKSPACE_SOURCE
): Promise<Client> {
  const trustedNotifyChannels = (Array.isArray(notifyChannelIds) ? notifyChannelIds : [notifyChannelIds]).flatMap(
    (id) => (id ? [{ id, type: 'telegram' as const }] : [])
  )
  const client = await connectMcpTestClient(() => {
    const server = new McpServer({ name: 'cherry-tools', version: '1.0.0' })
    registerAutonomyTools(server, {
      agentId,
      sessionId: 'session_test',
      workspaceSource,
      workspacePath,
      trustedNotifyChannels,
      allowAnyOwnedNotifyChannel: typeof notifyChannelIds === 'string'
    })
    return server
  })
  clients.push(client)
  return client
}

// Returns `any` so assertions can poke content items without narrowing the SDK union.
async function callTool(
  server: Client | Promise<Client>,
  args: Record<string, unknown>,
  toolName = 'cron'
): Promise<any> {
  return (await server).callTool({ name: toolName, arguments: args })
}

async function listTools(server: Client | Promise<Client>) {
  return (await (await server).listTools()).tools
}

describe('cherry-tools autonomy tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetChannel.mockImplementation((channelId: string) => ({ id: channelId, agentId: 'agent_1' }))
    mockGetSession.mockReturnValue({ id: 'session_test', agentId: 'agent_test' })
    mockGetLatestActive.mockReturnValue(null)
    mockGetAgent.mockReturnValue({ id: 'agent_test', name: 'Agent A', model: 'provider::model' })
    mockListAgents.mockReturnValue({ agents: [], total: 0 })
    mockListSessions.mockReturnValue({ items: [], nextCursor: undefined })
    mockSearchSessions.mockReturnValue([])
    mockSearchSessionMessages.mockReturnValue([])
    mockListSessionDeliveries.mockReturnValue([])
    mockGetInteractionState.mockReturnValue({ currentTurn: 'interactive', userResponse: 'stream' })
  })

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()))
  })

  it('advertises read and search without channel tools', async () => {
    const tools = await listTools(createServer('agent_test', WORKSPACE_PATH, 'ch1'))
    expect(tools.map((tool) => tool.name)).toContain('agent_list')
    const readSchema = tools.find((tool) => tool.name === 'session_read')?.inputSchema
    expect(readSchema?.required).toContain('session_id')
    expect(readSchema?.properties?.limit).toMatchObject({ type: 'integer', exclusiveMinimum: 0 })
    expect(readSchema?.properties).not.toHaveProperty('type')
    expect(tools.find((tool) => tool.name === 'session_search')?.inputSchema.properties?.query).toMatchObject({
      maxLength: 4096
    })
    expect(tools.map((tool) => tool.name)).not.toContain('notify')
  })

  it('does not offer notify for sessions without a source channel', async () => {
    const server = createServer('agent_test', WORKSPACE_PATH, null)

    expect((await listTools(server)).map((tool) => tool.name)).not.toContain('notify')
    await expect(callTool(server, { message: 'Hello' }, 'notify')).rejects.toThrow('notify')
    expect(mockGetNotifyAdapters).not.toHaveBeenCalled()
  })

  describe('session tools', () => {
    it('lists public Agent identity and runtime readiness without configuration', async () => {
      mockListAgents.mockReturnValue({
        agents: [
          { id: 'agent-a', name: 'Builder', description: 'Builds things', type: 'claude-code', model: 'p::m' },
          { id: 'agent-b', name: 'Unconfigured', description: '', type: 'pi', model: null }
        ],
        total: 2
      })

      const result = await callTool(createServer(), {}, 'agent_list')

      expect(JSON.parse(result.content[0].text)).toEqual({
        agents: [
          {
            id: 'agent-a',
            name: 'Builder',
            description: 'Builds things',
            runtime: { type: 'claude-code', available: false },
            modelConfigured: true
          },
          {
            id: 'agent-b',
            name: 'Unconfigured',
            description: '',
            runtime: { type: 'pi', available: false },
            modelConfigured: false
          }
        ]
      })
    })
    it.each([
      'agent_list',
      'session_list',
      'session_search',
      'session_read',
      'session_deliveries',
      'session_create',
      'session_send'
    ])('denies %s from a headless turn before reading or mutating another Session', async (toolName) => {
      mockGetInteractionState.mockReturnValue({ currentTurn: 'headless', userResponse: 'unavailable' })
      const args =
        toolName === 'session_search'
          ? { query: 'secret' }
          : toolName === 'session_create'
            ? { message: 'delegate' }
            : toolName === 'session_send'
              ? { target_session_id: 'session_b', message: 'delegate' }
              : toolName === 'session_read'
                ? { session_id: 'topic-1' }
                : {}

      const result = await callTool(createServer(), args, toolName)

      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ok: false,
        error: { code: 'SESSION_TOOL_FORBIDDEN' }
      })
      expect(mockSearchSessionMessages).not.toHaveBeenCalled()
      expect(mockAcceptSessionDelivery).not.toHaveBeenCalled()
      expect(mockCreateSessionWithDelivery).not.toHaveBeenCalled()
    })

    it('reads a conversation through the unified session_read facade', async () => {
      mockReadConversation.mockReturnValue({
        source: 'topic',
        sessionId: 'topic-1',
        messages: [{ message: { id: 'message-1', role: 'user', data: { parts: [] } } }],
        nextCursor: 'cursor-1'
      })

      const result = await callTool(createServer(), { session_id: 'topic-1', limit: 10 }, 'session_read')

      expect(mockReadConversation).toHaveBeenCalledWith({
        sessionId: 'topic-1',
        cursor: undefined,
        limit: 10,
        nodeId: undefined,
        includeSiblings: undefined,
        messageId: undefined
      })
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        source: 'topic',
        messages: [{ message: { id: 'message-1' } }],
        nextCursor: 'cursor-1'
      })
    })

    it.each(['topic', 'agent', 'temporary', 'exact-topic', 'exact-agent', 'tool-result'])(
      'does not expose attachment locators or runtime metadata through %s reads',
      async (mode) => {
        const privatePath = '/private/handoff-unselected.pdf'
        const message = {
          id: 'message-1',
          role: 'user',
          metadata: { attachmentPath: privatePath },
          data: {
            metadata: { attachmentPath: privatePath },
            parts: [
              { type: 'text', text: 'Keep the factual evidence.', providerMetadata: { cherry: { path: privatePath } } },
              {
                type: 'file',
                filename: privatePath,
                mediaType: 'application/pdf',
                url: `file://${privatePath}`,
                providerMetadata: { cherry: { fileEntryId: 'private-entry' } }
              },
              {
                type: 'file',
                filename: 'remote.pdf',
                mediaType: 'application/pdf',
                url: 'https://private.example/signed-secret'
              },
              { type: 'data-video', data: { filePath: privatePath, url: `file://${privatePath}` } },
              { type: 'data-agent-task-event', data: { outputFile: privatePath } },
              { type: 'reasoning', text: 'private reasoning' },
              { type: 'source-url', sourceId: 'citation-1', url: 'https://example.com/evidence', title: 'Evidence' },
              {
                type: 'tool-search',
                toolCallId: 'call-1',
                state: 'output-available',
                input: { query: 'failure' },
                output: 'Found the cause.',
                callProviderMetadata: { path: privatePath }
              }
            ]
          }
        }
        const before = structuredClone(message)
        const exact = mode.startsWith('exact-') || mode === 'tool-result'
        const source = mode === 'tool-result' ? 'agent' : mode.replace('exact-', '')
        mockReadConversation.mockReturnValue({
          source,
          sessionId: 'source-1',
          ...(exact
            ? { message }
            : {
                messages: source === 'topic' ? [{ message, siblingsGroup: [message] }] : [message],
                nextCursor: 'next-page'
              })
        })
        mockFindPersistedToolOutput.mockResolvedValue({ found: true, output: 'Complete tool evidence.' })
        const result = await callTool(
          createServer(),
          {
            session_id: 'source-1',
            ...(exact ? { message_id: 'message-1' } : {}),
            ...(mode === 'tool-result' ? { tool_call_id: 'call-1' } : {})
          },
          'session_read'
        )
        expect(result.isError).not.toBe(true)
        const serialized = result.content[0].text
        for (const secret of [
          privatePath,
          'file://',
          'private-entry',
          'signed-secret',
          'private reasoning',
          'ProviderMetadata'
        ]) {
          expect(serialized).not.toContain(secret)
        }
        expect(serialized).toContain('Keep the factual evidence.')
        expect(serialized).toContain('handoff-unselected.pdf')
        expect(serialized).toContain('https://example.com/evidence')
        expect(serialized).toContain('Found the cause.')
        expect(serialized).toContain('call-1')
        const evidence = JSON.parse(serialized)
        if (!exact) expect(evidence.nextCursor).toBe('next-page')
        if (mode === 'tool-result')
          expect(evidence.toolResult).toEqual({ found: true, output: 'Complete tool evidence.' })
        expect(message).toEqual(before)
      }
    )

    it('adds a persisted tool result to an exact session_read', async () => {
      mockReadConversation.mockReturnValue({
        source: 'agent',
        sessionId: 'session-a',
        message: { id: 'message-1', role: 'assistant', data: { parts: [] } }
      })
      mockFindPersistedToolOutput.mockResolvedValue({ found: true, output: 'full tool output' })

      const result = await callTool(
        createServer(),
        { session_id: 'session-a', message_id: 'message-1', tool_call_id: 'call-1' },
        'session_read'
      )

      expect(mockFindPersistedToolOutput).toHaveBeenCalledWith('agent-session:session-a', 'message-1', 'call-1')
      expect(JSON.parse(result.content[0].text).toolResult).toEqual({ found: true, output: 'full tool output' })
    })

    it('rejects session_read input without a session id', async () => {
      const result = await callTool(createServer(), {}, 'session_read')

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Invalid input')
      expect(mockReadConversation).not.toHaveBeenCalled()
    })

    it('rejects a caller-supplied session type because Main identifies the source by id', async () => {
      const result = await callTool(createServer(), { session_id: 'topic-1', type: 'topic' }, 'session_read')

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unrecognized key')
      expect(mockReadConversation).not.toHaveBeenCalled()
    })

    it('keeps the existing sender identity gate for session_read', async () => {
      mockGetSession.mockReturnValue({ id: 'session_test', agentId: 'another-agent' })

      const result = await callTool(createServer(), { session_id: 'topic-1' }, 'session_read')

      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ok: false,
        error: { code: 'SENDER_FORBIDDEN' }
      })
      expect(mockReadConversation).not.toHaveBeenCalled()
    })

    it('rejects an invalid delivery direction instead of coercing it to incoming', async () => {
      const result = await callTool(createServer(), { direction: 'sideways' }, 'session_deliveries')

      expect(result.isError).toBe(true)
      expect(mockListSessionDeliveries).not.toHaveBeenCalled()
    })

    it('discovers active Session addresses without exposing workspace data', async () => {
      mockListSessions.mockReturnValue({
        items: [
          { sessionId: 'session_test', agentId: 'agent_test', sessionName: 'Current', agentName: 'Agent A' },
          { sessionId: 'session_b', agentId: 'agent_b', sessionName: 'Build', agentName: 'Agent B' }
        ]
      })

      const result = await callTool(createServer(), { limit: 10 }, 'session_list')
      const payload = JSON.parse(result.content[0].text)

      expect(payload.sessions).toEqual([
        {
          agentId: 'agent_test',
          agentName: 'Agent A',
          sessionId: 'session_test',
          sessionName: 'Current',
          isCurrent: true
        },
        {
          agentId: 'agent_b',
          agentName: 'Agent B',
          sessionId: 'session_b',
          sessionName: 'Build',
          isCurrent: false
        }
      ])
    })

    it('passes the addressable Session cursor through and returns the next page cursor', async () => {
      mockListSessions.mockReturnValue({ items: [], nextCursor: 'session-next' })

      const result = await callTool(createServer(), { cursor: 'session-prev', limit: 5 }, 'session_list')

      expect(mockListSessions).toHaveBeenCalledWith({ agentId: undefined, cursor: 'session-prev', limit: 5 })
      expect(JSON.parse(result.content[0].text)).toEqual({ sessions: [], nextCursor: 'session-next' })
    })

    it('injects the trusted current identity when sending across Agents', async () => {
      const accepted = {
        id: 'message-1',
        sessionId: 'session_b',
        delivery: { id: 'delivery-1', status: 'accepted' }
      }
      mockAcceptSessionDelivery.mockReturnValue(accepted)
      const result = await callTool(
        createServer('agent_test'),
        { target_session_id: 'session_b', message: 'Implement this' },
        'session_send'
      )

      expect(mockAcceptSessionDelivery).toHaveBeenCalledWith({
        senderAgentId: 'agent_test',
        senderSessionId: 'session_test',
        receiverSessionId: 'session_b',
        content: 'Implement this',
        replyPolicy: 'none'
      })
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ok: true,
        delivery: { id: 'delivery-1', status: 'accepted' }
      })
    })

    it('records completion requests without a redundant delivery mode', async () => {
      mockAcceptSessionDelivery.mockReturnValue({
        id: 'request-1',
        sessionId: 'session_b',
        delivery: { status: 'accepted', replyPolicy: 'completion' }
      })
      await callTool(
        createServer('agent_test'),
        { target_session_id: 'session_b', message: 'Return the result', reply: 'completion' },
        'session_send'
      )

      expect(mockAcceptSessionDelivery).toHaveBeenCalledWith(expect.objectContaining({ replyPolicy: 'completion' }))
    })

    it('returns message evidence for session search candidates', async () => {
      mockSearchSessionMessages.mockReturnValue([
        {
          messageId: 'message-1',
          sessionId: 'session_b',
          sessionName: 'Build',
          agentId: 'agent_b',
          agentName: 'Agent B',
          snippet: 'implemented auth',
          createdAt: '2026-08-10T00:00:00.000Z'
        }
      ])

      const result = await callTool(createServer(), { query: 'auth' }, 'session_search')

      expect(JSON.parse(result.content[0].text).sessions).toEqual([
        expect.objectContaining({
          sessionId: 'session_b',
          matches: [expect.objectContaining({ messageId: 'message-1', snippet: 'implemented auth' })]
        })
      ])
      expect(mockSearchSessionMessages).toHaveBeenCalledWith({
        q: 'auth',
        limit: 20,
        agentId: undefined,
        addressableOnly: true
      })
    })

    it('scopes ranked message and metadata searches before their limits', async () => {
      await callTool(createServer(), { query: 'auth', agent_id: 'agent_b', limit: 3 }, 'session_search')

      expect(mockSearchSessionMessages).toHaveBeenCalledWith({
        q: 'auth',
        limit: 3,
        agentId: 'agent_b',
        addressableOnly: true
      })
      expect(mockSearchSessions).toHaveBeenCalledWith({
        q: 'auth',
        limit: 3,
        agentId: 'agent_b',
        addressableOnly: true
      })
    })

    it('places metadata-only Session hits after ranked message evidence', async () => {
      mockSearchSessionMessages.mockReturnValue([
        {
          messageId: 'message-ranked',
          sessionId: 'session-ranked',
          sessionName: 'Ranked evidence',
          agentId: 'agent_a',
          agentName: 'Agent A',
          snippet: 'ranked evidence',
          createdAt: '2026-08-10T00:00:00.000Z'
        }
      ])
      mockSearchSessions.mockReturnValue([
        {
          item: {
            id: 'session-metadata',
            title: 'Metadata only',
            subtitle: 'Agent B',
            target: { agentId: 'agent_b' }
          },
          matches: [{ field: 'name', snippet: 'Metadata only' }]
        }
      ])

      const result = await callTool(createServer(), { query: 'evidence' }, 'session_search')

      expect(JSON.parse(result.content[0].text).sessions).toEqual([
        expect.objectContaining({ sessionId: 'session-ranked', matches: [expect.anything()] }),
        expect.objectContaining({
          sessionId: 'session-metadata',
          matches: [],
          metadataMatches: [{ field: 'name', snippet: 'Metadata only' }]
        })
      ])
    })

    it('merges metadata evidence and applies limit to final Sessions', async () => {
      mockSearchSessionMessages.mockReturnValue([
        {
          messageId: 'message-ranked',
          sessionId: 'session-ranked',
          sessionName: 'Ranked evidence',
          agentId: 'agent_a',
          agentName: 'Agent A',
          snippet: 'ranked evidence',
          createdAt: '2026-08-10T00:00:00.000Z'
        }
      ])
      mockSearchSessions.mockReturnValue([
        {
          item: {
            id: 'session-metadata',
            title: 'Metadata only',
            subtitle: 'Agent B',
            target: { agentId: 'agent_b' }
          },
          matches: [{ field: 'description', snippet: 'Contains ranked evidence' }]
        },
        {
          item: {
            id: 'session-over-limit',
            title: 'Over limit',
            subtitle: 'Agent C',
            target: { agentId: 'agent_c' }
          },
          matches: [{ field: 'description', snippet: 'More ranked evidence' }]
        },
        {
          item: {
            id: 'session-ranked',
            title: 'Ranked evidence',
            subtitle: 'Agent A',
            target: { agentId: 'agent_a' }
          },
          matches: [{ field: 'name', snippet: 'Ranked evidence' }]
        }
      ])

      const result = await callTool(createServer(), { query: 'evidence', limit: 2 }, 'session_search')

      expect(JSON.parse(result.content[0].text).sessions).toEqual([
        expect.objectContaining({
          sessionId: 'session-ranked',
          metadataMatches: [{ field: 'name', snippet: 'Ranked evidence' }]
        }),
        expect.objectContaining({
          sessionId: 'session-metadata',
          metadataMatches: [{ field: 'description', snippet: 'Contains ranked evidence' }]
        })
      ])
    })

    it('creates a same-Agent Session with its first message before dispatching it', async () => {
      const message = {
        id: 'message-1',
        sessionId: 'session-new',
        delivery: { id: 'delivery-1', status: 'accepted' }
      }
      mockCreateSessionWithDelivery.mockReturnValue({
        session: { id: 'session-new', agentId: 'agent_test' },
        message
      })
      const result = await callTool(createServer(), { message: 'Hello', title: 'English greeting' }, 'session_create')

      expect(mockCreateSessionWithDelivery).toHaveBeenCalledWith({
        senderAgentId: 'agent_test',
        senderSessionId: 'session_test',
        sessionName: 'English greeting',
        workspace: WORKSPACE_SOURCE,
        content: 'Hello'
      })
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ok: true,
        agentId: 'agent_test',
        sessionId: 'session-new',
        delivery: { id: 'delivery-1', status: 'accepted' }
      })
    })

    it('creates a Session for an explicit target Agent while retaining the trusted sender', async () => {
      mockGetAgent.mockReturnValue({ id: 'agent-target', name: 'Target', model: 'provider::model' })
      mockCreateSessionWithDelivery.mockReturnValue({
        session: { id: 'session-target', agentId: 'agent-target' },
        message: { id: 'message-target', delivery: { status: 'accepted' } }
      })

      await callTool(createServer(), { message: 'Delegate this', target_agent_id: 'agent-target' }, 'session_create')

      expect(mockCreateSessionWithDelivery).toHaveBeenCalledWith({
        senderAgentId: 'agent_test',
        senderSessionId: 'session_test',
        targetAgentId: 'agent-target',
        sessionName: '',
        workspace: WORKSPACE_SOURCE,
        content: 'Delegate this'
      })
    })

    it('continues the target Agent own most recent workspace for a cross-Agent Session', async () => {
      mockGetAgent.mockReturnValue({ id: 'agent-target', name: 'Target', model: 'provider::model' })
      mockGetLatestActive.mockReturnValue({
        workspaceId: 'workspace-target',
        workspace: { type: 'user' }
      })
      mockCreateSessionWithDelivery.mockReturnValue({
        session: { id: 'session-target', agentId: 'agent-target' },
        message: { id: 'message-target', delivery: { status: 'accepted' } }
      })

      await callTool(createServer(), { message: 'Delegate this', target_agent_id: 'agent-target' }, 'session_create')

      expect(mockGetLatestActive).toHaveBeenCalledWith({ agentId: 'agent-target' })
      expect(mockCreateSessionWithDelivery).toHaveBeenCalledWith({
        senderAgentId: 'agent_test',
        senderSessionId: 'session_test',
        targetAgentId: 'agent-target',
        sessionName: '',
        workspace: { type: 'user', workspaceId: 'workspace-target' },
        content: 'Delegate this'
      })
    })

    it('falls back to the sender workspace when the target Agent has no Session', async () => {
      const senderWorkspace = { type: 'user' as const, workspaceId: 'workspace-sender' }
      mockGetAgent.mockReturnValue({ id: 'agent-target', name: 'Target', model: 'provider::model' })
      mockCreateSessionWithDelivery.mockReturnValue({
        session: { id: 'session-target', agentId: 'agent-target' },
        message: { id: 'message-target', delivery: { status: 'accepted' } }
      })

      await callTool(
        createServer('agent_test', WORKSPACE_PATH, 'ch1', senderWorkspace),
        { message: 'Delegate this', target_agent_id: 'agent-target' },
        'session_create'
      )

      expect(mockCreateSessionWithDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: senderWorkspace })
      )
    })

    it('starts a fresh system workspace when the target Agent last Session had no project', async () => {
      const senderWorkspace = { type: 'user' as const, workspaceId: 'workspace-sender' }
      mockGetAgent.mockReturnValue({ id: 'agent-target', name: 'Target', model: 'provider::model' })
      mockGetLatestActive.mockReturnValue({
        workspaceId: 'workspace-target-system',
        workspace: { type: 'system' }
      })
      mockCreateSessionWithDelivery.mockReturnValue({
        session: { id: 'session-target', agentId: 'agent-target' },
        message: { id: 'message-target', delivery: { status: 'accepted' } }
      })

      await callTool(
        createServer('agent_test', WORKSPACE_PATH, 'ch1', senderWorkspace),
        { message: 'Delegate this', target_agent_id: 'agent-target' },
        'session_create'
      )

      expect(mockCreateSessionWithDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: { type: 'system' } })
      )
    })

    it('rejects a missing explicit target Agent with a target-owned error', async () => {
      mockGetAgent.mockReturnValue(null)

      const result = await callTool(
        createServer(),
        { message: 'Delegate this', target_agent_id: 'missing' },
        'session_create'
      )

      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        ok: false,
        error: { code: 'TARGET_AGENT_DELETED' }
      })
      expect(mockCreateSessionWithDelivery).not.toHaveBeenCalled()
    })
  })

  describe('add action', () => {
    it('should create a task with cron schedule', async () => {
      const task = { id: 'task_1', name: 'test', scheduleType: 'cron', scheduleValue: '0 9 * * 1-5' }
      mockCreateTask.mockReturnValue(task)

      const server = createServer('agent_1', WORKSPACE_PATH, null)
      const result = await callTool(server, {
        action: 'add',
        name: 'Daily standup',
        message: 'Run standup check',
        cron: '0 9 * * 1-5'
      })

      expect(mockCreateTask).toHaveBeenCalledWith('agent_1', {
        name: 'Daily standup',
        prompt: 'Run standup check',
        trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
        workspace: WORKSPACE_SOURCE,
        timeoutMinutes: undefined,
        channelIds: undefined
      })
      expect(result.content[0].text).toContain('Job created')
    })

    it('should create a task with interval schedule', async () => {
      const task = { id: 'task_2', name: 'check', trigger: { kind: 'interval', ms: 30 * 60_000 } }
      mockCreateTask.mockReturnValue(task)

      const server = createServer('agent_2', WORKSPACE_PATH, null)
      await callTool(server, {
        action: 'add',
        name: 'Health check',
        message: 'Check system health',
        every: '30m'
      })

      expect(mockCreateTask).toHaveBeenCalledWith('agent_2', {
        name: 'Health check',
        prompt: 'Check system health',
        trigger: { kind: 'interval', ms: 30 * 60_000 },
        workspace: WORKSPACE_SOURCE,
        timeoutMinutes: undefined,
        channelIds: undefined
      })
    })

    it('should parse hour+minute durations', async () => {
      mockCreateTask.mockReturnValue({ id: 'task_3' })

      const server = createServer('agent_test', WORKSPACE_PATH, null)
      await callTool(server, {
        action: 'add',
        name: 'test',
        message: 'test',
        every: '1h30m'
      })

      expect(mockCreateTask).toHaveBeenCalledWith(
        'agent_test',
        expect.objectContaining({
          trigger: { kind: 'interval', ms: 90 * 60_000 }
        })
      )
    })

    it('should create a one-time task with at', async () => {
      mockCreateTask.mockReturnValue({ id: 'task_4' })

      const server = createServer('agent_test', WORKSPACE_PATH, null)
      await callTool(server, {
        action: 'add',
        name: 'Deploy',
        message: 'Deploy to prod',
        at: '2024-01-15T14:30:00+08:00'
      })

      expect(mockCreateTask).toHaveBeenCalledWith(
        'agent_test',
        expect.objectContaining({
          trigger: expect.objectContaining({ kind: 'once' })
        })
      )
    })

    it('should reject when no schedule is provided', async () => {
      const server = createServer()
      const result = await callTool(server, {
        action: 'add',
        name: 'test',
        message: 'test'
      })

      expect(result.isError).toBe(true)
      expect(mockCreateTask).not.toHaveBeenCalled()
    })

    it('should reject when multiple schedules are provided', async () => {
      const server = createServer()
      const result = await callTool(server, {
        action: 'add',
        name: 'test',
        message: 'test',
        cron: '* * * * *',
        every: '30m'
      })

      expect(result.isError).toBe(true)
      expect(mockCreateTask).not.toHaveBeenCalled()
    })
  })

  describe('list action', () => {
    it('should list tasks', async () => {
      const tasks = [{ id: 'task_1', name: 'Job 1' }]
      mockListTasks.mockReturnValue({ tasks, total: 1 })

      const server = createServer('agent_1')
      const result = await callTool(server, { action: 'list' })

      expect(mockListTasks).toHaveBeenCalledWith('agent_1', { limit: 100 })
      expect(result.content[0].text).toContain('Job 1')
    })

    it('should handle empty task list', async () => {
      mockListTasks.mockReturnValue({ tasks: [], total: 0 })

      const server = createServer()
      const result = await callTool(server, { action: 'list' })

      expect(result.content[0].text).toBe('No scheduled jobs.')
    })
  })

  describe('remove action', () => {
    it('should remove a task', async () => {
      mockDeleteTask.mockResolvedValue(true)

      const server = createServer('agent_1')
      const result = await callTool(server, { action: 'remove', id: 'task_1' })

      expect(mockDeleteTask).toHaveBeenCalledWith('agent_1', 'task_1')
      expect(result.content[0].text).toContain('removed')
    })

    it('should error when task not found', async () => {
      mockDeleteTask.mockResolvedValue(false)

      const server = createServer()
      const result = await callTool(server, { action: 'remove', id: 'nonexistent' })

      expect(result.isError).toBe(true)
    })
  })

  describe('config tool', () => {
    describe('status action', () => {
      it('reports agent status without channel configuration', async () => {
        const server = createServer()
        const result = await callTool(server, { action: 'status' }, 'config')
        const status = JSON.parse(result.content[0].text)
        expect(status.agentId).toBeTruthy()
        expect(status).not.toHaveProperty('channels')
        expect(status).not.toHaveProperty('supported_channel_types')
      })

      it('should error when agent not found', async () => {
        mockGetAgent.mockReturnValue(null)

        const server = createServer('agent_1')
        const result = await callTool(server, { action: 'status' }, 'config')

        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('Agent not found')
      })
    })

    it('should handle unknown config action', async () => {
      const server = createServer()
      const result = await callTool(server, { action: 'unknown' }, 'config')

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('status')
    })
  })
})
