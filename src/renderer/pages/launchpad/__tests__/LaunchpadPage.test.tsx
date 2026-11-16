import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

import { getOrderedLaunchpadApps, reorderLaunchpadApps } from '@renderer/utils/sidebar'
const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  reorder: vi.fn(),
  pin: vi.fn(),
  order: ['notes', 'knowledge', 'agents', 'assistants'] as string[],
  sortable: undefined as any
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/hooks/useLaunchpadAppOrder', () => ({
  useLaunchpadAppOrder: () => ({ orderedAppIds: getOrderedLaunchpadApps(state.order), reorderApps: state.reorder })
}))
vi.mock('@renderer/hooks/useSidebarShortcuts', () => ({
  useSidebarShortcuts: () => ({ isPinned: () => false, setPinned: state.pin })
}))
vi.mock('@cherrystudio/ui', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Sortable: (props: any) => {
    state.sortable = props
    return <div>{props.items.map((item: any) => props.renderItem(item))}</div>
  }
}))
vi.mock('@renderer/components/command', () => ({
  CommandContextMenu: ({ children, extraItems }: { children: ReactNode; extraItems: any[] }) => (
    <div>
      {children}
      {extraItems.map((item) => (
        <button key={item.id} onClick={item.onSelect}>
          {item.label}
        </button>
      ))}
    </div>
  )
}))
import LaunchpadPage from '../LaunchpadPage'
beforeEach(() => vi.clearAllMocks())
it('shows chat and knowledge in saved order while hiding pending destinations', () => {
  render(<LaunchpadPage />)
  expect(state.sortable.items.map((item: any) => item.id)).toEqual(['knowledge', 'assistants'])
  expect(screen.queryByRole('button', { name: 'title.work' })).toBeNull()
  expect(screen.queryByRole('heading', { name: 'launchpad.miniApps' })).toBeNull()
})
it('preserves hidden saved destinations when the visible tiles are reordered', () => {
  render(<LaunchpadPage />)
  act(() => {
    state.sortable.onSortEnd({ oldIndex: 0, newIndex: 1 })
  })
  expect(state.reorder).toHaveBeenCalledWith(['assistants', 'knowledge'])
  const stored = reorderLaunchpadApps(state.order, ['assistants', 'knowledge'])
  expect(stored.slice(0, 2)).toEqual(['assistants', 'knowledge'])
  expect(stored).toContain('agents')
  expect(stored).toContain('notes')
  expect(state.pin).not.toHaveBeenCalled()
})
it('opens chat fresh in the current tab and supports sidebar pinning', async () => {
  render(<LaunchpadPage />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'title.chat' }))
  expect(state.navigate).toHaveBeenCalledWith({ to: '/app/chat' })
  await user.click(screen.getAllByRole('button', { name: 'launchpad.pin_to_sidebar' })[0])
  expect(state.pin).toHaveBeenCalledWith(
    expect.objectContaining({ locator: { providerId: 'core.app', resourceId: 'knowledge' } }),
    true,
    expect.any(String)
  )
})
