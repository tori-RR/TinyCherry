import { memo, type RefObject, useMemo } from 'react'

import {
  clampForwardedWheelDelta,
  type ScrollRuntimeBoundary
} from '@renderer/components/chat/messages/list/ScrollOwnershipContext'
import { htmlArtifactRequiresUserConsent, stripMetaRefresh } from '@renderer/utils/htmlArtifact'

import HtmlPreviewFrame, { HTML_PREVIEW_RESTRICTED_CSP } from './HtmlPreviewFrame'
export const SCROLL_ACTIVATION_DELAY_MS = 300
export const htmlArtifactPreviewRequiresInteractive = htmlArtifactRequiresUserConsent
export const StaticHtmlPreview = memo(function StaticHtmlPreview({
  html,
  title,
  zoom,
  iframeRef,
  emptyText
}: {
  html: string
  title: string
  zoom: number
  iframeRef?: RefObject<HTMLIFrameElement | null>
  emptyText?: string
}) {
  const zoomScale = zoom / 100
  // The static tier is a preview, never navigation: meta-refresh survives the
  // script-less sandbox (navigation needs no JS) and CSP cannot govern navigations.
  const staticHtml = useMemo(() => stripMetaRefresh(html), [html])
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        className="origin-top-left"
        style={{
          width: `${100 / zoomScale}%`,
          height: `${100 / zoomScale}%`,
          transform: `scale(${zoomScale})`
        }}>
        <HtmlPreviewFrame
          html={staticHtml}
          title={title}
          iframeRef={iframeRef}
          sandbox="allow-same-origin"
          csp={HTML_PREVIEW_RESTRICTED_CSP}
          stableScrollbarGutter
          emptyText={emptyText}
        />
      </div>
    </div>
  )
})
/** Interactive HTML execution is pending; all content stays in the script-less frame. */
export const HtmlArtifactPreviewSurface = memo(function HtmlArtifactPreviewSurface({
  html,
  title,
  zoom = 100,
  iframeRef,
  emptyText
}: {
  html: string
  title: string
  authorized: boolean
  zoom?: number
  iframeRef?: RefObject<HTMLIFrameElement | null>
  emptyText?: string
  forwardBoundaryWheel?: boolean
  onHeightChange?: (height: number) => void
}) {
  return <StaticHtmlPreview html={html} title={title} zoom={zoom} iframeRef={iframeRef} emptyText={emptyText} />
})
export default HtmlArtifactPreviewSurface
export function routeWheelScroll(viewport: HTMLElement, runtime: ScrollRuntimeBoundary, deltaY: number): void {
  if (!runtime.scrollByWheel(deltaY))
    viewport.ownerDocument.defaultView?.scrollBy({ top: clampForwardedWheelDelta(deltaY) })
}
export function getMaxPreviewHeight(viewport: HTMLElement, container: HTMLElement | null): number {
  const height = container?.contains(viewport)
    ? Math.max(container.clientHeight, container.getBoundingClientRect().height)
    : 0
  return Math.max(1, Math.floor((height || viewport.ownerDocument.defaultView?.innerHeight || 0) * 0.72))
}
