import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import './generate-skills'
import './generate-computer-tools'
import { isRetiredProvider } from '../../src/main/data/retiredProviders'
import { DefaultBootConfig } from '../../src/shared/data/bootConfig/bootConfigSchemas'
import { DefaultPreferences } from '../../src/shared/data/preference/preferenceSchemas'
import { isExcludedProviderPreset } from '../../src/shared/data/presets/providerCatalog'
import { DEFAULT_ASSISTANT_SETTINGS } from '../../src/shared/data/types/assistant'

const directory = fileURLToPath(new URL('backend/generated/', import.meta.url))
mkdirSync(directory, { recursive: true })
const preferences = {
  ...DefaultPreferences.default,
  ...Object.fromEntries(
    Object.entries(DefaultBootConfig)
      .filter(([key]) => !key.startsWith('temp.'))
      .map(([key, value]) => [`BootConfig.${key}`, value])
  ),
  'app.dist.auto_update.enabled': false,
  'app.privacy.data_collection.enabled': false
}
const catalog = JSON.parse(
  readFileSync(new URL('../../packages/provider-registry/data/providers.json', import.meta.url), 'utf8')
)
const providers = catalog.providers
  .filter((provider: { id: string }) => !isExcludedProviderPreset(provider.id) && !isRetiredProvider(provider.id))
  .map((provider: any) => ({
    ...provider,
    websites: provider.metadata?.website,
    settings: {},
    apiKeys: [],
    authType: 'api-key',
    reportsActualCost: false,
    isEnabled: false
  }))
writeFileSync(
  `${directory}/defaults.json`,
  JSON.stringify({ preferences, assistantSettings: DEFAULT_ASSISTANT_SETTINGS, providers })
)
