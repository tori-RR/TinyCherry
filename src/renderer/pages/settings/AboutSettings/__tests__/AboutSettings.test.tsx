import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
const open = vi.hoisted(() => vi.fn())
vi.mock('@renderer/hooks/useOpenReleaseNotes', () => ({ useOpenReleaseNotes: () => open }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
import AboutSettings from '../AboutSettings'
it('uses validated host metadata and keeps the release notes action', async () => {
  render(<AboutSettings />)
  expect(screen.getByRole('heading', { name: 'TinyCherry' })).toBeVisible()
  expect(screen.getByText(window.desktop.info.version)).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'settings.about.release_notes' }))
  expect(open).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: /update|diagnostic|report|feedback/i })).toBeNull()
})
