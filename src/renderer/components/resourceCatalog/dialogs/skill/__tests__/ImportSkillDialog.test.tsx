import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as CherryStudioUi from '@cherrystudio/ui'

const installFromZip = vi.fn()
const installFromDirectory = vi.fn()
const ipcApiRequest = vi.hoisted(() => vi.fn())
const runtime = vi.hoisted(() => ({ isEvoStack: false }))

vi.mock(import('@renderer/utils/platform'), async (importOriginal) => ({
  ...(await importOriginal()),
  get isEvoStack() {
    return runtime.isEvoStack
  }
}))

vi.mock('@renderer/ipc', () => ({ ipcApi: { request: ipcApiRequest } }))

const fileMetadata = {
  kind: 'file' as const,
  type: 'other' as const,
  size: 0,
  createdAt: 0,
  modifiedAt: 0,
  mime: 'application/octet-stream'
}

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
  runtime.isEvoStack = false
  vi.clearAllMocks()
  installFromZip.mockReset()
  installFromDirectory.mockReset()
  ipcApiRequest.mockReset()
  ipcApiRequest.mockResolvedValue(fileMetadata)
  Object.assign(window, {
    api: {
      ...window.api,
      file: {
        ...window.api?.file,
        getPathForFile: vi.fn((file: File) => `/tmp/${file.name}`),
        select: vi.fn(async () => [{ name: 'broken.zip', path: '/tmp/broken.zip' }])
      }
    }
  })
})

afterEach(cleanup)

describe('ImportSkillDialog', () => {
  it('imports a native absolute path without calling an unavailable Electron picker', async () => {
    runtime.isEvoStack = true
    const user = userEvent.setup()
    installFromDirectory.mockResolvedValueOnce({ id: 'fixture', name: 'Local fixture' })
    render(<ImportSkillDialog open onOpenChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'settings.skills.installFromDirectory' }))
    expect(screen.getByText('settings.skills.evostack.path_required')).toBeInTheDocument()
    expect(installFromDirectory).not.toHaveBeenCalled()
    await user.type(screen.getByRole('textbox', { name: 'settings.skills.evostack.import_path' }), 'C:/fixture/skill')
    await user.click(screen.getByRole('button', { name: 'settings.skills.installFromDirectory' }))

    await waitFor(() => expect(installFromDirectory).toHaveBeenCalledWith('C:/fixture/skill'))
    expect(window.api.file.select).not.toHaveBeenCalled()
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
