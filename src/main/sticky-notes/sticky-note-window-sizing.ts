import type { StickyNoteContentMeasurement } from '../../shared/sticky-notes'

export type { StickyNoteContentMeasurement } from '../../shared/sticky-notes'

export interface StickyNoteWindowSize {
  width: number
  height: number
}

const MINIMUM_WINDOW_SIZE = 180
const DEFAULT_WINDOW_SIZE = 320
const MAXIMUM_WINDOW_WIDTH = 600
const MAXIMUM_WINDOW_HEIGHT = 800
const WIDTH_CHROME = 40
const HEIGHT_CHROME = 88
const MAXIMUM_MEASUREMENT = 10_000

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function parseStickyNoteContentMeasurement(
  value: unknown,
): StickyNoteContentMeasurement | undefined {
  if (!isPlainRecord(value)) return undefined
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== 2
    || !Object.hasOwn(value, 'scrollWidth')
    || !Object.hasOwn(value, 'scrollHeight')
  ) return undefined
  const { scrollWidth, scrollHeight } = value
  if (
    typeof scrollWidth !== 'number'
    || !Number.isSafeInteger(scrollWidth)
    || scrollWidth < 0
    || scrollWidth > MAXIMUM_MEASUREMENT
    || typeof scrollHeight !== 'number'
    || !Number.isSafeInteger(scrollHeight)
    || scrollHeight < 0
    || scrollHeight > MAXIMUM_MEASUREMENT
  ) return undefined
  return { scrollWidth, scrollHeight }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export function calculateStickyNoteWindowSize(
  measurement: StickyNoteContentMeasurement,
  workArea: StickyNoteWindowSize,
): StickyNoteWindowSize {
  const maximumWidth = Math.max(
    MINIMUM_WINDOW_SIZE,
    Math.min(MAXIMUM_WINDOW_WIDTH, Math.floor(workArea.width)),
  )
  const maximumHeight = Math.max(
    MINIMUM_WINDOW_SIZE,
    Math.min(MAXIMUM_WINDOW_HEIGHT, Math.floor(workArea.height)),
  )
  return {
    width: clamp(
      Math.max(DEFAULT_WINDOW_SIZE, measurement.scrollWidth + WIDTH_CHROME),
      MINIMUM_WINDOW_SIZE,
      maximumWidth,
    ),
    height: clamp(
      Math.max(DEFAULT_WINDOW_SIZE, measurement.scrollHeight + HEIGHT_CHROME),
      MINIMUM_WINDOW_SIZE,
      maximumHeight,
    ),
  }
}
