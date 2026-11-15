import type { FileProcessorFeature } from '@shared/data/preference/preferenceTypes'

import type { FileProcessingCapabilityHandler, FileProcessingProcessorRegistry } from './types'

function lazyHandler<Feature extends FileProcessorFeature>(
  mode: FileProcessingCapabilityHandler['mode'],
  load: () => Promise<FileProcessingCapabilityHandler<Feature>>
): FileProcessingCapabilityHandler<Feature> {
  let handlerPromise: Promise<FileProcessingCapabilityHandler<Feature>> | undefined

  return {
    mode,
    async prepare(file, config, signal, context) {
      const handler = await (handlerPromise ??= load())
      return handler.prepare(file, config, signal, context)
    }
  }
}

export const processorRegistry = {
  tesseract: { runtime: 'local', isSupported: () => false, capabilities: {} },
  system: { runtime: 'local', isSupported: () => false, capabilities: {} },
  paddleocr: {
    runtime: 'remote',
    isSupported: () => true,
    capabilities: {
      document_to_markdown: lazyHandler('remote-poll', async () =>
        import('./paddleocr/documentToMarkdown/handler').then(
          ({ paddleDocumentToMarkdownHandler }) => paddleDocumentToMarkdownHandler
        )
      )
    }
  },
  'local-paddleocr': { runtime: 'local', isSupported: () => false, capabilities: {} },
  'local-document': { runtime: 'local', isSupported: () => false, capabilities: {} },
  ovocr: { runtime: 'local', isSupported: () => false, capabilities: {} },
  mineru: {
    runtime: 'remote',
    isSupported: () => true,
    capabilities: {
      document_to_markdown: lazyHandler('remote-poll', async () =>
        import('./mineru/documentToMarkdown/handler').then(
          ({ mineruDocumentToMarkdownHandler }) => mineruDocumentToMarkdownHandler
        )
      )
    }
  },
  doc2x: {
    runtime: 'remote',
    isSupported: () => true,
    capabilities: {
      document_to_markdown: lazyHandler('remote-poll', async () =>
        import('./doc2x/documentToMarkdown/handler').then(
          ({ doc2xDocumentToMarkdownHandler }) => doc2xDocumentToMarkdownHandler
        )
      )
    }
  },
  mistral: {
    runtime: 'remote',
    isSupported: () => true,
    capabilities: {
      document_to_markdown: lazyHandler('background', async () =>
        import('./mistral/documentToMarkdown/handler').then(
          ({ mistralDocumentToMarkdownHandler }) => mistralDocumentToMarkdownHandler
        )
      )
    }
  },
  'open-mineru': {
    runtime: 'remote',
    isSupported: () => true,
    capabilities: {
      document_to_markdown: lazyHandler('auto', async () =>
        import('./openMineru/documentToMarkdown/handler').then(
          ({ openMineruDocumentToMarkdownHandler }) => openMineruDocumentToMarkdownHandler
        )
      )
    }
  }
} satisfies FileProcessingProcessorRegistry
