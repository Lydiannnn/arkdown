import { sanitizeWindowBounds, type WindowBounds } from './settings-store'

export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function intersects(bounds: Required<WindowBounds>, area: WorkArea): boolean {
  return (
    bounds.x < area.x + area.width &&
    bounds.x + bounds.width > area.x &&
    bounds.y < area.y + area.height &&
    bounds.y + bounds.height > area.y
  )
}

export function restoreWindowBounds(
  bounds: WindowBounds | undefined,
  workAreas: readonly WorkArea[],
): WindowBounds | undefined {
  const safeBounds = sanitizeWindowBounds(bounds)
  if (!safeBounds) return undefined

  const availableAreas = workAreas.filter(
    (area) => isFinitePositiveNumber(area.width) && isFinitePositiveNumber(area.height),
  )
  if (!availableAreas.some((area) => safeBounds.width <= area.width && safeBounds.height <= area.height)) {
    return undefined
  }

  const result: WindowBounds = { width: safeBounds.width, height: safeBounds.height }
  if (safeBounds.x === undefined || safeBounds.y === undefined) return result

  const positionedBounds: Required<WindowBounds> = { ...result, x: safeBounds.x, y: safeBounds.y }
  return availableAreas.some((area) => intersects(positionedBounds, area))
    ? positionedBounds
    : result
}

export function createDisplayBoundsNormalizer(
  getWorkAreas: () => readonly WorkArea[],
): (bounds: WindowBounds | undefined) => WindowBounds | undefined {
  return (bounds) => restoreWindowBounds(bounds, getWorkAreas())
}
