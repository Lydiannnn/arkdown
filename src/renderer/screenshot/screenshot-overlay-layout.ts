import type {
  ScreenshotOcrBlock,
  ScreenshotRect,
  ScreenshotSize,
  ScreenshotTranslatedBlock,
} from '../../shared/screenshot-translation'

export interface ScreenshotOverlayLayout {
  imageRectCss: ScreenshotRect
  blocks: readonly {
    id: string
    text: string
    rectCss: ScreenshotRect
    fontSizeCss: number
    fit: 'original-size' | 'wrapped' | 'shrunk' | 'unfit'
  }[]
}

export interface ScreenshotOverlayLayoutInput {
  imageSizePx: ScreenshotSize
  containerRectCss: ScreenshotRect
  sidebarWidthCss?: number
  devicePixelRatio?: number
  blocks: readonly ScreenshotOcrBlock[]
  translations: readonly ScreenshotTranslatedBlock[]
}

const EMPTY_RECT: ScreenshotRect = { x: 0, y: 0, width: 0, height: 0 }
const MIN_FONT_SIZE = 10
const LINE_HEIGHT = 1.2

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function estimateCharacterUnits(character: string): number {
  if (/\s/u.test(character)) return 0.33
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) return 1
  if (/[MW@#%&]/u.test(character)) return 0.78
  if (/\p{Punctuation}/u.test(character)) return 0.45
  return 0.56
}

function measureTextUnits(text: string): number {
  let units = 0
  for (const character of text) units += estimateCharacterUnits(character)
  return units
}

function requiredLines(textUnits: number, width: number, fontSize: number): number {
  if (!finitePositive(width)) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.ceil(textUnits * fontSize / width))
}

function fits(textUnits: number, rect: ScreenshotRect, fontSize: number): boolean {
  return requiredLines(textUnits, rect.width, fontSize) * fontSize * LINE_HEIGHT <= rect.height
}

function estimateOriginalFont(block: ScreenshotOcrBlock, scale: number): number {
  const heights = block.words
    .map((word) => word.rectPx.height * scale)
    .filter(finitePositive)
    .sort((left, right) => left - right)
  const median = heights[Math.floor(heights.length / 2)] ?? block.rectPx.height * scale
  return Math.max(MIN_FONT_SIZE, Math.round(median * 0.9 * 10) / 10)
}

export function fitScreenshotOverlayText(
  text: string,
  rect: ScreenshotRect,
  originalFontSize: number,
  measureUnits: (value: string) => number = measureTextUnits,
) {
  const textUnits = measureUnits(text)
  let probes = 0
  const probe = (fontSize: number) => {
    probes += 1
    return fits(textUnits, rect, fontSize)
  }
  const oneLine = textUnits * originalFontSize <= rect.width
    && originalFontSize * LINE_HEIGHT <= rect.height
  if (oneLine) return { fontSizeCss: originalFontSize, fit: 'original-size' as const, probes }
  if (probe(originalFontSize)) return { fontSizeCss: originalFontSize, fit: 'wrapped' as const, probes }
  if (!probe(MIN_FONT_SIZE)) return { fontSizeCss: MIN_FONT_SIZE, fit: 'unfit' as const, probes }

  let lowestFit = Math.ceil(MIN_FONT_SIZE * 2)
  let highestUnfit = Math.max(lowestFit + 1, Math.floor(originalFontSize * 2))
  while (lowestFit + 1 < highestUnfit) {
    const candidate = Math.floor((lowestFit + highestUnfit) / 2)
    if (probe(candidate / 2)) lowestFit = candidate
    else highestUnfit = candidate
  }
  return { fontSizeCss: lowestFit / 2, fit: 'shrunk' as const, probes }
}

export function computeScreenshotOverlayLayout(input: ScreenshotOverlayLayoutInput): ScreenshotOverlayLayout {
  const sidebar = input.sidebarWidthCss ?? 0
  const dpr = input.devicePixelRatio ?? 1
  const values = [
    input.imageSizePx.width, input.imageSizePx.height,
    input.containerRectCss.x, input.containerRectCss.y,
    input.containerRectCss.width, input.containerRectCss.height,
    sidebar, dpr,
  ]
  if (!values.every(Number.isFinite)
    || !finitePositive(input.imageSizePx.width)
    || !finitePositive(input.imageSizePx.height)
    || !finitePositive(input.containerRectCss.width)
    || !finitePositive(input.containerRectCss.height)
    || sidebar < 0
    || sidebar >= input.containerRectCss.width
    || !finitePositive(dpr)) {
    return { imageRectCss: EMPTY_RECT, blocks: [] }
  }

  const availableWidth = input.containerRectCss.width - sidebar
  const scale = Math.min(
    availableWidth / input.imageSizePx.width,
    input.containerRectCss.height / input.imageSizePx.height,
  )
  const imageWidth = input.imageSizePx.width * scale
  const imageHeight = input.imageSizePx.height * scale
  const imageRectCss = {
    x: input.containerRectCss.x + (availableWidth - imageWidth) / 2,
    y: input.containerRectCss.y + (input.containerRectCss.height - imageHeight) / 2,
    width: imageWidth,
    height: imageHeight,
  }
  const translations = new Map(input.translations.map((translation) => [translation.id, translation.text]))
  const blocks = input.blocks.flatMap((block) => {
    const text = translations.get(block.id)
    const source = block.rectPx
    if (!text
      || ![source.x, source.y, source.width, source.height].every(Number.isFinite)
      || source.x < 0 || source.y < 0
      || !finitePositive(source.width) || !finitePositive(source.height)
      || source.x + source.width > input.imageSizePx.width
      || source.y + source.height > input.imageSizePx.height) return []
    const rectCss = {
      x: imageRectCss.x + source.x * scale,
      y: imageRectCss.y + source.y * scale,
      width: source.width * scale,
      height: source.height * scale,
    }
    const { probes: _probes, ...fit } = fitScreenshotOverlayText(
      text, rectCss, estimateOriginalFont(block, scale),
    )
    return [{ id: block.id, text, rectCss, ...fit }]
  })
  return { imageRectCss, blocks }
}
