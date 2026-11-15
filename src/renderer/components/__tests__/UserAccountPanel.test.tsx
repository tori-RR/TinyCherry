import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { SWRConfig } from 'swr'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import i18n from '@renderer/i18n/resolver'
import { openSettingsTab } from '@renderer/services/mainWindowNavigation'

import { UserAccountPanel } from '../UserAccountPanel'

const runtime = vi.hoisted(() => ({ isEvoStack: false }))

vi.mock(import('@renderer/utils/platform'), async (importOriginal) => ({
  ...(await importOriginal()),
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))

vi.unmock('@cherrystudio/ui')
vi.mock('@renderer/hooks/useAvatar', () => ({ default: () => '🍒' }))
vi.mock('@renderer/services/mainWindowNavigation', () => ({ openSettingsTab: vi.fn() }))
vi.mock('../NotificationCenter', () => ({
  NotificationCenterButton: ({ onRequestClose }: { onRequestClose?: () => void }) => (
    <button type="button" onClick={onRequestClose}>
      Notifications
    </button>
  )
}))

beforeEach(async () => {
  runtime.isEvoStack = false
  vi.clearAllMocks()
  MockUsePreferenceUtils.resetMocks()
  MockUsePreferenceUtils.setPreferenceValue('app.user.name', '')
  await i18n.changeLanguage('zh-CN')
})

describe('UserAccountPanel', () => {
  it('shows EvoStack app information without requesting cloud account services', async () => {
    const request = vi.mocked(window.api.ipcApi.request)
    runtime.isEvoStack = true
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', 'Local nickname')
    request.mockImplementation(async (route) => {
      if (route === 'app.get_info') {
        return {
          ok: true,
          data: {
            version: '2.2.1',
            isPackaged: true,
            appPath: 'C:/TinyCherry',
            homePath: 'C:/TinyCherry/data',
            notesPath: 'C:/TinyCherry/data',
            configPath: 'C:/TinyCherry/data',
            appDataPath: 'C:/TinyCherry/data',
            resourcesPath: 'C:/TinyCherry/data',
            logsPath: 'C:/TinyCherry/data',
            arch: 'x64',
            isPortable: true,
            canCheckForUpdates: false,
            installPath: 'C:/TinyCherry'
          }
        }
      }
      return { ok: true, data: undefined }
    })
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <UserAccountPanel />
      </SWRConfig>
    )

    expect(await screen.findByText('v2.2.1')).toBeVisible()
    expect(screen.getByText('TinyCherry')).toBeVisible()
    expect(screen.queryByText('Local nickname')).not.toBeInTheDocument()
    expect(screen.queryByText('个人信息')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /订阅|重试|登录/ })).not.toBeInTheDocument()
    expect(request.mock.calls.filter(([route]) => route.startsWith('cherry_cloud.'))).toEqual([])
  })

  it('shows the local nickname without account, profile editing or subscription controls', () => {
    MockUsePreferenceUtils.setPreferenceValue('app.user.name', 'Local nickname')
    render(<UserAccountPanel />)

    expect(screen.getByText('Local nickname')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Local nickname|个人信息|登录|订阅|用量/ })).not.toBeInTheDocument()
    expect(vi.mocked(window.api.ipcApi.request).mock.calls.some(([route]) => route.startsWith('cherry_cloud.'))).toBe(
      false
    )
  })

  it('places help below appearance and keeps settings as the last menu action', async () => {
    const close = vi.fn()
    render(
      <UserAccountPanel onRequestClose={close}>
        <button type="button">帮助</button>
      </UserAccountPanel>
    )
    const appearance = screen.getByRole('button', { name: '外观' })
    const help = screen.getByRole('button', { name: '帮助' })
    const settings = screen.getByRole('button', { name: '设置' })
    expect(screen.getAllByRole('button').filter((button) => [appearance, help, settings].includes(button))).toEqual([
      appearance,
      help,
      settings
    ])

    await userEvent.click(settings)
    expect(close).toHaveBeenCalledOnce()
    expect(openSettingsTab).toHaveBeenCalledOnce()
  })

  it('hands focus off to notifications and closes the account menu', async () => {
    const close = vi.fn()
    const openNotifications = vi.fn()
    render(<UserAccountPanel onRequestClose={close} onNotificationsOpen={openNotifications} />)

    await userEvent.click(screen.getByRole('button', { name: 'Notifications' }))
    expect(openNotifications).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the entire account menu after selecting an appearance mode', async () => {
    function AccountMenu() {
      const [open, setOpen] = useState(true)
      return open ? (
        <UserAccountPanel onRequestClose={() => setOpen(false)} />
      ) : (
        <button type="button">Open account menu</button>
      )
    }
    const user = userEvent.setup()
    render(<AccountMenu />)
    await user.hover(screen.getByRole('button', { name: '外观' }))
    await user.click(await screen.findByRole('button', { name: '浅色', pressed: false }))

    expect(screen.getByRole('button', { name: 'Open account menu' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '外观' })).not.toBeInTheDocument()
  })
})
