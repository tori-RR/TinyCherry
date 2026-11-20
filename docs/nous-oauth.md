# NousResearch and Hermes providers

**NousResearch** signs in to Nous Portal from the native Windows desktop. It uses
device authorization in the system browser, then sends OpenAI-compatible Chat
Completions requests from the Go backend. The renderer never receives an access
token, refresh token or device token.

## Use

1. Open the **NousResearch** provider in Settings. If the provider list is filtered
   to enabled entries, switch it to **All** first: the new preset starts disabled.
2. Choose **Sign in**, complete the Nous authorization page in your browser, and
   confirm the displayed user code when requested. Keep the settings page open
   until authorization finishes; Cancel stops the pending authorization.
3. Fetch the available models and enable the models you want to use. The exact
   model IDs returned by the account's `/models` endpoint are preserved, including
   Hermes models.
4. Select an enabled model for a conversation. Tokens are refreshed before a
   request when they approach expiry. An explicitly invalid grant requires a new
   sign-in. Explicit rate limits preserve the saved session. When an HTTP server
   error or interrupted response leaves the result of a refresh uncertain, the
   app asks for a new sign-in so it cannot reuse a potentially consumed grant.

Logout removes the app-owned credential and disables this provider. The browser's
Nous website session is separate. This feature supplies model access only; it
does not enable Agent runtimes, MCP or other features still awaiting migration.

## Client identity and service compatibility

The default public client ID is `hermes-cli`, matching the published Hermes
device-flow implementation. This is a compatibility implementation, not a claim
that Nous has registered, endorsed or guaranteed a separate TinyCherry client.
The server can reject an unsupported client or account entitlement. Successful
synthetic tests do not establish live account access.

If Nous supplies a client ID for your deployment, enter it under **OAuth Client
ID (optional)**. This non-secret setting is stored as
`provider.settings.oauthClientId`; clearing it restores the default. Changing
the client identity requires a fresh login. No client secret is embedded in the
desktop application.

Reference implementation inspected for this integration:
[`NousResearch/hermes-agent@bb13381`](https://github.com/NousResearch/hermes-agent/tree/bb13381eeeb7393c22889bbb01f335fed5dc3810),
especially `hermes_cli/auth_constants.py`, `auth_device_flow.py` and
`auth_nous.py`.

## Native ownership and transport

- `oauth.device.start` returns only the request ID, user code, verification URLs,
  expiry and polling interval. Its initial HTTP request is bounded below the
  host's ordinary 15-second IPC deadline. Go owns the subsequent polling.
- `oauth.device.status` observes the specific request; `oauth.device.cancel`
  cancels it. Neither response exposes credentials. Standard token-presence,
  account-summary and logout routes apply only to the implemented Nous provider.
- The Go runtime requests `inference:invoke` from
  `https://portal.nousresearch.com/api/oauth/device/code` and polls
  `/api/oauth/token`. Refresh uses the `x-nous-refresh-token` header, following
  the inspected Nous contract.
- Authorization, refresh and inference use the existing application proxy
  settings. OAuth destinations are validated independently of the generic API
  Key provider's editable URLs and headers. Redirects are not followed with
  credentials.
- Windows DPAPI protects the app-owned token bundle. OAuth credentials have
  explicit ownership in secret cleanup; they are not ordinary API Key entries
  that the key editor could read back into the renderer.
- Refresh is serialized per session, and persistence checks the session
  generation and provider ownership. Logout, client changes and provider
  deletion cannot be undone by a late authorization or refresh response.
- HTTP refresh happens outside the global database/state lock. Chat, model
  listing and model checks all use the same credential resolution. A failed
  model request is never automatically replayed.

Do not import or copy Hermes's `auth.json` into TinyCherry. Independently
refreshing a copied, rotating refresh token can invalidate both applications'
session chain.

A successful token rotation and a local protected-storage write cannot be one
atomic transaction across the network. If saving the result fails, the running
app blocks reuse of that refresh token and asks for a fresh sign-in. A hard crash
during exchange or an unrecoverable storage failure can still leave an unusable
old credential on disk; uninterrupted session recovery is not guaranteed in
those cases. Logout and a fresh independent sign-in recover access without
copying another application's token.

## Hermes Subscription Proxy

The built-in **Hermes** preset connects to the local subscription proxy at
`http://127.0.0.1:8645/v1`. Sign in with `hermes portal` if Hermes needs a Nous
session, then keep the proxy running:

```sh
hermes proxy start
```

In TinyCherry, open **Settings → Providers → Hermes**, leave the API Key field
empty and sync models. Enable the provider and select a model from that list.
Hermes attaches and refreshes its own upstream credential. The Hermes API Server
listens on `8642` by default and exposes the Agent through a separate endpoint.
See the official [Subscription Proxy guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy).

If Hermes runs on another machine, map its loopback port to the desktop through
an authenticated tunnel. Keep the proxy on a trusted local path because its
loopback endpoint accepts requests without a client API key.

## Verification

Automated coverage uses synthetic credentials and controlled transports. It
must cover authorization completion, cancellation, pending/slow-down/expiry,
duplicate starts, safe error responses, concurrent refresh, rotated-token
persistence, logout races, provider deletion/recreation, and credential
destination restrictions. UI tests cover the device-code states and backend-only
token boundary. Existing API Key behavior remains part of regression coverage.

Windows DPAPI behavior, the packaged WebView/system-browser interaction, and a
real Nous login/refresh/streaming conversation are separate acceptance checks.
Record which checks ran for the candidate being reviewed; a cross-compile or a
synthetic test is not a successful live-account sign-in.
