import { ImageOff, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { readPaintingBlob } from './paintingFiles'

/** Only visible history cards load their small native thumbnails. Full images load on preview. */
export function PaintingImage({
  fileId,
  alt,
  thumbnail = false,
  className = ''
}: {
  fileId: string
  alt: string
  thumbnail?: boolean
  className?: string
}) {
  const container = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(!thumbnail)
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!thumbnail || !container.current || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' }
    )
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [thumbnail])

  useEffect(() => {
    setUrl(undefined)
    setError(false)
    if (!visible) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    void readPaintingBlob(fileId, { thumbnail, signal: controller.signal })
      .then((blob) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true)
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [fileId, thumbnail, visible])

  return (
    <div ref={container} className={`flex items-center justify-center overflow-hidden bg-muted/40 ${className}`}>
      {url ? (
        <img
          data-testid="painting-image"
          data-file-id={fileId}
          src={url}
          alt={alt}
          className="h-full w-full object-contain"
          draggable={false}
        />
      ) : error ? (
        <span
          role="img"
          aria-label="图片不可用"
          className="flex flex-col items-center gap-2 text-xs text-muted-foreground">
          <ImageOff className="size-6" />
          图片不可用
        </span>
      ) : (
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="正在加载图片" />
      )}
    </div>
  )
}
