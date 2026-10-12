export const EDITOR_ZOOM_MIN = 70
export const EDITOR_ZOOM_MAX = 200
export const EDITOR_ZOOM_STEP = 10

export type EditorZoomAction = 'in' | 'out' | 'reset'

function normalizeEditorZoom(current: number): number {
  if (!Number.isFinite(current)) return 100
  const stepped = Math.round(current / EDITOR_ZOOM_STEP) * EDITOR_ZOOM_STEP
  return Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, stepped))
}

export function nextEditorZoom(current: number, action: EditorZoomAction): number {
  if (action === 'reset') return 100
  const normalized = normalizeEditorZoom(current)
  const delta = action === 'in' ? EDITOR_ZOOM_STEP : -EDITOR_ZOOM_STEP
  return Math.min(EDITOR_ZOOM_MAX, Math.max(EDITOR_ZOOM_MIN, normalized + delta))
}
