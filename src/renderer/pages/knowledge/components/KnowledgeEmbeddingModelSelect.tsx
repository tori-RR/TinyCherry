import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'

import { type KnowledgeModelSelectProps } from './KnowledgeModelSelect'
type KnowledgeEmbeddingModelSelectProps = Omit<KnowledgeModelSelectProps, 'filter' | 'prioritizedProviderIds'>
export const KnowledgeEmbeddingModelSelect = (props: KnowledgeEmbeddingModelSelectProps) => {
  const { t } = useTranslation()
  {
    return (
      <div className="flex flex-col gap-1.5">
        <Button
          type="button"
          variant="outline"
          disabled
          aria-label={props['aria-label']}
          className="h-8 w-full justify-start font-normal">
          {t('knowledge.evostack.bm25_only')}
        </Button>
        <p className="m-0 text-muted-foreground text-xs">{t('knowledge.evostack.embedding_unavailable')}</p>
      </div>
    )
  }
}
