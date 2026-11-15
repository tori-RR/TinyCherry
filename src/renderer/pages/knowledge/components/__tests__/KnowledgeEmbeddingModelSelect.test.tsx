import { mockUseQuery } from '@test-mocks/renderer/useDataApi'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { ApiPath, ResponseForPath } from '@shared/data/api/paths'
import { LOCAL_EMBEDDING_UNIQUE_MODEL_ID } from '@shared/data/presets/localEmbedding'
import { type Model, MODEL_CAPABILITY, type UniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'

import { KnowledgeEmbeddingModelSelect } from '../KnowledgeEmbeddingModelSelect'

// jsdom has no viewport measurements; keep the real selector's rows and filtering.
vi.mock('@renderer/components/VirtualList', () => ({
  DynamicVirtualList: ({
    list,
    children
  }: {
    list: unknown[]
    children: (item: unknown, index: number) => ReactNode
  }) => list.map(children)
}))

vi.unmock('@cherrystudio/ui')
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const makeEmbeddingModel = (id: UniqueModelId, providerId: string, name: string): Model => ({
  id,
  providerId,
  name,
  capabilities: [MODEL_CAPABILITY.EMBEDDING],
  supportsStreaming: false,
  isEnabled: true,
  isHidden: false
})

describe('KnowledgeEmbeddingModelSelect', () => {
  it('offers provider embeddings, excludes retired local and chat models, and selects the Ollama id', async () => {
    const user = userEvent.setup()
    const embeddingModel: Model = {
      ...makeEmbeddingModel('ollama::acme-retriever:latest', 'ollama', 'acme-retriever:latest'),
      apiModelId: 'acme-retriever:latest',
      supportsStreaming: true
    }
    const models: Model[] = [
      embeddingModel,
      { ...makeEmbeddingModel('ollama::llama3', 'ollama', 'llama3'), capabilities: [], supportsStreaming: true },
      makeEmbeddingModel(LOCAL_EMBEDDING_UNIQUE_MODEL_ID, 'local-embedding', 'Qwen3 Embedding 0.6B')
    ]
    const providers: Provider[] = ['ollama', 'local-embedding'].map((id) => ({
      id,
      name: id,
      isEnabled: true,
      authType: 'api-key',
      apiKeys: [],
      settings: {},
      reportsActualCost: false
    }))
    const onChange = vi.fn()
    await mockUseQuery.withImplementation(
      <TPath extends ApiPath>(path: TPath) => ({
        data: (path === '/models' ? models : path === '/providers' ? providers : []) as ResponseForPath<TPath, 'GET'>,
        isLoading: false,
        isRefreshing: false,
        error: undefined,
        refetch: vi.fn().mockResolvedValue(undefined),
        mutate: vi.fn()
      }),
      async () => {
        render(<KnowledgeEmbeddingModelSelect value={null} placeholder="Choose embedding model" onChange={onChange} />)

        await user.click(screen.getByRole('button', { name: /Choose embedding model/ }))

        expect(await screen.findByRole('option', { name: /acme-retriever:latest/ })).toBeInTheDocument()
        expect(screen.queryByRole('option', { name: /Qwen3 Embedding 0.6B/ })).not.toBeInTheDocument()
        expect(screen.queryByRole('option', { name: /llama3/ })).not.toBeInTheDocument()
        await user.click(screen.getByRole('option', { name: /acme-retriever:latest/ }))

        expect(onChange).toHaveBeenCalledWith('ollama::acme-retriever:latest')
      }
    )
  })
})
