import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@renderer/ipc', () => ({ ipcApi: { request } }))

import { readPaintingBlob, uploadPaintingImage } from '../paintingFiles'

beforeEach(() => {
  request.mockReset()
})

function testFile(size: number): File {
  return {
    name: 'reference.png',
    type: 'image/png',
    size,
    slice: (offset: number, end: number) => ({
      arrayBuffer: async () => new Uint8Array(Math.min(size, end) - offset).buffer
    })
  } as File
}

describe('painting image transport', () => {
  it('uploads images larger than a native frame in small sequential chunks', async () => {
    request.mockImplementation(async (route, input) => {
      if (route === 'painting.file.upload.begin') return { uploadId: 'upload-1' }
      if (route === 'painting.file.upload.chunk') return { offset: input.offset + atob(input.data).length }
      if (route === 'painting.file.upload.finish') return { id: 'image-1' }
      throw new Error(`Unexpected ${route}`)
    })
    const result = await uploadPaintingImage(testFile(5 * 1024 * 1024))
    expect(result.id).toBe('image-1')
    const chunks = request.mock.calls.filter(([route]) => route === 'painting.file.upload.chunk')
    expect(chunks.length).toBeGreaterThan(20)
    expect(chunks.every(([, input]) => JSON.stringify(input).length < 300_000)).toBe(true)
    expect(request.mock.calls.at(-1)?.[0]).toBe('painting.file.upload.finish')
  })

  it('aborts the temporary upload when its acknowledged offset is invalid', async () => {
    request.mockImplementation(async (route) =>
      route === 'painting.file.upload.begin' ? { uploadId: 'upload-1' } : { offset: 7 }
    )
    await expect(uploadPaintingImage(testFile(12))).rejects.toThrow('进度不一致')
    expect(request).toHaveBeenLastCalledWith('painting.file.upload.abort', { uploadId: 'upload-1' })
    expect(request.mock.calls.some(([route]) => route === 'painting.file.upload.finish')).toBe(false)
  })

  it('joins bounded image chunks into a local Blob', async () => {
    request
      .mockResolvedValueOnce({ data: btoa('abc'), size: 5, mime: 'image/png', nextOffset: 3, done: false })
      .mockResolvedValueOnce({ data: btoa('de'), size: 5, mime: 'image/png', nextOffset: 5, done: true })
    const blob = await readPaintingBlob('image-1', { thumbnail: true })
    expect(blob.size).toBe(5)
    expect(blob.type).toBe('image/png')
    expect(request).toHaveBeenLastCalledWith('painting.file.read', { fileId: 'image-1', offset: 3, thumbnail: true })
  })

  it.each([
    { data: '', size: 5, mime: 'image/png', nextOffset: 0, done: false },
    { data: btoa('abc'), size: 5, mime: 'image/png', nextOffset: 2, done: false },
    { data: btoa('abc'), size: 5, mime: 'image/png', nextOffset: 3, done: true },
    { data: btoa('abc'), size: 5, mime: 'text/html', nextOffset: 3, done: false }
  ])('rejects corrupt or nonprogressing chunks without looping', async (response) => {
    request.mockResolvedValue(response)
    await expect(readPaintingBlob('image-1')).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('cancellation stops a transfer before reading additional chunks', async () => {
    const controller = new AbortController()
    request.mockImplementation(async () => {
      controller.abort()
      return { data: btoa('abc'), size: 5, mime: 'image/png', nextOffset: 3, done: false }
    })
    await expect(readPaintingBlob('image-1', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
