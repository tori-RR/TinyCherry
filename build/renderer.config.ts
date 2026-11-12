import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

import { APP_EDITIONS, type AppEdition } from '../src/shared/types/appEdition'
import { parseReleaseHistory, validateCurrentReleaseHistory } from '../src/shared/utils/releaseNotes'

const resolve = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url))

export const rendererAliases = {
  '@renderer': resolve('src/renderer'),
  '@shared': resolve('src/shared'),
  '@logger': resolve('src/renderer/services/LoggerService'),
  '@data': resolve('src/renderer/data'),
  '@cherrystudio/ai-core/provider': resolve('packages/aiCore/src/core/providers'),
  '@cherrystudio/ai-core/built-in/plugins': resolve('packages/aiCore/src/core/plugins/built-in'),
  '@cherrystudio/ai-core': resolve('packages/aiCore/src'),
  '@cherrystudio/extension-table-plus': resolve('packages/extension-table-plus/src'),
  '@cherrystudio/ai-sdk-provider': resolve('packages/ai-sdk-provider/src'),
  '@cherrystudio/provider-registry/node': resolve('packages/provider-registry/src/registry-loader'),
  '@cherrystudio/provider-registry': resolve('packages/provider-registry/src'),
  '@cherrystudio/web-search/catalog': resolve('packages/web-search/src/catalog.ts'),
  '@cherrystudio/web-search/providers/zhipu': resolve('packages/web-search/src/providers/zhipu.ts'),
  '@cherrystudio/web-search/providers/tavily': resolve('packages/web-search/src/providers/tavily.ts'),
  '@cherrystudio/web-search/providers/searxng': resolve('packages/web-search/src/providers/searxng.ts'),
  '@cherrystudio/web-search/providers/exa': resolve('packages/web-search/src/providers/exa.ts'),
  '@cherrystudio/web-search/providers/exa-mcp': resolve('packages/web-search/src/providers/exaMcp.ts'),
  '@cherrystudio/web-search/providers/bocha': resolve('packages/web-search/src/providers/bocha.ts'),
  '@cherrystudio/web-search/providers/querit': resolve('packages/web-search/src/providers/querit.ts'),
  '@cherrystudio/web-search/providers/jina': resolve('packages/web-search/src/providers/jina.ts'),
  '@cherrystudio/web-search/providers/firecrawl': resolve('packages/web-search/src/providers/firecrawl.ts'),
  '@cherrystudio/web-search/providers/crawl4ai': resolve('packages/web-search/src/providers/crawl4ai.ts'),
  '@cherrystudio/web-search/providers/parallel': resolve('packages/web-search/src/providers/parallel.ts'),
  '@cherrystudio/web-search/providers/serply': resolve('packages/web-search/src/providers/serply.ts'),
  '@cherrystudio/web-search/providers/deepseek': resolve('packages/web-search/src/providers/deepseek.ts'),
  '@cherrystudio/web-search/providers/desearch': resolve('packages/web-search/src/providers/desearch.ts'),
  '@cherrystudio/web-search/providers/searchapi': resolve('packages/web-search/src/providers/searchapi.ts'),
  '@cherrystudio/web-search/tools/config': resolve('packages/web-search/src/tools/config.ts'),
  '@cherrystudio/web-search/tools/url-filter': resolve('packages/web-search/src/tools/urlFilter.ts'),
  '@cherrystudio/web-search/tools/content': resolve('packages/web-search/src/tools/content.ts'),
  '@cherrystudio/web-search': resolve('packages/web-search/src/index.ts'),
  '@cherrystudio/file-preview/core': resolve('packages/file-preview/src/core.ts'),
  '@cherrystudio/file-preview/react': resolve('packages/file-preview/src/react.ts'),
  '@cherrystudio/ui/icons/providers': resolve('packages/ui/src/components/icons/providers'),
  '@cherrystudio/ui/icons': resolve('packages/ui/src/components/icons'),
  '@cherrystudio/ui': resolve('packages/ui/src'),
  '@test-mocks': resolve('tests/__mocks__')
}

export function resolveRendererEdition(value: string | undefined): AppEdition {
  const edition = value?.trim().toLowerCase() || 'global'
  if (APP_EDITIONS.includes(edition as AppEdition)) return edition as AppEdition
  throw new Error(`Unsupported renderer edition: ${edition}`)
}

export function loadRendererReleaseMetadata(version: string) {
  const config = parse(readFileSync(resolve('electron-builder.yml'), 'utf8')) as {
    releaseInfo?: { releaseNotes?: unknown }
  }
  const releaseNotes = config.releaseInfo?.releaseNotes
  if (typeof releaseNotes !== 'string' || !releaseNotes.trim()) {
    throw new Error('electron-builder.yml must define non-empty releaseInfo.releaseNotes')
  }
  const history = parseReleaseHistory(readFileSync(resolve('resources/cherry-studio/release-history.json'), 'utf8'))
  validateCurrentReleaseHistory({ releaseNotes, version }, history)
  return { releaseNotes, history }
}

export function rendererDefines(version: string, edition = resolveRendererEdition(process.env.CHERRY_EDITION)) {
  const { releaseNotes, history } = loadRendererReleaseMetadata(version)
  return {
    __APP_EDITION__: JSON.stringify(edition),
    __APP_RELEASE_HISTORY__: JSON.stringify(history),
    __APP_RELEASE_NOTES__: JSON.stringify(releaseNotes),
    __APP_RELEASE_VERSION__: JSON.stringify(version)
  }
}
