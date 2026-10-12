import type { BackgroundImageAlignment } from '../../shared/background-settings'

export type BackgroundAnchor = BackgroundImageAlignment

export interface ShrinkOnlyCoverLayoutInput {
  containerWidth: number
  containerHeight: number
  imageWidth: number
  imageHeight: number
  anchor: BackgroundAnchor
}

export interface ShrinkOnlyCoverLayout {
  scale: number
  width: number
  height: number
  left: number
  top: number
}

export function calculateShrinkOnlyCoverLayout({
  containerWidth,
  containerHeight,
  imageWidth,
  imageHeight,
  anchor,
}: ShrinkOnlyCoverLayoutInput): ShrinkOnlyCoverLayout {
  const scale = Math.min(1, Math.max(
    containerWidth / imageWidth,
    containerHeight / imageHeight,
  ))
  const width = imageWidth * scale
  const height = imageHeight * scale
  const horizontal = anchor === 'center'
    ? (containerWidth - width) / 2
    : anchor.startsWith('right')
      ? containerWidth - width
      : 0
  const vertical = anchor === 'center'
    ? (containerHeight - height) / 2
    : anchor.endsWith('bottom')
      ? containerHeight - height
      : 0

  return {
    scale,
    width,
    height,
    left: horizontal,
    top: vertical,
  }
}
