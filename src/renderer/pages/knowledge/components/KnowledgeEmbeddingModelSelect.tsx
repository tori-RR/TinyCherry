import { useTranslation } from 'react-i18next'

import { Button } from '@cherrystudio/ui'
import { isEvoStack } from '@renderer/utils/platform'
import { LOCAL_EMBEDDING_UNIQUE_MODEL_ID } from '@shared/data/presets/localEmbedding'

import { isEmbeddingModel, KnowledgeModelSelect, type KnowledgeModelSelectProps } from './KnowledgeModelSelect'

type KnowledgeEmbeddingModelSelectProps = Omit<KnowledgeModelSelectProps, 'filter' | 'prioritizedProviderIds'>

export const KnowledgeEmbeddingModelSelect = (props: KnowledgeEmbeddingModelSelectProps) => {
  const { t } = useTranslation()
  if (isEvoStack) {
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
  return (
    <KnowledgeModelSelect
      {...props}
      filter={(model) => isEmbeddingModel(model) && model.id !== LOCAL_EMBEDDING_UNIQUE_MODEL_ID}
    />
  )
}
