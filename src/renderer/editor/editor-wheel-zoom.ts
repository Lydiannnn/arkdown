import type { EditorZoomAction } from './editor-zoom'

export interface EditorWheelZoomOptions {
  now?: () => number
  minimumIntervalMs?: number
}

export function createEditorWheelZoomHandler(
  onZoom: (action: Extract<EditorZoomAction, 'in' | 'out'>) => void,
  options: EditorWheelZoomOptions = {},
): (event: WheelEvent) => void {
  const now = options.now ?? (() => performance.now())
  const minimumIntervalMs = options.minimumIntervalMs ?? 50
  let lastDirection: Extract<EditorZoomAction, 'in' | 'out'> | undefined
  let lastActivation = Number.NEGATIVE_INFINITY

  return (event) => {
    if (!event.ctrlKey || event.deltaY === 0 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
    event.preventDefault()
    const direction = event.deltaY < 0 ? 'in' : 'out'
    const timestamp = now()
    if (direction === lastDirection && timestamp - lastActivation < minimumIntervalMs) return
    lastDirection = direction
    lastActivation = timestamp
    onZoom(direction)
  }
}
