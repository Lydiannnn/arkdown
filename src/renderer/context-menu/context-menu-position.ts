export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export interface Rect extends Size {
  left: number
  top: number
  right: number
  bottom: number
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}

export function placeContextMenu(
  anchor: Point,
  menu: Size,
  viewport: Size,
  margin = 8,
): Point {
  return {
    x: clamp(anchor.x, margin, viewport.width - menu.width - margin),
    y: clamp(anchor.y, margin, viewport.height - menu.height - margin),
  }
}

export function placeSubmenu(
  parent: Rect,
  menu: Size,
  viewport: Size,
  margin = 8,
): Point & { side: 'left' | 'right' } {
  const roomOnRight = viewport.width - parent.right - margin
  const side = roomOnRight >= menu.width ? 'right' : 'left'
  const preferredX = side === 'right' ? parent.right : parent.left - menu.width
  return {
    x: clamp(preferredX, margin, viewport.width - menu.width - margin),
    y: clamp(parent.top, margin, viewport.height - menu.height - margin),
    side,
  }
}
