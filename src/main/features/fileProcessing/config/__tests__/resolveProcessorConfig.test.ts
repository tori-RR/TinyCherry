import { beforeEach, describe, expect, it, vi } from 'vitest'

const isSupportedSystemMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('../../processors/registry', () => ({
  processorRegistry: {
    tesseract: { isSupported: () => true },
    system: { isSupported: isSupportedSystemMock },
    paddleocr: { isSupported: () => true },
    'local-paddleocr': { isSupported: () => false },
    'local-document': { isSupported: () => false },
    ovocr: { isSupported: () => true },
    mineru: { isSupported: () => true },
    doc2x: { isSupported: () => true },
    mistral: { isSupported: () => true },
    'open-mineru': { isSupported: () => true }
  }
}))

import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'

import { MB } from '@shared/utils/constants'

import { getFileProcessorConfigById, resolveProcessorConfigByFeature } from '../resolveProcessorConfig'

describe('resolveProcessorConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockMainPreferenceServiceUtils.resetMocks()
    isSupportedSystemMock.mockReturnValue(true)
  })

  it('getFileProcessorConfigById merges preference override into preset config', () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.file_processing.overrides', {
      'open-mineru': {
        apiKeys: ['secret-key'],
        capabilities: {
          document_to_markdown: {
            apiHost: 'http://127.0.0.1:9000'
          }
        },
        options: {
          langs: ['eng']
        }
      }
    })

    expect(getFileProcessorConfigById('open-mineru')).toEqual({
      id: 'open-mineru',
      type: 'api',
      capabilities: [
        {
          feature: 'document_to_markdown',
          inputs: ['document'],
          output: 'markdown',
          apiHost: 'http://127.0.0.1:9000',
          maxInputBytes: 200 * MB
        }
      ],
      apiKeys: ['secret-key'],
      options: {
        langs: ['eng']
      }
    })
  })

  it('getFileProcessorConfigById throws notFound for an unknown processor id', () => {
    expect(() => getFileProcessorConfigById('missing' as never)).toThrowError('File processor not found: missing')
  })

  it('uses the explicit processor when one is provided', () => {
    MockMainPreferenceServiceUtils.setMultiplePreferenceValues({
      'feature.file_processing.default_document_to_markdown': 'open-mineru',
      'feature.file_processing.overrides': {
        paddleocr: {
          capabilities: {
            document_to_markdown: {
              modelId: 'paddle-custom'
            }
          }
        }
      }
    })

    const config = resolveProcessorConfigByFeature('document_to_markdown', 'paddleocr')

    expect(config.id).toBe('paddleocr')
    expect(config.capabilities.find((capability) => capability.feature === 'document_to_markdown')).toEqual(
      expect.objectContaining({
        feature: 'document_to_markdown',
        modelId: 'paddle-custom'
      })
    )
  })

  it('throws when the explicit processor does not support the requested feature', () => {
    expect(() => resolveProcessorConfigByFeature('document_to_markdown', 'tesseract')).toThrowError(
      'File processor tesseract does not support document_to_markdown'
    )
  })

  it('fails fast when no default processor is configured and the feature has no fallback', () => {
    expect(() => resolveProcessorConfigByFeature('document_to_markdown')).toThrowError(
      'Default file processor for document_to_markdown is not configured'
    )
  })

  it('uses mistral when it is the default markdown processor', () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.file_processing.default_document_to_markdown', 'mistral')

    expect(resolveProcessorConfigByFeature('document_to_markdown')).toEqual(
      expect.objectContaining({
        id: 'mistral'
      })
    )
  })

  it('rejects OCR even when a previous profile still has an OCR processor configured', () => {
    MockMainPreferenceServiceUtils.setPreferenceValue('feature.file_processing.default_image_to_text', 'tesseract')
    expect(() => resolveProcessorConfigByFeature('image_to_text')).toThrow('OCR is unavailable in TinyCherry')
    expect(() => resolveProcessorConfigByFeature('image_to_text', 'mistral')).toThrow(
      'OCR is unavailable in TinyCherry'
    )
  })
})
