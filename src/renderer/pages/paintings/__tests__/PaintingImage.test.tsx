import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const read = vi.hoisted(() => vi.fn())
vi.mock('../paintingFiles', () => ({ readPaintingBlob: read }))
import { PaintingImage } from '../PaintingImage'

const createObjectURL = vi.fn(() => 'blob:painting-preview')
const revokeObjectURL = vi.fn()

beforeEach(() => {
  read.mockReset()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createObjectURL
      static revokeObjectURL = revokeObjectURL
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

it('releases preview Blob URLs when the preview unmounts', async () => {
  read.mockResolvedValue(new Blob(['image'], { type: 'image/png' }))
  const view = render(<PaintingImage fileId="fixture" alt="A cherry" />)
  await screen.findByAltText('A cherry')
  expect(createObjectURL).toHaveBeenCalledOnce()
  view.unmount()
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:painting-preview')
  expect(read.mock.calls[0][1].signal.aborted).toBe(true)
})

it('does not allocate a Blob URL for an image that completes after unmount', async () => {
  let finish!: (blob: Blob) => void
  read.mockImplementation(
    () =>
      new Promise<Blob>((resolve) => {
        finish = resolve
      })
  )
  const view = render(<PaintingImage fileId="fixture" alt="A cherry" />)
  await waitFor(() => expect(read).toHaveBeenCalledOnce())
  view.unmount()
  await act(async () => finish(new Blob(['image'])))
  expect(createObjectURL).not.toHaveBeenCalled()
})
