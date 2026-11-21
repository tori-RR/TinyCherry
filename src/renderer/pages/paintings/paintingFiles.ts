import { ipcApi } from '@renderer/ipc'
import type { FileEntry } from '@shared/data/types/file'

const CHUNK_SIZE = 192 * 1024
export const IMAGE_SIZE_LIMIT = 20 * 1024 * 1024

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Image operation cancelled', 'AbortError')
}

function encodeBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Large images are uploaded incrementally; no request approaches the 4 MiB bridge limit. */
export async function uploadPaintingImage(file: File, signal?: AbortSignal): Promise<FileEntry> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('请选择 PNG、JPEG 或 WebP 图片。')
  }
  if (file.size < 1 || file.size > IMAGE_SIZE_LIMIT) throw new Error('每张参考图需小于 20 MiB。')
  throwIfAborted(signal)
  const { uploadId } = await ipcApi.request('painting.file.upload.begin', { name: file.name, size: file.size })
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      throwIfAborted(signal)
      const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer())
      const result = await ipcApi.request('painting.file.upload.chunk', { uploadId, offset, data: encodeBytes(bytes) })
      if (result.offset !== offset + bytes.length) throw new Error('图片上传进度不一致，请重新上传。')
    }
    throwIfAborted(signal)
    const entry = await ipcApi.request('painting.file.upload.finish', { uploadId })
    if (signal?.aborted) {
      await ipcApi.request('painting.file.release', { fileId: entry.id }).catch(() => undefined)
      throwIfAborted(signal)
    }
    return entry
  } catch (error) {
    await ipcApi.request('painting.file.upload.abort', { uploadId }).catch(() => undefined)
    throw error
  }
}

export async function readPaintingBlob(
  fileId: string,
  options: { thumbnail?: boolean; signal?: AbortSignal } = {}
): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  let expectedSize: number | undefined
  let mime: string | undefined
  for (;;) {
    throwIfAborted(options.signal)
    const result = await ipcApi.request('painting.file.read', { fileId, offset, thumbnail: options.thumbnail })
    throwIfAborted(options.signal)
    if (
      !Number.isSafeInteger(result.size) ||
      result.size < 1 ||
      result.size > (options.thumbnail ? 1024 * 1024 : IMAGE_SIZE_LIMIT) ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(result.mime) ||
      (expectedSize !== undefined && expectedSize !== result.size) ||
      (mime !== undefined && mime !== result.mime)
    ) {
      throw new Error('图片文件信息无效。')
    }
    expectedSize = result.size
    mime = result.mime
    const binary = atob(result.data)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    if (
      bytes.length < 1 ||
      bytes.length > CHUNK_SIZE ||
      result.nextOffset !== offset + bytes.length ||
      result.nextOffset > result.size ||
      result.done !== (result.nextOffset === result.size)
    ) {
      throw new Error('图片分片不完整，请刷新后重试。')
    }
    chunks.push(bytes)
    offset = result.nextOffset
    if (result.done) return new Blob(chunks, { type: mime })
  }
}
