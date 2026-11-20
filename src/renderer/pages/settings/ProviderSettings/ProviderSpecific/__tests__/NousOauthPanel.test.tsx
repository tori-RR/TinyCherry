import { MockUseDataApiUtils, mockUseInvalidateCache } from '@test-mocks/renderer/useDataApi'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toast } from '@renderer/services/toast'
import type { OutputFor } from '@shared/ipc/types'

import NousOauthPanel from '../NousOauthPanel'

const { requestMock, invalidateMock, openWebsiteMock, updateProviderMock, provider, tMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  invalidateMock: vi.fn().mockResolvedValue(undefined),
  openWebsiteMock: vi.fn().mockResolvedValue(undefined),
  updateProviderMock: vi.fn().mockResolvedValue(undefined),
  provider: { id: 'nous-portal', settings: {} as { oauthClientId?: string } },
  tMock: (key: string) => key
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tMock }) }))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: (...args: unknown[]) => requestMock(...args) } }))
vi.mock('@renderer/services/website', () => ({ openExternalWebsite: openWebsiteMock }))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProvider: () => ({ provider, updateProvider: updateProviderMock })
}))
vi.mock('@cherrystudio/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    'aria-label': ariaLabel
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
    'aria-label'?: string
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />
}))

const ns = 'settings.provider.nous_portal'
const authorization = (requestId: string): OutputFor<'oauth.device.start'> => ({
  requestId,
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://portal.nousresearch.com/device',
  verificationUriComplete: 'https://portal.nousresearch.com/device?user_code=ABCD-EFGH',
  expiresAt: Date.now() + 300000,
  interval: 5
})

let status: OutputFor<'oauth.device.status'>
let hasToken: boolean

beforeEach(() => {
  vi.clearAllMocks()
  MockUseDataApiUtils.resetMocks()
  mockUseInvalidateCache.mockReturnValue(invalidateMock)
  provider.settings = {}
  hasToken = false
  status = { status: 'pending' }
  openWebsiteMock.mockResolvedValue(undefined)
  updateProviderMock.mockResolvedValue(undefined)
  requestMock.mockImplementation((route: string, input?: { requestId: string }) => {
    if (route === 'oauth.has_token') return Promise.resolve(hasToken)
    if (route === 'oauth.get_account') return Promise.resolve({ accountId: null })
    if (route === 'oauth.device.start') return Promise.resolve(authorization(input!.requestId))
    if (route === 'oauth.device.status') return Promise.resolve(status)
    if (route === 'oauth.device.cancel') return Promise.resolve(undefined)
    if (route === 'oauth.logout') {
      hasToken = false
      return Promise.resolve(undefined)
    }
    throw new Error(`Unexpected route ${route}`)
  })
})

async function startSignIn() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: `${ns}.sign_in_button` }))
  return user
}

describe('Nous device OAuth panel', () => {
  it('shows the approval code, opens the official browser page and observes the short status route', async () => {
    render(<NousOauthPanel />)
    await startSignIn()

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument()
    expect(screen.getByText('https://portal.nousresearch.com/device')).toBeInTheDocument()
    expect(openWebsiteMock).toHaveBeenCalledWith('https://portal.nousresearch.com/device?user_code=ABCD-EFGH')
    const input = requestMock.mock.calls.find(([route]) => route === 'oauth.device.start')?.[1]
    expect(input).toEqual({ providerId: 'nous-portal', requestId: expect.any(String) })
    expect(requestMock).toHaveBeenCalledWith('oauth.device.status', input)
    expect(requestMock).not.toHaveBeenCalledWith('oauth.sign_in', expect.anything())
    expect(updateProviderMock).not.toHaveBeenCalled()
  })

  it('reflects completion and refreshes provider data without sending credentials back from the renderer', async () => {
    status = { status: 'completed', accountId: 'synthetic-account' }
    render(<NousOauthPanel />)
    await startSignIn()

    expect(await screen.findByText(`${ns}.logged_in`)).toBeInTheDocument()
    expect(screen.getByText('synthetic-account')).toBeInTheDocument()
    expect(invalidateMock).toHaveBeenCalledWith(['/providers', '/providers/nous-portal', '/providers/nous-portal/*'])
    expect(toast.success).toHaveBeenCalledWith(`${ns}.sign_in_success`)
    expect(updateProviderMock).not.toHaveBeenCalled()
    expect(screen.queryByText('ABCD-EFGH')).not.toBeInTheDocument()
  })

  it('cancels the owned attempt and permits a fresh request id without an error toast', async () => {
    render(<NousOauthPanel />)
    const user = await startSignIn()
    const firstInput = requestMock.mock.calls.find(([route]) => route === 'oauth.device.start')?.[1]

    await user.click(await screen.findByRole('button', { name: 'common.cancel' }))
    expect(requestMock).toHaveBeenCalledWith('oauth.device.cancel', firstInput)
    await user.click(await screen.findByRole('button', { name: `${ns}.sign_in_button` }))

    const attempts = requestMock.mock.calls.filter(([route]) => route === 'oauth.device.start')
    expect(attempts).toHaveLength(2)
    expect(attempts[1][1].requestId).not.toBe(attempts[0][1].requestId)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([
    [{ status: 'expired' }, 'expired'],
    [{ status: 'error', code: 'access_denied', message: 'Untrusted server details' }, 'denied']
  ] as const)('makes a terminal failure retryable: %s', async (result, key) => {
    status = result
    render(<NousOauthPanel />)
    await startSignIn()

    expect(await screen.findByRole('alert')).toHaveTextContent(`${ns}.${key}`)
    expect(screen.getByRole('button', { name: `${ns}.sign_in_button` })).toBeEnabled()
    expect(screen.queryByText('Untrusted server details')).not.toBeInTheDocument()
  })

  it('keeps the code available if opening the browser fails', async () => {
    openWebsiteMock.mockRejectedValueOnce(new Error('synthetic browser failure'))
    render(<NousOauthPanel />)
    await startSignIn()

    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument()
    expect(toast.error).toHaveBeenCalledWith(`${ns}.browser_failed`)
    expect(screen.getByRole('button', { name: `${ns}.open_browser` })).toBeEnabled()
  })

  it('cancels a late start reply after unmount and never opens its browser', async () => {
    let resolveStart: (flow: OutputFor<'oauth.device.start'>) => void = () => {}
    const defaultImplementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((route: string, input: unknown) => {
      if (route !== 'oauth.device.start') return defaultImplementation(route, input)
      return new Promise((resolve) => {
        resolveStart = resolve
      })
    })
    const { unmount } = render(<NousOauthPanel />)
    await startSignIn()
    const input = requestMock.mock.calls.find(([route]) => route === 'oauth.device.start')?.[1]
    unmount()

    await act(async () => {
      resolveStart(authorization(input.requestId))
    })

    expect(requestMock).toHaveBeenCalledWith('oauth.device.cancel', input)
    expect(openWebsiteMock).not.toHaveBeenCalled()
    expect(invalidateMock).not.toHaveBeenCalled()
  })

  it('rejects an unexpected verification host before opening a browser', async () => {
    const defaultImplementation = requestMock.getMockImplementation()!
    requestMock.mockImplementation((route: string, input: { requestId: string }) => {
      if (route !== 'oauth.device.start') return defaultImplementation(route, input)
      return Promise.resolve({
        ...authorization(input.requestId),
        verificationUriComplete: 'https://example.com/device'
      })
    })
    render(<NousOauthPanel />)
    await startSignIn()

    expect(await screen.findByRole('alert')).toHaveTextContent(`${ns}.sign_in_failed`)
    expect(openWebsiteMock).not.toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledWith('oauth.device.cancel', {
      providerId: 'nous-portal',
      requestId: expect.any(String)
    })
  })

  it('saves the public client id through provider settings and leaves OAuth tokens in the backend', async () => {
    render(<NousOauthPanel />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: `${ns}.sign_in_button` })
    await user.click(screen.getByText(`${ns}.client_id_label`, { selector: 'summary' }))
    await user.type(screen.getByRole('textbox', { name: `${ns}.client_id_label` }), 'tinycherry-test')
    await user.click(screen.getByRole('button', { name: 'common.save' }))

    await waitFor(() =>
      expect(updateProviderMock).toHaveBeenCalledWith({
        providerSettings: { oauthClientId: 'tinycherry-test' }
      })
    )
    expect(requestMock).not.toHaveBeenCalledWith('oauth.device.start', expect.anything())
  })

  it('rejects a non-ASCII client id before sending a settings mutation', async () => {
    render(<NousOauthPanel />)
    const user = userEvent.setup()
    await screen.findByRole('button', { name: `${ns}.sign_in_button` })
    await user.click(screen.getByText(`${ns}.client_id_label`, { selector: 'summary' }))
    await user.type(screen.getByRole('textbox', { name: `${ns}.client_id_label` }), 'tinycherry-客户端')
    await user.click(screen.getByRole('button', { name: 'common.save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(`${ns}.client_id_invalid`)
    expect(updateProviderMock).not.toHaveBeenCalled()
  })
})
