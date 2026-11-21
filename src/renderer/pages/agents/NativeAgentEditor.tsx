import { Bot, ChevronDown, ShieldCheck, ShieldEllipsis, Wrench } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Textarea
} from '@cherrystudio/ui'
import { ModelSelector, type ModelSelectorFilter } from '@renderer/components/ModelSelector'
import { useKnowledgeBases } from '@renderer/hooks/useKnowledgeBase'
import { useDefaultModel, useModelById } from '@renderer/hooks/useModel'
import { useProviderById } from '@renderer/hooks/useProvider'
import { getErrorMessage } from '@renderer/utils/error'
import { cn } from '@renderer/utils/style'
import { isNativeAgentModelCompatible, NATIVE_AGENT_TOOLS } from '@shared/ai/nativeAgentRuntime'
import type { AgentEntity } from '@shared/data/api/schemas/agents'
import type { UniqueModelId } from '@shared/data/types/model'
import type { CreateAgentCommand } from '@shared/ipc/schemas/ai'

const modelFilter: ModelSelectorFilter = (model, provider) => isNativeAgentModelCompatible(provider, model)

export function NativeAgentEditor({
  agent,
  onClose,
  onSave
}: {
  agent?: AgentEntity
  onClose: () => void
  onSave: (input: CreateAgentCommand) => Promise<void>
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(agent?.name ?? '')
  const [description, setDescription] = useState(agent?.description ?? '')
  const [instructions, setInstructions] = useState(agent?.instructions ?? '')
  const [modelId, setModelId] = useState<UniqueModelId | undefined>(agent?.model ?? undefined)
  const [permissionMode, setPermissionMode] = useState<'default' | 'plan'>(
    agent?.configuration?.permission_mode === 'plan' ? 'plan' : 'default'
  )
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState(agent?.knowledgeBaseIds ?? [])
  const [disabledTools, setDisabledTools] = useState(agent?.disabledTools ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const { bases, error: knowledgeError } = useKnowledgeBases()
  const { defaultModel } = useDefaultModel()
  const { provider: defaultProvider } = useProviderById(defaultModel?.providerId)
  const { model } = useModelById(modelId)
  const { provider } = useProviderById(model?.providerId)
  const validModel = !!model && isNativeAgentModelCompatible(provider, model)

  useEffect(() => {
    if (!modelId && defaultModel && isNativeAgentModelCompatible(defaultProvider, defaultModel)) {
      setModelId(defaultModel.id)
    }
  }, [defaultModel, defaultProvider, modelId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || !name.trim() || !modelId || !validModel) return
    setSaving(true)
    setError(undefined)
    try {
      await onSave({
        type: 'native',
        name: name.trim(),
        description: description.trim(),
        instructions,
        model: modelId,
        knowledgeBaseIds,
        disabledTools,
        configuration: { ...agent?.configuration, permission_mode: permissionMode }
      })
      onClose()
    } catch (cause) {
      setError(getErrorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        size="lg"
        className="max-h-[90vh] overflow-y-auto"
        closeOnOverlayClick={false}
        data-testid="agent-editor">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-primary" />
            {agent ? t('agent.native.edit', '编辑智能体') : t('agent.native.create', '新建智能体')}
          </DialogTitle>
          <DialogDescription>
            {t('agent.native.editor_hint', '设定智能体的目标、模型和可用工具。每个工作会话保留独立的历史与工作区。')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-5" inert={saving}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="native-agent-name">{t('common.name', '名称')}</Label>
              <Input
                id="native-agent-name"
                data-testid="agent-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={255}
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label>{t('agent.native.model', '模型')}</Label>
              <ModelSelector
                multiple={false}
                selectionType="id"
                value={modelId}
                onSelect={setModelId}
                filter={modelFilter}
                onSettingsNavigate={(navigate) => {
                  onClose()
                  navigate()
                }}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full justify-between"
                    data-testid="agent-model-select">
                    <span className="truncate">
                      {model?.name ?? modelId ?? t('agent.native.select_model', '选择模型')}
                    </span>
                    <ChevronDown className="size-4 shrink-0" />
                  </Button>
                }
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('agent.native.model_hint', '使用已启用、支持工具调用的 OpenAI Chat Completions 兼容模型。')}
          </p>
          <div className="space-y-2">
            <Label htmlFor="native-agent-description">{t('common.description', '说明')}</Label>
            <Input
              id="native-agent-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={4096}
              placeholder={t('agent.native.description_placeholder', '例如：整理项目文档、分析代码和生成报告')}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="native-agent-instructions">{t('agent.native.instructions', '系统指令')}</Label>
            <Textarea.Input
              id="native-agent-instructions"
              data-testid="agent-instructions"
              value={instructions}
              onValueChange={setInstructions}
              maxLength={65536}
              rows={5}
              className="max-h-64 resize-y font-mono text-sm"
              placeholder={t('agent.native.instructions_placeholder', '描述角色、工作方式和完成任务的标准…')}
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{t('agent.native.permissions', '执行权限')}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(['default', 'plan'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={permissionMode === mode}
                  data-testid={`agent-permission-${mode}`}
                  onClick={() => setPermissionMode(mode)}
                  className={cn(
                    'rounded-xl border p-3 text-left transition-colors',
                    permissionMode === mode ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'
                  )}>
                  <span className="mb-1 flex items-center gap-2 text-sm font-medium">
                    {mode === 'default' ? <ShieldCheck className="size-4" /> : <ShieldEllipsis className="size-4" />}
                    {mode === 'default'
                      ? t('agent.native.default_mode', '逐次确认')
                      : t('agent.native.plan_mode', '只读规划')}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {mode === 'default'
                      ? t('agent.native.default_hint', '自动读取工作区，写入文件和运行命令前请求确认。')
                      : t('agent.native.plan_hint', '只允许浏览、读取和搜索文件，不写文件或运行命令。')}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
              <Wrench className="size-4" />
              {t('agent.native.tools', '可用工具')}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {NATIVE_AGENT_TOOLS.map((tool) => (
                <label
                  key={tool.id}
                  className={cn(
                    'flex items-start gap-2 rounded-lg border border-border-subtle p-2.5 text-sm',
                    permissionMode === 'plan' && tool.writes && 'opacity-50'
                  )}>
                  <Checkbox
                    aria-label={tool.label}
                    checked={!disabledTools.includes(tool.id)}
                    disabled={permissionMode === 'plan' && tool.writes}
                    onCheckedChange={(checked) =>
                      setDisabledTools((current) =>
                        checked ? current.filter((id) => id !== tool.id) : [...current, tool.id]
                      )
                    }
                  />
                  <span>
                    <span className="block">{t(`agent.native.tools.${tool.id}.label`, tool.label)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {t(`agent.native.tools.${tool.id}.description`, tool.description)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {(bases.length > 0 || knowledgeError) && (
            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">{t('title.knowledge', '知识库')}</legend>
              {knowledgeError ? (
                <p role="alert" className="text-xs text-destructive">
                  {knowledgeError.message}
                </p>
              ) : (
                <div className="grid max-h-32 gap-2 overflow-y-auto sm:grid-cols-2">
                  {bases.map((base) => (
                    <label key={base.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        aria-label={base.name}
                        checked={knowledgeBaseIds.includes(base.id)}
                        disabled={knowledgeBaseIds.length >= 10 && !knowledgeBaseIds.includes(base.id)}
                        onCheckedChange={(checked) =>
                          setKnowledgeBaseIds((ids) =>
                            checked ? [...ids, base.id] : ids.filter((id) => id !== base.id)
                          )
                        }
                      />
                      <span className="truncate">{base.name}</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {t('agent.native.knowledge_hint', '每次提问会从所选知识库检索相关内容作为任务上下文。')}
              </p>
            </fieldset>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <span className="mr-auto self-center text-xs text-muted-foreground">TinyCherry Native</span>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {t('common.cancel', '取消')}
            </Button>
            <Button
              type="submit"
              variant="emphasis"
              disabled={!name.trim() || !validModel}
              loading={saving}
              data-testid="agent-save">
              {agent ? t('common.save', '保存') : t('common.create', '创建')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
