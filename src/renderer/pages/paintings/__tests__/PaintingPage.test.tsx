import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Activity } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  request: vi.fn(),
  upload: vi.fn(),
  refresh: vi.fn().mockResolvedValue(undefined),
  jobs: [] as Array<Record<string, unknown>>,
  paintings: [] as Array<Record<string, unknown>>,
  models: [
    {
      id: 'paint::gpt-image-1',
      name: 'gpt-image-1',
      providerId: 'paint',
      providerName: 'Test',
      protocol: 'openai',
      canEdit: true,
      maxInputs: 4,
      maxImages: 4,
      sizes: ['1024x1024'],
      qualities: ['high'],
      formats: ['png'],
      aspectRatios: []
    }
  ]
}))
vi.mock('@renderer/ipc', () => ({ ipcApi: { request: state.request } }))
vi.mock('swr', () => ({
  default: (key: string) => ({ data: key === 'painting.models' ? state.models : state.jobs, mutate: state.refresh })
}))
vi.mock('@data/hooks/usePreference', () => ({
  usePreference: (key: string) => [key.endsWith('model_id') ? 'paint::gpt-image-1' : 'paint', state.refresh]
}))
vi.mock('@data/hooks/useDataChange', () => ({ useDataChange: vi.fn() }))
vi.mock('@data/hooks/useDataApi', () => ({
  useInfiniteQuery: () => ({
    pages: [{ items: state.paintings, total: state.paintings.length }],
    isLoading: false,
    isRefreshing: false,
    hasNext: false,
    refresh: state.refresh
  }),
  useMutation: () => ({ trigger: state.refresh, isLoading: false })
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/settings/provider">{children}</a>
}))
vi.mock('@cherrystudio/ui', () => ({
  Button: ({ children, loading, disabled, ...props }: any) => (
    <button disabled={disabled || loading} {...props}>
      {children}
    </button>
  ),
  Textarea: { Input: (props: any) => <textarea {...props} /> },
  ConfirmDialog: () => null,
  Dialog: () => null,
  DialogContent: () => null,
  DialogDescription: () => null,
  DialogHeader: () => null,
  DialogTitle: () => null
}))
vi.mock('../PaintingImage', () => ({ PaintingImage: ({ alt }: { alt: string }) => <img alt={alt} /> }))
vi.mock('../paintingFiles', () => ({ uploadPaintingImage: state.upload }))
import PaintingPage from '../PaintingPage'

beforeEach(() => {
  state.request.mockReset()
  state.refresh.mockClear()
  state.upload.mockReset().mockResolvedValue({ id: 'draft-reference' })
  state.jobs = []
  state.paintings = []
  localStorage.clear()
})

it('confirms an uncertain submission using the same idempotency token and payload', async () => {
  state.request
    .mockRejectedValueOnce(new Error('EVOSTACK_REQUEST_TIMEOUT'))
    .mockResolvedValueOnce({ status: 'running' })
  render(<PaintingPage />)
  fireEvent.change(screen.getByTestId('painting-prompt'), { target: { value: 'A cherry blossom' } })
  fireEvent.click(screen.getByTestId('painting-generate'))
  await screen.findByText('确认提交状态')
  const first = state.request.mock.calls[0][1]
  expect(JSON.parse(localStorage.getItem('tinycherry.paintings.pending-request') ?? 'null').requestId).toBe(
    first.requestId
  )
  fireEvent.click(screen.getByTestId('painting-generate'))
  await waitFor(() => expect(state.request).toHaveBeenCalledTimes(2))
  expect(state.request.mock.calls[1]).toEqual(['painting.generate.start', first])
  await waitFor(() => expect(localStorage.getItem('tinycherry.paintings.pending-request')).toBeNull())
})

it('cancels the actual persisted running job from the workbench', async () => {
  state.jobs = [{ id: 'running-request', status: 'running', prompt: 'Slow image' }]
  state.request.mockResolvedValue({ status: 'cancelled' })
  render(<PaintingPage />)
  fireEvent.click(screen.getByTestId('painting-cancel'))
  await waitFor(() =>
    expect(state.request).toHaveBeenCalledWith('painting.generate.abort', { requestId: 'running-request' })
  )
  expect(state.refresh).toHaveBeenCalled()
})

it('does not report export success when the native save dialog is cancelled', async () => {
  state.paintings = [
    {
      id: 'receipt',
      providerId: 'paint',
      modelId: 'gpt-image-1',
      prompt: 'Saved cherry',
      createdAt: '2026-01-01T00:00:00Z',
      files: { input: [], output: ['image-1'] }
    }
  ]
  state.request.mockResolvedValue({ saved: false })
  render(<PaintingPage />)
  fireEvent.click(screen.getByTestId('painting-export'))
  await waitFor(() => expect(state.request).toHaveBeenCalledWith('painting.file.export', { fileId: 'image-1' }))
  expect(screen.queryByText('图片已保存。')).toBeNull()
})

it('retains draft references across Activity tab hiding and showing', async () => {
  const page = (mode: 'visible' | 'hidden') => (
    <Activity mode={mode}>
      <PaintingPage />
    </Activity>
  )
  const view = render(page('visible'))
  fireEvent.change(view.container.querySelector('input[type="file"]')!, {
    target: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] }
  })
  await screen.findByAltText('reference.png')
  fireEvent.change(screen.getByLabelText(/^尺寸/), { target: { value: '1024x1024' } })
  fireEvent.change(screen.getByLabelText(/^质量/), { target: { value: 'high' } })
  fireEvent.change(screen.getByLabelText(/^张数/), { target: { value: '3' } })
  view.rerender(page('hidden'))
  view.rerender(page('visible'))
  await screen.findByAltText('reference.png')
  expect(screen.getByLabelText(/^尺寸/)).toHaveValue('1024x1024')
  expect(screen.getByLabelText(/^质量/)).toHaveValue('high')
  expect(screen.getByLabelText(/^张数/)).toHaveValue('3')
  expect(state.request.mock.calls.some(([route]) => route === 'painting.file.release')).toBe(false)
  view.unmount()
  expect(state.request.mock.calls.some(([route]) => route === 'painting.file.release')).toBe(false)
})

it('keeps unconfirmed start references on unmount and restores the same request for confirmation', async () => {
  state.paintings = [
    {
      id: 'old-receipt',
      providerId: 'paint',
      modelId: 'gpt-image-1',
      prompt: 'An older draft',
      createdAt: '2026-01-01T00:00:00Z',
      files: { input: ['other-reference'], output: [] }
    }
  ]
  let rejectFirst!: (error: Error) => void
  state.request.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectFirst = reject
      })
  )
  const first = render(<PaintingPage />)
  fireEvent.change(first.container.querySelector('input[type="file"]')!, {
    target: { files: [new File(['image'], 'reference.png', { type: 'image/png' })] }
  })
  await screen.findByAltText('reference.png')
  fireEvent.change(screen.getByTestId('painting-prompt'), { target: { value: 'Use my reference image' } })
  fireEvent.click(screen.getByTestId('painting-generate'))
  await waitFor(() => expect(state.request).toHaveBeenCalledTimes(1))
  expect(screen.getByRole('button', { name: '复用' })).toBeDisabled()
  const submitted = state.request.mock.calls[0][1]
  expect(submitted.inputFileIds).toEqual(['draft-reference'])
  first.unmount()
  expect(state.request.mock.calls.some(([route]) => route === 'painting.file.release')).toBe(false)
  await act(async () => rejectFirst(new Error('EVOSTACK_REQUEST_TIMEOUT')))

  state.request.mockResolvedValue({ status: 'running' })
  render(<PaintingPage />)
  fireEvent.click(screen.getByTestId('painting-generate'))
  await waitFor(() => expect(state.request).toHaveBeenCalledTimes(2))
  expect(state.request.mock.calls[1]).toEqual(['painting.generate.start', submitted])
  expect(state.request.mock.calls.some(([route]) => route === 'painting.file.release')).toBe(false)
  await waitFor(() => expect(localStorage.getItem('tinycherry.paintings.pending-request')).toBeNull())
})
