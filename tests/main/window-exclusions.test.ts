import { expect, it, vi } from 'vitest'
import { collectScreenshotWindowExclusions, nativeWindowHandleString } from '../../src/main/screenshot-translation/window-exclusions'

const window = (handle: string, destroyed = false) => ({
  isDestroyed: () => destroyed,
  getNativeWindowHandle: vi.fn(() => { const buffer = Buffer.alloc(8); buffer.writeBigUInt64LE(BigInt(handle)); return buffer }),
})

it('excludes auxiliary HWNDs while allowing independent user windows of the same process', () => {
  const primary = window('100'), document = window('101'), mask = window('102'), menu = window('103'), closed = window('104', true)
  expect(collectScreenshotWindowExclusions([primary, document, mask, menu, closed], new Set([primary, document])))
    .toEqual(new Set(['102', '103']))
  expect(closed.getNativeWindowHandle).not.toHaveBeenCalled()
})

it('retains 64-bit HWND identity and rejects invalid buffers instead of broad process exclusion', () => {
  const large = window('9007199254740993').getNativeWindowHandle()
  expect(nativeWindowHandleString(large)).toBe('9007199254740993')
  expect(() => nativeWindowHandleString(Buffer.alloc(8))).toThrow()
  expect(() => nativeWindowHandleString(Buffer.alloc(3))).toThrow()
})
