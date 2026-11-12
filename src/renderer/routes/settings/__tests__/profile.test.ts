import { describe, expect, it } from 'vitest'

import { Route as gateway } from '../api-gateway'
import { Route as channels } from '../channels'
import { Route as devices } from '../device-connections'
import { Route as documents } from '../file-processing'
import { Route as profile } from '../profile'
import { Route as screenshot } from '../screenshot'
import { Route as subscription } from '../subscription'
import { Route as voice } from '../voice'

describe('retired settings routes', () => {
  it.each([gateway, channels, devices, documents, profile, screenshot, subscription, voice])(
    'redirects $id to model providers',
    (route) => {
      const beforeLoad = route.options.beforeLoad as () => void
      expect(beforeLoad).toThrow(
        expect.objectContaining({ options: expect.objectContaining({ to: '/settings/provider', replace: true }) })
      )
    }
  )
})
