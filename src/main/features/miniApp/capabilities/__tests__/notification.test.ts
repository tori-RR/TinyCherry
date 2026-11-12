import { MockMainPreferenceServiceUtils } from '@test-mocks/main/PreferenceService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockMiniAppApplication } from '../../__tests__/applicationMock'

const sendNotification = vi.fn()

/**
 * `NotificationService` is a LIFECYCLE service (`@Injectable`, registered in
 * `serviceRegistry`), so it is reached through the container — never constructed here.
 * `mockMiniAppApplication` because the unified factory throws on any name outside its
 * nine infrastructure services.
 */
vi.mock('@application', () =>
  mockMiniAppApplication({
    NotificationService: { sendNotification },
    MiniAppRuntimeService: { displayNameOf: () => 'My Game' }
  })
)

const { notificationCapability, resetNotificationRateForTest } = await import('../notification')
const { QuotaExceededError } = await import('../quota')

const A = 'com.example.a'

beforeEach(() => {
  sendNotification.mockReset()
  resetNotificationRateForTest()
  MockMainPreferenceServiceUtils.resetMocks()
  MockMainPreferenceServiceUtils.setPreferenceValue('app.notification.mini_app.enabled', true)
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('cherry.notification.show', () => {
  it('sends nothing for a valid call', async () => {
    // The gate lives HERE, mirroring `deliverConversationNotification`: main-side
    // `sendNotification` shows unconditionally, so an ungated caller ignores the switch.
    MockMainPreferenceServiceUtils.setPreferenceValue('app.notification.mini_app.enabled', false)

    await expect(notificationCapability.show(A, { title: 'Saved' })).resolves.toEqual({ ok: true })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('rejects an over-long title', async () => {
    await expect(notificationCapability.show(A, { title: 'x'.repeat(500), body: 'y' })).rejects.toThrow()
  })

  it('rate limits bursts', async () => {
    for (let i = 0; i < 5; i++) await notificationCapability.show(A, { title: 't', body: 'b' })
    await expect(notificationCapability.show(A, { title: 't', body: 'b' })).rejects.toThrow(QuotaExceededError)
  })

  it('refills after the window', async () => {
    for (let i = 0; i < 5; i++) await notificationCapability.show(A, { title: 't', body: 'b' })
    vi.advanceTimersByTime(61_000)
    await expect(notificationCapability.show(A, { title: 't', body: 'b' })).resolves.toBeDefined()
  })
})
