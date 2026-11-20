import { Check, CheckCircle2, Copy, ExternalLink, LogIn, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Input } from '@cherrystudio/ui'
import { useInvalidateCache } from '@data/hooks/useDataApi'
import { loggerService } from '@logger'
import { useProvider } from '@renderer/hooks/useProvider'
import { ipcApi } from '@renderer/ipc'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { openExternalWebsite } from '@renderer/services/website'
import { NOUS_PORTAL_PROVIDER_ID } from '@shared/data/presets/nousPortal'
import { ProviderSettingsSchema } from '@shared/data/types/provider'
import type { OutputFor } from '@shared/ipc/types'

import { useCopyToClipboard } from '../hooks/useCopyToClipboard'

const logger = loggerService.withContext('NousOauthPanel')
const providerId = NOUS_PORTAL_PROVIDER_ID
const ns = 'settings.provider.nous_portal'
const STATUS_POLL_MS = 1000
type DeviceAuthorization = OutputFor<'oauth.device.start'>

/** A server-supplied verification link must stay on the official Portal. */
function verificationUrl(authorization: DeviceAuthorization): string {
  for (const value of [authorization.verificationUri, authorization.verificationUriComplete]) {
    if (!value) continue
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'portal.nousresearch.com' ||
      url.port ||
      url.username ||
      url.password
    ) {
      throw new Error('Unexpected Nous verification URL')
    }
  }
  return authorization.verificationUriComplete ?? authorization.verificationUri
}

/**
 * Device-code polling and all credentials belong to Go. Each IPC operation is
 * short; this view observes only an approval code, expiry and terminal status.
 * Leaving the panel cancels its owned attempt rather than orphaning a sign-in.
 */
export default function NousOauthPanel() {
  const { t } = useTranslation()
  const { provider, updateProvider } = useProvider(providerId)
  const invalidateCache = useInvalidateCache()
  const [copied, copy] = useCopyToClipboard()
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [accountId, setAccountId] = useState<string | null>(null)
  const [authorization, setAuthorization] = useState<DeviceAuthorization | null>(null)
  const [starting, setStarting] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [savingClientId, setSavingClientId] = useState(false)
  const [clientIdDraft, setClientIdDraft] = useState(provider?.settings.oauthClientId ?? '')
  const [messageKey, setMessageKey] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const mountedRef = useRef(false)
  const requestIdRef = useRef<string | null>(null)
  const cancellingRef = useRef(false)
  const startInFlightRef = useRef(false)
  const clientIdDirtyRef = useRef(false)

  const refreshProviderData = useCallback(
    () => invalidateCache(['/providers', `/providers/${providerId}`, `/providers/${providerId}/*`]),
    [invalidateCache]
  )

  const refreshStatus = useCallback(async () => {
    const hasToken = await ipcApi.request('oauth.has_token', { providerId })
    const account = hasToken ? await ipcApi.request('oauth.get_account', { providerId }) : { accountId: null }
    if (!mountedRef.current) return
    setLoggedIn(hasToken)
    setAccountId(account.accountId)
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void refreshStatus().catch(() => {
      if (!mountedRef.current) return
      setLoggedIn(false)
      setMessageKey(`${ns}.status_failed`)
    })
    return () => {
      mountedRef.current = false
      const requestId = requestIdRef.current
      requestIdRef.current = null
      if (requestId) {
        void ipcApi.request('oauth.device.cancel', { providerId, requestId }).catch(() => {})
      }
    }
  }, [refreshStatus])

  useEffect(() => {
    if (!clientIdDirtyRef.current) setClientIdDraft(provider?.settings.oauthClientId ?? '')
  }, [provider?.settings.oauthClientId])

  useEffect(() => {
    if (!authorization) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const { requestId } = authorization
    const isCurrent = () => active && mountedRef.current && requestIdRef.current === requestId
    const finish = (key: string | null) => {
      requestIdRef.current = null
      setAuthorization(null)
      setMessageKey(key)
    }
    const poll = async () => {
      try {
        const result = await ipcApi.request('oauth.device.status', { providerId, requestId })
        if (!isCurrent()) return
        setNow(Date.now())
        if (!cancellingRef.current) {
          if (result.status === 'completed') {
            finish(null)
            setLoggedIn(true)
            setAccountId(result.accountId)
            await refreshProviderData()
            if (mountedRef.current) toast.success(t(`${ns}.sign_in_success`))
            return
          }
          if (result.status !== 'pending') {
            finish(
              result.status === 'expired'
                ? `${ns}.expired`
                : result.status === 'cancelled'
                  ? null
                  : result.code === 'access_denied'
                    ? `${ns}.denied`
                    : `${ns}.sign_in_failed`
            )
            return
          }
          setMessageKey(null)
        }
      } catch {
        if (!isCurrent()) return
        // A lost IPC response is not a new authorization request. Observe the
        // same attempt again; never replay start or token exchanges here.
        setMessageKey(`${ns}.status_retrying`)
        if (Date.now() > authorization.expiresAt + 5000) {
          void ipcApi.request('oauth.device.cancel', { providerId, requestId }).catch(() => {})
          finish(`${ns}.expired`)
          return
        }
      }
      if (isCurrent()) timer = setTimeout(() => void poll(), STATUS_POLL_MS)
    }
    void poll()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [authorization, refreshProviderData, t])

  const openVerification = useCallback(
    async (flow: DeviceAuthorization) => {
      try {
        await openExternalWebsite(verificationUrl(flow))
      } catch {
        if (mountedRef.current) toast.error(t(`${ns}.browser_failed`))
      }
    },
    [t]
  )

  const startSignIn = useCallback(async () => {
    if (startInFlightRef.current || requestIdRef.current) return
    startInFlightRef.current = true
    setStarting(true)
    setMessageKey(null)
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    try {
      const flow = await ipcApi.request('oauth.device.start', { providerId, requestId })
      if (!mountedRef.current || requestIdRef.current !== requestId) {
        await ipcApi.request('oauth.device.cancel', { providerId, requestId })
        return
      }
      if (flow.requestId !== requestId) throw new Error('Unexpected Nous authorization request')
      verificationUrl(flow)
      setNow(Date.now())
      setAuthorization(flow)
      await openVerification(flow)
    } catch {
      // This also cancels a backend attempt whose start reply was lost.
      void ipcApi.request('oauth.device.cancel', { providerId, requestId }).catch(() => {})
      if (requestIdRef.current === requestId) requestIdRef.current = null
      if (mountedRef.current) {
        setAuthorization(null)
        setMessageKey(`${ns}.sign_in_failed`)
      }
    } finally {
      startInFlightRef.current = false
      if (mountedRef.current) setStarting(false)
    }
  }, [openVerification])

  const cancelSignIn = useCallback(async () => {
    const requestId = requestIdRef.current
    if (!requestId || cancellingRef.current) return
    cancellingRef.current = true
    setCancelling(true)
    try {
      await ipcApi.request('oauth.device.cancel', { providerId, requestId })
      if (!mountedRef.current) return
      requestIdRef.current = null
      setAuthorization(null)
      setMessageKey(null)
      // Completion can win the race with a cancel click; reflect the backend.
      await refreshProviderData()
      await refreshStatus()
    } catch {
      if (mountedRef.current) setMessageKey(`${ns}.cancel_failed`)
    } finally {
      cancellingRef.current = false
      if (mountedRef.current) setCancelling(false)
    }
  }, [refreshProviderData, refreshStatus])

  const logout = useCallback(async () => {
    if (
      !(await popup.confirm({
        title: t('settings.provider.oauth.logout'),
        content: t('settings.provider.oauth.logout_confirm'),
        centered: true
      }))
    ) {
      return
    }
    setLoggingOut(true)
    try {
      await ipcApi.request('oauth.logout', { providerId })
      await refreshProviderData()
      if (!mountedRef.current) return
      setLoggedIn(false)
      setAccountId(null)
      setMessageKey(null)
      toast.success(t('settings.provider.oauth.logout_success'))
    } catch {
      if (mountedRef.current) toast.warning(t('settings.provider.oauth.logout_warning'))
    } finally {
      if (mountedRef.current) setLoggingOut(false)
    }
  }, [refreshProviderData, t])

  const saveClientId = async () => {
    const clientId = clientIdDraft.trim()
    if (clientId && !ProviderSettingsSchema.shape.oauthClientId.safeParse(clientId).success) {
      setMessageKey(`${ns}.client_id_invalid`)
      return
    }
    setSavingClientId(true)
    try {
      await updateProvider({ providerSettings: { oauthClientId: clientId || null } })
      clientIdDirtyRef.current = false
      if (!mountedRef.current) return
      setClientIdDraft(clientId)
      setMessageKey(null)
      await refreshStatus()
    } catch {
      logger.warn('Failed to save Nous OAuth client id')
      if (mountedRef.current) toast.error(t('settings.provider.save_failed'))
    } finally {
      if (mountedRef.current) setSavingClientId(false)
    }
  }

  if (loggedIn === null) {
    return (
      <div className="flex items-center gap-2 text-foreground-tertiary text-xs">
        <RefreshCw className="size-4 animate-spin" aria-hidden />
        {t('common.loading')}
      </div>
    )
  }

  const busy = starting || !!authorization || loggingOut || savingClientId
  const secondsLeft = authorization ? Math.max(0, Math.ceil((authorization.expiresAt - now) / 1000)) : 0
  const timeLeft = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`

  return (
    <div className="flex flex-col gap-3">
      {loggedIn ? (
        <div className="flex items-center gap-3 rounded-lg border border-success-border bg-success-subtle p-3 text-success-subtle-foreground">
          <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <div className="text-sm">{t(`${ns}.logged_in`)}</div>
            {accountId ? <div className="mt-1 truncate text-xs">{accountId}</div> : null}
          </div>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void logout()}>
            {t('settings.provider.oauth.logout')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-3 rounded-lg border border-info-border bg-info-subtle p-3 text-info-subtle-foreground">
        <p className="text-sm">{t(`${ns}.description`)}</p>
        {authorization ? (
          <>
            <p className="text-xs" role="status">
              {t(`${ns}.waiting`)}
            </p>
            <div className="flex items-center gap-2">
              <code className="select-all rounded bg-background px-3 py-2 font-mono text-base tracking-widest">
                {authorization.userCode}
              </code>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('common.copy')}
                onClick={() => void copy(authorization.userCode)}>
                {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              </Button>
            </div>
            <p className="break-all text-xs">{authorization.verificationUri}</p>
            <p className="text-xs">{t(`${ns}.expires_in`, { time: timeLeft })}</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void openVerification(authorization)}>
                <ExternalLink className="size-4" aria-hidden />
                {t(`${ns}.open_browser`)}
              </Button>
              <Button variant="ghost" disabled={cancelling} onClick={() => void cancelSignIn()}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : (
          <Button className="self-start" disabled={busy} onClick={() => void startSignIn()}>
            {starting ? (
              <RefreshCw className="size-4 animate-spin" aria-hidden />
            ) : (
              <LogIn className="size-4" aria-hidden />
            )}
            {starting ? t(`${ns}.starting`) : loggedIn ? t(`${ns}.sign_in_again`) : t(`${ns}.sign_in_button`)}
          </Button>
        )}
      </div>
      {messageKey ? (
        <p className="text-destructive text-xs" role="alert">
          {t(messageKey)}
        </p>
      ) : null}
      <details className="text-xs text-foreground-secondary">
        <summary className="cursor-pointer">{t(`${ns}.client_id_label`)}</summary>
        <p className="my-2">{t(`${ns}.client_id_help`)}</p>
        <div className="flex items-center gap-2">
          <Input
            aria-label={t(`${ns}.client_id_label`)}
            value={clientIdDraft}
            placeholder="hermes-cli"
            maxLength={256}
            disabled={busy || !provider}
            onChange={(event) => {
              clientIdDirtyRef.current = true
              setClientIdDraft(event.target.value)
            }}
          />
          <Button
            variant="outline"
            disabled={busy || !provider || clientIdDraft.trim() === (provider?.settings.oauthClientId ?? '')}
            onClick={() => void saveClientId()}>
            {t('common.save')}
          </Button>
        </div>
      </details>
    </div>
  )
}
