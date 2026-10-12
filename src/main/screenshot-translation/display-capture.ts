import {
  SCREENSHOT_IMAGE_MAX_DIMENSION_PX,
  clipRectToBounds,
  parseCaptureDisplaySnapshot,
  type CaptureDisplaySnapshot,
  type ScreenshotRect,
} from '../../shared/screenshot-translation'

export type CaptureFailureCode = 'CAPTURE_UNAVAILABLE' | 'CAPTURE_EMPTY'

export class DisplayCaptureError extends Error {
  constructor(readonly code: CaptureFailureCode) {
    super(code)
    this.name = 'DisplayCaptureError'
  }
}

export interface NativeImageLike {
  getSize(): { width: number; height: number }
  isEmpty(): boolean
  toDataURL(): string
  toBitmap(): Buffer
  crop(rect: ScreenshotRect): NativeImageLike
}

interface ElectronDisplayLike {
  id: number
  bounds: ScreenshotRect
  scaleFactor: number
}

interface DesktopSourceLike { display_id: string; thumbnail: NativeImageLike }

export interface CapturedDisplay {
  readonly snapshot: CaptureDisplaySnapshot
  readonly image: NativeImageLike
}

export interface DisplayCaptureService {
  captureAll(): Promise<readonly CapturedDisplay[]>
  crop(display: CapturedDisplay, selectionDip: ScreenshotRect): NativeImageLike
}

export interface DisplayCaptureDependencies {
  screen: { getAllDisplays(): readonly ElectronDisplayLike[] }
  desktopCapturer: { getSources(options: {
    types: ['screen']
    fetchWindowIcons: false
    thumbnailSize: { width: number; height: number }
  }): Promise<readonly DesktopSourceLike[]> }
}

const MAX_DIP_COORDINATE = 1_000_000
const MAX_BITMAP_SAMPLES = 4_096

function unavailable(): DisplayCaptureError { return new DisplayCaptureError('CAPTURE_UNAVAILABLE') }
function empty(): DisplayCaptureError { return new DisplayCaptureError('CAPTURE_EMPTY') }

function isSafePositive(value: unknown, maximum = SCREENSHOT_IMAGE_MAX_DIMENSION_PX): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum
}

function isDisplay(value: unknown): value is ElectronDisplayLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const display = value as ElectronDisplayLike
  const { bounds } = display
  return Number.isSafeInteger(display.id) && display.id >= 0
    && typeof display.scaleFactor === 'number' && Number.isFinite(display.scaleFactor)
    && display.scaleFactor >= 0.5 && display.scaleFactor <= 8
    && typeof bounds === 'object' && bounds !== null
    && [bounds.x, bounds.y, bounds.width, bounds.height].every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_DIP_COORDINATE)
    && bounds.width > 0 && bounds.height > 0
}

function requestedDimension(dip: number, scaleFactor: number): number | undefined {
  const value = Math.ceil(dip * scaleFactor)
  return isSafePositive(value) ? value : undefined
}

function hasVisiblePixels(image: NativeImageLike, size: { width: number; height: number }): boolean {
  const bitmap = image.toBitmap()
  const pixels = size.width * size.height
  if (!Buffer.isBuffer(bitmap) || bitmap.length < pixels * 4) return false
  const step = Math.max(1, Math.ceil(pixels / MAX_BITMAP_SAMPLES))
  for (let pixel = 0; pixel < pixels; pixel += step) {
    const offset = pixel * 4
    const red = bitmap[offset]
    const green = bitmap[offset + 1]
    const blue = bitmap[offset + 2]
    const alpha = bitmap[offset + 3]
    if (alpha > 0 && (red > 1 || green > 1 || blue > 1)) return true
  }
  return false
}

function inspectImage(
  image: NativeImageLike,
  invalidTransportCode: CaptureFailureCode = 'CAPTURE_UNAVAILABLE',
): { width: number; height: number; dataUrl: string } {
  const size = image.getSize()
  if (!isSafePositive(size.width) || !isSafePositive(size.height) || image.isEmpty()) throw empty()
  const dataUrl = image.toDataURL()
  if (!parseCaptureDisplaySnapshot({
    displayId: '0',
    boundsDip: { x: 0, y: 0, width: 1, height: 1 },
    scaleFactor: 1,
    imageSizePx: size,
    dataUrl,
  })) throw new DisplayCaptureError(invalidTransportCode)
  if (!hasVisiblePixels(image, size)) throw empty()
  return { width: size.width, height: size.height, dataUrl }
}

function immutableSnapshot(snapshot: CaptureDisplaySnapshot): CaptureDisplaySnapshot {
  return Object.freeze({
    ...snapshot,
    boundsDip: Object.freeze({ ...snapshot.boundsDip }),
    imageSizePx: Object.freeze({ ...snapshot.imageSizePx }),
  })
}

export function createDisplayCaptureService(dependencies: DisplayCaptureDependencies): DisplayCaptureService {
  return {
    async captureAll(): Promise<readonly CapturedDisplay[]> {
      let displays: readonly ElectronDisplayLike[]
      try { displays = dependencies.screen.getAllDisplays() } catch { throw unavailable() }
      if (!Array.isArray(displays) || displays.length === 0 || displays.some((display) => !isDisplay(display))) throw unavailable()
      const ids = new Set<number>()
      if (displays.some((display) => ids.has(display.id) || (ids.add(display.id), false))) throw unavailable()

      const captured: CapturedDisplay[] = []
      for (const display of displays) {
        const width = requestedDimension(display.bounds.width, display.scaleFactor)
        const height = requestedDimension(display.bounds.height, display.scaleFactor)
        if (!width || !height) throw unavailable()
        let sources: readonly DesktopSourceLike[]
        try {
          sources = await dependencies.desktopCapturer.getSources({
            types: ['screen'], fetchWindowIcons: false, thumbnailSize: { width, height },
          })
        } catch { throw unavailable() }
        if (!Array.isArray(sources)) throw unavailable()
        const matches = sources.filter((source) => source && source.display_id === String(display.id))
        if (matches.length !== 1) throw unavailable()
        try {
          const inspected = inspectImage(matches[0].thumbnail)
          const snapshot = parseCaptureDisplaySnapshot({
            displayId: String(display.id),
            boundsDip: { ...display.bounds },
            scaleFactor: display.scaleFactor,
            imageSizePx: { width: inspected.width, height: inspected.height },
            dataUrl: inspected.dataUrl,
          })
          if (!snapshot) throw unavailable()
          captured.push(Object.freeze({ snapshot: immutableSnapshot(snapshot), image: matches[0].thumbnail }))
        } catch (error) {
          if (error instanceof DisplayCaptureError) throw error
          throw unavailable()
        }
      }
      return Object.freeze(captured)
    },

    crop(display: CapturedDisplay, selectionDip: ScreenshotRect): NativeImageLike {
      const clipped = clipRectToBounds(selectionDip, display.snapshot.boundsDip)
      if (!clipped) throw empty()
      try {
        const actual = display.image.getSize()
        if (!isSafePositive(actual.width) || !isSafePositive(actual.height)) throw empty()
        const scaleX = actual.width / display.snapshot.boundsDip.width
        const scaleY = actual.height / display.snapshot.boundsDip.height
        if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) throw empty()
        const left = Math.max(0, Math.min(actual.width, Math.floor((clipped.x - display.snapshot.boundsDip.x) * scaleX)))
        const top = Math.max(0, Math.min(actual.height, Math.floor((clipped.y - display.snapshot.boundsDip.y) * scaleY)))
        const right = Math.max(0, Math.min(actual.width, Math.ceil((clipped.x + clipped.width - display.snapshot.boundsDip.x) * scaleX)))
        const bottom = Math.max(0, Math.min(actual.height, Math.ceil((clipped.y + clipped.height - display.snapshot.boundsDip.y) * scaleY)))
        if (!Number.isSafeInteger(left) || !Number.isSafeInteger(top) || !Number.isSafeInteger(right) || !Number.isSafeInteger(bottom) || right <= left || bottom <= top) throw empty()
        const result = display.image.crop({ x: left, y: top, width: right - left, height: bottom - top })
        inspectImage(result, 'CAPTURE_EMPTY')
        return result
      } catch (error) {
        if (error instanceof DisplayCaptureError) throw error
        throw unavailable()
      }
    },
  }
}
