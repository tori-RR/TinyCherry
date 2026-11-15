import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as RendererPlatform from '@renderer/utils/platform'

import ChunkingSection from '../ChunkingSection'

const platform = vi.hoisted(() => ({ native: false }))
vi.mock('@renderer/utils/platform', async (original) => ({
  ...(await original<typeof RendererPlatform>()),
  get isEvoStack() {
    return platform.native
  }
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const renderSection = (structured = true) =>
  render(
    <ChunkingSection
      chunkStrategy={structured ? 'structured' : 'delimiter'}
      chunkSeparator={'\\n\\n'}
      chunkSize="512"
      chunkOverlap="64"
      onChunkStrategyChange={vi.fn()}
      onChunkSeparatorChange={vi.fn()}
      onChunkSizeChange={vi.fn()}
      onChunkOverlapChange={vi.fn()}
    />
  )

describe('chunking capabilities', () => {
  beforeEach(() => {
    platform.native = false
  })

  it('keeps Electron smart chunking and token units', () => {
    renderSection()
    expect(screen.getByRole('switch', { name: 'knowledge.rag.smart_chunking' })).toBeChecked()
    expect(screen.getAllByText('knowledge.rag.tokens_unit')).toHaveLength(2)
    expect(screen.getByRole('textbox', { name: 'knowledge.rag.chunk_separator' })).toBeEnabled()
  })

  it('uses character units and disables the ignored separator in native window mode', async () => {
    platform.native = true
    renderSection()
    expect(screen.getByRole('switch', { name: 'knowledge.rag.character_window' })).toBeChecked()
    expect(screen.getAllByText('knowledge.rag.characters_unit')).toHaveLength(2)
    expect(screen.queryByText('knowledge.rag.tokens_unit')).not.toBeInTheDocument()
    const separator = screen.getByRole('textbox', { name: 'knowledge.rag.chunk_separator' })
    expect(separator).toBeDisabled()
    await userEvent.setup().type(separator, 'changed')
    expect(separator).toHaveValue('\\n\\n')
    expect(screen.getByRole('textbox', { name: 'knowledge.rag.chunk_size' })).toBeEnabled()
  })

  it('allows editing the separator in native delimiter mode', () => {
    platform.native = true
    renderSection(false)
    expect(screen.getByRole('textbox', { name: 'knowledge.rag.chunk_separator' })).toBeEnabled()
  })
})
