import { getRouteApi, useNavigate } from '@tanstack/react-router'
import { omit } from 'es-toolkit'
import {
  Archive,
  Bot,
  ChevronDown,
  FolderOpen,
  History,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip } from '@cherrystudio/ui'
import { dataApiService } from '@data/DataApiService'
import PromptPopup from '@renderer/components/popups/PromptPopup'
import {
  useDataChange,
  useInfiniteFlatItems,
  useInfiniteQuery,
  useInvalidateCache,
  useQuery
} from '@renderer/data/hooks/useDataApi'
import { useAgent, useAgents } from '@renderer/hooks/agent/useAgent'
import { useSession } from '@renderer/hooks/agent/useSession'
import { ipcApi } from '@renderer/ipc'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { getErrorMessage } from '@renderer/utils/error'
import { cn } from '@renderer/utils/style'
import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { AgentSessionWorkspaceSource } from '@shared/data/api/schemas/agentWorkspaces'
import type { CreateAgentCommand } from '@shared/ipc/schemas/ai'
import { AbsoluteFilePathSchema } from '@shared/types/file'

import { NativeAgentConversation } from './NativeAgentConversation'
import { NativeAgentEditor } from './NativeAgentEditor'

const route = getRouteApi('/app/agents')
const SYSTEM_WORKSPACE = '__system__'

function AgentPage() {
  const { t } = useTranslation()
  const search = route.useSearch()
  const navigate = useNavigate()
  const invalidate = useInvalidateCache()
  const { agents, isLoading: agentsLoading, error: agentsError, refetch: refreshAgents } = useAgents()
  const {
    session,
    error: sessionError,
    isLoading: sessionLoading,
    mutate: refreshSession
  } = useSession(search.sessionId ?? null)
  const { agent: sessionAgent } = useAgent(session?.agentId ?? null)
  const { agent: requestedAgent } = useAgent(search.agentId ?? null)
  const [showTrash, setShowTrash] = useState(false)
  const [filter, setFilter] = useState('')
  const [workspaceId, setWorkspaceId] = useState(SYSTEM_WORKSPACE)
  const [editor, setEditor] = useState<{ agent?: AgentEntity } | null>(null)
  const [busy, setBusy] = useState<string>()
  const actionInFlight = useRef(false)
  const {
    data: latest,
    isLoading: latestInitialLoading,
    isRefreshing: latestRefreshing,
    refetch: refreshLatest
  } = useQuery('/agent-sessions/latest', {
    query: search.agentId ? { agentId: search.agentId } : undefined,
    enabled: !search.sessionId && !showTrash,
    swrOptions: { keepPreviousData: false, revalidateOnMount: true }
  })
  const latestLoading = latestInitialLoading || latestRefreshing
  const selectedAgent = search.agentId
    ? (agents.find((agent) => agent.id === search.agentId) ?? requestedAgent)
    : ((session?.id === search.sessionId ? sessionAgent : undefined) ??
      agents.find((agent) => agent.id === latest?.session?.agentId) ??
      agents.find((agent) => agent.type === 'native') ??
      agents[0])
  const sessionQuery = showTrash ? { inTrash: true } : search.agentId ? { agentId: search.agentId } : undefined
  const history = useInfiniteQuery('/agent-sessions', {
    query: sessionQuery,
    limit: 30,
    swrOptions: { keepPreviousData: false, revalidateAll: true, revalidateFirstPage: false }
  })
  const sessions = useInfiniteFlatItems(history.pages)
  const { data: workspaces, refetch: refreshWorkspaces } = useQuery('/agent-workspaces')
  const { data: archivedAgents, refetch: refreshArchivedAgents } = useQuery('/agents', {
    query: { inTrash: true, limit: 200 },
    enabled: showTrash
  })
  const navigateSession = (value: AgentSessionEntity) => {
    void navigate({
      to: '/app/agents',
      search: { sessionId: value.id, ...(search.agentId && value.agentId ? { agentId: value.agentId } : {}) },
      replace: true
    })
  }

  useEffect(() => {
    const candidate = latest?.session
    if (
      !search.sessionId &&
      !showTrash &&
      !latestLoading &&
      candidate &&
      (!search.agentId || candidate.agentId === search.agentId)
    ) {
      void navigate({
        to: '/app/agents',
        search: { sessionId: candidate.id, ...(search.agentId ? { agentId: search.agentId } : {}) },
        replace: true
      })
    }
  }, [latest, latestLoading, navigate, search.agentId, search.sessionId, showTrash])

  useDataChange('/agent-sessions', () => {
    void history.refresh().catch(() => {})
  })
  useDataChange('/agent-sessions/latest', () => {
    void refreshLatest().catch(() => {})
  })
  useDataChange('/agent-workspaces', () => {
    void refreshWorkspaces().catch(() => {})
  })
  useDataChange('/agents', () => {
    if (showTrash) void refreshArchivedAgents().catch(() => {})
  })

  const run = async (key: string, action: () => Promise<void>) => {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(key)
    try {
      await action()
    } catch (error) {
      toast.error(getErrorMessage(error))
    } finally {
      actionInFlight.current = false
      setBusy(undefined)
    }
  }
  const refresh = () => {
    void Promise.allSettled([
      refreshAgents(),
      history.refresh(),
      refreshSession(),
      refreshArchivedAgents(),
      refreshLatest()
    ])
  }

  const createSession = () =>
    run('create-session', async () => {
      if (!selectedAgent || selectedAgent.type !== 'native' || selectedAgent.deletedAt) return
      const workspace: AgentSessionWorkspaceSource =
        workspaceId === SYSTEM_WORKSPACE ? { type: 'system' } : { type: 'user', workspaceId }
      const created = await dataApiService.post('/agent-sessions', {
        body: { agentId: selectedAgent.id, name: '', workspace }
      })
      setShowTrash(false)
      navigateSession(created)
      void history.refresh().catch(() => {})
    })

  const chooseDirectory = () =>
    run('workspace', async () => {
      const path = await window.api.file.selectFolder({ properties: ['openDirectory', 'createDirectory'] })
      if (!path) return
      const workspace = await ipcApi.request('ai.agent.workspace.register', {
        path: AbsoluteFilePathSchema.parse(path)
      })
      setWorkspaceId(workspace.id)
      void refreshWorkspaces().catch(() => {})
    })

  const saveAgent = async (input: CreateAgentCommand) => {
    let saved: AgentEntity
    if (editor?.agent) {
      saved = await dataApiService.patch(`/agents/${editor.agent.id}`, { body: omit(input, ['type', 'skillIds']) })
    } else {
      saved = await ipcApi.request('ai.agent.create', input)
    }
    void invalidate('/agents').catch(() => {})
    void invalidate(`/agents/${saved.id}`).catch(() => {})
    if (!editor?.agent) {
      setShowTrash(false)
      void navigate({ to: '/app/agents', search: { agentId: saved.id }, replace: true })
    }
  }

  const renameSession = (item: AgentSessionEntity) =>
    run(`rename:${item.id}`, async () => {
      const name = await PromptPopup.show({
        title: t('agent.native.rename_session', '重命名工作'),
        message: '',
        defaultValue: item.name,
        inputProps: { maxLength: 255 }
      })
      if (name === null || !name.trim()) return
      await dataApiService.patch(`/agent-sessions/${item.id}`, {
        body: { name: name.trim(), isNameManuallyEdited: true }
      })
      refresh()
    })

  const deleteSession = (item: AgentSessionEntity) =>
    run(`delete:${item.id}`, async () => {
      if (
        !(await popup.confirm({
          title: t('agent.native.archive_session', '将工作移入回收站？'),
          content: t('agent.native.archive_session_hint', '消息和工作区文件会保留，你可以在回收站恢复这项工作。'),
          okText: t('common.delete', '删除'),
          okButtonProps: { danger: true }
        }))
      )
        return
      await ipcApi.request('ai.agent.session.delete', { sessionIds: [item.id] })
      if (search.sessionId === item.id)
        void navigate({ to: '/app/agents', search: search.agentId ? { agentId: search.agentId } : {}, replace: true })
      refresh()
    })

  const deleteAgent = () =>
    run('delete-agent', async () => {
      if (!selectedAgent) return
      if (
        !(await popup.confirm({
          title: t('agent.native.archive_agent', '将智能体移入回收站？'),
          content: t('agent.native.archive_agent_hint', '保留它的全部工作记录。恢复智能体后可以继续执行任务。'),
          okText: t('common.delete', '删除'),
          okButtonProps: { danger: true }
        }))
      )
        return
      await ipcApi.request('ai.agent.delete', { agentId: selectedAgent.id, deleteSessions: false })
      void navigate({ to: '/app/agents', search: {}, replace: true })
      refresh()
    })

  const restoreSession = (item: AgentSessionEntity) =>
    run(`restore:${item.id}`, async () => {
      const restored = await ipcApi.request('ai.agent.session.restore', { sessionId: item.id })
      setShowTrash(false)
      navigateSession(restored)
      refresh()
    })
  const restoreAgent = (agent: AgentEntity) =>
    run(`restore-agent:${agent.id}`, async () => {
      await ipcApi.request('ai.agent.restore', { agentId: agent.id })
      setShowTrash(false)
      void navigate({ to: '/app/agents', search: { agentId: agent.id }, replace: true })
      refresh()
    })

  const visibleSessions = sessions.filter((item) => !filter || item.name.toLowerCase().includes(filter.toLowerCase()))
  const currentSession = session?.id === search.sessionId ? session : undefined
  const currentAgent = currentSession?.agentId === sessionAgent?.id ? sessionAgent : undefined
  const canCreate = selectedAgent?.type === 'native' && !selectedAgent.deletedAt && !showTrash

  return (
    <div
      className="flex h-full min-h-0 w-full overflow-hidden bg-background"
      data-ui="agent.page"
      data-testid="agent-page">
      <aside className="flex w-64 min-w-56 shrink-0 flex-col border-r border-border-subtle bg-muted/20 max-[700px]:w-56">
        <div className="flex h-14 shrink-0 items-center gap-2 px-4">
          <Bot className="size-5 text-primary" />
          <h1 className="flex-1 text-sm font-semibold">{t('title.work', '工作')}</h1>
          <Tooltip content={t('agent.native.create', '新建智能体')}>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('agent.native.create', '新建智能体')}
              data-testid="agent-create"
              onClick={() => setEditor({})}>
              <Plus className="size-4" />
            </Button>
          </Tooltip>
        </div>
        <div className="space-y-3 px-3 pb-4">
          <div className="flex items-center gap-1">
            <Select
              value={selectedAgent?.id ?? ''}
              onValueChange={(id) => {
                setShowTrash(false)
                setFilter('')
                void navigate({ to: '/app/agents', search: { agentId: id }, replace: true })
              }}>
              <SelectTrigger className="min-w-0 flex-1 bg-background">
                <SelectValue placeholder={t('agent.native.select_agent', '选择智能体')} />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                    {agent.type !== 'native' ? ' · ' + t('agent.native.history_only', '仅历史') : ''}
                  </SelectItem>
                ))}
                {selectedAgent?.deletedAt && (
                  <SelectItem value={selectedAgent.id} disabled>
                    {selectedAgent.name} · {t('agent.native.archived', '已删除')}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            {selectedAgent?.type === 'native' && !selectedAgent.deletedAt && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  aria-label={t('agent.native.edit', '编辑智能体')}
                  onClick={() => setEditor({ agent: selectedAgent })}>
                  <Settings2 className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  aria-label={t('agent.native.delete_agent', '删除智能体')}
                  disabled={!!busy}
                  onClick={() => void deleteAgent()}>
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground">{t('agent.native.next_workspace', '新工作的工作区')}</p>
            <div className="flex items-center gap-1">
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger className="min-w-0 flex-1 border-border-subtle bg-transparent text-xs">
                  <FolderOpen className="mr-1 size-3.5 shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SYSTEM_WORKSPACE}>
                    {t('agent.native.system_workspace_new', '自动创建独立工作区')}
                  </SelectItem>
                  {workspaces
                    ?.filter((workspace) => workspace.type === 'user')
                    .map((workspace) => (
                      <SelectItem key={workspace.id} value={workspace.id}>
                        {workspace.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <Tooltip content={t('agent.native.choose_directory', '添加本地文件夹')}>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  aria-label={t('agent.native.choose_directory', '添加本地文件夹')}
                  loading={busy === 'workspace'}
                  disabled={!!busy}
                  onClick={() => void chooseDirectory()}>
                  <Plus className="size-4" />
                </Button>
              </Tooltip>
            </div>
          </div>
          <Button
            variant="emphasis"
            className="w-full"
            disabled={!canCreate || !!busy}
            loading={busy === 'create-session'}
            data-testid="agent-session-create"
            onClick={() => void createSession()}>
            <Plus className="size-4" />
            {t('agent.native.new_work', '新建工作')}
          </Button>
        </div>
        <div className="flex items-center gap-2 border-t border-border-subtle px-4 pt-3 pb-2 text-xs text-muted-foreground">
          <History className="size-3.5" />
          <span className="flex-1">
            {showTrash ? t('agent.native.trash', '回收站') : t('agent.native.history', '工作记录')}
          </span>
          {search.agentId && !showTrash && (
            <button
              type="button"
              className="hover:text-foreground"
              onClick={() => {
                void navigate({ to: '/app/agents', search: {}, replace: true })
              }}>
              {t('agent.native.all_sessions', '全部')}
            </button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="size-6"
            aria-label={showTrash ? t('agent.native.close_trash', '退出回收站') : t('agent.native.trash', '回收站')}
            onClick={() => {
              setShowTrash((current) => !current)
              setFilter('')
            }}>
            {showTrash ? <X className="size-3.5" /> : <Archive className="size-3.5" />}
          </Button>
        </div>
        <div className="relative mx-3 mb-2">
          <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            className="h-8 pl-8 text-xs"
            placeholder={t('agent.native.search_sessions', '搜索已加载的工作记录')}
            aria-label={t('agent.native.search_sessions', '搜索已加载的工作记录')}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {showTrash &&
            archivedAgents?.items.map((agent) => (
              <div
                key={agent.id}
                className="mb-1 flex items-center gap-2 rounded-lg border border-border-subtle p-2 text-xs">
                <Bot className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={t('agent.native.restore_agent', '恢复智能体')}
                  disabled={!!busy}
                  onClick={() => void restoreAgent(agent)}>
                  <RotateCcw className="size-3.5" />
                </Button>
              </div>
            ))}
          {history.isLoading && (
            <div className="flex justify-center p-5">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          )}
          {visibleSessions.map((item) => (
            <div
              key={item.id}
              className={cn(
                'group/session mb-1 flex min-w-0 items-center rounded-lg px-2 transition-colors hover:bg-accent',
                search.sessionId === item.id && 'bg-accent'
              )}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 py-2.5 text-left"
                data-testid="agent-session-item"
                data-session-id={item.id}
                onClick={() => navigateSession(item)}>
                <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">{item.name || t('agent.native.new_session', '新工作')}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    {new Date(item.lastActivityAt).toLocaleDateString()} · {item.workspace.name}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 opacity-0 group-hover/session:opacity-100 group-focus-within/session:opacity-100">
                {showTrash ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-6"
                    aria-label={t('agent.native.restore_session', '恢复工作')}
                    disabled={!!busy}
                    onClick={() => void restoreSession(item)}>
                    <RotateCcw className="size-3" />
                  </Button>
                ) : (
                  <>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      aria-label={t('agent.native.rename_session', '重命名工作')}
                      disabled={!!busy}
                      onClick={() => void renameSession(item)}>
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      aria-label={t('agent.native.delete_session', '删除工作')}
                      disabled={!!busy}
                      onClick={() => void deleteSession(item)}>
                      <Trash2 className="size-3" />
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
          {!history.isLoading && visibleSessions.length === 0 && (
            <p className="p-4 text-center text-xs text-muted-foreground">
              {t('agent.native.no_sessions', '还没有工作记录')}
            </p>
          )}
          {history.hasNext && (
            <Button
              className="mt-2 w-full"
              variant="ghost"
              size="sm"
              loading={history.isRefreshing}
              onClick={() => history.loadNext()}>
              {t('common.load_more', '加载更多')}
              <ChevronDown className="size-3" />
            </Button>
          )}
          {(history.error || agentsError) && (
            <div role="alert" className="break-words p-3 text-xs text-destructive">
              {history.error?.message ?? agentsError?.message}
              <Button variant="ghost" size="sm" onClick={refresh}>
                {t('common.retry', '重试')}
              </Button>
            </div>
          )}
        </div>
        <div className="border-t border-border-subtle px-4 py-3 text-[10px] text-muted-foreground">
          TinyCherry Native · {t('agent.native.local_workspace', '本地工作区')}
        </div>
      </aside>
      {currentSession ? (
        <NativeAgentConversation
          key={currentSession.id}
          session={currentSession}
          agent={currentAgent}
          onEdit={() => currentAgent && setEditor({ agent: currentAgent })}
        />
      ) : (
        <main className="flex min-w-0 flex-1 flex-col items-center justify-center p-8 text-center">
          {agentsLoading || sessionLoading || latestLoading ? (
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          ) : (
            <>
              <div className="mb-6 flex size-20 items-center justify-center rounded-3xl bg-primary/10">
                <Bot className="size-10 text-primary" />
              </div>
              <h2 className="mb-3 text-2xl font-medium">{t('agent.native.welcome', '让智能体帮你完成工作')}</h2>
              <p className="max-w-lg text-sm leading-7 text-muted-foreground">
                {t(
                  'agent.native.welcome_hint',
                  '把模型、指令和知识库组合成专属智能体。在独立工作区中分析资料、编辑文件和执行任务，完整保留过程与结果。'
                )}
              </p>
              <div className="mt-7 flex gap-3">
                <Button variant={canCreate ? 'outline' : 'emphasis'} onClick={() => setEditor({})}>
                  <Plus className="size-4" />
                  {t('agent.native.create', '新建智能体')}
                </Button>
                {canCreate && (
                  <Button variant="emphasis" disabled={!!busy} onClick={() => void createSession()}>
                    <MessageSquare className="size-4" />
                    {t('agent.native.new_work', '新建工作')}
                  </Button>
                )}
              </div>
              {sessionError && (
                <p role="alert" className="mt-5 text-sm text-destructive">
                  {sessionError.message}
                </p>
              )}
            </>
          )}
        </main>
      )}
      {editor && (
        <NativeAgentEditor
          key={editor.agent?.id ?? 'new'}
          agent={editor.agent}
          onClose={() => setEditor(null)}
          onSave={saveAgent}
        />
      )}
    </div>
  )
}

export default AgentPage
