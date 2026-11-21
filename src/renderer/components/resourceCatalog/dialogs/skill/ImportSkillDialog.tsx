import { Import, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, Button, Dialog, DialogContent, DialogDescription, DialogTitle } from '@cherrystudio/ui'
import { useSkillInstall } from '@renderer/hooks/useSkills'
import { toast } from '@renderer/services/toast'
import { formatErrorMessageWithPrefix } from '@renderer/utils/error'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type ImportKind = 'zip' | 'directory'

export function ImportSkillDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation()
  const { installFromZip, installFromDirectory } = useSkillInstall()
  const [installing, setInstalling] = useState<ImportKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) setError(null)
  }, [open])

  const importSkill = async (kind: ImportKind) => {
    if (installing) return
    setInstalling(kind)
    setError(null)
    try {
      const skill = await (kind === 'zip' ? installFromZip() : installFromDirectory())
      if (!skill) return
      toast.success(t('settings.skills.installSuccess', { name: skill.name }))
      onOpenChange(false)
    } catch (error) {
      setError(
        formatErrorMessageWithPrefix(error, t('settings.skills.installFailed', { name: t('library.type.skill') }))
      )
    } finally {
      setInstalling(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !installing && onOpenChange(next)}>
      <DialogContent onPointerDownOutside={(event) => installing && event.preventDefault()}>
        <div>
          <DialogTitle className="text-lg leading-none font-semibold text-foreground">
            {t('library.import_skill_dialog.title')}
          </DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            {t('library.import_skill_dialog.subtitle')}
          </DialogDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={Boolean(installing)} onClick={() => void importSkill('zip')}>
            {installing === 'zip' ? <Loader2 size={12} className="animate-spin" /> : <Import size={12} />}
            {t('settings.skills.installFromZip')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(installing)}
            onClick={() => void importSkill('directory')}>
            {installing === 'directory' ? <Loader2 size={12} className="animate-spin" /> : <Import size={12} />}
            {t('settings.skills.installFromDirectory')}
          </Button>
        </div>
        {error && <Alert type="error" showIcon message={error} className="rounded-md px-3 py-2 text-xs shadow-none" />}
      </DialogContent>
    </Dialog>
  )
}
