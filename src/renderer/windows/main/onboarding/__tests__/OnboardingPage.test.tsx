import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'

import { dataApiService } from '@data/DataApiService'
import { toast } from '@renderer/services/toast'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID } from '@shared/data/presets/cherryai'

const state = vi.hoisted(() => ({
  providers: [] as any[],
  models: [] as any[],
  defaults: {} as any,
  status: vi.fn(),
  loading: false
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@data/hooks/usePreference', () => ({
  usePreference: (key: string) => [
    key === 'app.language' ? 'zh-CN' : 'pending',
    key === 'app.language' ? vi.fn() : state.status
  ]
}))
vi.mock('@renderer/hooks/useProvider', () => ({
  useProviders: () => ({ providers: state.providers, isLoading: state.loading })
}))
vi.mock('@renderer/hooks/useModel', () => ({
  useModels: () => ({ models: state.models, isLoading: state.loading }),
  useDefaultModel: () => state.defaults
}))
vi.mock('@renderer/components/WindowControls', () => ({ WindowControls: () => null }))
vi.mock('@renderer/pages/settings/ProviderSettings', () => ({
  ProviderSettingsPage: () => <div>Provider settings</div>
}))
vi.mock('@renderer/pages/settings/ModelSettings/ModelSettings', () => ({ default: () => <div>Model settings</div> }))
import OnboardingPage from '../OnboardingPage'

beforeEach(() => {
  vi.clearAllMocks()
  state.providers = []
  state.models = []
  state.defaults = {}
  state.loading = false
  state.status.mockResolvedValue(undefined)
  vi.mocked(dataApiService.get).mockResolvedValue({ items: [], total: 0 } as never)
})
it('keeps configure and later actions in order without cloud login or privacy controls', () => {
  render(<OnboardingPage />)
  const configure = screen.getByRole('button', { name: 'onboarding.welcome.configure_provider' })
  const later = screen.getByRole('button', { name: 'onboarding.skip' })
  expect(configure.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /cherryin|cherry_cloud|login/i })).toBeNull()
})
it('persists skip and keeps a failed write visible for retry', async () => {
  const user = userEvent.setup()
  state.status.mockRejectedValueOnce(Error('synthetic write failure'))
  render(<OnboardingPage />)
  await user.click(screen.getByRole('button', { name: 'onboarding.skip' }))
  expect(state.status).toHaveBeenCalledWith('skipped')
  expect(toast.error).toHaveBeenCalledWith('onboarding.toast.complete_failed')
  await user.click(screen.getByRole('button', { name: 'onboarding.skip' }))
  expect(state.status).toHaveBeenCalledTimes(2)
  expect(dataApiService.patch).not.toHaveBeenCalled()
})
it('requires an enabled provider and chat model before continuing', async () => {
  const user = userEvent.setup()
  render(<OnboardingPage />)
  await user.click(screen.getByRole('button', { name: 'onboarding.welcome.configure_provider' }))
  expect(screen.getByRole('button', { name: 'onboarding.provider_setup.next' })).toHaveAttribute(
    'aria-disabled',
    'true'
  )
  expect(screen.queryByText('Model settings')).toBeNull()
})
it.each([true, false])(
  'completes with real model selection and only updates the sole seeded assistant (%s)',
  async (seeded) => {
    const model = { id: 'fixture::chat', providerId: 'fixture', capabilities: ['chat'], isEnabled: true }
    state.providers = [{ id: 'fixture' }]
    state.models = [model]
    state.defaults = { defaultModel: model, quickModel: model, translateModel: model }
    vi.mocked(dataApiService.get).mockResolvedValue({
      items: [{ id: 'assistant-1', modelId: seeded ? CHERRYAI_DEFAULT_UNIQUE_MODEL_ID : 'custom::model' }],
      total: 1
    } as never)
    const user = userEvent.setup()
    render(<OnboardingPage />)
    await user.click(screen.getByRole('button', { name: 'onboarding.welcome.configure_provider' }))
    await user.click(screen.getByRole('button', { name: 'onboarding.provider_setup.next' }))
    await user.click(screen.getByRole('button', { name: 'onboarding.select_model.start' }))
    await waitFor(() => expect(state.status).toHaveBeenCalledWith('completed'))
    if (seeded)
      expect(dataApiService.patch).toHaveBeenCalledExactlyOnceWith('/assistants/assistant-1', {
        body: { modelId: 'fixture::chat' }
      })
    else expect(dataApiService.patch).not.toHaveBeenCalled()
    expect(vi.mocked(dataApiService.get).mock.calls.every(([route]) => !route.startsWith('/agents'))).toBe(true)
  }
)
