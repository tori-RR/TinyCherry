import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ language: 'en-US' }))
vi.unmock('@cherrystudio/ui')
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: state.language, resolvedLanguage: state.language }
  })
}))
import { HelpMenu } from '../HelpMenu'
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})
it('focuses the guide from the keyboard and returns focus on Escape', async () => {
  const user = userEvent.setup()
  render(<HelpMenu />)
  const trigger = screen.getByRole('button', { name: 'help.title' })
  trigger.focus()
  await user.keyboard('{ArrowRight}')
  expect(await screen.findByRole('button', { name: 'help.guide' })).toHaveFocus()
  expect(screen.getAllByRole('button').map((node) => node.textContent)).toEqual(['help.title', 'help.guide'])
  await user.keyboard('{Escape}')
  await waitFor(() => expect(trigger).toHaveFocus())
})
it('hover opens the menu without stealing focus', async () => {
  const user = userEvent.setup()
  render(
    <>
      <button>Existing focus</button>
      <HelpMenu />
    </>
  )
  const focus = screen.getByRole('button', { name: 'Existing focus' })
  focus.focus()
  await user.hover(screen.getByRole('button', { name: 'help.title' }))
  await screen.findByRole('button', { name: 'help.guide' })
  expect(focus).toHaveFocus()
})
it.each([
  ['zh-CN', 'https://cherryai.com.cn/docs'],
  ['en-US', 'https://cherryai.com/docs']
])('opens the %s guide through the external URL facade', async (language, url) => {
  state.language = language
  const user = userEvent.setup()
  const close = vi.fn()
  render(<HelpMenu onRequestClose={close} />)
  await user.click(screen.getByRole('button', { name: 'help.title' }))
  await user.click(await screen.findByRole('button', { name: 'help.guide' }))
  await waitFor(() => expect(window.api.shell.openExternal).toHaveBeenCalledWith(url))
  expect(close).toHaveBeenCalledOnce()
})
