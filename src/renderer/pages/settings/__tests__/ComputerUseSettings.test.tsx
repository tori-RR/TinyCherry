import { mockUsePreference, MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SWRConfig } from 'swr'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@renderer/i18n/resolver'
import { ipcApi } from '@renderer/ipc'

import { ComputerUseSettings } from '../ComputerUseSettings'

const runtime = vi.hoisted(() => ({ isEvoStack: false }))
const defaultUsePreference = mockUsePreference.getMockImplementation()!
vi.mock(import('@renderer/utils/platform'), async (importOriginal) => ({
  ...(await importOriginal()),
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))

vi.unmock('@cherrystudio/ui')
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: vi.fn() } }))

function showSettings() {
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <ComputerUseSettings />
    </SWRConfig>
  )
}

beforeEach(async () => {
  runtime.isEvoStack = false
  vi.clearAllMocks()
  MockUsePreferenceUtils.resetMocks()
  mockUsePreference.mockImplementation(defaultUsePreference)
  await i18n.changeLanguage('en-us')
})
afterEach(cleanup)

describe('Computer Use permission settings', () => {
  it('keeps native control disabled when the runtime cannot provide control', async () => {
    runtime.isEvoStack = true
    MockUsePreferenceUtils.setPreferenceValue('app.computer_use.agent_control.enabled', false)
    vi.mocked(ipcApi.request).mockResolvedValue({ permissions: [], controlAvailable: false })
    showSettings()
    expect(await screen.findByText(/Desktop control is currently unavailable/)).toBeVisible()
    expect(screen.getByText(/Background key presses are not yet supported; use clicks and field editing/)).toBeVisible()
    const toggle = screen.getByRole('switch', { name: 'Allow agents to control desktop applications' })
    expect(toggle).not.toBeChecked()
    expect(toggle).toBeDisabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Granted')).not.toBeInTheDocument()
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(false)
  })

  it('allows an explicit native control grant and revocation when the runtime is ready', async () => {
    runtime.isEvoStack = true
    vi.mocked(ipcApi.request).mockResolvedValue({ permissions: [], controlAvailable: true })
    const user = userEvent.setup()
    showSettings()
    expect(await screen.findByText(/Stopping generation cancels the current control task/)).toBeVisible()
    expect(screen.getByText(/Background key presses are not yet supported; use clicks and field editing/)).toBeVisible()
    expect(screen.queryByText(/You can stop control from the tray/)).not.toBeInTheDocument()
    const toggle = screen.getByRole('switch', { name: 'Allow agents to control desktop applications' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(true)
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(false)
  })

  it('allows native control to be turned off while the permission query is still pending', async () => {
    runtime.isEvoStack = true
    MockUsePreferenceUtils.setPreferenceValue('app.computer_use.agent_control.enabled', true)
    let finishQuery!: (status: { permissions: []; controlAvailable: boolean }) => void
    vi.mocked(ipcApi.request).mockImplementationOnce(() => new Promise((resolve) => (finishQuery = resolve)))
    const user = userEvent.setup()
    showSettings()
    const toggle = screen.getByRole('switch', { name: 'Allow agents to control desktop applications' })
    expect(toggle).toBeChecked()
    expect(toggle).toBeEnabled()
    expect(screen.getByRole('status')).toHaveTextContent('Loading')
    await user.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(false)
    await act(async () => finishQuery({ permissions: [], controlAvailable: true }))
    await waitFor(() => expect(toggle).toBeEnabled())
  })

  it('allows a previously saved native control setting to be turned off and prevents re-enabling it', async () => {
    runtime.isEvoStack = true
    MockUsePreferenceUtils.setPreferenceValue('app.computer_use.agent_control.enabled', true)
    vi.mocked(ipcApi.request).mockResolvedValue({ permissions: [], controlAvailable: false })
    const user = userEvent.setup()
    showSettings()
    const toggle = screen.getByRole('switch', { name: 'Allow agents to control desktop applications' })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    await waitFor(() => expect(toggle).toBeDisabled())
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(false)
  })

  it('requires an explicit desktop-control grant independently of OS permission status', async () => {
    const user = userEvent.setup()
    vi.mocked(ipcApi.request).mockResolvedValue({ permissions: [] })
    showSettings()
    const toggle = screen.getByRole('switch', { name: 'Allow agents to control desktop applications' })
    expect(toggle).not.toBeChecked()
    await user.click(toggle)
    expect(toggle).toBeChecked()
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(true)
    expect(
      vi.mocked(ipcApi.request).mock.calls.every(([route]) => route === 'computer_use.get_permission_status')
    ).toBe(true)
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(false)
  })
  it('requests only on a click, keeps an unconfirmed result, and refreshes after returning from settings', async () => {
    const user = userEvent.setup()
    let granted = false
    vi.mocked(ipcApi.request).mockImplementation(async () => ({
      permissions: [
        {
          id: 'accessibility',
          label: 'Accessibility',
          status: granted ? 'granted' : 'unknown',
          interaction: granted ? 'none' : 'systemSettings'
        }
      ]
    }))
    showSettings()
    const grant = await screen.findByRole('button', { name: 'Manage Accessibility permission' })
    expect(screen.getByText('Not confirmed')).toBeInTheDocument()
    expect(ipcApi.request).not.toHaveBeenCalledWith('computer_use.request_permissions', expect.anything())
    await user.click(grant)
    expect(ipcApi.request).toHaveBeenCalledWith('computer_use.request_permissions', { ids: ['accessibility'] })
    await waitFor(() => expect(grant).toBeEnabled())
    expect(screen.getByText('Not confirmed')).toBeInTheDocument()
    granted = true
    fireEvent.focus(window)
    expect(await screen.findByText('Granted')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Manage Accessibility permission' })).not.toBeInTheDocument()
  })

  it('shows a query failure and allows an explicit permission recheck to recover', async () => {
    const user = userEvent.setup()
    vi.mocked(ipcApi.request).mockRejectedValueOnce(new Error('runtime missing')).mockResolvedValue({ permissions: [] })
    showSettings()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not check or request helper permissions')
    await user.click(screen.getByRole('button', { name: 'Recheck permissions' }))
    expect(await screen.findByText(/This runtime has no system permission request flow/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByText('Granted')).not.toBeInTheDocument()
  })

  it('surfaces a failed request without retrying the system interaction', async () => {
    const user = userEvent.setup()
    vi.mocked(ipcApi.request).mockImplementation(async (route) => {
      if (route === 'computer_use.request_permissions') throw new Error('cancelled')
      return {
        permissions: [
          { id: 'screenRecording', label: 'Screen Recording', status: 'unknown', interaction: 'systemSettings' }
        ]
      }
    })
    showSettings()
    await user.click(await screen.findByRole('button', { name: 'Manage Screen Recording permission' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    fireEvent.focus(window)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Recheck permissions' })).toBeEnabled())
    expect(
      vi.mocked(ipcApi.request).mock.calls.filter(([route]) => route === 'computer_use.request_permissions')
    ).toHaveLength(1)
    expect(screen.getByText('Not confirmed')).toBeInTheDocument()
  })

  it.each([false, true])('keeps the saved grant at %s if changing control fails', async (enabled) => {
    runtime.isEvoStack = true
    MockUsePreferenceUtils.setPreferenceValue('app.computer_use.agent_control.enabled', enabled)
    MockUsePreferenceUtils.mockPreferenceError('app.computer_use.agent_control.enabled', new Error('save failed'))
    vi.mocked(ipcApi.request).mockResolvedValue({ permissions: [], controlAvailable: true })
    const user = userEvent.setup()
    showSettings()
    const toggle = screen.getByRole('switch', { name: 'Allow agents to control desktop applications' })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the desktop control setting')
    expect(toggle).toHaveAttribute('aria-checked', String(enabled))
    expect(MockUsePreferenceUtils.getPreferenceValue('app.computer_use.agent_control.enabled')).toBe(enabled)
    expect(toggle).toBeEnabled()
  })

  it('prevents overlapping control changes while the preference save is pending', async () => {
    runtime.isEvoStack = true
    let finishSave!: () => void
    const save = vi.fn(() => new Promise<void>((resolve) => (finishSave = resolve)))
    MockUsePreferenceUtils.mockPreferenceReturn('app.computer_use.agent_control.enabled', false, save)
    vi.mocked(ipcApi.request).mockResolvedValue({ permissions: [], controlAvailable: true })
    const user = userEvent.setup()
    showSettings()
    const toggle = screen.getByRole('switch', { name: 'Allow agents to control desktop applications' })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(save).toHaveBeenCalledExactlyOnceWith(true)
    await act(async () => finishSave())
    expect(toggle).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
