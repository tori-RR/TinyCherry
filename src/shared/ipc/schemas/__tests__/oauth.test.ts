import { describe, expect, it } from 'vitest'

import { oauthRequestSchemas } from '../oauth'

const authorization = {
  requestId: 'synthetic-request',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://portal.nousresearch.com/device',
  expiresAt: 1900000000000,
  interval: 5
}

describe('device OAuth IPC boundary', () => {
  it('only accepts the implemented provider and bounded request identifiers', () => {
    const { input } = oauthRequestSchemas['oauth.device.start']
    expect(input.safeParse({ providerId: 'nous-portal', requestId: 'synthetic-request' }).success).toBe(true)
    expect(input.safeParse({ providerId: 'openai-codex', requestId: 'synthetic-request' }).success).toBe(false)
    expect(input.safeParse({ providerId: 'nous-portal', requestId: '' }).success).toBe(false)
    expect(input.safeParse({ providerId: 'nous-portal', requestId: 'x'.repeat(129) }).success).toBe(false)
  })

  it.each(['deviceCode', 'device_code', 'accessToken', 'refreshToken'])(
    'rejects a backend response that accidentally includes %s',
    (secretField) => {
      expect(oauthRequestSchemas['oauth.device.start'].output.safeParse(authorization).success).toBe(true)
      expect(
        oauthRequestSchemas['oauth.device.start'].output.safeParse({ ...authorization, [secretField]: 'synthetic' })
          .success
      ).toBe(false)
      expect(
        oauthRequestSchemas['oauth.device.status'].output.safeParse({
          status: 'completed',
          accountId: null,
          [secretField]: 'synthetic'
        }).success
      ).toBe(false)
    }
  )
})
