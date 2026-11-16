import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { HtmlArtifactPreviewSurface, getMaxPreviewHeight, routeWheelScroll } from '../HtmlArtifactPreviewSurface'

describe('desktop HTML preview boundary', () => {
  it.each([
    '<div>Static fragment</div>',
    '<!doctype html><html><body><h1>Document</h1></body></html>',
    '<script>parent.api.preference.set("owned",true)</script><h1>Active document</h1>',
    '<iframe src="https://example.invalid"></iframe><div onclick="run()">Content</div>'
  ])('keeps every preview script-less even when an old caller supplies consent (%s)', (html) => {
    render(<HtmlArtifactPreviewSurface html={html} title="fixture" authorized />)
    const frame = screen.getByTitle('fixture')
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin')
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts')
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'")
    expect(document.querySelector('webview')).toBeNull()
  })
  it('removes meta-refresh navigation before constructing the document', () => {
    render(
      <HtmlArtifactPreviewSurface
        html='<meta http-equiv="refresh" content="0;url=https://example.invalid"><h1>Safe</h1>'
        title="fixture"
        authorized={false}
      />
    )
    expect(screen.getByTitle('fixture').getAttribute('srcdoc')).not.toMatch(/http-equiv=["']refresh/i)
  })
  it('keeps preview height tied to the owning scroll container', () => {
    const parent = document.createElement('div'),
      viewport = document.createElement('div')
    parent.append(viewport)
    Object.defineProperty(parent, 'clientHeight', { value: 1000 })
    expect(getMaxPreviewHeight(viewport, parent)).toBe(720)
  })
  it('forwards wheel input only after the owning runtime declines it', () => {
    const viewport = document.createElement('div'),
      scroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
    const runtime = { scrollByWheel: vi.fn(() => true) }
    routeWheelScroll(viewport, runtime as Parameters<typeof routeWheelScroll>[1], 40)
    expect(scroll).not.toHaveBeenCalled()
    runtime.scrollByWheel.mockReturnValue(false)
    routeWheelScroll(viewport, runtime as Parameters<typeof routeWheelScroll>[1], 40)
    expect(scroll).toHaveBeenCalledOnce()
  })
})
