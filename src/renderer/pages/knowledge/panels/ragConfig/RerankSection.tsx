import type { FC } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'

import { RagFieldLabel } from './panelPrimitives'
interface RerankSectionProps {
  rerankModelId: string | null
  onRerankModelChange: (rerankModelId: string | null) => void
}
const RerankSection: FC<RerankSectionProps> = () => {
  const { t } = useTranslation()
  return (
    <div>
      <RagFieldLabel label={t('knowledge.rag.rerank_model')} hint={t('knowledge.rag.hints.rerank_model')} />
      {
        <Button type="button" variant="outline" disabled className="h-8 w-full justify-start font-normal">
          {t('knowledge.rag.rerank_disabled')}
        </Button>
      }
    </div>
  )
}
export default RerankSection
