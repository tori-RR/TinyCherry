import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import AppLogo from '@renderer/assets/images/logo.png'
import { useOpenReleaseNotes } from '@renderer/hooks/useOpenReleaseNotes'
import { APP_NAME } from '@shared/utils/constants'

export default function AboutSettings() {
  const { t } = useTranslation()
  const openReleaseNotes = useOpenReleaseNotes()
  return (
    <div className="mx-auto flex max-w-200 flex-col items-center gap-5 p-10">
      <img src={AppLogo} alt="" className="size-20" />
      <h1 className="text-2xl font-semibold">{APP_NAME}</h1>
      <p>{window.desktop.info.version}</p>
      <Button variant="outline" onClick={() => openReleaseNotes()}>
        {t('settings.about.release_notes')}
      </Button>
    </div>
  )
}
