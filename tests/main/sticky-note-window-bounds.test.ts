import { describe, expect, it, vi } from 'vitest'
import { restoreStickyNoteWindowBounds } from '../../src/main/sticky-notes/sticky-note-window-bounds'

type Rect = { x: number; y: number; width: number; height: number }

// Reproduce the enclosing-rectangle mapping seen in Electron 43.2 at 150%.
// Frame edges here are observed fixture values, not production constants.
function nonlinearWindow(target: Rect, scale = 1.5) {
  const origin = { x: Math.ceil(153 * scale), y: Math.ceil(180 * scale) }
  let physical = { ...origin, width: 655, height: 464 }
  const screenToDipRect = vi.fn((rect: Rect) => ({
    x: Math.floor(rect.x / scale), y: Math.floor(rect.y / scale),
    width: Math.ceil((rect.x + rect.width) / scale) - Math.floor(rect.x / scale),
    height: Math.ceil((rect.y + rect.height) / scale) - Math.floor(rect.y / scale),
  }))
  const getBounds = () => {
    const raw = screenToDipRect(physical)
    return { x: raw.x + 7, y: raw.y, width: raw.width - 14, height: raw.height - 7 }
  }
  const window = {
    getBounds,
    setBounds: vi.fn((rect: Rect) => {
      physical = {
        ...origin,
        width: Math.ceil((rect.width + 14) * scale),
        height: Math.ceil((rect.height + 7) * scale),
      }
    }),
  }
  const adapter = {
    screenToDipRect,
    getDisplay: vi.fn(() => ({ id: 1, scaleFactor: scale })),
    getPhysicalRect: vi.fn(() => ({ ...physical, dpi: Math.round(scale * 96), style: 1, extendedStyle: 2, monitor: 1n })),
    setPhysicalSize: vi.fn((_expected: unknown, size: { width: number; height: number }) => {
      physical = { ...physical, ...size }
      return true
    }),
  }
  return { target, window, adapter }
}

describe('physical sticky-note bounds restoration', () => {
  it.each([[420, 300], [422, 302]])('restores the nonlinear %i x %i readback with only one physical adjustment', (width, height) => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width, height })
    restoreStickyNoteWindowBounds(window, target, adapter)
    expect(window.getBounds()).toEqual(target)
    expect(window.setBounds).toHaveBeenCalledExactlyOnceWith(target)
    expect(adapter.setPhysicalSize).toHaveBeenCalledTimes(1)
  })

  it.each([[428, 301], [421, 301], [423, 302], [180, 301], [10_000, 10_000]])('finds reachable %i x %i without integer-DIP correction', (width, height) => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width, height })
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('exact')
    expect(window.getBounds()).toEqual(target)
    expect(window.setBounds).toHaveBeenCalledTimes(1)
    expect(adapter.setPhysicalSize).toHaveBeenCalledTimes(1)
  })

  it('preserves the physical size of an already accurate axis', () => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 428, height: 301 })
    restoreStickyNoteWindowBounds(window, target, adapter)
    const [before, requested] = adapter.setPhysicalSize.mock.calls[0]!
    expect(requested.height).toBe((before as { height: number }).height)
  })

  it('does nothing when the constructor or the original replay is exact', () => {
    const bounds = { x: -160, y: -180, width: 420, height: 300 }
    const adapter = nonlinearWindow(bounds).adapter
    let actual = { ...bounds }
    const window = { getBounds: () => actual, setBounds: vi.fn((rect: Rect) => { actual = rect }) }
    expect(restoreStickyNoteWindowBounds(window, bounds, adapter)).toBe('exact')
    expect(window.setBounds).not.toHaveBeenCalled()
    actual = { ...bounds, width: 423 }
    expect(restoreStickyNoteWindowBounds(window, bounds, adapter)).toBe('exact')
    expect(window.setBounds).toHaveBeenCalledTimes(1)
    expect(adapter.getPhysicalRect).not.toHaveBeenCalled()
  })

  it.each([179, 10_001, Number.NaN, Infinity, 420.5])('rejects invalid persisted dimensions: %s', width => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width, height: 300 })
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('invalid')
    expect(window.setBounds).not.toHaveBeenCalled()
    expect(adapter.setPhysicalSize).not.toHaveBeenCalled()
  })

  it('does not hide a position mismatch with a size-only correction', () => {
    const { target, window, adapter } = nonlinearWindow({ x: 171, y: 191, width: 420, height: 300 })
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('position-mismatch')
    expect(adapter.setPhysicalSize).not.toHaveBeenCalled()
    expect(window.getBounds()).toMatchObject({ x: 160, y: 180 })
  })

  it('reports missing physical support without repeating an integer-DIP request', () => {
    const { target, window } = nonlinearWindow({ x: 160, y: 180, width: 420, height: 300 })
    expect(restoreStickyNoteWindowBounds(window, target)).toBe('unavailable')
    expect(window.setBounds).toHaveBeenCalledTimes(1)
  })

  it.each([0, -1, Infinity, Number.NaN, 15, 2])('rejects unsupported scale without native writes: %s', scaleFactor => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 420, height: 300 })
    adapter.getDisplay.mockReturnValue({ id: 1, scaleFactor })
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('unsupported')
    expect(adapter.setPhysicalSize).not.toHaveBeenCalled()
  })

  it('accepts Chromium float scale for the same custom window DPI', () => {
    const scale = Math.fround(110 / 96)
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 420, height: 300 }, scale)
    expect(adapter.getPhysicalRect().dpi).toBe(110)
    expect(scale).not.toBe(110 / 96)
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('exact')
    expect(window.getBounds()).toEqual(target)
    expect(adapter.setPhysicalSize).toHaveBeenCalledTimes(1)
  })

  it('does not resize when no finite candidate maps exactly', () => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 420, height: 300 })
    const conversion = adapter.screenToDipRect
    const impossible = { ...adapter, screenToDipRect: vi.fn((_rect: Rect) => conversion({ x: 230, y: 270, width: 652, height: 462 })) }
    expect(restoreStickyNoteWindowBounds(window, target, impossible)).toBe('unsupported')
    expect(impossible.screenToDipRect.mock.calls.length).toBeLessThanOrEqual(20)
    expect(adapter.setPhysicalSize).not.toHaveBeenCalled()
  })

  it.each(['position', 'dpi', 'style', 'extendedStyle', 'monitor', 'display', 'scale'] as const)('rejects a changed %s snapshot before native mutation', change => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 420, height: 300 })
    const read = adapter.getPhysicalRect.getMockImplementation()!
    adapter.getPhysicalRect.mockImplementationOnce(read).mockImplementation(() => {
      const value = read()
      if (change === 'position') value.x++
      if (change === 'dpi') value.dpi = 192
      if (change === 'style') value.style++
      if (change === 'extendedStyle') value.extendedStyle++
      if (change === 'monitor') value.monitor = 2n
      return value
    })
    adapter.getDisplay.mockReturnValueOnce({ id: 1, scaleFactor: 1.5 }).mockReturnValue({
      id: change === 'display' ? 2 : 1, scaleFactor: change === 'scale' ? 2 : 1.5,
    })
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('stale')
    expect(adapter.setPhysicalSize).not.toHaveBeenCalled()
  })

  it('reports a native stale/monitor guard rejection and never retries', () => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 420, height: 300 })
    adapter.setPhysicalSize.mockReturnValue(false)
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('native-rejected')
    expect(adapter.setPhysicalSize).toHaveBeenCalledTimes(1)
  })

  it('retains an OS-clamped minimum as inexact while correcting the other dimension', () => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 180, height: 300 })
    const resize = adapter.setPhysicalSize.getMockImplementation()!
    adapter.setPhysicalSize.mockImplementation((expected, size) => resize(expected, { width: Math.max(291, size.width), height: size.height }))
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('inexact')
    expect(window.getBounds()).toEqual({ ...target, width: 181 })
    expect(adapter.setPhysicalSize).toHaveBeenCalledTimes(1)
  })

  it('reports a post-resize DPI/policy transition without a second adjustment', () => {
    const { target, window, adapter } = nonlinearWindow({ x: 160, y: 180, width: 420, height: 300 })
    const resize = adapter.setPhysicalSize.getMockImplementation()!
    adapter.setPhysicalSize.mockImplementation((expected, size) => {
      const success = resize(expected, size)
      adapter.getDisplay.mockReturnValue({ id: 2, scaleFactor: 2 })
      return success
    })
    expect(restoreStickyNoteWindowBounds(window, target, adapter)).toBe('stale')
    expect(adapter.setPhysicalSize).toHaveBeenCalledTimes(1)
  })
})
