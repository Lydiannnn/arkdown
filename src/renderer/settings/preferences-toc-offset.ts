const DEFAULT_DESIRED_OFFSET_PX = 30
const DEFAULT_MINIMUM_SAFE_INSET_PX = 16

function nonNegativeFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

export function computePreferencesTocOffset(input: {
  availableLeftPx: number
  desiredOffsetPx?: number
  minimumSafeInsetPx?: number
}): number {
  const availableLeftPx = nonNegativeFinite(input.availableLeftPx, 0)
  const desiredOffsetPx = input.desiredOffsetPx === undefined
    ? DEFAULT_DESIRED_OFFSET_PX
    : nonNegativeFinite(input.desiredOffsetPx, 0)
  const minimumSafeInsetPx = input.minimumSafeInsetPx === undefined
    ? DEFAULT_MINIMUM_SAFE_INSET_PX
    : nonNegativeFinite(input.minimumSafeInsetPx, DEFAULT_MINIMUM_SAFE_INSET_PX)

  return Math.min(
    DEFAULT_DESIRED_OFFSET_PX,
    desiredOffsetPx,
    Math.max(0, availableLeftPx - minimumSafeInsetPx),
  )
}
