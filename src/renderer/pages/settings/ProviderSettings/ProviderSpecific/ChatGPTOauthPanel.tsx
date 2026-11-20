import { CheckCircle2, ExternalLink, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import useSWR from 'swr'

import { Button } from '@cherrystudio/ui'
import { Openai } from '@cherrystudio/ui/icons/providers'
import { useInvalidateCache } from '@data/hooks/useDataApi'
import { ipcApi } from '@renderer/ipc'
import { popup } from '@renderer/services/popup'
import { toast } from '@renderer/services/toast'
import { openExternalWebsite } from '@renderer/services/website'
import { CHATGPT_SUB_PROVIDER_ID, CHATGPT_USAGE_URL } from '@shared/data/presets/chatgptSub'
import type { OutputFor } from '@shared/ipc/types'

const providerId = CHATGPT_SUB_PROVIDER_ID
const ns = 'settings.provider.chatgpt_sub'
type BrowserAuthorization = OutputFor<'oauth.chatgpt.start'>

function cancelAttempt(requestId: string) {
  return ipcApi.request('oauth.chatgpt.cancel', { providerId, requestId })
}

export default function ChatGPTOauthPanel() {
  const { t } = useTranslation()
  const invalidateCache = useInvalidateCache()
  const {
    data: accounts,
    error: accountsError,
    mutate
  } = useSWR('oauth.chatgpt.accounts', () => ipcApi.request('oauth.chatgpt.accounts', { providerId }))
  const [flow, setFlow] = useState<BrowserAuthorization | null>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const requestIdRef = useRef<string | null>(null)
  const accountId = selection ?? (accounts?.activeAccountId || accounts?.accounts[0]?.id || '')
  const active = accounts?.accounts.find((account) => account.id === accounts.activeAccountId)

  const refreshProvider = useCallback(async () => {
    await Promise.all([mutate(), invalidateCache(['/providers', `/providers/${providerId}`])])
  }, [invalidateCache, mutate])

  useEffect(() => {
    return () => {
      const requestId = requestIdRef.current
      requestIdRef.current = null
      if (requestId) void cancelAttempt(requestId).catch(() => {})
    }
  }, [])

  useEffect(() => {
    if (!flow) return
    const { requestId } = flow
    let timer: ReturnType<typeof setTimeout>
    let disposed = false
    const poll = async () => {
      try {
        const result = await ipcApi.request('oauth.chatgpt.status', { providerId, requestId })
        if (disposed || requestIdRef.current !== requestId) return
        if (result.status === 'pending') {
          timer = setTimeout(poll, 1000)
          return
        }
        requestIdRef.current = null
        setFlow(null)
        if (result.status === 'completed') {
          setSelection(null)
          setMessage('')
          await refreshProvider()
          if (result.firstUse) {
            void popup.info({
              title: t(`${ns}.using_plan`),
              content: t(`${ns}.first_use`),
              centered: true
            })
          }
        } else if (result.status === 'error') {
          setMessage(result.message)
        } else if (result.status !== 'cancelled') {
          setMessage(t(`${ns}.${result.status}`))
        }
      } catch {
        if (disposed || requestIdRef.current !== requestId) return
        requestIdRef.current = null
        setFlow(null)
        setMessage(t(`${ns}.sign_in_failed`))
        void cancelAttempt(requestId).catch(() => {})
      }
    }
    timer = setTimeout(poll, 500)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [flow, refreshProvider, t])

  const openBrowser = async (url: string) => {
    try {
      await openExternalWebsite(url)
    } catch {
      setMessage(t(`${ns}.browser_failed`))
    }
  }

  const signIn = async () => {
    if (busy || requestIdRef.current) return
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    setBusy(true)
    setMessage('')
    try {
      const authorization = await ipcApi.request('oauth.chatgpt.start', { providerId, requestId, accountId })
      if (requestIdRef.current !== requestId) {
        await cancelAttempt(requestId)
        return
      }
      setFlow(authorization)
      await openBrowser(authorization.authorizationUrl)
    } catch {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = null
        setMessage(t(`${ns}.sign_in_failed`))
      }
      void cancelAttempt(requestId).catch(() => {})
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    if (
      !(await popup.confirm({
        title: t('settings.provider.oauth.logout'),
        content: t('settings.provider.oauth.logout_confirm'),
        centered: true
      }))
    ) {
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const { revoked } = await ipcApi.request('oauth.chatgpt.logout', { providerId })
      await refreshProvider()
      if (revoked) {
        toast.success(t('settings.provider.oauth.logout_success'))
      } else {
        toast.warning(t('settings.provider.oauth.logout_warning'))
      }
    } catch {
      setMessage(t(`${ns}.sign_out_failed`))
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || !!flow || !accounts
  return (
    <div className="flex flex-col gap-3" data-testid="chatgpt-sub-auth">
      {active?.status === 'connected' ? (
        <div className="flex items-center gap-3 rounded-lg border border-success-border bg-success-subtle p-3 text-success-subtle-foreground">
          <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm">{t(`${ns}.connected`)}</p>
            {active.email ? <p className="mt-1 truncate text-xs">{active.email}</p> : null}
          </div>
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void signOut()}>
            {t('settings.provider.oauth.logout')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border p-3">
        <p className="text-sm">{t(`${ns}.description`)}</p>
        {active?.status === 'identity-only' || active?.status === 'needs-sign-in' ? (
          <div className="flex w-full items-center justify-between gap-2">
            <p className="text-foreground-secondary text-xs" role="status">
              {t(`${ns}.${active.status}`)}
            </p>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void signOut()}>
              {t('settings.provider.oauth.logout')}
            </Button>
          </div>
        ) : null}
        {accounts?.accounts.length ? (
          <label className="flex w-full flex-col gap-1 text-foreground-secondary text-xs">
            {t(`${ns}.account`)}
            <select
              className="h-8 max-w-full rounded-md border border-border bg-background px-2 text-foreground text-sm"
              disabled={disabled}
              value={accountId}
              onChange={(event) => setSelection(event.target.value)}>
              {accounts.accounts.map((account, index) => (
                <option key={account.id} value={account.id}>
                  {account.email || 'ChatGPT'} · {index + 1}
                </option>
              ))}
              <option value="">{t(`${ns}.add_account`)}</option>
            </select>
          </label>
        ) : null}
        {flow ? (
          <>
            <p className="text-sm" role="status">
              {t(`${ns}.waiting`)}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void openBrowser(flow.authorizationUrl)}>
                <ExternalLink className="size-4" aria-hidden />
                {t(`${ns}.open_browser`)}
              </Button>
              <Button
                variant="ghost"
                onClick={() => void cancelAttempt(flow.requestId).catch(() => setMessage(t(`${ns}.sign_in_failed`)))}>
                {t('common.cancel')}
              </Button>
            </div>
          </>
        ) : (
          <Button variant="outline" onClick={() => void signIn()} disabled={disabled}>
            {busy ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <Openai className="size-4" aria-hidden />
            )}
            {t(`${ns}.continue`)}
          </Button>
        )}
        {accountsError ? (
          <button className="text-destructive text-xs underline" type="button" onClick={() => void mutate()}>
            {t(`${ns}.accounts_failed`)}
          </button>
        ) : null}
        <button
          className="text-foreground-secondary text-xs underline underline-offset-2"
          type="button"
          onClick={() => void openBrowser(CHATGPT_USAGE_URL)}>
          {t(`${ns}.manage_usage`)}
        </button>
      </div>
      {message ? (
        <p className="text-destructive text-xs" role="alert">
          {message}
        </p>
      ) : null}
    </div>
  )
}
