import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { useMessageHeaderCapabilities } from '../useMessageHeaderCapabilities'

vi.mock('@renderer/hooks/useAvatar', () => ({ default: () => '🍒' }))

it('displays the saved avatar without offering to edit personal information', () => {
  const { result } = renderHook(useMessageHeaderCapabilities)
  expect(result.current.userProfile).toEqual({ avatar: '🍒' })
  expect(result.current.openUserProfile).toBeUndefined()
})
