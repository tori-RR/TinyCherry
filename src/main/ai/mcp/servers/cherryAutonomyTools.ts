/**
 * Agent autonomy tools (cron / notify / config / session_*) hosted by the in-process
 * `cherry-tools` MCP server (see `cherryBuiltinTools.ts`).
 *
 * Unlike the stateless builtin lookup tools, these act on behalf of a specific
 * agent (schedule its tasks, delegate to other Sessions,
 * manage its own configuration), so they take the per-session agent context.
 */

import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import * as z from 'zod'

import { application } from '@application'
import { agentService } from '@data/services/AgentService'
import { AgentSessionDeliveryRoutingError, agentSessionMessageService } from '@data/services/AgentSessionMessageService'
import { agentSessionService } from '@data/services/AgentSessionService'
import { agentTaskService as taskService } from '@data/services/AgentTaskService'
import { loggerService } from '@logger'
import { buildAgentSessionTopicId } from '@main/ai/agentSession/topic'
import { conversationEvidence } from '@main/ai/messages/conversationEvidence'
import { findPersistedToolOutput } from '@main/ai/messages/persistedToolOutput'
import { readConversation, type ReadConversationInput } from '@main/ai/messages/readConversation'
import type { NotifyChannel } from '@main/ai/runtime/agentMcpServers'
import { runtimeDriverRegistry } from '@main/ai/runtime/registry'
import { isHeartbeatEnabled } from '@shared/ai/agentHeartbeat'
import {
  AgentSessionDeliveryStatusSchema,
  SESSION_CREATE_TOOL_NAME,
  SESSION_DELIVERIES_TOOL_NAME,
  SESSION_LIST_TOOL_NAME,
  SESSION_READ_TOOL_NAME,
  SESSION_RENAME_TOOL_NAME,
  SESSION_SEARCH_TOOL_NAME,
  SESSION_SEND_TOOL_NAME
} from '@shared/ai/agentSessionDelivery'
import { CONFIG_TOOL_NAME, CRON_TOOL_NAME } from '@shared/ai/builtinTools'
import { TimeoutMinutesAtomSchema } from '@shared/data/api/schemas/agents'
import { AGENT_WORKSPACE_TYPE, type AgentSessionWorkspaceSource } from '@shared/data/api/schemas/agentWorkspaces'
import { JOB_ERROR_CODES, type Trigger } from '@shared/data/api/schemas/jobs'

const logger = loggerService.withContext('McpServer:CherryAutonomyTools')

const AGENT_LIST_TOOL_NAME = 'agent_list'

/** Per-session agent context the autonomy tools act on behalf of. */
export interface AutonomyToolsContext {
  agentId: string
  /** Trusted current Session identity injected by the runtime; never accepted from tool args. */
  sessionId: string
  workspaceSource: AgentSessionWorkspaceSource
  workspacePath: string
  /** Notification recipients authorized for this exact turn, supplied only by the runtime. */
  trustedNotifyChannels: readonly NotifyChannel[]
  /** Source-channel turns may explicitly select another live channel owned by this Agent. */
  allowAnyOwnedNotifyChannel: boolean
}

/**
 * Parse a human-friendly duration string (e.g. '30m', '2h', '1h30m') into minutes.
 */
function parseDurationToMinutes(duration: string): number {
  let totalMinutes = 0
  const hourMatch = duration.match(/(\d+)\s*h/i)
  const minMatch = duration.match(/(\d+)\s*m/i)

  if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60
  if (minMatch) totalMinutes += parseInt(minMatch[1], 10)

  if (totalMinutes === 0) {
    const raw = parseInt(duration, 10)
    if (!isNaN(raw) && raw > 0) return raw
    throw new Error(`Invalid duration: "${duration}". Use formats like '30m', '2h', '1h30m'.`)
  }

  return totalMinutes
}

const CRON_DESCRIPTION =
  "Manage scheduled jobs: add, update, list, remove. Prefer update over recreating; one-time jobs use an RFC3339 'at'."

const CronInputSchema = z.object({
  action: z.enum(['add', 'update', 'list', 'remove']).describe('The action to perform'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('Name of the job (required for add). Names are unique across all Agents, including disabled jobs.'),
  message: z.string().min(1).optional().describe('The prompt/instruction to execute on schedule (required for add)'),
  cron: z
    .string()
    .min(1)
    .optional()
    .describe("Cron expression, e.g. '0 9 * * 1-5' for weekdays at 9am (use cron OR every, not both)"),
  every: z.string().min(1).optional().describe("Duration, e.g. '30m', '2h', '24h' (use every OR cron, not both)"),
  at: z
    .string()
    .min(1)
    .optional()
    .describe(
      "RFC3339 timestamp for a one-time job, e.g. '2024-01-15T14:30:00+08:00' (use at OR cron OR every, not combined)"
    ),
  timeout_minutes: TimeoutMinutesAtomSchema.describe(
    'Timeout in minutes before the task is aborted. Default is 2 on add; omit on update to keep the current timeout. Use null for no timeout.'
  ),
  reuse_session: z
    .boolean()
    .optional()
    .describe(
      'Continue each execution in the same session. Default is false on add; omit on update to keep the current setting.'
    ),
  id: z.string().min(1).optional().describe('Job ID (required for update and remove)')
})
type CronInput = z.output<typeof CronInputSchema>

const CONFIG_DESCRIPTION = 'Inspect agent configuration, rename the agent, or update its bootstrap status.'

const ConfigInputSchema = z.object({
  action: z.enum(['status', 'rename', 'complete_bootstrap', 'reset_bootstrap']).describe('The action to perform'),
  name: z.string().optional().describe('New agent display name for rename')
})
type ConfigInput = z.output<typeof ConfigInputSchema>

const SessionListInputSchema = z.object({
  agent_id: z.string().optional().describe('Optional Agent id filter.'),
  cursor: z.string().optional().describe('Opaque cursor returned by the previous page.'),
  limit: z.number().optional().describe('Maximum Sessions to return (default 50, max 100).')
})

const SessionSearchInputSchema = z.object({
  query: z.string().max(4096).describe('Natural-language or keyword query, ranked by lexical relevance.'),
  agent_id: z.string().optional().describe('Optional Agent id filter.'),
  limit: z.number().optional().describe('Maximum Sessions to return (default 20, max 100).')
})

const SessionReadInputSchema = z.strictObject({
  session_id: z.string().min(1).describe('Chat topic, Agent Session, or temporary conversation id.'),
  cursor: z.string().optional().describe('Opaque cursor returned by the previous page.'),
  limit: z.number().int().positive().optional().describe('Maximum messages to return.'),
  node_id: z.string().optional().describe('Topic branch endpoint message id.'),
  include_siblings: z.boolean().optional().describe('Include sibling replies for topic messages.'),
  message_id: z.string().min(1).optional().describe('Read one exact message in the conversation.'),
  tool_call_id: z.string().min(1).optional().describe('Restore the persisted output for message_id tool call.')
})

const SessionDeliveriesInputSchema = z.object({
  direction: z.enum(['incoming', 'outgoing']).optional(),
  request_id: z.string().optional().describe('Optional request id; correlated results are included.'),
  status: AgentSessionDeliveryStatusSchema.optional(),
  limit: z.number().optional().describe('Maximum deliveries to return (default 20, max 100).')
})

const SessionRenameInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(255).describe('New Session title (1–255 characters).'),
  session_id: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Target Agent Session id, including another Agent’s Session. Omit to rename the current Session.')
})

const SessionCreateInputSchema = z.object({
  message: z.string().describe('First message for the new Session.'),
  title: z.string().max(255).optional().describe('Optional Session title.'),
  target_agent_id: z.string().optional().describe('Optional target Agent id.')
})

const SessionSendInputSchema = z.object({
  target_session_id: z.string().describe('Target sessionId returned by session_list or delivery sender.'),
  message: z.string().describe('Message for the target Agent.'),
  reply: z
    .enum(['none', 'completion'])
    .optional()
    .describe('completion returns one asynchronous terminal result in a separate turn.')
})

function assertCurrentSessionIdentity(ctx: AutonomyToolsContext): void {
  const session = agentSessionService.getById(ctx.sessionId)
  if (session.agentId !== ctx.agentId) {
    throw new AgentSessionDeliveryRoutingError('SENDER_FORBIDDEN', 'The active runtime no longer owns this Session')
  }
}

function assertSessionToolsAuthorized(ctx: AutonomyToolsContext): void {
  const interaction = application.get('AgentSessionRuntimeService').getInteractionState(ctx.sessionId)
  if (interaction.currentTurn === 'headless' || interaction.userResponse === 'unavailable') {
    throw new AgentSessionDeliveryRoutingError(
      'SESSION_TOOL_FORBIDDEN',
      'Cross-Session discovery and delegation require an interactive user turn'
    )
  }
}

/** Session tools share the sender gates; routing failures keep a machine-readable code for the model. */
async function runSessionTool(
  ctx: AutonomyToolsContext,
  run: () => CallToolResult | Promise<CallToolResult>
): Promise<CallToolResult> {
  try {
    assertCurrentSessionIdentity(ctx)
    assertSessionToolsAuthorized(ctx)
    return await run()
  } catch (error) {
    if (!(error instanceof AgentSessionDeliveryRoutingError)) throw error
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) }
      ],
      isError: true
    }
  }
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return limit === undefined ? fallback : Math.min(Math.max(Math.trunc(limit), 1), 100)
}

function listSessions(ctx: AutonomyToolsContext, args: z.output<typeof SessionListInputSchema>): CallToolResult {
  const agentId = args.agent_id?.trim() || undefined
  const cursor = args.cursor?.trim() || undefined
  const page = agentSessionService.listAddressableByCursor({ agentId, cursor, limit: clampLimit(args.limit, 50) })
  const sessions = page.items.map((session) => ({
    ...session,
    isCurrent: session.sessionId === ctx.sessionId
  }))
  return {
    content: [{ type: 'text', text: JSON.stringify({ sessions, nextCursor: page.nextCursor }) }]
  }
}

function listAgents(): CallToolResult {
  const agents = agentService.listAgents().agents.map((agent) => ({
    id: agent.id,
    name: agent.name,
    description: agent.description ?? '',
    runtime: {
      type: agent.type,
      available: runtimeDriverRegistry.getAgentSessionDriver(agent.type) !== undefined
    },
    modelConfigured: agent.model !== null
  }))
  return { content: [{ type: 'text', text: JSON.stringify({ agents }) }] }
}

function renameSession(ctx: AutonomyToolsContext, args: z.output<typeof SessionRenameInputSchema>): CallToolResult {
  const sessionId = args.session_id ?? ctx.sessionId
  const updated = agentSessionService.update(sessionId, { name: args.title })
  return {
    content: [{ type: 'text', text: JSON.stringify({ sessionId: updated.id, sessionName: updated.name }) }]
  }
}

function searchSessions(ctx: AutonomyToolsContext, args: z.output<typeof SessionSearchInputSchema>): CallToolResult {
  const query = args.query.trim()
  if (!query) throw new Error("'query' is required")
  const agentId = args.agent_id?.trim() || undefined
  const limit = clampLimit(args.limit, 20)
  const matches = agentSessionMessageService.searchRanked({ q: query, limit, agentId, addressableOnly: true })
  const sessions = new Map<
    string,
    {
      agentId?: string
      agentName?: string
      sessionId: string
      sessionName: string
      isCurrent: boolean
      matches: Array<{ messageId: string; snippet: string; createdAt: string }>
      metadataMatches: Array<{ field: 'name' | 'description'; snippet: string }>
    }
  >()
  for (const match of matches) {
    const candidate = sessions.get(match.sessionId) ?? {
      agentId: match.agentId,
      agentName: match.agentName,
      sessionId: match.sessionId,
      sessionName: match.sessionName,
      isCurrent: match.sessionId === ctx.sessionId,
      matches: [],
      metadataMatches: []
    }
    candidate.matches.push({ messageId: match.messageId, snippet: match.snippet, createdAt: match.createdAt })
    sessions.set(match.sessionId, candidate)
  }
  for (const result of agentSessionService.searchWithMetadataEvidence({
    q: query,
    limit,
    agentId,
    addressableOnly: true
  })) {
    const match = result.item
    const existing = sessions.get(match.id)
    if (existing) {
      existing.metadataMatches.push(...result.matches)
      continue
    }
    if (sessions.size >= limit) continue
    sessions.set(match.id, {
      agentId: match.target.agentId ?? undefined,
      agentName: match.subtitle,
      sessionId: match.id,
      sessionName: match.title,
      isCurrent: match.id === ctx.sessionId,
      matches: [],
      metadataMatches: result.matches
    })
  }
  return { content: [{ type: 'text', text: JSON.stringify({ sessions: [...sessions.values()] }) }] }
}

async function readSession(args: z.output<typeof SessionReadInputSchema>): Promise<CallToolResult> {
  const sessionId = args.session_id.trim()
  if (args.tool_call_id && !args.message_id) {
    throw new Error("'tool_call_id' requires 'message_id'")
  }

  const readInput: ReadConversationInput = {
    sessionId,
    cursor: args.cursor,
    limit: args.limit,
    nodeId: args.node_id,
    includeSiblings: args.include_siblings,
    messageId: args.message_id
  }
  const conversation = conversationEvidence(readConversation(readInput))
  if (args.tool_call_id && args.message_id) {
    const topicId = conversation.source === 'agent' ? buildAgentSessionTopicId(sessionId) : sessionId
    const toolResult = await findPersistedToolOutput(topicId, args.message_id, args.tool_call_id)
    return { content: [{ type: 'text', text: JSON.stringify({ ...conversation, toolResult }) }] }
  }
  return { content: [{ type: 'text', text: JSON.stringify(conversation) }] }
}

function listSessionDeliveries(
  ctx: AutonomyToolsContext,
  args: z.output<typeof SessionDeliveriesInputSchema>
): CallToolResult {
  const deliveries = agentSessionMessageService
    .listSessionDeliveries({
      sessionId: ctx.sessionId,
      direction: args.direction ?? 'incoming',
      requestId: args.request_id?.trim(),
      status: args.status,
      limit: clampLimit(args.limit, 20)
    })
    .flatMap((message) =>
      message.delivery
        ? [
            {
              id: message.id,
              envelope: message.delivery,
              content: (message.data.parts ?? [])
                .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
            }
          ]
        : []
    )
  return { content: [{ type: 'text', text: JSON.stringify({ deliveries }) }] }
}

function resolveWorkspaceForNewSession(
  ctx: AutonomyToolsContext,
  targetAgentId: string | undefined
): AgentSessionWorkspaceSource {
  if (!targetAgentId || targetAgentId === ctx.agentId) return ctx.workspaceSource
  // Match a human opening the target Agent: continue that Agent's own last workspace.
  const latest = agentSessionService.getLatestActive({ agentId: targetAgentId })
  if (!latest) return ctx.workspaceSource
  return latest.workspace.type === AGENT_WORKSPACE_TYPE.USER
    ? { type: AGENT_WORKSPACE_TYPE.USER, workspaceId: latest.workspaceId }
    : { type: AGENT_WORKSPACE_TYPE.SYSTEM }
}

function createSession(ctx: AutonomyToolsContext, args: z.output<typeof SessionCreateInputSchema>): CallToolResult {
  const content = args.message.trim()
  const title = args.title?.trim() ?? ''
  if (!content) throw new Error("'message' is required")

  let targetAgentId: string | undefined
  if (args.target_agent_id !== undefined) {
    targetAgentId = args.target_agent_id.trim()
    if (!targetAgentId) throw new Error("'target_agent_id' must be a non-empty string")
    if (!agentService.getAgent(targetAgentId)) {
      throw new AgentSessionDeliveryRoutingError('TARGET_AGENT_DELETED', `Target Agent not found: ${targetAgentId}`)
    }
  }

  const created = application.get('AgentSessionDeliveryService').acceptWithNewSession({
    senderAgentId: ctx.agentId,
    senderSessionId: ctx.sessionId,
    sessionName: title,
    workspace: resolveWorkspaceForNewSession(ctx, targetAgentId),
    content,
    ...(targetAgentId ? { targetAgentId } : {})
  })
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          agentId: created.session.agentId,
          sessionId: created.session.id,
          requestId: created.message.id,
          delivery: created.message.delivery
        })
      }
    ]
  }
}

function sendSessionMessage(ctx: AutonomyToolsContext, args: z.output<typeof SessionSendInputSchema>): CallToolResult {
  const receiverSessionId = args.target_session_id.trim()
  const content = args.message.trim()
  if (!receiverSessionId) throw new Error("'target_session_id' is required")
  if (!content) throw new Error("'message' is required")

  const accepted = application.get('AgentSessionDeliveryService').accept({
    senderAgentId: ctx.agentId,
    senderSessionId: ctx.sessionId,
    receiverSessionId,
    content,
    replyPolicy: args.reply ?? 'none'
  })
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          requestId: accepted.id,
          status: 'accepted',
          delivery: accepted.delivery
        })
      }
    ]
  }
}

function saveJob(ctx: AutonomyToolsContext, args: CronInput, action: 'add' | 'update'): CallToolResult {
  const {
    name,
    message,
    cron: cronExpr,
    every,
    at,
    timeout_minutes: timeoutMinutes,
    reuse_session: reuseSession,
    id
  } = args
  if (action === 'update' && !id) throw new Error("'id' is required for update")
  if (action === 'add' && !name) throw new Error("'name' is required for add")
  if (action === 'add' && !message) throw new Error("'message' is required for add")

  // Determine trigger shape (cron expression / interval ms / one-shot timestamp)
  const scheduleCount = [cronExpr, every, at].filter(Boolean).length
  if (action === 'add' && scheduleCount === 0) throw new Error("One of 'cron', 'every', or 'at' is required")
  if (scheduleCount > 1) throw new Error("Use only one of 'cron', 'every', or 'at'")

  let trigger: Trigger | undefined

  if (cronExpr) {
    trigger = { kind: 'cron', expr: cronExpr }
  } else if (every) {
    const minutes = parseDurationToMinutes(every)
    trigger = { kind: 'interval', ms: minutes * 60_000 }
  } else if (at) {
    const date = new Date(at)
    if (isNaN(date.getTime())) throw new Error(`Invalid timestamp: "${at}"`)
    trigger = { kind: 'once', at: date.getTime() }
  }

  const service = application.get('AgentJobsService')
  const patch = {
    name,
    prompt: message,
    trigger,
    timeoutMinutes,
    ...(reuseSession !== undefined ? { reuseSession } : {})
  }
  const task =
    action === 'add'
      ? service.createTask(ctx.agentId, {
          ...patch,
          name: name!,
          prompt: message!,
          trigger: trigger!,
          workspace: ctx.workspaceSource
        })
      : service.updateTask(ctx.agentId, id!, patch)
  if (!task) throw new Error(`Job "${id}" not found`)

  const outcome = action === 'add' ? 'created' : 'updated'
  logger.info(`Cron job ${outcome} via tool`, { agentId: ctx.agentId, taskId: task.id })
  return {
    content: [{ type: 'text', text: `Job ${outcome}:\n${JSON.stringify(task, null, 2)}` }]
  }
}

function listJobs(ctx: AutonomyToolsContext): CallToolResult {
  const { tasks } = taskService.listTasks(ctx.agentId, { limit: 100 })

  if (tasks.length === 0) {
    return { content: [{ type: 'text', text: 'No scheduled jobs.' }] }
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }]
  }
}

async function removeJob(ctx: AutonomyToolsContext, id: string | undefined): Promise<CallToolResult> {
  if (!id) throw new Error("'id' is required for remove")

  const deleted = await application.get('AgentJobsService').deleteTask(ctx.agentId, id)
  if (!deleted) throw new Error(`Job "${id}" not found`)

  logger.info('Cron job removed via tool', { agentId: ctx.agentId, taskId: id })
  return {
    content: [{ type: 'text', text: `Job "${id}" removed.` }]
  }
}

async function runCron(ctx: AutonomyToolsContext, args: CronInput): Promise<CallToolResult> {
  try {
    switch (args.action) {
      case 'add':
      case 'update':
        return saveJob(ctx, args, args.action)
      case 'list':
        return listJobs(ctx)
      case 'remove':
        return await removeJob(ctx, args.id)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(JOB_ERROR_CODES.SCHEDULE_NAME_CONFLICT)) {
      throw new Error(
        `${error.message} Names are unique across all Agents, including disabled jobs; cron list only shows this Agent's jobs. Use update with the existing job id to edit your own task, choose a different name, or inspect the conflicting task in Settings > Scheduled Tasks.`
      )
    }
    throw error
  }
}

function configStatus(ctx: AutonomyToolsContext): CallToolResult {
  const agent = agentService.getAgent(ctx.agentId)
  if (!agent) throw new Error(`Agent not found: ${ctx.agentId}`)

  const config = agent.configuration
  const result = {
    agentId: agent.id,
    name: agent.name,
    model: agent.model,
    heartbeat_enabled: isHeartbeatEnabled(config ?? {})
  }

  logger.info('Config status queried', { agentId: ctx.agentId })
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  }
}

function configRename(ctx: AutonomyToolsContext, args: ConfigInput): CallToolResult {
  const name = args.name?.trim()
  if (!name) throw new Error("'name' is required for rename")

  agentService.updateAgent(ctx.agentId, { name })

  logger.info('Agent renamed via config tool', { agentId: ctx.agentId, name })
  return {
    content: [{ type: 'text', text: `Agent renamed to "${name}".` }]
  }
}

function configSetBootstrap(ctx: AutonomyToolsContext, completed: boolean): CallToolResult {
  const updated = agentService.updateAgent(ctx.agentId, { configuration: { bootstrap_completed: completed } })
  if (!updated) throw new Error(`Agent not found: ${ctx.agentId}`)

  logger.info(completed ? 'Bootstrap marked as completed' : 'Bootstrap reset', { agentId: ctx.agentId })
  const text = completed
    ? 'Bootstrap is turned off for this agent. Stop onboarding now; future sessions will skip it unless the user asks to reset it.'
    : 'Bootstrap has been reset. The next session will run the onboarding flow.'
  return { content: [{ type: 'text', text }] }
}

function assertConfigMutationAuthorized(ctx: AutonomyToolsContext): void {
  const interaction = application.get('AgentSessionRuntimeService').getInteractionState(ctx.sessionId)
  if (interaction.currentTurn === 'headless') {
    throw new Error(
      'Headless channel or scheduled turns cannot mutate agent configuration. Ask the user to make this change in Cherry Studio.'
    )
  }
}

async function runConfig(ctx: AutonomyToolsContext, args: ConfigInput): Promise<CallToolResult> {
  if (args.action !== 'status') assertConfigMutationAuthorized(ctx)
  switch (args.action) {
    case 'status':
      return configStatus(ctx)
    case 'rename':
      return configRename(ctx, args)
    case 'complete_bootstrap':
      return configSetBootstrap(ctx, true)
    case 'reset_bootstrap':
      return configSetBootstrap(ctx, false)
  }
}

export function registerAutonomyTools(server: McpServer, ctx: AutonomyToolsContext): void {
  server.registerTool(CRON_TOOL_NAME, { description: CRON_DESCRIPTION, inputSchema: CronInputSchema }, (args) =>
    runCron(ctx, args)
  )
  server.registerTool(CONFIG_TOOL_NAME, { description: CONFIG_DESCRIPTION, inputSchema: ConfigInputSchema }, (args) =>
    runConfig(ctx, args)
  )
  server.registerTool(
    SESSION_LIST_TOOL_NAME,
    {
      description:
        'List active Cherry Agent Sessions that can receive a message. Returns both agentId and sessionId for every address.',
      inputSchema: SessionListInputSchema
    },
    (args) => runSessionTool(ctx, () => listSessions(ctx, args))
  )
  server.registerTool(
    AGENT_LIST_TOOL_NAME,
    {
      description: 'List available Cherry Agents with their public identity and runtime readiness.',
      inputSchema: z.object({})
    },
    () => runSessionTool(ctx, listAgents)
  )
  server.registerTool(
    SESSION_SEARCH_TOOL_NAME,
    {
      description: 'Search visible Cherry Agent Sessions by metadata and message evidence.',
      inputSchema: SessionSearchInputSchema
    },
    (args) => runSessionTool(ctx, () => searchSessions(ctx, args))
  )
  server.registerTool(
    SESSION_READ_TOOL_NAME,
    {
      description:
        'Read messages from a Chat topic, Agent Session, or temp chat. Use message_id for one message; attachments are omitted.',
      inputSchema: SessionReadInputSchema
    },
    (args) => runSessionTool(ctx, () => readSession(args))
  )
  server.registerTool(
    SESSION_RENAME_TOOL_NAME,
    {
      description:
        'Rename the current Agent Session, or another Agent Session by id. The title is protected from automatic renaming.',
      inputSchema: SessionRenameInputSchema
    },
    (args) => runSessionTool(ctx, () => renameSession(ctx, args))
  )
  server.registerTool(
    SESSION_CREATE_TOOL_NAME,
    {
      description:
        "Create a Session and send its first message. Omit target_agent_id for this Agent; it inherits the current workspace. With target_agent_id, the Session uses that Agent's own most recent workspace, falling back to the current workspace when the Agent has no Session.",
      inputSchema: SessionCreateInputSchema
    },
    (args) => runSessionTool(ctx, () => createSession(ctx, args))
  )
  server.registerTool(
    SESSION_DELIVERIES_TOOL_NAME,
    {
      description: 'Inspect durable incoming or outgoing cross-Session requests, results, and delivery state.',
      inputSchema: SessionDeliveriesInputSchema
    },
    (args) => runSessionTool(ctx, () => listSessionDeliveries(ctx, args))
  )
  server.registerTool(
    SESSION_SEND_TOOL_NAME,
    {
      description:
        'Send a durable message to another Agent Session. Sender identity is injected by the runtime and cannot be set.',
      inputSchema: SessionSendInputSchema
    },
    (args) => runSessionTool(ctx, () => sendSessionMessage(ctx, args))
  )
}
