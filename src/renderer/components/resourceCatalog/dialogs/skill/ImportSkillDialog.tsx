import { CheckCircle2, CircleAlert, Import, Loader2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, Dialog, DialogContent, Input, Label, ScrollArea } from '@cherrystudio/ui'
import { useSkillInstall } from '@renderer/hooks/useSkills'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'
import { AbsoluteFilePathSchema } from '@shared/types/file'
import type { InstalledSkill } from '@shared/types/skill'
interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}
type ImportStatus =
  | {
      kind: 'idle'
    }
  | {
      kind: 'error'
      message: string
    }
type InstallingKey = null | 'zip' | 'directory'
type ImportKind = 'zip' | 'directory'
type ImportItemStatus = 'pending' | 'installing' | 'success' | 'error'
type ImportItem = {
  id: string
  kind: ImportKind
  name: string
  path: string
  status: ImportItemStatus
  skillName?: string
  error?: string
}
/**
 * Skill import dialog — local install only (ZIP file or directory
 * containing `SKILL.md`). Online registry search stays in the sibling
 * `SkillMarketplaceDialog`, keeping local and remote install flows separate.
 *
 * Drop-zone + explicit picker buttons share the same pipeline through
 * `useSkillInstall.installFromZip` / `installFromDirectory`. Cache
 * invalidation for `/skills` is handled inside the hook, so the library
 * grid refreshes automatically after each successful install.
 */
export function ImportSkillDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const { installFromZip, installFromDirectory } = useSkillInstall()
  const [status, setStatus] = useState<ImportStatus>({ kind: 'idle' })
  const [installing, setInstalling] = useState<InstallingKey>(null)
  const [items, setItems] = useState<ImportItem[]>([])
  const [nativePath, setNativePath] = useState('')
  // Reset transient state on open / close.
  useEffect(() => {
    if (!open) {
      setStatus({ kind: 'idle' })
      setInstalling(null)
      setItems([])
      setNativePath('')
    }
  }, [open])
  const close = () => {
    if (installing) return
    onOpenChange(false)
  }
  const getInstallErrorMessage = useCallback(
    (e: unknown, fallbackName?: string) => {
      const prefix = t('settings.skills.installFailed', { name: fallbackName ?? t('library.type.skill') })
      return e instanceof Error && e.message ? formatErrorMessageWithPrefix(e, prefix) : prefix
    },
    [t]
  )
  const updateItem = useCallback((id: string, patch: Partial<ImportItem>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }, [])
  const runImportQueue = useCallback(
    async (nextItems: ImportItem[], installingKey: Exclude<InstallingKey, null>) => {
      if (installing) return
      setInstalling(installingKey)
      setStatus({ kind: 'idle' })
      setItems(nextItems)
      let successCount = 0
      const preErrorCount = nextItems.filter((item) => item.status === 'error').length
      let failedCount = preErrorCount
      let lastSkill: InstalledSkill | null = null
      try {
        for (const item of nextItems) {
          if (item.status === 'error') continue
          updateItem(item.id, { status: 'installing', error: undefined })
          try {
            const skill = item.kind === 'zip' ? await installFromZip(item.path) : await installFromDirectory(item.path)
            if (!skill) {
              failedCount += 1
              updateItem(item.id, { status: 'error', error: getInstallErrorMessage(undefined, item.name) })
              continue
            }
            lastSkill = skill
            successCount += 1
            updateItem(item.id, { status: 'success', skillName: skill.name })
          } catch (error) {
            failedCount += 1
            updateItem(item.id, { status: 'error', error: getInstallErrorMessage(error, item.name) })
          }
        }
        if (preErrorCount === nextItems.length) return
        if (failedCount > 0) {
          if (nextItems.length > 1) {
            setStatus({
              kind: 'error',
              message: t('settings.skills.batchInstallPartialFailed', {
                failed: failedCount,
                success: successCount,
                total: nextItems.length
              })
            })
          }
          return
        }
        const message =
          nextItems.length === 1 && lastSkill
            ? t('settings.skills.installSuccess', { name: lastSkill.name })
            : t('settings.skills.batchInstallComplete', { count: successCount })
        toast.success(message)
        onOpenChange(false)
      } finally {
        setInstalling(null)
      }
    },
    [getInstallErrorMessage, installFromDirectory, installFromZip, installing, onOpenChange, t, updateItem]
  )
  const createImportItem = useCallback(
    (
      kind: ImportKind,
      filePath: string,
      name: string,
      index: number,
      itemStatus: ImportItemStatus = 'pending'
    ): ImportItem => ({
      id: `${Date.now()}-${index}-${filePath}`,
      kind,
      name,
      path: filePath,
      status: itemStatus
    }),
    []
  )
  const getNameFromPath = (filePath: string) => {
    const name = filePath.split(/[/\\]/).pop()
    return name || filePath
  }
  const handleZipPick = async () => {
    if (installing) return
    {
      const path = nativePath.trim()
      if (!AbsoluteFilePathSchema.safeParse(path).success) {
        setStatus({ kind: 'error', message: t('settings.skills.evostack.path_required') })
        return
      }
      await runImportQueue([createImportItem('zip', path, getNameFromPath(path), 0)], 'zip')
      return
    }
  }
  const handleDirPick = async () => {
    if (installing) return
    {
      const path = nativePath.trim()
      if (!AbsoluteFilePathSchema.safeParse(path).success) {
        setStatus({ kind: 'error', message: t('settings.skills.evostack.path_required') })
        return
      }
      await runImportQueue([createImportItem('directory', path, getNameFromPath(path), 0)], 'directory')
      return
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !installing) close()
      }}>
      <DialogContent className="overflow-hidden" onPointerDownOutside={(event) => installing && event.preventDefault()}>
        {/* Header */}
        <div>
          <div>
            <h3 className="text-lg leading-none font-semibold text-foreground">
              {t('library.import_skill_dialog.title')}
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">{t('library.import_skill_dialog.subtitle')}</p>
          </div>
        </div>

        {/* Body */}
        <div className="min-w-0">
          {
            <div className="space-y-2">
              <Label htmlFor="native-skill-import-path">{t('settings.skills.evostack.import_path')}</Label>
              <Input
                id="native-skill-import-path"
                value={nativePath}
                onChange={(event) => setNativePath(event.target.value)}
                disabled={Boolean(installing)}
              />
              <p className="text-xs text-muted-foreground">{t('settings.skills.evostack.import_hint')}</p>
            </div>
          }

          <div className="mt-4 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleZipPick()}
              disabled={Boolean(installing)}
              className="shrink-0">
              {installing === 'zip' ? <Loader2 size={12} className="animate-spin" /> : <Import size={12} />}
              <span>{t('settings.skills.installFromZip')}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleDirPick()}
              disabled={Boolean(installing)}
              className="shrink-0">
              {installing === 'directory' ? <Loader2 size={12} className="animate-spin" /> : <Import size={12} />}
              <span>{t('settings.skills.installFromDirectory')}</span>
            </Button>
          </div>

          <ImportResultList items={items} />
          <StatusBanner status={status} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
function ImportResultList({ items }: { items: ImportItem[] }) {
  const { t } = useTranslation()
  if (items.length === 0) return null
  return (
    <ScrollArea
      viewportProps={{ 'data-testid': 'skill-import-results', className: 'overflow-x-hidden' }}
      className="mt-4 max-h-44 w-full max-w-full min-w-0 rounded-md border border-border-subtle bg-background-subtle/50">
      <div className="min-w-0 divide-y divide-border-subtle">
        {items.map((item) => {
          const displayName = item.status === 'success' ? (item.skillName ?? item.name) : item.name
          return (
            <div key={item.id} className="flex min-w-0 items-start gap-2 px-3 py-2 text-xs">
              <ImportItemStatusIcon status={item.status} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-foreground" title={displayName}>
                  {displayName}
                </div>
                {item.status !== 'success' ? (
                  <div
                    className="mt-0.5 min-w-0 [overflow-wrap:anywhere] break-words whitespace-normal text-foreground-tertiary"
                    title={item.status === 'error' ? item.error : undefined}>
                    {item.status === 'pending' ? t('settings.skills.batchInstallQueued') : null}
                    {item.status === 'installing' ? t('common.loading') : null}
                    {item.status === 'error' ? item.error : null}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
function ImportItemStatusIcon({ status }: { status: ImportItemStatus }) {
  if (status === 'installing') {
    return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-foreground-tertiary" />
  }
  if (status === 'success') {
    return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
  }
  if (status === 'error') {
    return <CircleAlert size={14} className="mt-0.5 shrink-0 text-error" />
  }
  return <span className="mt-1.5 size-2 shrink-0 rounded-full border border-border-strong bg-muted" />
}
function StatusBanner({ status }: { status: ImportStatus }) {
  return (
    <AnimatePresence>
      {status.kind === 'error' && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className="mt-4">
          <Alert type="error" showIcon message={status.message} className="rounded-md px-3 py-2 text-xs shadow-none" />
        </motion.div>
      )}
    </AnimatePresence>
  )
}
