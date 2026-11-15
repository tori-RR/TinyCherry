import { MockUsePreferenceUtils } from '@test-mocks/renderer/usePreference'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Platform from '@renderer/utils/platform'
import { LATEST_PRIVACY_POLICY_VERSION } from '@shared/utils/constants'

import { useIsPrivacyUpdateRequired } from '../useIsPrivacyUpdateRequired'

const runtime = vi.hoisted(() => ({ isEvoStack: false }))
vi.mock('@renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof Platform>()),
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))

describe('useIsPrivacyUpdateRequired', () => {
  beforeEach(() => {
    runtime.isEvoStack = false
    MockUsePreferenceUtils.resetMocks()
  })

  it('does not gate EvoStack on privacy consent even for an older profile', () => {
    runtime.isEvoStack = true
    MockUsePreferenceUtils.setMultiplePreferenceValues({
      'app.privacy.data_collection.enabled': true,
      'app.privacy.policy_version': 'previous'
    })
    expect(renderHook(() => useIsPrivacyUpdateRequired()).result.current).toBe(false)
    expect(MockUsePreferenceUtils.getPreferenceValue('app.privacy.policy_version')).toBe('previous')
  })

  it('requires an update only while data collection is on and the acknowledged version is stale', () => {
    MockUsePreferenceUtils.setMultiplePreferenceValues({
      'app.privacy.data_collection.enabled': true,
      'app.privacy.policy_version': 'previous'
    })
    expect(renderHook(() => useIsPrivacyUpdateRequired()).result.current).toBe(true)

    MockUsePreferenceUtils.setPreferenceValue('app.privacy.policy_version', LATEST_PRIVACY_POLICY_VERSION)
    expect(renderHook(() => useIsPrivacyUpdateRequired()).result.current).toBe(false)

    MockUsePreferenceUtils.setMultiplePreferenceValues({
      'app.privacy.data_collection.enabled': false,
      'app.privacy.policy_version': 'previous'
    })
    expect(renderHook(() => useIsPrivacyUpdateRequired()).result.current).toBe(false)
  })
})
