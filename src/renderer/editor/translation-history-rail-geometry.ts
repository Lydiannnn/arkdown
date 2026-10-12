export interface TranslationHistoryRailAnchorGeometry {
  recordId: string
  createdAt: number
  rect: DOMRectReadOnly
}

export interface TranslationHistoryRailItem {
  recordId: string
  buttonTop: number
  buttonLeft: number
  connectorLeft: number | null
  connectorTop: number | null
  connectorHorizontalWidth: number
  connectorVerticalLeft: number | null
  connectorVerticalTop: number | null
  connectorVerticalHeight: number
}

const DEFAULT_BUTTON_SIZE = 30
const DEFAULT_CONTENT_GAP = 20
const DEFAULT_COLLISION_GAP = 4

function finiteRect(rect: DOMRectReadOnly): boolean {
  return [rect.left, rect.right, rect.top, rect.bottom, rect.width, rect.height]
    .every(Number.isFinite)
    && rect.width >= 0
    && rect.height >= 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

export function computeTranslationHistoryRailItems(input: {
  anchors: readonly TranslationHistoryRailAnchorGeometry[]
  mode: 'visual' | 'source'
  surfaceRect: DOMRectReadOnly
  contentRight: number
  buttonSize?: number
  contentGap?: number
  collisionGap?: number
}): readonly TranslationHistoryRailItem[] {
  const {
    anchors,
    mode,
    surfaceRect,
    contentRight,
    buttonSize = DEFAULT_BUTTON_SIZE,
    contentGap = DEFAULT_CONTENT_GAP,
    collisionGap = DEFAULT_COLLISION_GAP,
  } = input
  if (
    !finiteRect(surfaceRect)
    || !Number.isFinite(contentRight)
    || !Number.isFinite(buttonSize)
    || !Number.isFinite(contentGap)
    || !Number.isFinite(collisionGap)
    || buttonSize <= 0
    || contentGap < 0
    || collisionGap < 0
  ) return []

  const ordered = anchors
    .filter(({ createdAt, rect }) => Number.isFinite(createdAt) && finiteRect(rect))
    .sort((left, right) => (
      left.rect.top - right.rect.top
      || left.createdAt - right.createdAt
      || left.recordId.localeCompare(right.recordId)
    ))
  if (ordered.length === 0) return []

  const maximumTop = Math.max(0, surfaceRect.height - buttonSize)
  const buttonLeft = clamp(
    contentRight - surfaceRect.left + contentGap,
    0,
    Math.max(0, surfaceRect.width - buttonSize),
  )
  const buttonTops = ordered.map(({ rect }) => clamp(
    mode === 'visual'
      ? rect.bottom - surfaceRect.top + 2
      : rect.top - surfaceRect.top + (rect.height - buttonSize) / 2,
    0,
    maximumTop,
  ))
  for (let index = 1; index < buttonTops.length; index += 1) {
    buttonTops[index] = Math.max(
      buttonTops[index]!,
      buttonTops[index - 1]! + buttonSize + collisionGap,
    )
  }
  const overflow = Math.max(0, buttonTops.at(-1)! - maximumTop)
  if (overflow > 0) {
    for (let index = 0; index < buttonTops.length; index += 1) buttonTops[index]! -= overflow
  }
  if (buttonTops[0]! < 0) {
    const underflow = -buttonTops[0]!
    for (let index = 0; index < buttonTops.length; index += 1) buttonTops[index]! += underflow
  }

  return ordered.map(({ recordId, rect }, index) => {
    const buttonTop = buttonTops[index]!
    if (mode === 'source') {
      return {
        recordId,
        buttonTop,
        buttonLeft,
        connectorLeft: null,
        connectorTop: null,
        connectorHorizontalWidth: 0,
        connectorVerticalLeft: null,
        connectorVerticalTop: null,
        connectorVerticalHeight: 0,
      }
    }
    const connectorLeft = clamp(rect.right - surfaceRect.left, 0, buttonLeft)
    const connectorTop = clamp(rect.bottom - surfaceRect.top + 2, 0, surfaceRect.height)
    const buttonCenter = buttonTop + buttonSize / 2
    return {
      recordId,
      buttonTop,
      buttonLeft,
      connectorLeft,
      connectorTop,
      connectorHorizontalWidth: Math.max(0, buttonLeft - connectorLeft),
      connectorVerticalLeft: buttonLeft,
      connectorVerticalTop: Math.min(connectorTop, buttonCenter),
      connectorVerticalHeight: Math.abs(buttonCenter - connectorTop),
    }
  })
}
