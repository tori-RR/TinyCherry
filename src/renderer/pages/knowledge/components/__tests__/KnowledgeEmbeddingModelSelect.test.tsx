import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'

import { KnowledgeEmbeddingModelSelect } from '../KnowledgeEmbeddingModelSelect'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
it('keeps BM25 available and cannot invoke the pending embedding selector', async () => {
  const onChange = vi.fn()
  render(<KnowledgeEmbeddingModelSelect aria-label="Embedding model" onChange={onChange} />)
  const button = screen.getByRole('button', { name: 'Embedding model' })
  expect(button).toBeDisabled()
  await userEvent.click(button)
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByText('knowledge.evostack.embedding_unavailable')).toBeVisible()
})
