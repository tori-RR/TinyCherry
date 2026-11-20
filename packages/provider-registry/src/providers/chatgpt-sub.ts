import { defineProvider } from './types'

export default defineProvider({
  id: 'chatgpt-sub',
  name: 'ChatGPT Sub',
  availableInEditions: ['global', 'cn'],
  defaultChatEndpoint: 'openai-responses',
  modelListSource: 'api',
  authMethods: ['oauth'],
  endpointConfigs: {
    'openai-responses': { adapterFamily: 'openai', baseUrl: 'https://api.openai.com/v1' }
  },
  metadata: {
    website: {
      official: 'https://chatgpt.com',
      docs: 'https://developers.openai.com/siwc/token-sharing-open-source',
      billing: 'https://chatgpt.com/settings/usage'
    }
  }
})
