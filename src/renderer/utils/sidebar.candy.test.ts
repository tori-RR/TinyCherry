import { afterEach, expect, it, vi } from 'vitest'

import { createSidebarShortcutId } from '@shared/data/preference/preferenceTypes'

import {
  createSidebarShortcutTarget,
  getOrderedLaunchpadApps,
  getVisibleSidebarShortcutItems,
  normalizeSidebarShortcutItems
} from './sidebar'

afterEach(() => vi.unstubAllGlobals())

it('restores saved work, painting and agent/session pins without mutating saved navigation', () => {
  const shortcuts = [
    createSidebarShortcutTarget('core.app', 'agents'),
    createSidebarShortcutTarget('core.app', 'paintings'),
    createSidebarShortcutTarget('core.agent', 'retained-agent'),
    createSidebarShortcutTarget('core.agent-session', 'retained-session')
  ].map((target) => ({ type: 'shortcut', id: createSidebarShortcutId(target), target }))
  const saved = JSON.stringify(shortcuts)
  vi.stubGlobal('desktop', { info: { capabilities: { agents: false, painting: false } } })
  expect(getVisibleSidebarShortcutItems(shortcuts)).toHaveLength(0)
  expect(normalizeSidebarShortcutItems(shortcuts)).toHaveLength(4)
  vi.stubGlobal('desktop', { info: { capabilities: { agents: true, painting: true } } })
  expect(getVisibleSidebarShortcutItems(shortcuts)).toHaveLength(4)
  expect(getOrderedLaunchpadApps(['paintings', 'agents', 'knowledge', 'assistants']).slice(0, 4)).toEqual([
    'paintings',
    'agents',
    'knowledge',
    'assistants'
  ])
  expect(JSON.stringify(shortcuts)).toBe(saved)
})
