import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'

const installFromZip = vi.fn()
const installFromDirectory = vi.fn()
vi.mock('@cherrystudio/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof CherryStudioUi>()
  return actual
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string | number>) => {
      if (!opts) return key
      if ('name' in opts) return `${key}:${opts.name}`
      if ('count' in opts) return `${key}:${opts.count}`
      if ('success' in opts && 'total' in opts && 'failed' in opts) {
        return `${key}:${opts.success}:${opts.total}:${opts.failed}`
      }
      return key
    }
  })
}))

vi.mock('@renderer/hooks/useSkills', () => ({
  useSkillInstall: () => ({ installFromZip, installFromDirectory })
}))

import { ImportSkillDialog } from '../ImportSkillDialog'

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {}
  }
  if (!HTMLElement.prototype.setPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => {}
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  installFromZip.mockReset()
  installFromDirectory.mockReset()
})

afterEach(cleanup)

describe('ImportSkillDialog', () => {
  it('asks the native host to pick and import the skill directory', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    installFromDirectory.mockResolvedValueOnce({ id: 'fixture', name: 'Local fixture' })
    render(<ImportSkillDialog open onOpenChange={onOpenChange} />)

    await user.click(screen.getByRole('button', { name: 'settings.skills.installFromDirectory' }))
    expect(installFromDirectory).toHaveBeenCalledExactlyOnceWith()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('keeps the import dialog ready when the native picker is cancelled', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    installFromZip.mockResolvedValueOnce(null)
    render(<ImportSkillDialog open onOpenChange={onOpenChange} />)

    const zip = screen.getByRole('button', { name: 'settings.skills.installFromZip' })
    await user.click(zip)
    expect(installFromZip).toHaveBeenCalledExactlyOnceWith()
    await waitFor(() => expect(zip).toBeEnabled())
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('closes when clicking the overlay while idle', () => {
    const onOpenChange = vi.fn()

    render(<ImportSkillDialog open onOpenChange={onOpenChange} />)

    const overlay = document.querySelector('[data-slot="dialog-overlay"]')
    expect(overlay).toBeInTheDocument()

    fireEvent.click(overlay!)

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
