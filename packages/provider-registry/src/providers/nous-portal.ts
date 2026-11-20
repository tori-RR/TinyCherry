import { defineProvider } from './types'

/**
 * Nous Portal serves the authenticated account's model catalog over the OpenAI
 * Chat Completions protocol. Keep discovery dynamic: Portal also serves models
 * from other creators, so a local Hermes-only model allowlist would be wrong.
 */
export default defineProvider({
  id: 'nous-portal',
  name: 'Nous Portal',
  availableInEditions: ['global', 'cn'],
  defaultChatEndpoint: 'openai-chat-completions',
  modelListSource: 'api',
  authMethods: ['oauth'],
  endpointConfigs: {
    'openai-chat-completions': {
      adapterFamily: 'openai-compatible',
      baseUrl: 'https://inference-api.nousresearch.com/v1'
    }
  },
  metadata: {
    website: {
      official: 'https://portal.nousresearch.com',
      docs: 'https://hermes-agent.nousresearch.com/docs/integrations/nous-portal',
      billing: 'https://portal.nousresearch.com/manage-subscription'
    }
  }
})
