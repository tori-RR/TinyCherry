import { openaiCompatible } from './types'

export default openaiCompatible({
  id: 'hermes',
  name: 'Hermes',
  availableInEditions: ['global', 'cn'],
  baseUrl: 'http://127.0.0.1:8645/v1',
  authOptional: true,
  website: {
    official: 'https://hermes-agent.nousresearch.com',
    docs: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy'
  }
})
