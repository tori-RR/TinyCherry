import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'

const mocks = vi.hoisted(() => ({
  openSettingsTab: vi.fn()
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => {
  return importOriginal<typeof CherryStudioUi>()
})

vi.mock('@renderer/services/mainWindowNavigation', () => ({
  openSettingsTab: mocks.openSettingsTab
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'common.cancel': 'Cancel',
        'common.go_to_settings': 'Go to settings',
        'knowledge.rag.file_processing': 'File processing',
        'knowledge.rag.file_processing_hint': 'Choose a document processor',
        'knowledge.rag.file_processing_none': "Don't use"
      })[key] ?? key
  })
}))

import FileProcessingSection from '../FileProcessingSection'

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

const options = [
  { value: 'paddleocr', label: 'PaddleOCR', disabled: false },
  { value: 'doc2x', label: 'Doc2X', disabled: true, statusLabel: 'Not configured' },
  { value: 'mineru', label: 'MinerU', disabled: false }
]

const LOCAL_OPTION = { value: 'local-document', label: 'Local document', disabled: false }
const renderSection = (onFileProcessorChange = vi.fn()) => {
  render(
    <FileProcessingSection
      fileProcessorId={null}
      initialFileProcessorId={null}
      fileProcessorOptions={options}
      onFileProcessorChange={onFileProcessorChange}
    />
  )
  return onFileProcessorChange
}

describe('FileProcessingSection', () => {
  it('shows unavailable processors without allowing selection', () => {
    const onFileProcessorChange = renderSection()

    const trigger = screen.getByRole('button', { name: 'File processing' })
    fireEvent.click(trigger)

    expect(screen.getByTestId('file-processor-selector-content')).toHaveStyle({ height: '185px' })
    // Select triggers must not add border or outer-ring feedback when expanded.
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).not.toHaveClass(
      'aria-expanded:border-primary',
      'aria-expanded:ring-3',
      'aria-expanded:ring-primary/20'
    )
    expect(screen.getByText('Not configured')).toBeInTheDocument()
    expect(screen.getByTestId('processor-icon-paddleocr').querySelector('svg')).toBeInTheDocument()
    expect(screen.getByTestId('processor-icon-doc2x').querySelector('svg')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: /Doc2X/ }))
    expect(onFileProcessorChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('option', { name: 'PaddleOCR' }))
    expect(onFileProcessorChange).toHaveBeenCalledWith('paddleocr')
  })

  it('keeps unknown supplied processors selectable without requiring a bundled logo', () => {
    const onFileProcessorChange = vi.fn()
    render(
      <FileProcessingSection
        fileProcessorId="local-document"
        initialFileProcessorId="local-document"
        fileProcessorOptions={[LOCAL_OPTION, { value: 'not-a-real-processor', label: 'Unmapped', disabled: false }]}
        onFileProcessorChange={onFileProcessorChange}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'File processing' }))

    // Supplied processor IDs may be absent from the bundled icon catalog.
    expect(screen.getAllByTestId('processor-icon-local-document')[0].querySelector('svg')).toBeInTheDocument()
    expect(screen.getByTestId('processor-icon-not-a-real-processor').querySelector('svg')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Local document' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Unmapped' }))
    expect(onFileProcessorChange).toHaveBeenCalledWith('not-a-real-processor')
  })

  it('clears the selection and opens document processing settings from the footer', () => {
    const onFileProcessorChange = renderSection()

    fireEvent.click(screen.getByRole('button', { name: 'File processing' }))
    fireEvent.click(screen.getByRole('button', { name: "Don't use" }))
    expect(onFileProcessorChange).toHaveBeenCalledWith(null)

    fireEvent.click(screen.getByRole('button', { name: 'File processing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Go to settings' }))
    expect(mocks.openSettingsTab).toHaveBeenCalledWith('/settings/file-processing')
  })

  it('focuses the list and skips unavailable processors during keyboard navigation', async () => {
    const user = userEvent.setup()
    const onFileProcessorChange = renderSection()

    await user.click(screen.getByRole('button', { name: 'File processing' }))

    const listbox = screen.getByRole('listbox', { name: 'File processing' })
    const paddleOption = screen.getByRole('option', { name: 'PaddleOCR' })
    const mineruOption = screen.getByRole('option', { name: 'MinerU' })
    await waitFor(() => {
      expect(listbox).toHaveFocus()
      expect(listbox).toHaveAttribute('aria-activedescendant', paddleOption.id)
    })

    await user.keyboard('{ArrowDown}')
    expect(listbox).toHaveAttribute('aria-activedescendant', mineruOption.id)

    await user.keyboard('{ArrowUp}')
    expect(listbox).toHaveAttribute('aria-activedescendant', paddleOption.id)

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onFileProcessorChange).toHaveBeenCalledWith('mineru')
  })
})
