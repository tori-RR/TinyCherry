import { Minus, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { ipcApi } from '@renderer/ipc'

export const WINDOW_CONTROLS_OVERLAY_WIDTH = '138px'

export function WindowControls() {
  const { t } = useTranslation()
  return (
    <div className="nodrag flex h-8 shrink-0" style={{ width: WINDOW_CONTROLS_OVERLAY_WIDTH }}>
      <Button
        variant="ghost"
        className="h-8 w-11.5 rounded-none p-0"
        aria-label={t('common.minimize')}
        onClick={() => void ipcApi.request('window.minimize')}>
        <Minus className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        className="h-8 w-11.5 rounded-none p-0"
        aria-label={t('common.maximize')}
        onClick={() =>
          void ipcApi
            .request('window.is_maximized')
            .then((max) => ipcApi.request(max ? 'window.unmaximize' : 'window.maximize'))
        }>
        <Square className="size-3" />
      </Button>
      <Button
        variant="ghost"
        className="h-8 w-11.5 rounded-none p-0 hover:bg-destructive hover:text-white"
        aria-label={t('common.close')}
        onClick={() => void ipcApi.request('window.close')}>
        <X className="size-4" />
      </Button>
    </div>
  )
}
export default WindowControls
