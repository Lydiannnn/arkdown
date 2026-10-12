import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { BackgroundSettings } from '../../shared/background-settings'
import {
  calculateShrinkOnlyCoverLayout,
  type BackgroundAnchor,
} from './background-layout'
import './background-image-layer.css'

export type ImageCoverage = 'covered' | 'undersized'

export interface BackgroundImageLayerProps {
  anchor: BackgroundAnchor
  imageUrl: string | null
  settings: BackgroundSettings
  onImageCoverageChange?: (coverage: ImageCoverage) => void
}

interface Size {
  width: number
  height: number
}

function sameSize(left: Size | null, right: Size): boolean {
  return left?.width === right.width && left.height === right.height
}

function opacityString(percent: number): string {
  return String(Math.round(percent) / 100)
}

export function BackgroundImageLayer({
  anchor,
  imageUrl,
  settings,
  onImageCoverageChange,
}: BackgroundImageLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<Size | null>(null)
  const [imageSize, setImageSize] = useState<Size | null>(null)

  useEffect(() => {
    setImageSize(null)
  }, [imageUrl])

  useEffect(() => {
    if (imageUrl === null) return
    const layer = layerRef.current
    if (!layer) return
    const measure = () => {
      const { width, height } = layer.getBoundingClientRect()
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
      const next = { width, height }
      setContainerSize((current) => sameSize(current, next) ? current : next)
    }
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measure)
    observer?.observe(layer)
    measure()
    return () => observer?.disconnect()
  }, [imageUrl])

  const layout = imageSize && containerSize
    ? calculateShrinkOnlyCoverLayout({
      containerWidth: containerSize.width,
      containerHeight: containerSize.height,
      imageWidth: imageSize.width,
      imageHeight: imageSize.height,
      anchor,
    })
    : null
  const coverage: ImageCoverage | null = imageSize && containerSize
    ? imageSize.width < containerSize.width || imageSize.height < containerSize.height
      ? 'undersized'
      : 'covered'
    : null

  useEffect(() => {
    if (coverage !== null) onImageCoverageChange?.(coverage)
  }, [coverage, onImageCoverageChange])

  if (imageUrl === null) return null

  const imageStyle: CSSProperties & Record<`--${string}`, string> = {
    opacity: settings.imageOpacityPercent / 100,
    visibility: layout === null ? 'hidden' : 'visible',
    ...(layout === null ? {} : {
      width: `${layout.width}px`,
      height: `${layout.height}px`,
      left: `${layout.left}px`,
      top: `${layout.top}px`,
    }),
    ...(settings.maskType === 'none' ? {} : {
      '--background-mask-opacity': opacityString(settings.maskOpacityPercent),
      '--background-mask-hidden-opacity': opacityString(100 - settings.maskStrengthPercent),
      '--background-mask-softness': `${100 - settings.maskTransitionPercent}%`,
      '--background-mask-band-start': `${50 - settings.maskTransitionPercent / 2}%`,
      '--background-mask-band-end': `${50 + settings.maskTransitionPercent / 2}%`,
    }),
  }

  return <div
    aria-hidden="true"
    className="background-image-layer"
    data-alignment={anchor}
    data-image-coverage={coverage ?? 'loading'}
    data-mask-type={settings.maskType}
    data-testid="background-image-layer"
    ref={layerRef}
    style={{ pointerEvents: 'none', userSelect: 'none' }}
  >
    <img
      alt=""
      className="background-image-layer__image"
      data-mask-type={settings.maskType}
      data-testid="background-image-layer-image"
      draggable={false}
      onLoad={(event) => {
        const image = event.currentTarget
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          setImageSize({ width: image.naturalWidth, height: image.naturalHeight })
        }
      }}
      src={imageUrl}
      style={imageStyle}
    />
  </div>
}
