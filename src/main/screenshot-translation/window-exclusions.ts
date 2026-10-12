export interface ScreenshotNativeWindow {
  isDestroyed(): boolean
  getNativeWindowHandle(): Buffer
}

export function isWindowHandle(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value)
    && BigInt(value) <= 0xffff_ffff_ffff_ffffn
}

export function nativeWindowHandleString(buffer: Buffer): string {
  if (!Buffer.isBuffer(buffer) || (buffer.length !== 4 && buffer.length !== 8)) throw new Error('Invalid native window handle')
  const value = buffer.length === 8 ? buffer.readBigUInt64LE(0).toString() : buffer.readUInt32LE(0).toString()
  if (!isWindowHandle(value)) throw new Error('Invalid native window handle')
  return value
}

// Window roles, not shared process ownership, determine what the picker must skip.
export function collectScreenshotWindowExclusions<T extends ScreenshotNativeWindow>(
  windows: readonly T[], userWindows: ReadonlySet<T>,
): ReadonlySet<string> {
  const excluded = new Set<string>()
  for (const window of windows) {
    if (window.isDestroyed() || userWindows.has(window)) continue
    excluded.add(nativeWindowHandleString(window.getNativeWindowHandle()))
  }
  return excluded
}
