import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import './generate-skills'
import './generate-computer-tools'
import { DefaultBootConfig } from '../../src/shared/data/bootConfig/bootConfigSchemas'
import { DefaultPreferences } from '../../src/shared/data/preference/preferenceSchemas'
import { CHATGPT_SUB_PROVIDER_ID } from '../../src/shared/data/presets/chatgptSub'
import { NOUS_PORTAL_PROVIDER_ID } from '../../src/shared/data/presets/nousPortal'
import { isExcludedProviderPreset } from '../../src/shared/data/presets/providerCatalog'
import { isRetiredProvider } from '../../src/shared/data/presets/retiredProviders'
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
    authType: [NOUS_PORTAL_PROVIDER_ID, CHATGPT_SUB_PROVIDER_ID].includes(provider.id) ? 'oauth' : 'api-key',
    reportsActualCost: false,
    isEnabled: false
  }))
writeFileSync(
  `${directory}/defaults.json`,
  JSON.stringify({ preferences, assistantSettings: DEFAULT_ASSISTANT_SETTINGS, providers })
)
