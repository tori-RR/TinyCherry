import { beforeEach, expect, it, vi } from 'vitest'

import { toast } from '@renderer/services/toast'

import { handlePaste, shouldHandleClipboardFiles } from '../pasteHandling'
beforeEach(() => vi.clearAllMocks())
function clipboard(text: string, files: File[] = []) {
  return {
    clipboardData: { files, getData: (kind: string) => (kind === 'text/plain' ? text : '') },
    preventDefault: vi.fn()
  } as unknown as ClipboardEvent
}
it.each(['plain text', 'x'.repeat(20000)])(
  'preserves text without creating implicit attachments (%s)',
  async (text) => {
    const event = clipboard(text),
      setFiles = vi.fn()
    expect(await handlePaste(event, ['.txt'], setFiles, true, 10)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setFiles).not.toHaveBeenCalled()
    expect(window.api.file.createTempFile).not.toHaveBeenCalled()
  }
)
it('rejects file-only paste with a pending-feature message and no imported files', async () => {
  const event = clipboard('', [new File(['synthetic'], 'fixture.txt')]),
    setFiles = vi.fn()
  expect(shouldHandleClipboardFiles(event.clipboardData, ['.txt'])).toBe(false)
  expect(await handlePaste(event, ['.txt'], setFiles, false, 10, undefined, (key) => key)).toBe(true)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(setFiles).not.toHaveBeenCalled()
  expect(toast.info).toHaveBeenCalledWith('desktop.feature_unavailable')
  expect(window.api.file.get).not.toHaveBeenCalled()
})
