import { useTranslation } from 'react-i18next'

/** Saved links remain readable while their backend is waiting for migration. */
export function FeatureUnavailable() {
  const { t } = useTranslation()
  return (
    <div role="status" className="flex h-full items-center justify-center p-8 text-muted-foreground">
      {t('desktop.feature_unavailable')}
    </div>
  )
}
