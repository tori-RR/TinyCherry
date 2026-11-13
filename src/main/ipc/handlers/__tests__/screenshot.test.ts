import { beforeEach, describe, expect, it, vi } from 'vitest'

import { screenshotRequestSchemas } from '@shared/ipc/schemas/screenshot'

const { appGetMock } = vi.hoisted(() => ({ appGetMock: vi.fn() }))
vi.mock('@application', () => ({ application: { get: appGetMock } }))

import { IpcRouter } from '../../IpcRouter'
import { screenshotHandlers } from '../screenshot'

const overlayService = {
  isSessionOverlay: vi.fn(),
  isActiveOverlay: vi.fn(),
  isActiveCapture: vi.fn(),
  startCapture: vi.fn(),
  commit: vi.fn(),
  copy: vi.fn(),
  save: vi.fn<(result: unknown) => Promise<void>>(async () => {}),
  submitResult: vi.fn(),
  dismiss: vi.fn(),
  markOverlayActive: vi.fn(),
  focusOverlay: vi.fn(),
  markOverlayReady: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  overlayService.isActiveCapture.mockImplementation(
    (_windowId: string, mediaId: string) => overlayService.isActiveOverlay() && mediaId === 'media-1'
  )
  appGetMock.mockImplementation((name: string) => {
    if (name === 'ScreenshotOverlayService') return overlayService
    throw new Error(`Unexpected application.get(${name})`)
  })
})

const ctx = (senderId: string | null) => ({ senderId })
const captureResult = { mediaId: 'media-1', pngBytes: new Uint8Array([137, 80, 78, 71]) }

/** Every route that consults a predicate, with the input its schema declares. */
const guardedRoutes = {
  'screenshot.commit': () => screenshotHandlers['screenshot.commit'](captureResult, ctx('overlay-a')),
  'screenshot.copy': () => screenshotHandlers['screenshot.copy'](captureResult, ctx('overlay-a')),
  'screenshot.save': () => screenshotHandlers['screenshot.save'](captureResult, ctx('overlay-a')),
  'screenshot.cancel': () => screenshotHandlers['screenshot.cancel'](undefined, ctx('overlay-a')),
  'screenshot.overlay_active': () => screenshotHandlers['screenshot.overlay_active'](undefined, ctx('overlay-a')),
  'screenshot.overlay_focus': () => screenshotHandlers['screenshot.overlay_focus'](undefined, ctx('overlay-a')),
  'screenshot.overlay_ready': () =>
    screenshotHandlers['screenshot.overlay_ready']({ mediaId: 'media-1' }, ctx('overlay-a'))
}

/** Everything the routes delegate to, so "nothing happened" is checkable in one go. */
const expectNoDelegation = () => {
  expect(overlayService.commit).not.toHaveBeenCalled()
  expect(overlayService.copy).not.toHaveBeenCalled()
  expect(overlayService.save).not.toHaveBeenCalled()
  expect(overlayService.dismiss).not.toHaveBeenCalled()
  expect(overlayService.markOverlayActive).not.toHaveBeenCalled()
  expect(overlayService.focusOverlay).not.toHaveBeenCalled()
  expect(overlayService.markOverlayReady).not.toHaveBeenCalled()
}

describe('screenshotHandlers', () => {
  it.each(['commit', 'copy', 'save', 'submit_result'] as const)(
    'requires the current capture identity before producing a %s result',
    async (action) => {
      const route = `screenshot.${action}` as const
      const router = new IpcRouter(screenshotRequestSchemas, screenshotHandlers)
      const produced: unknown[] = []
      const method = action === 'submit_result' ? 'submitResult' : action
      overlayService[method].mockImplementation(async (result: unknown) => {
        produced.push(result)
      })
      overlayService.isActiveCapture.mockImplementation(
        (windowId: string, mediaId: string) => windowId === 'overlay-a' && mediaId === 'media-2'
      )
      const payload = { ...captureResult, text: 'message' }
      for (const senderId of [null, 'another-window', 'overlay-a']) {
        await router.dispatch(route, payload, ctx(senderId))
      }
      expect(produced).toEqual([])
      const current = { ...payload, mediaId: 'media-2' }
      await router.dispatch(route, current, ctx('another-window'))
      expect(produced).toEqual([])
      await router.dispatch(route, current, ctx('overlay-a'))
      expect(produced).toEqual([
        action === 'submit_result'
          ? { pngBytes: captureResult.pngBytes, text: 'message' }
          : { pngBytes: captureResult.pngBytes }
      ])
      await expect(
        router.dispatch(route, { pngBytes: captureResult.pngBytes, text: 'message' }, ctx('overlay-a'))
      ).rejects.toThrow('Invalid input')
      await expect(router.dispatch(route, { ...payload, mediaId: '' }, ctx('overlay-a'))).rejects.toThrow(
        'Invalid input'
      )
      expect(produced).toHaveLength(1)
    }
  )

  describe('active scope', () => {
    beforeEach(() => {
      // A session overlay the user has moved away from: the one state that separates the two tiers,
      // and the one where display A's delayed request would copy or save an abandoned selection.
      overlayService.isSessionOverlay.mockReturnValue(true)
      overlayService.isActiveOverlay.mockReturnValue(false)
    })

    it('commit refuses an overlay that is no longer the active one', async () => {
      await guardedRoutes['screenshot.commit']()
      expect(overlayService.commit).not.toHaveBeenCalled()
    })

    it('copy refuses an overlay that is no longer the active one', async () => {
      await guardedRoutes['screenshot.copy']()
      expect(overlayService.copy).not.toHaveBeenCalled()
    })

    it('save refuses an overlay that is no longer the active one', async () => {
      await guardedRoutes['screenshot.save']()
      expect(overlayService.save).not.toHaveBeenCalled()
    })

    it('cannot send a stale overlay image to chat', async () => {
      await screenshotHandlers['screenshot.submit_result']({ ...captureResult, text: 'message' }, ctx('overlay-a'))
      expect(overlayService.submitResult).not.toHaveBeenCalled()
    })
  })

  describe('session scope', () => {
    beforeEach(() => {
      // Esc, hover, and the first-frame handshake all legitimately arrive from an
      // overlay that is not the active one; active scope would silently drop them.
      overlayService.isSessionOverlay.mockReturnValue(true)
      overlayService.isActiveOverlay.mockReturnValue(false)
    })

    it('cancel ends the session from any overlay, not just the active one', async () => {
      await guardedRoutes['screenshot.cancel']()
      expect(overlayService.dismiss).toHaveBeenCalledOnce()
    })

    it('overlay_active promotes a non-active overlay — it is the call that changes which one is active', async () => {
      await guardedRoutes['screenshot.overlay_active']()
      expect(overlayService.markOverlayActive).toHaveBeenCalledWith('overlay-a')
    })

    it('overlay_focus redirects the keyboard from a merely hovered overlay', async () => {
      await guardedRoutes['screenshot.overlay_focus']()
      expect(overlayService.focusOverlay).toHaveBeenCalledWith('overlay-a')
    })

    it('overlay_ready reveals an overlay that never became the active one', async () => {
      await guardedRoutes['screenshot.overlay_ready']()
      expect(overlayService.markOverlayReady).toHaveBeenCalledWith('overlay-a', 'media-1')
    })
  })

  describe('the active overlay itself', () => {
    beforeEach(() => {
      overlayService.isSessionOverlay.mockReturnValue(true)
      overlayService.isActiveOverlay.mockReturnValue(true)
    })

    it('forwards commit and save', async () => {
      await guardedRoutes['screenshot.commit']()
      await guardedRoutes['screenshot.copy']()
      await guardedRoutes['screenshot.save']()

      expect(overlayService.commit).toHaveBeenCalledWith({ pngBytes: captureResult.pngBytes })
      expect(overlayService.copy).toHaveBeenCalledWith({ pngBytes: captureResult.pngBytes })
      expect(overlayService.save).toHaveBeenCalledWith({ pngBytes: captureResult.pngBytes })
    })
  })

  describe('a window outside the session', () => {
    beforeEach(() => {
      overlayService.isSessionOverlay.mockReturnValue(false)
      overlayService.isActiveOverlay.mockReturnValue(false)
    })

    it('gets nothing from any guarded route', async () => {
      for (const invoke of Object.values(guardedRoutes)) await invoke()

      expectNoDelegation()
    })

    it('can still start a capture — that entry point is only sender-scoped', async () => {
      // An in-app control is not an overlay and no session exists yet, so any session
      // predicate here would make the feature unreachable from inside the app.
      await screenshotHandlers['screenshot.capture'](undefined, ctx('main-window'))

      expect(overlayService.startCapture).toHaveBeenCalledOnce()
    })

    it('reports a failed capture to the caller instead of dropping it', async () => {
      overlayService.startCapture.mockRejectedValueOnce(new Error('capture backend is gone'))

      // startCapture is asynchronous: a handler that calls it without awaiting answers
      // "started" while the rejection becomes an unhandled promise nobody sees.
      await expect(screenshotHandlers['screenshot.capture'](undefined, ctx('main-window'))).rejects.toThrow(
        'capture backend is gone'
      )
    })
  })

  describe('a sender that is not a managed window', () => {
    beforeEach(() => {
      // Both predicates accept, so only the senderId check can refuse these.
      overlayService.isSessionOverlay.mockReturnValue(true)
      overlayService.isActiveOverlay.mockReturnValue(true)
    })

    it('gets nothing from any guarded route', async () => {
      await screenshotHandlers['screenshot.commit'](captureResult, ctx(null))
      await screenshotHandlers['screenshot.copy'](captureResult, ctx(null))
      await screenshotHandlers['screenshot.save'](captureResult, ctx(null))
      await screenshotHandlers['screenshot.cancel'](undefined, ctx(null))
      await screenshotHandlers['screenshot.overlay_active'](undefined, ctx(null))
      await screenshotHandlers['screenshot.overlay_focus'](undefined, ctx(null))
      await screenshotHandlers['screenshot.overlay_ready']({ mediaId: 'media-1' }, ctx(null))

      expectNoDelegation()
    })
  })
})
