import { describe, expect, it } from 'vitest'

import { settingsMenu } from '@renderer/components/settingsMenu'

describe('TinyCherry settings menu', () => {
  it('omits retired sections and keeps model services', () => {
    const routes = settingsMenu.map(({ route }) => route)
    for (const section of [
      'profile',
      'api-gateway',
      'file-processing',
      'channels',
      'device-connections',
      'screenshot',
      'voice',
      'local-models',
      'notifications',
      'ocr'
    ]) {
      expect(routes).not.toContain('/settings/' + section)
    }
    expect(routes).toEqual(expect.arrayContaining(['/settings/provider']))
  })
})
