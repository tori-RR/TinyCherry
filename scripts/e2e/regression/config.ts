import type { CaseId } from './cases'

const customProviderConfig = [
  'CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL',
  'CHERRY_TEST_CUSTOM_PROVIDER_ANTHROPIC_BASE_URL',
  'CHERRY_TEST_CUSTOM_PROVIDER_API_KEY',
  'CHERRY_TEST_CUSTOM_PROVIDER_CHAT_MODEL'
] as const

export const REQUIRED_CONFIG = [
  ...customProviderConfig,
  'CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_BASE_URL',
  'CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_API_KEY',
  'CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_MODEL',
  'CHERRY_TEST_CHERRYIN_CHAT_MODEL',
  'CHERRY_TEST_CHERRYIN_IMAGE_MODEL',
  'CHERRY_TEST_CHERRYIN_ACCOUNT',
  'CHERRY_TEST_CHERRYIN_PASSWORD'
] as const

export type RequiredConfigName = (typeof REQUIRED_CONFIG)[number]

const customProviderCases: readonly CaseId[] = [
  'M-02',
  'C-01',
  'C-02',
  'A-01',
  'A-02',
  'A-03',
  'A-04',
  'CODE-01',
  'CODE-03',
  'MP-09',
  'MP-10',
  'MP-16',
  'MP-19',
  'MP-31',
  'MP-32',
  'MP-35',
  'MP-36',
  'MP-51',
  'MP-52',
  'MP-53',
  'MP-55',
  'MP-138',
  'MP-139',
  'MP-144',
  'MP-152',
  'MP-153'
]

export function requiredConfigForCases(cases: readonly { id: CaseId }[]): RequiredConfigName[] {
  const required = new Set<RequiredConfigName>()
  for (const { id } of cases) {
    if (customProviderCases.includes(id)) {
      for (const name of customProviderConfig) required.add(name)
    }
    if (id === 'M-01' || id === 'P-01' || id === 'MP-90') {
      required.add('CHERRY_TEST_CHERRYIN_ACCOUNT')
      required.add('CHERRY_TEST_CHERRYIN_PASSWORD')
      required.add(id === 'M-01' ? 'CHERRY_TEST_CHERRYIN_CHAT_MODEL' : 'CHERRY_TEST_CHERRYIN_IMAGE_MODEL')
    }
  }
  return REQUIRED_CONFIG.filter((name) => required.has(name))
}

export interface RegressionTestConfig {
  customProvider: {
    baseUrl: string
    anthropicBaseUrl: string
    apiKey: string
    chatModel: string
  }
  customEmbeddingProvider: {
    baseUrl: string
    apiKey: string
    model: string
  }
  cherryIn: {
    chatModel: string
    imageModel: string
    account: string
    password: string
  }
}

type Environment = Record<string, string | undefined>

export function loadTestConfig(
  environment: Environment = process.env,
  required: readonly RequiredConfigName[] = REQUIRED_CONFIG
): RegressionTestConfig {
  const values = { ...environment }
  const missing = required.filter((name) => !values[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing regression test configuration: ${missing.join(', ')}`)
  }

  const value = (name: RequiredConfigName) => {
    const result = values[name]?.trim()
    if (!result) throw new Error(`Missing regression test configuration: ${name}`)
    return result
  }
  const absoluteUrl = (name: RequiredConfigName) => {
    const result = value(name)
    try {
      new URL(result)
      return result
    } catch {
      throw new Error(`${name} must be an absolute URL`)
    }
  }

  for (const name of required) if (name.endsWith('_BASE_URL')) absoluteUrl(name)

  return {
    customProvider: {
      get baseUrl() {
        return absoluteUrl('CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL')
      },
      get anthropicBaseUrl() {
        return absoluteUrl('CHERRY_TEST_CUSTOM_PROVIDER_ANTHROPIC_BASE_URL')
      },
      get apiKey() {
        return value('CHERRY_TEST_CUSTOM_PROVIDER_API_KEY')
      },
      get chatModel() {
        return value('CHERRY_TEST_CUSTOM_PROVIDER_CHAT_MODEL')
      }
    },
    customEmbeddingProvider: {
      get baseUrl() {
        return absoluteUrl('CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_BASE_URL')
      },
      get apiKey() {
        return value('CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_API_KEY')
      },
      get model() {
        return value('CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_MODEL')
      }
    },
    cherryIn: {
      get chatModel() {
        return value('CHERRY_TEST_CHERRYIN_CHAT_MODEL')
      },
      get imageModel() {
        return value('CHERRY_TEST_CHERRYIN_IMAGE_MODEL')
      },
      get account() {
        return value('CHERRY_TEST_CHERRYIN_ACCOUNT')
      },
      get password() {
        return value('CHERRY_TEST_CHERRYIN_PASSWORD')
      }
    }
  }
}

export function getSensitiveConfigValues(environment: Environment = process.env): string[] {
  return [
    environment.CHERRY_TEST_CUSTOM_PROVIDER_API_KEY,
    environment.CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_API_KEY,
    environment.CHERRY_TEST_CHERRYIN_ACCOUNT,
    environment.CHERRY_TEST_CHERRYIN_PASSWORD
  ].flatMap((value) => (value?.trim() ? [value.trim()] : []))
}
