export interface ViewerSize { width: number; height: number }
export const VIEWER_GUTTER = 24
export const MIN_READING_TEXT = 14

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export function clampViewerScale(scale: number, diagram: ViewerSize): number {
  const max = Math.min(64, 8_000_000 / Math.max(positive(diagram.width, 1), positive(diagram.height, 1)))
  return Math.max(0.00001, Math.min(max, positive(scale, 1)))
}

export function chooseViewerScales(diagram: ViewerSize, viewport: ViewerSize, smallestText: number | null) {
  const fit = clampViewerScale(Math.min(1,
    Math.max(1, positive(viewport.width, 800) - VIEWER_GUTTER * 2) / positive(diagram.width, 800),
    Math.max(1, positive(viewport.height, 600) - VIEWER_GUTTER * 2) / positive(diagram.height, 600)), diagram)
  const reading = smallestText !== null && Number.isFinite(smallestText) && smallestText > 0
    ? clampViewerScale(Math.max(fit, MIN_READING_TEXT / smallestText), diagram)
    : fit
  return { fit, reading, initial: reading }
}

export function zoomScrollPosition(scroll: number, anchor: number, viewport: number, natural: number, oldScale: number, newScale: number): number {
  const oldOffset = Math.max(VIEWER_GUTTER, (viewport - natural * oldScale) / 2)
  const newOffset = Math.max(VIEWER_GUTTER, (viewport - natural * newScale) / 2)
  const next = (scroll + anchor - oldOffset) / oldScale * newScale + newOffset - anchor
  return Math.max(0, Math.min(Math.max(0, natural * newScale + VIEWER_GUTTER * 2 - viewport), next))
}
