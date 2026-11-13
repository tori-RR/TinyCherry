import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'
import type * as RendererPlatform from '@renderer/utils/platform'
import { MIN_COMPRESS_THRESHOLD_PERCENT, MIN_TRUNCATE_THRESHOLD } from '@shared/data/types/contextSettings'

const prefs = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  setters: {} as Record<string, ReturnType<typeof vi.fn>>
}))
const platform = vi.hoisted(() => ({ native: false }))
vi.mock('@renderer/utils/platform', async (original) => ({
  ...(await original<typeof RendererPlatform>()),
  get isEvoStack() {
    return platform.native
  }
}))

vi.mock('@data/hooks/usePreference', () => ({
  usePreference: (key: string) => {
    prefs.setters[key] ??= vi.fn()
    return [prefs.state[key], prefs.setters[key]]
  }
}))

vi.mock('@cherrystudio/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof CherryStudioUi>()),
  Divider: () => <hr />,
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: (checked: boolean) => void }) => (
    <input
      type="checkbox"
      role="switch"
      checked={!!checked}
      onChange={(event) => onCheckedChange(event.currentTarget.checked)}
    />
  ),
  InfoTooltip: ({ content, ariaLabel }: { content: string; ariaLabel: string }) => (
    <span aria-label={ariaLabel} data-tooltip-content={content} />
  )
}))

vi.mock('@renderer/hooks/useModel', () => ({ useModelById: () => ({ model: undefined }) }))
vi.mock('@renderer/hooks/useProvider', () => ({ useProviders: () => ({ providers: [] }) }))
vi.mock('@renderer/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'light' }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/components/DefaultModelSelector', () => ({
  DefaultModelSelector: () => <button type="button" data-testid="compress-model-selector" />
}))

import { ContextManagementSettings } from '../ContextManagementSettings'

describe('ContextManagementSettings', () => {
  beforeEach(() => {
    platform.native = false
    vi.clearAllMocks()
    prefs.state = {
      'chat.context_settings.enabled': true,
      'chat.context_settings.max_messages': null,
      'chat.context_settings.truncate_threshold': 50_000,
      'chat.context_settings.compress.enabled': true,
      'chat.context_settings.compress.model_id': null,
      'chat.context_settings.compress.threshold_percent': 80
    }
  })

  it('writes the message limit and clears it back to unlimited', () => {
    render(<ContextManagementSettings />)
    const input = screen.getByLabelText('settings.models.context_management.max_messages')
    expect(input).toHaveAttribute('placeholder', 'settings.models.context_management.max_messages_unlimited')

    fireEvent.change(input, { target: { value: '5' } })
    fireEvent.blur(input)
    expect(prefs.setters['chat.context_settings.max_messages']).toHaveBeenCalledWith(5)

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(prefs.setters['chat.context_settings.max_messages']).toHaveBeenCalledWith(null)
  })

  it('writes the master switch preference', () => {
    prefs.state['chat.context_settings.enabled'] = false
    render(<ContextManagementSettings />)
    fireEvent.click(screen.getByRole('switch'))
    expect(prefs.setters['chat.context_settings.enabled']).toHaveBeenCalledWith(true)
  })

  it('floors the threshold and clamps it to the fs_read-safe minimum', () => {
    render(<ContextManagementSettings />)
    const input = screen.getByLabelText('settings.models.context_management.truncate_threshold')
    const setter = prefs.setters['chat.context_settings.truncate_threshold']

    fireEvent.change(input, { target: { value: '80000.7' } })
    fireEvent.blur(input)
    expect(setter).toHaveBeenLastCalledWith(80_000)

    // A negative is clamped up to the floor like any other below-floor value:
    // the threshold doubles as fs_read's per-call output cap, so anything lower
    // makes persisted output unreadable.
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.blur(input)
    expect(setter).toHaveBeenLastCalledWith(MIN_TRUNCATE_THRESHOLD)

    // A below-floor value is not ignored but clamped. It doubles as fs_read's
    // per-call output cap, so anything lower makes persisted output unreadable.
    fireEvent.change(input, { target: { value: '1' } })
    fireEvent.blur(input)
    expect(setter).toHaveBeenLastCalledWith(MIN_TRUNCATE_THRESHOLD)
  })

  it('writes the compaction trigger and clamps it into range', () => {
    render(<ContextManagementSettings />)
    const input = screen.getByLabelText('settings.models.context_management.compress_threshold')
    const setter = prefs.setters['chat.context_settings.compress.threshold_percent']

    fireEvent.change(input, { target: { value: '60' } })
    fireEvent.blur(input)
    expect(setter).toHaveBeenLastCalledWith(60)

    // A trigger of 0 would fold on every step; 250 could never fire.
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input)
    expect(setter).toHaveBeenLastCalledWith(MIN_COMPRESS_THRESHOLD_PERCENT)

    fireEvent.change(input, { target: { value: '250' } })
    fireEvent.blur(input)
    expect(setter).toHaveBeenLastCalledWith(100)
  })

  it('hides the compaction trigger while compression is off', () => {
    prefs.state['chat.context_settings.compress.enabled'] = false
    render(<ContextManagementSettings />)
    expect(screen.queryByLabelText('settings.models.context_management.compress_threshold')).not.toBeInTheDocument()
  })

  it('keeps native history limits editable while preserving disabled overflow preferences', async () => {
    platform.native = true
    const before = { ...prefs.state }
    render(<ContextManagementSettings />)
    expect(screen.getByText('settings.models.context_management.native_unavailable')).toBeVisible()
    expect(screen.getByLabelText('settings.models.context_management.max_messages')).toBeEnabled()
    const overflow = screen.getByRole('group', { name: 'settings.models.context_management.enabled' })
    expect(overflow).toBeDisabled()
    expect(screen.getByLabelText('settings.models.context_management.truncate_threshold')).toBeDisabled()
    expect(screen.getByLabelText('settings.models.context_management.compress_threshold')).toBeDisabled()
    expect(screen.getByTestId('compress-model-selector')).toBeDisabled()
    await userEvent.setup().click(screen.getAllByRole('switch')[0])
    expect(prefs.state).toEqual(before)
    for (const setter of Object.values(prefs.setters)) expect(setter).not.toHaveBeenCalled()
  })
})
