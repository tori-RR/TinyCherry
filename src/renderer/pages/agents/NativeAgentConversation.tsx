import type { DynamicToolUIPart } from 'ai'
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  Loader2,
  ShieldCheck,
  Square,
  Terminal,
  Wrench,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Tooltip } from '@cherrystudio/ui'
import ComposerSurface, { type ComposerSurfaceActions } from '@renderer/components/composer/ComposerSurface'
import { AppMarkdown, MarkdownHostProvider } from '@renderer/components/markdown'
import { toast } from '@renderer/services/toast'
import { getErrorMessage } from '@renderer/utils/error'
import { cn } from '@renderer/utils/style'
import { NATIVE_AGENT_TOOLS } from '@shared/ai/nativeAgentRuntime'
import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { AgentSessionEntity } from '@shared/data/api/schemas/agentSessions'
import type { CherryUIMessage } from '@shared/data/types/message'

import { readNativeAgentDraft, writeNativeAgentDraft } from './nativeAgentMessages'
import { useNativeAgentSession } from './useNativeAgentSession'

const EMPTY_TOKENS: [] = []
const ignoreChange = () => {}

function displayValue(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')
}

function trustedToolCwd(part: DynamicToolUIPart): string | undefined {
  const metadata = part.callProviderMetadata?.cherry
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const cwd = metadata.resolvedCwd ?? metadata.workspacePath
  return typeof cwd === 'string' ? cwd : undefined
}

export function NativeAgentToolCard({
  part,
  messageId,
  canApprove,
  onRespond
}: {
  part: DynamicToolUIPart
  messageId: string
  canApprove: boolean
  onRespond: (approvalId: string, messageId: string, approved: boolean) => Promise<void>
}) {
  const { t } = useTranslation()
  const [responding, setResponding] = useState(false)
  const [decided, setDecided] = useState(false)
  const [error, setError] = useState<string>()
  const pending = part.state === 'approval-requested'
  const working =
    part.state === 'input-streaming' || part.state === 'input-available' || part.state === 'approval-responded'
  const failed = part.state === 'output-error' || part.state === 'output-denied'
  const tool = NATIVE_AGENT_TOOLS.find((candidate) => candidate.id === part.toolName)
  const cwd = trustedToolCwd(part)
  const handleDecision = async (approved: boolean) => {
    if (!pending || !canApprove || responding || decided) return
    setResponding(true)
    setError(undefined)
    try {
      await onRespond(part.approval.id, messageId, approved)
      setDecided(true)
    } catch (cause) {
      setError(getErrorMessage(cause))
    } finally {
      setResponding(false)
    }
  }

  return (
    <div
      data-testid="agent-tool-card"
      data-tool-name={part.toolName}
      data-tool-state={part.state}
      className={cn(
        'my-3 overflow-hidden rounded-xl border text-sm',
        pending ? 'border-amber-500/40 bg-amber-500/5' : 'border-border-subtle bg-muted/25'
      )}>
      <div className="flex items-center gap-2 px-3 py-2.5">
        {pending ? (
          <ShieldCheck className="size-4 text-amber-600" />
        ) : working && canApprove ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : failed ? (
          <X className="size-4 text-destructive" />
        ) : (
          <Check className="size-4 text-muted-foreground" />
        )}
        <span className="font-medium">
          {tool ? t(`agent.native.tools.${tool.id}.label`, tool.label) : part.toolName}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {pending
            ? t('agent.native.awaiting_approval', '等待本次确认')
            : working
              ? t('agent.native.tool_running', '执行中')
              : failed
                ? t('agent.native.tool_failed', '未完成')
                : t('agent.native.tool_done', '已完成')}
        </span>
      </div>
      <details open={pending || failed} className="border-t border-border-subtle">
        <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
          {t('agent.native.tool_details', '参数与执行结果')}
        </summary>
        <div className="space-y-2 px-3 pb-3">
          {cwd && (
            <div className="flex items-start gap-2 text-xs">
              <FolderOpen className="mt-0.5 size-3.5 shrink-0" />
              <code className="break-all">{cwd}</code>
            </div>
          )}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/60 p-3 text-xs">
            {displayValue(part.input)}
          </pre>
          {part.state === 'output-available' && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-background/60 p-3 text-xs">
              {displayValue(part.output)}
            </pre>
          )}
          {part.state === 'output-error' && (
            <p className="whitespace-pre-wrap break-words text-destructive">{part.errorText}</p>
          )}
          {part.state === 'output-denied' && (
            <p className="text-muted-foreground">{t('agent.native.tool_denied', '已拒绝本次操作。')}</p>
          )}
        </div>
      </details>
      {pending && (
        <div className="space-y-3 border-t border-amber-500/20 px-3 py-3">
          {part.toolName === 'run_shell' && (
            <p className="text-xs text-muted-foreground">
              {t(
                'agent.native.shell_notice',
                '命令以当前用户权限运行，可访问工作区以外的系统资源。请核对完整命令与执行目录后决定。'
              )}
            </p>
          )}
          {!canApprove && (
            <p className="text-xs text-muted-foreground">
              {t('agent.native.approval_expired', '任务已停止，此审批不再有效。')}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canApprove || responding || decided}
              data-testid="agent-tool-reject"
              onClick={() => void handleDecision(false)}>
              {t('agent.native.reject_once', '拒绝本次')}
            </Button>
            <Button
              variant="emphasis"
              size="sm"
              loading={responding}
              disabled={!canApprove || decided}
              data-testid="agent-tool-approve"
              onClick={() => void handleDecision(true)}>
              {decided ? t('agent.native.decision_sent', '已发送决定') : t('agent.native.approve_once', '允许本次')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function NativeMessage({
  message,
  agentName,
  isRunning,
  onRespond
}: {
  message: CherryUIMessage
  agentName: string
  isRunning: boolean
  onRespond: (approvalId: string, messageId: string, approved: boolean) => Promise<void>
}) {
  const { t } = useTranslation()
  const user = message.role === 'user'
  const pending = !user && isRunning && message.metadata?.status === 'pending'
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n\n')
      )
      toast.success(t('common.copied', '已复制'))
    } catch (error) {
      toast.error(getErrorMessage(error))
    }
  }
  return (
    <article className="group/message py-5" data-agent-message-id={message.id}>
      <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        {!user && <Bot className="size-4" />}
        <span className="font-medium text-foreground">{user ? t('agent.native.you', '你') : agentName}</span>
        {message.metadata?.createdAt && (
          <time dateTime={message.metadata.createdAt}>
            {new Date(message.metadata.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-6 opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100"
          aria-label={t('common.copy', '复制')}
          onClick={() => void copy()}>
          <Copy className="size-3.5" />
        </Button>
      </div>
      <div className={cn('min-w-0 space-y-3', user && 'rounded-2xl bg-accent/50 px-4 py-3')}>
        {message.parts.map((part, index) => {
          const key = `${message.id}:${index}`
          if (part.type === 'text')
            return (
              <AppMarkdown key={key} id={key} isStreaming={pending} className="break-words text-sm leading-7">
                {part.text}
              </AppMarkdown>
            )
          if (part.type === 'reasoning')
            return (
              <details
                key={key}
                className="rounded-lg border border-border-subtle px-3 py-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('agent.native.reasoning', '思考过程')}</summary>
                <div className="pt-2">
                  <AppMarkdown id={key} isStreaming={pending}>
                    {part.text}
                  </AppMarkdown>
                </div>
              </details>
            )
          if (part.type === 'dynamic-tool')
            return (
              <NativeAgentToolCard
                key={part.toolCallId}
                part={part}
                messageId={message.id}
                canApprove={isRunning}
                onRespond={onRespond}
              />
            )
          if (part.type === 'data-error')
            return (
              <p key={key} role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                {part.data.message ?? t('agent.native.execution_error', '任务执行失败，请检查模型和供应商配置。')}
              </p>
            )
          if (part.type === 'file')
            return (
              <p key={key} className="text-sm text-muted-foreground">
                {part.filename ?? part.mediaType}
              </p>
            )
          return null
        })}
        {pending && message.parts.length === 0 && (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t('agent.native.working', '正在处理任务…')}
          </div>
        )}
        {!pending && message.metadata?.status === 'paused' && (
          <p className="text-xs text-muted-foreground">{t('agent.native.stopped', '任务已停止，可继续发送新指令。')}</p>
        )}
      </div>
    </article>
  )
}

export function NativeAgentConversation({
  session,
  agent,
  onEdit
}: {
  session: AgentSessionEntity
  agent?: AgentEntity
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const runtime = useNativeAgentSession(session.id)
  const [text, setText] = useState(() => readNativeAgentDraft(session.id).text)
  const [expanded, setExpanded] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const followBottom = useRef(true)
  const actionsRef = useRef<ComposerSurfaceActions | null>(null)
  const canRun = agent?.type === 'native' && !!agent.model && !agent.deletedAt && !session.deletedAt
  const permissionMode = agent?.configuration?.permission_mode === 'plan' ? 'plan' : 'default'
  const setDraft = (value: string) => {
    setText(value)
    writeNativeAgentDraft(session.id, value)
  }
  useEffect(() => {
    if (followBottom.current && scrollerRef.current) scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight
  }, [runtime.messages])

  const send = async (draft: { text: string }) => {
    if (!canRun) return
    if (await runtime.send(draft.text)) {
      const current = readNativeAgentDraft(session.id).text
      setText(current)
      actionsRef.current?.replaceDraft({ text: current, tokens: [] })
      followBottom.current = true
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-ui="agent.conversation" data-testid="agent-conversation">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-6 py-3">
        <Bot className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{session.name || t('agent.native.new_session', '新工作')}</div>
          <div className="truncate text-xs text-muted-foreground">
            {agent?.name ?? t('agent.native.deleted_agent', '已删除的智能体')} ·{' '}
            {agent?.modelName ?? agent?.model ?? t('agent.native.no_model', '未选择模型')}
          </div>
        </div>
        {runtime.isRunning && (
          <Button size="sm" variant="outline" data-testid="agent-stop" onClick={() => void runtime.stop()}>
            <Square className="size-3" />
            {t('common.stop', '停止')}
          </Button>
        )}
        {agent?.type === 'native' && (
          <Button size="sm" variant="ghost" disabled={runtime.isRunning} onClick={onEdit}>
            <Wrench className="size-4" />
            {t('agent.native.settings', '配置')}
          </Button>
        )}
      </div>
      <Tooltip content={session.workspace.path}>
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border-subtle bg-muted/20 px-6 py-2 text-xs text-muted-foreground">
          <FolderOpen className="size-3.5 shrink-0" />
          <span className="shrink-0">
            {session.workspace.type === 'system'
              ? t('agent.native.system_workspace', '独立工作区')
              : session.workspace.name}
          </span>
          <code className="truncate">{session.workspace.path}</code>
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-5 shrink-0"
            aria-label={t('agent.native.copy_workspace', '复制工作区路径')}
            onClick={() =>
              void navigator.clipboard
                .writeText(session.workspace.path)
                .then(() => toast.success(t('common.copied', '已复制')))
                .catch((error) => toast.error(getErrorMessage(error)))
            }>
            <Copy className="size-3" />
          </Button>
        </div>
      </Tooltip>
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 overflow-y-auto"
        onScroll={(event) => {
          const el = event.currentTarget
          followBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
        }}>
        <div className="mx-auto w-full max-w-4xl px-6 pb-8">
          {runtime.hasOlder && (
            <div className="pt-4 text-center">
              <Button variant="ghost" size="sm" loading={runtime.isLoadingOlder} onClick={() => runtime.loadOlder()}>
                {t('agent.native.load_older', '加载更早的记录')}
              </Button>
            </div>
          )}
          {runtime.isLoading && (
            <div className="flex justify-center p-10">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!runtime.isLoading && runtime.messages.length === 0 && (
            <div className="flex flex-col items-center px-6 py-16 text-center">
              <div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary/10">
                <Bot className="size-7 text-primary" />
              </div>
              <h2 className="mb-2 text-xl font-medium">{t('agent.native.ready', '准备开始工作')}</h2>
              <p className="max-w-md text-sm leading-6 text-muted-foreground">
                {agent?.description ||
                  t(
                    'agent.native.ready_hint',
                    '描述你想完成的任务。智能体可以在工作区内读取资料、修改文件并运行经你确认的命令。'
                  )}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {['梳理这个目录的内容并给出摘要', '检查项目结构，列出可改进的地方', '根据现有资料起草一份说明文档'].map(
                  (prompt) => (
                    <Button
                      key={prompt}
                      size="sm"
                      variant="outline"
                      className="rounded-full text-xs"
                      disabled={!canRun}
                      onClick={() => {
                        setDraft(prompt)
                        actionsRef.current?.replaceDraft({ text: prompt, tokens: [] })
                        actionsRef.current?.focus('end')
                      }}>
                      {prompt}
                    </Button>
                  )
                )}
              </div>
            </div>
          )}
          <MarkdownHostProvider
            openExternalUrl={(url) => window.api.shell.openExternal(url)}
            notifyError={(message) => toast.error(message)}
            notifySuccess={(message) => toast.success(message)}>
            {runtime.messages.map((message) => (
              <NativeMessage
                key={message.id}
                message={message}
                agentName={agent?.name ?? 'TinyCherry Native'}
                isRunning={runtime.isRunning}
                onRespond={runtime.respond}
              />
            ))}
          </MarkdownHostProvider>
        </div>
      </div>
      {!canRun && (
        <div className="mx-6 mb-3 rounded-lg bg-muted p-3 text-sm text-muted-foreground">
          {!agent || agent.deletedAt
            ? t('agent.native.orphan_history', '此智能体已删除，工作记录仍可查看。')
            : agent.type !== 'native'
              ? t(
                  'agent.native.legacy_runtime',
                  '此记录使用其他运行时。当前版本执行 TinyCherry Native 智能体，你可以新建一个 Native 智能体继续工作。'
                )
              : !agent.model
                ? t('agent.native.choose_model_first', '请先在配置中选择模型。')
                : t('agent.native.trash_readonly', '回收站中的工作记录只读，恢复后可以继续。')}
        </div>
      )}
      {runtime.error && (
        <div
          role="alert"
          className="mx-6 mb-3 flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
          <span className="min-w-0 flex-1 break-words">{runtime.error}</span>
          <Button variant="ghost" size="sm" onClick={() => void runtime.refresh()}>
            {t('common.refresh', '刷新')}
          </Button>
        </div>
      )}
      <div className="shrink-0 pb-4" data-testid="agent-composer">
        <ComposerSurface
          text={text}
          onTextChange={setDraft}
          tokens={EMPTY_TOKENS}
          managedTokenKinds={EMPTY_TOKENS}
          onTokensChange={ignoreChange}
          placeholder={t('agent.native.prompt', '描述任务，或继续给智能体指令…')}
          sendDisabled={!canRun || !text.trim() || runtime.isRunning || runtime.isSubmitting}
          isLoading={runtime.isRunning}
          onSendDraft={send}
          onPause={runtime.stop}
          supportedExts={EMPTY_TOKENS}
          setFiles={ignoreChange}
          filesCount={0}
          isExpanded={expanded}
          onExpandedChange={setExpanded}
          quickPanelEnabled={false}
          enableDragDrop={false}
          enableSpellCheck={false}
          editable={canRun && !runtime.isSubmitting}
          fontSize={14}
          narrowMode
          markdownLivePreview
          onActionsChange={(actions) => {
            actionsRef.current = actions
          }}
          renderLeftControls={() => (
            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Terminal className="size-3.5" />
              <span>TinyCherry Native</span>
              <span className="text-border">·</span>
              <ShieldCheck className="size-3.5" />
              <span>
                {permissionMode === 'plan'
                  ? t('agent.native.plan_mode', '只读规划')
                  : t('agent.native.default_mode', '逐次确认')}
              </span>
              {runtime.isSubmitting && <Loader2 className="size-3.5 animate-spin" />}
            </div>
          )}
          renderBelowControls={() => (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <ChevronDown className="size-3" />
              {t('agent.native.composer_hint', '历史与工具执行结果会自动保存。切换工作不会中断正在执行的任务。')}
            </div>
          )}
        />
      </div>
    </div>
  )
}
