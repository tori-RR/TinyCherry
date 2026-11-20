import * as z from 'zod'

import { CHATGPT_SUB_PROVIDER_ID } from '@shared/data/presets/chatgptSub'

import { defineRoute } from '../define'

/**
 * OAuth IPC schemas — sign-in / token-state / logout for login-based providers.
 * Nous Portal's native device flow uses short start/status/cancel requests;
 * network polling, persistence and refresh remain owned by the Go backend.
 *
 * The base operations are provider-generic: a fixed set carries the target
 * `providerId`, and the handler drives providers through the shared runtime.
 * Providers with custom inputs or results keep those contracts in their own
 * domain instead of widening this surface.
 *
 * The older loopback `sign_in` contracts remain for Codex and Grok CLI while
 * those runtimes await native migration. CherryIN keeps its own contract under
 * `cherryin.sign_in`; declaring a contract does not enable an unsupported route.
 *
 * `sign_in` and `get_account` return only the account id; OAuth tokens stay in
 * the backend. Providers without an account concept resolve `{ accountId: null }`.
 *
 * `check_external_login` covers the other login shape — providers whose
 * credential lives in an external CLI's store (`authMethods` includes
 * `'external-cli'`, e.g. Claude Code) rather than an app-held token. It is a
 * read-only presence probe; no credential is read or returned.
 */

/** The account a provider associates with the session (Codex's ChatGPT id), or null. */
const oauthAccountSchema = z.object({ accountId: z.string().nullable() })

const signInAttachResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-found') }),
  z.object({ status: z.literal('completed'), account: oauthAccountSchema })
])

/** Every route targets one provider, named by its runtime id. */
const providerInput = z.object({ providerId: z.string() })
const signInObservationInput = providerInput.extend({ requestId: z.string().min(1) })

// Device authorization waits in the native backend, outside the 15-second IPC
// request budget. Only the human-facing code and login status cross this boundary.
const deviceInput = z.strictObject({
  providerId: z.literal('nous-portal'),
  requestId: z.string().min(1).max(128)
})

const deviceAuthorizationSchema = z.strictObject({
  requestId: z.string().min(1).max(128),
  userCode: z.string().min(1).max(256),
  verificationUri: z.url(),
  verificationUriComplete: z.url().optional(),
  /** Unix milliseconds, unlike OAuth's expires_in (seconds). */
  expiresAt: z.number().int().positive(),
  /** The server's token polling interval in seconds; polling is backend-owned. */
  interval: z.number().int().positive()
})

const deviceStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('completed'), accountId: z.string().nullable() }),
  z.strictObject({ status: z.literal('cancelled') }),
  z.strictObject({ status: z.literal('expired') }),
  z.strictObject({ status: z.literal('error'), code: z.string(), message: z.string() })
])

const chatGPTInput = z.strictObject({ providerId: z.literal(CHATGPT_SUB_PROVIDER_ID) })
const chatGPTAttemptInput = chatGPTInput.extend({ requestId: z.string().min(1).max(128) })
const chatGPTAuthorizationUrl = z
  .url()
  .refine((value) => value.startsWith('https://auth.openai.com/api/accounts/authorize?') && !value.includes('#'))
const chatGPTStatus = z.discriminatedUnion('status', [
  z.strictObject({ status: z.enum(['pending', 'denied', 'cancelled', 'expired']) }),
  z.strictObject({ status: z.literal('completed'), firstUse: z.boolean() }),
  z.strictObject({ status: z.literal('error'), message: z.string() })
])

export const oauthRequestSchemas = {
  'oauth.chatgpt.accounts': defineRoute({
    input: chatGPTInput,
    output: z.strictObject({
      activeAccountId: z.string(),
      accounts: z.array(
        z.strictObject({
          id: z.string(),
          email: z.string(),
          status: z.enum(['connected', 'identity-only', 'needs-sign-in', 'signed-out'])
        })
      )
    })
  }),
  'oauth.chatgpt.start': defineRoute({
    input: chatGPTAttemptInput.extend({ accountId: z.string().max(128).optional() }),
    output: z.strictObject({ requestId: z.string(), authorizationUrl: chatGPTAuthorizationUrl })
  }),
  'oauth.chatgpt.status': defineRoute({ input: chatGPTAttemptInput, output: chatGPTStatus }),
  'oauth.chatgpt.cancel': defineRoute({ input: chatGPTAttemptInput, output: z.void() }),
  'oauth.chatgpt.logout': defineRoute({ input: chatGPTInput, output: z.strictObject({ revoked: z.boolean() }) }),
  'oauth.device.start': defineRoute({ input: deviceInput, output: deviceAuthorizationSchema }),
  'oauth.device.status': defineRoute({ input: deviceInput, output: deviceStatusSchema }),
  'oauth.device.cancel': defineRoute({ input: deviceInput, output: z.void() }),
  'oauth.sign_in': defineRoute({ input: signInObservationInput, output: oauthAccountSchema }),
  'oauth.sign_in.attach': defineRoute({ input: signInObservationInput, output: signInAttachResultSchema }),
  'oauth.cancel_sign_in': defineRoute({ input: signInObservationInput, output: z.void() }),
  'oauth.has_token': defineRoute({ input: providerInput, output: z.boolean() }),
  'oauth.get_account': defineRoute({ input: providerInput, output: oauthAccountSchema }),
  'oauth.logout': defineRoute({ input: providerInput, output: z.void() }),
  'oauth.tokendance.authorize_api_key': defineRoute({ input: z.void(), output: z.string().min(1) }),
  'oauth.check_external_login': defineRoute({ input: providerInput, output: z.boolean() })
}
