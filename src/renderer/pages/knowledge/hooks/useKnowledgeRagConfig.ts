import { useMemo } from 'react'

import { useMutation } from '@data/hooks/useDataApi'
import { loggerService } from '@logger'
import type { KnowledgeBase } from '@shared/data/types/knowledge'

import type { FileProcessorSelectorOption } from '../panels/ragConfig/FileProcessorSelector'
import type { KnowledgeRagConfigFormValues } from '../types'
import { normalizeKnowledgeError } from '../utils/error'
import { buildKnowledgeRagConfigPatch, createKnowledgeRagConfigFormValues } from '../utils/rag'

const logger = loggerService.withContext('useKnowledgeRagConfig')

export const useKnowledgeRagConfig = (base: KnowledgeBase) => {
  const { trigger, isLoading, error } = useMutation('PATCH', '/knowledge-bases/:id', {
    refresh: ['/knowledge-bases']
  })

  const initialValues = useMemo(() => createKnowledgeRagConfigFormValues(base), [base])

  const fileProcessorOptions: FileProcessorSelectorOption[] = []

  const save = async (
    values: KnowledgeRagConfigFormValues,
    embeddingModelOverride?: { embeddingModelId: string | null; dimensions: number | null }
  ) => {
    const patch = buildKnowledgeRagConfigPatch(initialValues, values)

    if (embeddingModelOverride) {
      patch.embeddingModelId = embeddingModelOverride.embeddingModelId
      patch.dimensions = embeddingModelOverride.dimensions
    }

    try {
      return await trigger({
        params: { id: base.id },
        body: patch
      })
    } catch (saveError) {
      const normalizedError = normalizeKnowledgeError(saveError)
      logger.error('Failed to update knowledge RAG config', normalizedError, {
        baseId: base.id,
        updates: patch
      })
      throw normalizedError
    }
  }

  return {
    initialValues,
    fileProcessorOptions,
    save,
    isLoading,
    error
  }
}
