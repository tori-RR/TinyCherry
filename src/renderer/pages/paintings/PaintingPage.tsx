import { Link } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  ImagePlus,
  LoaderCircle,
  Palette,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  WandSparkles,
  X
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useSWR from 'swr'

import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Textarea
} from '@cherrystudio/ui'
import { useInfiniteQuery, useMutation } from '@data/hooks/useDataApi'
import { useDataChange } from '@data/hooks/useDataChange'
import { usePreference } from '@data/hooks/usePreference'
import { ipcApi } from '@renderer/ipc'
import type { Painting } from '@shared/data/types/painting'
import { IpcError } from '@shared/ipc/errors/IpcError'
import type { PaintingJob } from '@shared/ipc/schemas/painting'
import type { InputFor } from '@shared/ipc/types'

import { uploadPaintingImage } from './paintingFiles'
import { PaintingImage } from './PaintingImage'

type StartRequest = InputFor<'painting.generate.start'>
type ReferenceImage = { id: string; name: string }
const PENDING_KEY = 'tinycherry.paintings.pending-request'
const selectClass =
  'h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus:border-ring disabled:opacity-50'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。'
}

function recoverPendingRequest(): StartRequest | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as StartRequest | null
    if (
      value &&
      typeof value.requestId === 'string' &&
      typeof value.uniqueModelId === 'string' &&
      typeof value.prompt === 'string' &&
      value.params &&
      Array.isArray(value.inputFileIds)
    )
      return value
  } catch {
    /* A stale local draft never prevents the workspace from opening. */
  }
  return undefined
}

function rememberPendingRequest(value?: StartRequest): void {
  try {
    if (value) localStorage.setItem(PENDING_KEY, JSON.stringify(value))
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    /* Backend idempotency remains authoritative if browser storage is unavailable. */
  }
}

function jobLabel(job: PaintingJob): string {
  return { running: '正在生成', succeeded: '已完成', cancelled: '已取消', failed: '生成失败', interrupted: '生成中断' }[
    job.status
  ]
}

export default function PaintingPage() {
  const [defaultModel, setDefaultModel] = usePreference('feature.paintings.default_model_id')
  const [defaultProvider, setDefaultProvider] = usePreference('feature.paintings.default_provider')
  const {
    data: models = [],
    error: modelError,
    mutate: refreshModels
  } = useSWR('painting.models', () => ipcApi.request('painting.models'))
  const {
    data: jobs = [],
    error: jobError,
    mutate: refreshJobs
  } = useSWR('painting.generate.list', () => ipcApi.request('painting.generate.list'), {
    refreshInterval: (values) => (values?.some((job) => job.status === 'running') ? 1200 : 5000),
    revalidateOnFocus: true
  })
  const [modelId, setModelId] = useState('')
  const [prompt, setPrompt] = useState('')
  const [size, setSize] = useState('')
  const [quality, setQuality] = useState('')
  const [format, setFormat] = useState('')
  const [aspectRatio, setAspectRatio] = useState('')
  const [count, setCount] = useState(1)
  const [references, setReferences] = useState<ReferenceImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [pendingRequest, setPendingRequest] = useState(recoverPendingRequest)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [inTrash, setInTrash] = useState(false)
  const [preview, setPreview] = useState<{ painting: Painting; fileId: string }>()
  const [deleting, setDeleting] = useState<Painting>()
  const [exporting, setExporting] = useState<string>()
  const submittingRef = useRef(false)
  const uploadController = useRef<AbortController | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const referenceSnapshot = useRef(references)
  const pendingRequestSnapshot = useRef(pendingRequest)
  const parameterModelSnapshot = useRef(modelId)

  const updatePendingRequest = useCallback((next?: StartRequest) => {
    // Update synchronously: a hidden Activity can run cleanup before React commits
    // the render prompted by setState, while the start RPC is already in flight.
    pendingRequestSnapshot.current = next
    setPendingRequest(next)
    rememberPendingRequest(next)
  }, [])

  const query = useMemo(() => ({ inTrash }), [inTrash])
  const history = useInfiniteQuery('/paintings', { query, limit: 24, swrOptions: { keepPreviousData: false } })
  const paintings = useMemo(() => history.pages.flatMap((page) => page.items), [history.pages])
  const { trigger: deletePainting, isLoading: deletingPainting } = useMutation('DELETE', '/paintings/:id', {
    refresh: ['/paintings']
  })
  const { trigger: restorePainting } = useMutation('POST', '/paintings/:id/restore', { refresh: ['/paintings'] })
  const model = models.find((item) => item.id === modelId)
  const running = jobs.filter((job) => job.status === 'running')
  const lastIssue = jobs.find((job) => ['failed', 'interrupted', 'cancelled'].includes(job.status))
  const [dismissedIssue, setDismissedIssue] = useState<string>()

  useDataChange(['/providers', '/models'], () => void refreshModels())
  useDataChange('/paintings', () => {
    void history.refresh()
    void refreshJobs()
  })
  useEffect(() => {
    const removed = referenceSnapshot.current.filter((previous) => !references.some((next) => next.id === previous.id))
    referenceSnapshot.current = references
    for (const reference of removed) {
      if (!pendingRequestSnapshot.current?.inputFileIds.includes(reference.id)) {
        void ipcApi.request('painting.file.release', { fileId: reference.id }).catch(() => undefined)
      }
    }
  }, [references])
  useEffect(
    () => () => {
      uploadController.current?.abort()
      // TabRouter hides pages with Activity: cleanup also runs for a retained
      // draft. Only explicit removal releases references; abandoned drafts use
      // the backend's 24-hour cleanup, including an unconfirmed persisted start.
    },
    []
  )

  useEffect(() => {
    if (models.some((item) => item.id === modelId)) return
    const selected =
      models.find((item) => item.id === defaultModel) ??
      models.find((item) => item.providerId === defaultProvider) ??
      models[0]
    if (selected) setModelId(selected.id)
  }, [models, modelId, defaultModel, defaultProvider])

  useEffect(() => {
    if (parameterModelSnapshot.current === modelId) return
    parameterModelSnapshot.current = modelId
    setSize('')
    setQuality('')
    setFormat('')
    setAspectRatio('')
    setCount(1)
  }, [modelId])

  useEffect(() => {
    if (pendingRequest && jobs.some((job) => job.id === pendingRequest.requestId)) {
      updatePendingRequest()
    }
  }, [pendingRequest, jobs, updatePendingRequest])

  const selectModel = useCallback(
    (id: string) => {
      const selected = models.find((item) => item.id === id)
      if (!selected) return
      setModelId(id)
      void Promise.all([setDefaultModel(selected.id), setDefaultProvider(selected.providerId)]).catch((error) =>
        setError(errorMessage(error))
      )
    },
    [models, setDefaultModel, setDefaultProvider]
  )

  const generate = async () => {
    if (submittingRef.current || (!pendingRequest && !model)) return
    submittingRef.current = true
    setSubmitting(true)
    setError(undefined)
    setNotice(undefined)
    const request: StartRequest = pendingRequest ?? {
      requestId: crypto.randomUUID(),
      uniqueModelId: model!.id,
      prompt: prompt.trim(),
      inputFileIds: references.map((file) => file.id),
      params: {
        n: count,
        ...(size && { size }),
        ...(quality && { quality: quality as StartRequest['params']['quality'] }),
        ...(format && { outputFormat: format as StartRequest['params']['outputFormat'] }),
        ...(aspectRatio && { aspectRatio })
      }
    }
    updatePendingRequest(request)
    try {
      await ipcApi.request('painting.generate.start', request)
      updatePendingRequest()
      setInTrash(false)
      await refreshJobs()
    } catch (error) {
      if (error instanceof IpcError) {
        updatePendingRequest()
        setError(errorMessage(error))
      } else {
        setError('提交结果尚未确认。点击“确认提交状态”会核对同一任务，不会重复创建生成请求。')
      }
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const attach = async (files: FileList | null) => {
    if (!files?.length || uploading) return
    const limit = model?.maxInputs ?? 4
    if (references.length + files.length > limit) {
      setError(`当前模型最多支持 ${limit} 张参考图。`)
      return
    }
    const controller = new AbortController()
    uploadController.current = controller
    setUploading(true)
    setError(undefined)
    try {
      for (const file of files) {
        const entry = await uploadPaintingImage(file, controller.signal)
        setReferences((previous) => [...previous, { id: entry.id, name: file.name }])
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error))
    } finally {
      setUploading(false)
      uploadController.current = null
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const reuse = (painting: Painting) => {
    if (pendingRequestSnapshot.current) return
    setPrompt(painting.prompt)
    const id = `${painting.providerId}::${painting.modelId}`
    if (models.some((model) => model.id === id)) selectModel(id)
    setReferences(painting.files.input.map((id) => ({ id, name: '历史参考图' })))
    setNotice('已载入提示词和参考图，可调整参数后再次生成。')
    setPreview(undefined)
  }

  const exportImage = async (fileId: string) => {
    setExporting(fileId)
    setError(undefined)
    try {
      const result = await ipcApi.request('painting.file.export', { fileId })
      if (result.saved) setNotice('图片已保存。')
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setExporting(undefined)
    }
  }

  const remove = async (painting: Painting, permanent = false) => {
    try {
      await deletePainting({ params: { id: painting.id }, query: { permanent } })
      await history.refresh()
      setPreview(undefined)
      setDeleting(undefined)
      return true
    } catch (error) {
      setError(errorMessage(error))
      return false
    }
  }

  const canGenerate = Boolean(
    model && prompt.trim() && references.length <= model.maxInputs && running.length < 2 && !uploading
  )
  const issue = lastIssue && lastIssue.id !== dismissedIssue ? lastIssue : undefined

  return (
    <main
      data-testid="painting-page"
      data-ui="paintings.view"
      className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
        <div className="flex items-center gap-2.5">
          <Palette className="size-5 text-primary" />
          <h1 className="text-base font-semibold">绘画</h1>
          <span className="text-xs text-muted-foreground">让想象成为画面</span>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            void refreshModels()
            void refreshJobs()
            void history.refresh()
          }}
          aria-label="刷新绘画">
          <RefreshCw className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
        <aside className="flex shrink-0 flex-col gap-5 border-b p-6 lg:w-80 lg:overflow-auto lg:border-r lg:border-b-0 xl:w-96">
          <div className="space-y-2">
            <label htmlFor="painting-model" className="text-sm font-medium">
              绘画模型
            </label>
            <select
              data-testid="painting-model-select"
              id="painting-model"
              className={selectClass}
              value={modelId}
              onChange={(event) => selectModel(event.target.value)}
              disabled={Boolean(pendingRequest)}>
              {!models.length && <option value="">尚无可用的绘画模型</option>}
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.providerName} · {item.name}
                </option>
              ))}
            </select>
            {!models.length && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                在模型服务设置中启用绘画模型及其供应商。支持 OpenAI 图片接口、Gemini 原生图片模型、智谱 CogView 和
                SiliconFlow 绘画模型。
                <Link to="/settings/provider" className="ml-1 underline">
                  配置模型
                </Link>
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label htmlFor="painting-prompt" className="text-sm font-medium">
              画面描述
            </label>
            <Textarea.Input
              data-testid="painting-prompt"
              id="painting-prompt"
              className="min-h-40 resize-y text-sm leading-relaxed"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={32000}
              placeholder="描述主体、场景、风格与光线，例如：雨后的樱花街道，柔和的黄昏光，细腻的动画电影画面……"
              disabled={Boolean(pendingRequest)}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">参考图片</span>
              <span className="text-xs text-muted-foreground">
                {model?.canEdit ? `最多 ${model.maxInputs} 张` : '当前模型仅支持文生图'}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {references.map((reference) => (
                <div
                  key={reference.id}
                  className="relative size-16 overflow-hidden rounded-lg border"
                  title={reference.name}>
                  <PaintingImage fileId={reference.id} alt={reference.name} thumbnail className="h-full w-full" />
                  <button
                    type="button"
                    onClick={() => setReferences((items) => items.filter((item) => item.id !== reference.id))}
                    className="absolute top-0.5 right-0.5 rounded-full bg-background/90 p-0.5"
                    aria-label={`移除 ${reference.name}`}
                    disabled={Boolean(pendingRequest)}>
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <Button
                variant="outline"
                className="h-16 w-16 border-dashed"
                disabled={
                  !model?.canEdit || references.length >= model.maxInputs || uploading || Boolean(pendingRequest)
                }
                onClick={() => fileInput.current?.click()}
                aria-label="添加参考图片">
                {uploading ? <LoaderCircle className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              className="hidden"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(event) => void attach(event.target.files)}
            />
            <p className="text-xs text-muted-foreground">PNG、JPEG、WebP，每张不超过 20 MiB</p>
            {model && references.length > model.maxInputs && (
              <p role="alert" className="text-xs text-destructive">
                参考图数量超出当前模型限制，请移除图片或更换模型。
              </p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {model && model.sizes.length > 0 && (
              <label className="space-y-1.5 text-xs">
                尺寸
                <select
                  className={selectClass}
                  value={size}
                  onChange={(event) => setSize(event.target.value)}
                  disabled={Boolean(pendingRequest)}>
                  <option value="">模型默认</option>
                  {model.sizes.map((value) => (
                    <option key={value} value={value}>
                      {value.replace('x', ' × ')}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {model && model.aspectRatios.length > 0 && (
              <label className="space-y-1.5 text-xs">
                画面比例
                <select
                  className={selectClass}
                  value={aspectRatio}
                  onChange={(event) => setAspectRatio(event.target.value)}
                  disabled={Boolean(pendingRequest)}>
                  <option value="">模型默认</option>
                  {model.aspectRatios.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {model && model.qualities.length > 0 && (
              <label className="space-y-1.5 text-xs">
                质量
                <select
                  className={selectClass}
                  value={quality}
                  onChange={(event) => setQuality(event.target.value)}
                  disabled={Boolean(pendingRequest)}>
                  <option value="">模型默认</option>
                  {model.qualities.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {model && model.formats.length > 0 && (
              <label className="space-y-1.5 text-xs">
                格式
                <select
                  className={selectClass}
                  value={format}
                  onChange={(event) => setFormat(event.target.value)}
                  disabled={Boolean(pendingRequest)}>
                  <option value="">模型默认</option>
                  {model.formats.map((value) => (
                    <option key={value} value={value}>
                      {value.toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="space-y-1.5 text-xs">
              张数
              <select
                className={selectClass}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
                disabled={!model || Boolean(pendingRequest)}>
                {Array.from({ length: model?.maxImages ?? 1 }, (_, index) => (
                  <option key={index + 1} value={index + 1}>
                    {index + 1}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Button
            data-testid="painting-generate"
            size="lg"
            className="w-full"
            disabled={!pendingRequest && !canGenerate}
            loading={submitting}
            onClick={() => void generate()}>
            <WandSparkles className="size-4" />
            {pendingRequest ? '确认提交状态' : '生成图片'}
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            生成任务会保存在本机，切换页面后可继续查看。费用由所选供应商按其规则收取。
          </p>
        </aside>
        <section className="flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-auto">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex gap-2">
              <Button variant={!inTrash ? 'secondary' : 'ghost'} onClick={() => setInTrash(false)}>
                作品
              </Button>
              <Button variant={inTrash ? 'secondary' : 'ghost'} onClick={() => setInTrash(true)}>
                <Trash2 className="size-3.5" />
                回收站
              </Button>
            </div>
            <span className="text-xs text-muted-foreground">{history.pages[0]?.total ?? 0} 条记录</span>
          </div>
          {(error || modelError || jobError || history.error) && (
            <div
              role="alert"
              className="mx-6 mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error ?? errorMessage(modelError ?? jobError ?? history.error)}
              <button
                type="button"
                className="ml-2 underline"
                onClick={() => {
                  setError(undefined)
                  void refreshModels()
                  void refreshJobs()
                  void history.refresh()
                }}>
                刷新状态
              </button>
            </div>
          )}
          {notice && (
            <div role="status" className="mx-6 mb-4 flex items-center justify-between rounded-lg bg-muted p-3 text-sm">
              {notice}
              <button type="button" aria-label="关闭提示" onClick={() => setNotice(undefined)}>
                <X className="size-4" />
              </button>
            </div>
          )}
          {pendingRequest && !submitting && (
            <div role="status" className="mx-6 mb-4 rounded-lg border p-3 text-sm">
              上次提交尚未确认，请先确认任务状态。提示词：{pendingRequest.prompt.slice(0, 100)}
            </div>
          )}
          {running.map((job) => (
            <div
              key={job.id}
              data-job-id={job.id}
              className="mx-6 mb-3 flex items-center gap-3 rounded-xl border bg-muted/30 p-4">
              <LoaderCircle className="size-5 shrink-0 animate-spin text-primary" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">正在生成图片</p>
                <p className="truncate text-xs text-muted-foreground">{job.prompt}</p>
              </div>
              <Button
                data-testid="painting-cancel"
                data-job-id={job.id}
                variant="outline"
                onClick={() =>
                  void ipcApi
                    .request('painting.generate.abort', { requestId: job.id })
                    .then(() => refreshJobs())
                    .catch((error) => setError(errorMessage(error)))
                }>
                <Square className="size-3" />
                取消
              </Button>
            </div>
          ))}
          {issue && (
            <div className="mx-6 mb-4 rounded-lg border p-3 text-sm">
              <div className="flex justify-between">
                <strong className="font-medium">{jobLabel(issue)}</strong>
                <button type="button" aria-label="关闭任务提示" onClick={() => setDismissedIssue(issue.id)}>
                  <X className="size-4" />
                </button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{issue.error ?? '任务已停止。'}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">{issue.prompt}</p>
            </div>
          )}
          {history.isLoading ? (
            <div className="flex flex-1 items-center justify-center p-12">
              <LoaderCircle className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : paintings.length === 0 ? (
            <div className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <Palette className="size-12 text-muted-foreground/40" />
              <h2 className="text-base font-medium">{inTrash ? '回收站是空的' : '从一个想法开始'}</h2>
              <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
                {inTrash
                  ? '移入回收站的作品可在这里恢复。'
                  : '选择绘画模型，写下画面描述。生成的图片与提示词会一起保留在这里。'}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 px-6 pb-6 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {paintings.map((painting) => (
                <article
                  data-testid="painting-history-card"
                  data-painting-id={painting.id}
                  key={painting.id}
                  className="overflow-hidden rounded-xl border bg-card shadow-xs">
                  <button
                    data-testid="painting-preview-open"
                    type="button"
                    className="relative block aspect-square w-full overflow-hidden"
                    onClick={() =>
                      painting.files.output[0] && setPreview({ painting, fileId: painting.files.output[0] })
                    }
                    aria-label={`查看作品：${painting.prompt}`}>
                    {painting.files.output[0] ? (
                      <PaintingImage
                        fileId={painting.files.output[0]}
                        alt={painting.prompt}
                        thumbnail
                        className="h-full w-full"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center bg-muted">
                        <Palette className="size-8 text-muted-foreground" />
                      </div>
                    )}
                    {painting.files.output.length > 1 && (
                      <span className="absolute right-2 bottom-2 rounded-md bg-background/90 px-2 py-1 text-xs">
                        {painting.files.output.length} 张
                      </span>
                    )}
                  </button>
                  <div className="space-y-2 p-3">
                    <p className="line-clamp-2 min-h-10 text-sm leading-5" title={painting.prompt}>
                      {painting.prompt}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {painting.modelId} · {new Date(painting.createdAt).toLocaleDateString()}
                    </p>
                    <div className="flex justify-between gap-1">
                      {inTrash ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            void restorePainting({ params: { id: painting.id } })
                              .then(() => history.refresh())
                              .catch((error) => setError(errorMessage(error)))
                          }>
                          <RotateCcw className="size-3.5" />
                          恢复
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={Boolean(pendingRequest)}
                          onClick={() => reuse(painting)}>
                          <RotateCcw className="size-3.5" />
                          复用
                        </Button>
                      )}
                      <div className="flex gap-1">
                        {!inTrash && painting.files.output[0] && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="保存图片"
                            data-testid="painting-export"
                            data-file-id={painting.files.output[0]}
                            loading={exporting === painting.files.output[0]}
                            onClick={() => void exportImage(painting.files.output[0])}>
                            <ArrowDownToLine className="size-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={inTrash ? '永久删除作品' : '移入回收站'}
                          onClick={() => (inTrash ? setDeleting(painting) : void remove(painting))}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
          {history.hasNext && (
            <div className="flex justify-center pb-6">
              <Button variant="outline" disabled={history.isRefreshing} onClick={history.loadNext}>
                加载更多
              </Button>
            </div>
          )}
        </section>
      </div>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) setPreview(undefined)
        }}>
        <DialogContent
          data-testid="painting-preview"
          className="max-w-5xl"
          aria-describedby="painting-preview-description">
          <DialogHeader>
            <DialogTitle>作品预览</DialogTitle>
            <DialogDescription id="painting-preview-description" className="line-clamp-2">
              {preview?.painting.prompt}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <PaintingImage
                key={preview.fileId}
                fileId={preview.fileId}
                alt={preview.painting.prompt}
                className="h-[min(60vh,640px)] w-full rounded-lg"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-2">
                  {preview.painting.files.output.map((id) => (
                    <button
                      type="button"
                      key={id}
                      onClick={() => setPreview({ ...preview, fileId: id })}
                      className={`size-12 overflow-hidden rounded border-2 ${preview.fileId === id ? 'border-primary' : 'border-transparent'}`}
                      aria-label="切换图片">
                      <PaintingImage fileId={id} alt="作品缩略图" thumbnail className="h-full w-full" />
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  {!inTrash && (
                    <Button
                      variant="outline"
                      disabled={
                        Boolean(pendingRequest) ||
                        !model?.canEdit ||
                        references.length >= (model?.maxInputs ?? 0) ||
                        references.some((reference) => reference.id === preview.fileId)
                      }
                      onClick={() => {
                        if (pendingRequestSnapshot.current) return
                        setReferences((items) => [...items, { id: preview.fileId, name: '作品参考图' }])
                        setPreview(undefined)
                      }}>
                      <ImagePlus className="size-4" />
                      用作参考
                    </Button>
                  )}
                  <Button
                    data-testid="painting-preview-export"
                    loading={exporting === preview.fileId}
                    onClick={() => void exportImage(preview.fileId)}>
                    <ArrowDownToLine className="size-4" />
                    保存图片
                  </Button>
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined)
        }}
        title="永久删除这幅作品？"
        description="该记录和不再被其他作品引用的图片会从本机移除，无法恢复。"
        confirmText="永久删除"
        cancelText="取消"
        destructive
        confirmLoading={deletingPainting}
        onConfirm={() => (deleting ? remove(deleting, true) : undefined)}
      />
    </main>
  )
}
