import type { StickyNoteWindowBounds } from '../../shared/sticky-notes'

type Rect = StickyNoteWindowBounds
export interface StickyNotePhysicalRect extends Rect {
  dpi: number
  style: number
  extendedStyle: number
  monitor: bigint
}

export interface StickyNoteBoundsAdapter {
  getPhysicalRect(): StickyNotePhysicalRect
  setPhysicalSize(expected: StickyNotePhysicalRect, size: Pick<Rect, 'width' | 'height'>): boolean
  screenToDipRect(rect: Rect): Rect
  getDisplay(): { id: number; scaleFactor: number }
}

export function validStickyNoteBounds(bounds: Rect | null | undefined): bounds is Rect {
  return bounds !== null && bounds !== undefined
    && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)
    && bounds.width >= 180 && bounds.height >= 180
    && bounds.width <= 10_000 && bounds.height <= 10_000
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function samePolicy(a: StickyNotePhysicalRect, b: StickyNotePhysicalRect): boolean {
  return a.dpi === b.dpi && a.style === b.style && a.extendedStyle === b.extendedStyle && a.monitor === b.monitor
}

export type StickyNoteBoundsRestoreStatus = 'exact' | 'invalid' | 'position-mismatch'
  | 'unavailable' | 'unsupported' | 'stale' | 'native-rejected' | 'inexact'

// Runs only during hidden construction. Persistence and later user resizes keep
// reading live bounds; no saved-size override or resize listener is installed.
export function restoreStickyNoteWindowBounds(
  window: { getBounds(): Rect; setBounds(bounds: Rect): void },
  bounds: Rect | null | undefined,
  adapter?: StickyNoteBoundsAdapter,
): StickyNoteBoundsRestoreStatus {
  if (!validStickyNoteBounds(bounds)) return 'invalid'
  if (sameRect(window.getBounds(), bounds)) return 'exact'
  // Construction can compound rounding while centering and positioning. Replay
  // the original request once before measuring the final HWND frame conversion.
  window.setBounds({ ...bounds })
  const measured = window.getBounds()
  if (sameRect(measured, bounds)) return 'exact'
  if (measured.x !== bounds.x || measured.y !== bounds.y) return 'position-mismatch'
  if (!adapter) return 'unavailable'

  const display = adapter.getDisplay()
  const physical = adapter.getPhysicalRect()
  const scale = display.scaleFactor
  const radius = Math.ceil(scale) + 2
  // Bound computation rather than assuming any DPI can be inverted. Every
  // accepted candidate must still have an exact screenToDipRect inverse.
  if (!Number.isFinite(scale) || scale <= 0 || radius > 16
    || !Number.isInteger(physical.dpi) || physical.dpi <= 0 || Math.fround(physical.dpi / 96) !== Math.fround(scale)) return 'unsupported'
  const raw = adapter.screenToDipRect(physical)
  const desiredRaw = {
    x: raw.x, y: raw.y,
    width: raw.width + bounds.width - measured.width,
    height: raw.height + bounds.height - measured.height,
  }
  const size = { width: physical.width, height: physical.height }
  for (const axis of ['width', 'height'] as const) {
    if (measured[axis] === bounds[axis]) continue
    const center = physical[axis] + Math.round((bounds[axis] - measured[axis]) * scale)
    let found = false
    for (let step = 0; step <= radius * 2; step++) {
      const offset = step === 0 ? 0 : Math.ceil(step / 2) * (step % 2 ? -1 : 1)
      const candidate = center + offset
      if (!Number.isSafeInteger(candidate) || candidate <= 0 || candidate > 0x7fffffff) continue
      const converted = adapter.screenToDipRect({ ...physical, [axis]: candidate })
      if (converted.x === desiredRaw.x && converted.y === desiredRaw.y && converted[axis] === desiredRaw[axis]) {
        size[axis] = candidate
        found = true
        break
      }
    }
    if (!found) return 'unsupported'
  }
  if (!sameRect(adapter.screenToDipRect({ ...physical, ...size }), desiredRaw)) return 'unsupported'
  const currentDisplay = adapter.getDisplay()
  const currentPhysical = adapter.getPhysicalRect()
  if (currentDisplay.id !== display.id || currentDisplay.scaleFactor !== scale
    || !sameRect(window.getBounds(), measured) || !sameRect(currentPhysical, physical)
    || !samePolicy(currentPhysical, physical)) return 'stale'
  if (!adapter.setPhysicalSize(physical, size)) return 'native-rejected'

  // At most one native resize. Respect OS minimum constraints and report any
  // inexact readback, frame/DPI change or display transition without retrying.
  const after = window.getBounds()
  const afterPhysical = adapter.getPhysicalRect()
  const afterDisplay = adapter.getDisplay()
  const afterRaw = adapter.screenToDipRect(afterPhysical)
  if (!samePolicy(afterPhysical, physical) || afterDisplay.id !== display.id
    || afterDisplay.scaleFactor !== scale || afterPhysical.x !== physical.x || afterPhysical.y !== physical.y
    || after.x - afterRaw.x !== measured.x - raw.x || after.y - afterRaw.y !== measured.y - raw.y
    || afterRaw.width - after.width !== raw.width - measured.width
    || afterRaw.height - after.height !== raw.height - measured.height) return 'stale'
  return sameRect(after, bounds) ? 'exact' : 'inexact'
}
