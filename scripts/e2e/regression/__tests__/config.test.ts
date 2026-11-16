import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

import { selectCases } from '../cases'
import { getSensitiveConfigValues, loadTestConfig, REQUIRED_CONFIG, requiredConfigForCases } from '../config'

describe('regression test configuration', () => {
  const validEnv = {
    CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL: 'https://gateway.example.test/v1',
    CHERRY_TEST_CUSTOM_PROVIDER_ANTHROPIC_BASE_URL: ' https://anthropic.example.test ',
    CHERRY_TEST_CUSTOM_PROVIDER_API_KEY: 'provider-secret',
    CHERRY_TEST_CUSTOM_PROVIDER_CHAT_MODEL: 'Qwen/Qwen3.6-27B',
    CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_BASE_URL: 'https://embedding.example.test/v1',
    CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_API_KEY: 'embedding-secret',
    CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_MODEL: 'text-embedding-test',
    CHERRY_TEST_CHERRYIN_CHAT_MODEL: 'cherry-chat-test',
    CHERRY_TEST_CHERRYIN_IMAGE_MODEL: 'image-test',
    CHERRY_TEST_CHERRYIN_ACCOUNT: 'automation@example.test',
    CHERRY_TEST_CHERRYIN_PASSWORD: 'account-secret'
  }

  function preflight(task: string, configured: Record<string, string> = {}) {
    const names = new Set(REQUIRED_CONFIG.map((name) => name.toLowerCase()))
    const environment = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !names.has(name.toLowerCase()))
    )
    return spawnSync(
      process.execPath,
      [createRequire(import.meta.url).resolve('tsx/cli'), 'scripts/e2e/regression/cli.ts', 'preflight', '--task', task],
      { env: { ...environment, ...configured }, encoding: 'utf8', timeout: 20_000 }
    )
  }

  it('requires a separate Anthropic URL instead of reusing the OpenAI URL', () => {
    expect(() => loadTestConfig({ ...validEnv, CHERRY_TEST_CUSTOM_PROVIDER_ANTHROPIC_BASE_URL: undefined })).toThrow(
      'Missing regression test configuration: CHERRY_TEST_CUSTOM_PROVIDER_ANTHROPIC_BASE_URL'
    )
  })

  it('loads provider-scoped values for Playwright', () => {
    const config = loadTestConfig(validEnv)

    expect(config.customProvider).toEqual({
      baseUrl: 'https://gateway.example.test/v1',
      anthropicBaseUrl: 'https://anthropic.example.test',
      apiKey: 'provider-secret',
      chatModel: 'Qwen/Qwen3.6-27B'
    })
    expect(config.customEmbeddingProvider).toEqual({
      apiKey: 'embedding-secret',
      baseUrl: 'https://embedding.example.test/v1',
      model: 'text-embedding-test'
    })
    expect(config.cherryIn.imageModel).toBe('image-test')
    expect(config.customProvider.apiKey).toBe('provider-secret')
    expect(config.customEmbeddingProvider.apiKey).toBe('embedding-secret')
    expect(config.cherryIn.password).toBe('account-secret')
    expect(getSensitiveConfigValues(validEnv)).toEqual([
      'provider-secret',
      'embedding-secret',
      'automation@example.test',
      'account-secret'
    ])
  })

  it('collects available secrets for failure evidence without requiring external providers', () => {
    expect(getSensitiveConfigValues({})).toEqual([])
    expect(
      getSensitiveConfigValues({
        CHERRY_TEST_CUSTOM_PROVIDER_API_KEY: ' provider-secret ',
        CHERRY_TEST_CHERRYIN_PASSWORD: '   '
      })
    ).toEqual(['provider-secret'])
  })

  it.each([
    'startup-smoke',
    'notes',
    'mini-app',
    'provider-model-scroll',
    'clear-chat-messages',
    'everything-mcp'
  ] as const)('does not require cloud configuration for %s', (task) => {
    const required = requiredConfigForCases(selectCases(task))
    expect(required).toEqual([])
    const config = loadTestConfig({}, required)
    expect(() => config.customProvider.apiKey).toThrow(
      'Missing regression test configuration: CHERRY_TEST_CUSTOM_PROVIDER_API_KEY'
    )
  })

  it('requires only the custom provider for custom chat and validates it before launch', () => {
    const required = requiredConfigForCases(selectCases('custom-provider-chat'))
    expect(required).toEqual(REQUIRED_CONFIG.slice(0, 4))
    const environment = Object.fromEntries(required.map((name) => [name, validEnv[name]]))
    const config = loadTestConfig(environment, required)
    expect(config.customProvider.chatModel).toBe(validEnv.CHERRY_TEST_CUSTOM_PROVIDER_CHAT_MODEL)
    expect(() => loadTestConfig({ ...environment, CHERRY_TEST_CUSTOM_PROVIDER_API_KEY: '' }, required)).toThrow(
      'Missing regression test configuration: CHERRY_TEST_CUSTOM_PROVIDER_API_KEY'
    )
    expect(() => config.cherryIn.account).toThrow('CHERRY_TEST_CHERRYIN_ACCOUNT')
    expect(() => config.customEmbeddingProvider.model).toThrow('CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_MODEL')
  })

  it.each([
    ['cherryin-chat', 'CHERRY_TEST_CHERRYIN_CHAT_MODEL'],
    ['image-generation', 'CHERRY_TEST_CHERRYIN_IMAGE_MODEL']
  ] as const)('checks the selected CherryIN capability for %s', (task, modelName) => {
    const required = requiredConfigForCases(selectCases(task))
    expect(required).toEqual([modelName, 'CHERRY_TEST_CHERRYIN_ACCOUNT', 'CHERRY_TEST_CHERRYIN_PASSWORD'])
    const environment = Object.fromEntries(required.map((name) => [name, validEnv[name]]))
    expect(loadTestConfig(environment, required).cherryIn.account).toBe(validEnv.CHERRY_TEST_CHERRYIN_ACCOUNT)
    expect(() => loadTestConfig({ ...environment, [modelName]: undefined }, required)).toThrow(modelName)
    expect(() => loadTestConfig({ ...environment, CHERRY_TEST_CHERRYIN_PASSWORD: '' }, required)).toThrow(
      'CHERRY_TEST_CHERRYIN_PASSWORD'
    )
  })

  it('combines selected capabilities without requiring unrelated embeddings', () => {
    const required = requiredConfigForCases(selectCases(['custom-provider-chat', 'image-generation']))
    expect(required).toEqual([
      ...REQUIRED_CONFIG.slice(0, 4),
      'CHERRY_TEST_CHERRYIN_IMAGE_MODEL',
      'CHERRY_TEST_CHERRYIN_ACCOUNT',
      'CHERRY_TEST_CHERRYIN_PASSWORD'
    ])
    expect(requiredConfigForCases(selectCases('all'))).toEqual([
      ...REQUIRED_CONFIG.slice(0, 4),
      ...REQUIRED_CONFIG.slice(7)
    ])
    expect(() => loadTestConfig(validEnv, required)).not.toThrow()
  })

  it('validates only selected URLs and still rejects an unconfigured consumer access', () => {
    const required = requiredConfigForCases(selectCases('custom-provider-chat'))
    const config = loadTestConfig({ ...validEnv, CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_BASE_URL: 'invalid' }, required)
    expect(config.customProvider.baseUrl).toBe(validEnv.CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL)
    expect(() => config.customEmbeddingProvider.baseUrl).toThrow(
      'CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_BASE_URL must be an absolute URL'
    )
    expect(() => loadTestConfig({ ...validEnv, CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL: 'invalid' }, required)).toThrow(
      'CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL must be an absolute URL'
    )
  })

  it('scopes the actual CLI to custom chat and reports only the missing selected configuration', () => {
    const required = requiredConfigForCases(selectCases('custom-provider-chat'))
    const environment = Object.fromEntries(required.map((name) => [name, validEnv[name]]))
    const success = preflight('custom-provider-chat', environment)
    expect(success.status, success.stderr).toBe(0)
    expect(JSON.parse(success.stdout).configured).toEqual(required)
    const missing = preflight('custom-provider-chat', { ...environment, CHERRY_TEST_CUSTOM_PROVIDER_API_KEY: '' })
    expect(missing.status).not.toBe(0)
    expect(missing.stderr).toContain('Missing regression test configuration: CHERRY_TEST_CUSTOM_PROVIDER_API_KEY')
    expect(missing.stderr).not.toContain('CHERRY_TEST_CHERRYIN')
    expect(missing.stderr).not.toContain('EMBEDDING')
  })

  it.each(['chat-stream-failure', 'startup-smoke', 'notes-smoke'])(
    'allows %s to pass the CLI preflight without external credentials',
    (task) => {
      const result = preflight(task)
      expect(result.status).toBe(0)
    }
  )

  it('fails before application launch when any required value is blank', () => {
    expect(() =>
      loadTestConfig({
        ...validEnv,
        CHERRY_TEST_CUSTOM_PROVIDER_CHAT_MODEL: '   ',
        CHERRY_TEST_CHERRYIN_ACCOUNT: undefined
      })
    ).toThrow(
      'Missing regression test configuration: CHERRY_TEST_CUSTOM_PROVIDER_CHAT_MODEL, CHERRY_TEST_CHERRYIN_ACCOUNT'
    )
  })

  it.each([
    'CHERRY_TEST_CUSTOM_PROVIDER_BASE_URL',
    'CHERRY_TEST_CUSTOM_PROVIDER_ANTHROPIC_BASE_URL',
    'CHERRY_TEST_CUSTOM_PROVIDER_EMBEDDING_BASE_URL'
  ])('validates %s before application launch', (name) => {
    expect(() =>
      loadTestConfig({
        ...validEnv,
        [name]: 'not-a-url'
      })
    ).toThrow(`${name} must be an absolute URL`)
  })
})
