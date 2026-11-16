/** Serialized command menu entries retained for stored conversations and future runtimes. */
export interface AgentSessionSlashCommand {
  name: string
  description: string
  argumentHint: string
}

export const AGENT_SESSION_SLASH_COMMANDS_CACHE_KEY = (sessionId: string) =>
  `agent.session.slash_commands.${sessionId}` as const
