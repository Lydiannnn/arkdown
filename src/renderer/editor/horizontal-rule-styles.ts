export interface HorizontalRuleStyleDefinition {
  id: string
  commandId: string
  label: string
  color: string
  height: number
}

const HORIZONTAL_RULE_COLORS = {
  black: '0 0 0',
  red: '198 40 40',
  orange: '198 106 0',
  green: '24 134 75',
  cyan: '0 124 145',
  blue: '37 99 235',
  purple: '128 0 128',
  pink: '184 50 128',
} as const

export type HorizontalRuleStyleId = keyof typeof HORIZONTAL_RULE_COLORS

export interface HorizontalRuleAttributes {
  styleId: HorizontalRuleStyleId
  heightPx: number
  opacityPercent: number
}

export type HorizontalRuleAdjustment =
  | 'height-increase'
  | 'height-decrease'
  | 'opacity-increase'
  | 'opacity-decrease'

export const DEFAULT_HORIZONTAL_RULE_STYLE_ID = 'black-40'
export const DEFAULT_HORIZONTAL_RULE_ATTRIBUTES: HorizontalRuleAttributes = {
  styleId: 'black',
  heightPx: 2,
  opacityPercent: 40,
}

export const HORIZONTAL_RULE_STYLES = [
  { id: 'black-40', commandId: 'insert-horizontal-rule-black-40', label: '40%黑色', color: 'rgb(0 0 0 / 40%)', height: 2 },
  { id: 'black-80', commandId: 'insert-horizontal-rule-black-80', label: '80%黑色', color: 'rgb(0 0 0 / 80%)', height: 2 },
  { id: 'purple-40', commandId: 'insert-horizontal-rule-purple-40', label: '40%紫色', color: 'rgb(128 0 128 / 40%)', height: 2 },
  { id: 'blue-40', commandId: 'insert-horizontal-rule-blue-40', label: '40%蓝色', color: 'rgb(37 99 235 / 40%)', height: 2 },
  { id: 'cyan-40', commandId: 'insert-horizontal-rule-cyan-40', label: '40%青色', color: 'rgb(0 124 145 / 40%)', height: 2 },
  { id: 'green-40', commandId: 'insert-horizontal-rule-green-40', label: '40%绿色', color: 'rgb(24 134 75 / 40%)', height: 2 },
  { id: 'orange-40', commandId: 'insert-horizontal-rule-orange-40', label: '40%橙色', color: 'rgb(198 106 0 / 40%)', height: 2 },
  { id: 'red-40', commandId: 'insert-horizontal-rule-red-40', label: '40%红色', color: 'rgb(198 40 40 / 40%)', height: 2 },
  { id: 'pink-40', commandId: 'insert-horizontal-rule-pink-40', label: '40%粉色', color: 'rgb(184 50 128 / 40%)', height: 2 },
  { id: 'black-40-double', commandId: 'insert-horizontal-rule-black-40-double', label: '40%黑色双倍高度', color: 'rgb(0 0 0 / 40%)', height: 4 },
  { id: 'black-40-quadruple', commandId: 'insert-horizontal-rule-black-40-quadruple', label: '40%黑色四倍高度', color: 'rgb(0 0 0 / 40%)', height: 8 },
] as const satisfies readonly HorizontalRuleStyleDefinition[]

export type HorizontalRuleStyle = (typeof HORIZONTAL_RULE_STYLES)[number]

const LEGACY_ATTRIBUTES: Readonly<Record<string, HorizontalRuleAttributes>> = {
  'black-40': { styleId: 'black', heightPx: 2, opacityPercent: 40 },
  'black-80': { styleId: 'black', heightPx: 2, opacityPercent: 80 },
  'purple-40': { styleId: 'purple', heightPx: 2, opacityPercent: 40 },
  'blue-40': { styleId: 'blue', heightPx: 2, opacityPercent: 40 },
  'cyan-40': { styleId: 'cyan', heightPx: 2, opacityPercent: 40 },
  'green-40': { styleId: 'green', heightPx: 2, opacityPercent: 40 },
  'orange-40': { styleId: 'orange', heightPx: 2, opacityPercent: 40 },
  'red-40': { styleId: 'red', heightPx: 2, opacityPercent: 40 },
  'pink-40': { styleId: 'pink', heightPx: 2, opacityPercent: 40 },
  'black-40-double': { styleId: 'black', heightPx: 4, opacityPercent: 40 },
  'black-40-quadruple': { styleId: 'black', heightPx: 8, opacityPercent: 40 },
}

const RENDER_TOKEN_PREFIX = 'arkdown-rule:'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStyleId(value: unknown): value is HorizontalRuleStyleId {
  return typeof value === 'string' && Object.hasOwn(HORIZONTAL_RULE_COLORS, value)
}

function validHeight(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 12
}

function validOpacity(value: unknown): value is number {
  return Number.isInteger(value)
    && Number(value) >= 10
    && Number(value) <= 100
    && Number(value) % 10 === 0
}

function attributesForLegacyId(id: unknown): HorizontalRuleAttributes | null {
  if (typeof id !== 'string') return null
  const attributes = LEGACY_ATTRIBUTES[id]
  return attributes ? { ...attributes } : null
}

function renderToken(attributes: HorizontalRuleAttributes): string {
  return `${RENDER_TOKEN_PREFIX}${attributes.styleId}:${attributes.heightPx}:${attributes.opacityPercent}`
}

function attributesFromRenderToken(value: string): HorizontalRuleAttributes | null {
  if (!value.startsWith(RENDER_TOKEN_PREFIX)) return null
  const [styleId, height, opacity] = value.slice(RENDER_TOKEN_PREFIX.length).split(':')
  return normalizeHorizontalRuleAttributes({
    styleId,
    heightPx: Number(height),
    opacityPercent: Number(opacity),
  })
}

type ParsedHorizontalRuleAttributes = HorizontalRuleAttributes & { readonly id: string }

function parsedAttributes(attributes: HorizontalRuleAttributes): ParsedHorizontalRuleAttributes {
  const result = { ...attributes } as ParsedHorizontalRuleAttributes
  Object.defineProperty(result, 'id', {
    enumerable: false,
    value: renderToken(attributes),
  })
  return result
}

export function normalizeHorizontalRuleAttributes(value: unknown): HorizontalRuleAttributes {
  const record = isRecord(value) ? value : {}
  const legacy = attributesForLegacyId(record.styleId ?? record.id)
  const fallback = legacy ?? DEFAULT_HORIZONTAL_RULE_ATTRIBUTES
  return {
    styleId: isStyleId(record.styleId) ? record.styleId : fallback.styleId,
    heightPx: validHeight(record.heightPx) ? record.heightPx : fallback.heightPx,
    opacityPercent: validOpacity(record.opacityPercent)
      ? record.opacityPercent
      : fallback.opacityPercent,
  }
}

export function adjustHorizontalRule(
  attributes: HorizontalRuleAttributes,
  action: HorizontalRuleAdjustment,
): HorizontalRuleAttributes {
  const normalized = normalizeHorizontalRuleAttributes(attributes)
  switch (action) {
    case 'height-increase':
      return { ...normalized, heightPx: Math.min(12, normalized.heightPx + 1) }
    case 'height-decrease':
      return { ...normalized, heightPx: Math.max(1, normalized.heightPx - 1) }
    case 'opacity-increase':
      return { ...normalized, opacityPercent: Math.min(100, normalized.opacityPercent + 10) }
    case 'opacity-decrease':
      return { ...normalized, opacityPercent: Math.max(10, normalized.opacityPercent - 10) }
  }
}

export function horizontalRuleStyleForCommand(commandId: string): HorizontalRuleStyle | null {
  return HORIZONTAL_RULE_STYLES.find((style) => style.commandId === commandId) ?? null
}

export function horizontalRuleStyleForId(id: string): HorizontalRuleStyle | null {
  return HORIZONTAL_RULE_STYLES.find((style) => style.id === id) ?? null
}

export function horizontalRuleAttributesForElement(
  element: Pick<HTMLHRElement, 'dataset'>,
): HorizontalRuleAttributes {
  return normalizeHorizontalRuleAttributes({
    styleId: element.dataset.arkdownStyle,
    heightPx: Number(element.dataset.arkdownHeight),
    opacityPercent: Number(element.dataset.arkdownOpacity),
  })
}

function resolveAttributes(
  value: string | HorizontalRuleAttributes | HorizontalRuleStyle,
): HorizontalRuleAttributes | null {
  if (typeof value !== 'string') {
    if ('id' in value && !('styleId' in value)) return attributesForLegacyId(value.id)
    return normalizeHorizontalRuleAttributes(value)
  }
  return attributesFromRenderToken(value)
    ?? attributesForLegacyId(value)
    ?? (isStyleId(value) ? normalizeHorizontalRuleAttributes({ styleId: value }) : null)
}

export function horizontalRuleDomStyle(
  value: string | HorizontalRuleAttributes | HorizontalRuleStyle,
): { backgroundColor: string; blockSize: string; height: string } | null {
  const attributes = resolveAttributes(value)
  if (!attributes) return null
  const size = `${attributes.heightPx}px`
  return {
    backgroundColor: `rgb(${HORIZONTAL_RULE_COLORS[attributes.styleId]} / ${attributes.opacityPercent}%)`,
    blockSize: size,
    height: size,
  }
}

export function applyHorizontalRuleDomStyle(
  element: HTMLHRElement,
  value: string | HorizontalRuleAttributes | HorizontalRuleStyle,
): boolean {
  const attributes = resolveAttributes(value)
  if (!attributes) return false
  const style = horizontalRuleDomStyle(attributes)
  if (!style) return false
  element.dataset.arkdownStyle = attributes.styleId
  element.dataset.arkdownHeight = String(attributes.heightPx)
  element.dataset.arkdownOpacity = String(attributes.opacityPercent)
  element.removeAttribute('style')
  element.style.backgroundColor = style.backgroundColor
  element.style.blockSize = style.blockSize
  element.style.height = style.height
  return true
}

export function serializeHorizontalRule(
  value: HorizontalRuleAttributes | HorizontalRuleStyle,
): string {
  const attributes = resolveAttributes(value) ?? DEFAULT_HORIZONTAL_RULE_ATTRIBUTES
  return '<hr'
    + ` data-arkdown-style="${attributes.styleId}"`
    + ` data-arkdown-height="${attributes.heightPx}"`
    + ` data-arkdown-opacity="${attributes.opacityPercent}" />`
}

export function parseHorizontalRuleHtml(value: string): ParsedHorizontalRuleAttributes | null {
  const source = value.trim()
  const controlled = /^<hr\s+data-arkdown-style=(?:"([^"]*)"|'([^']*)')\s+data-arkdown-height=(?:"([^"]*)"|'([^']*)')\s+data-arkdown-opacity=(?:"([^"]*)"|'([^']*)')\s*\/?>$/i.exec(source)
  if (controlled) {
    return parsedAttributes(normalizeHorizontalRuleAttributes({
      styleId: controlled[1] ?? controlled[2],
      heightPx: Number(controlled[3] ?? controlled[4]),
      opacityPercent: Number(controlled[5] ?? controlled[6]),
    }))
  }
  const legacy = /^<hr\s+data-arkdown-style=(?:"([^"]*)"|'([^']*)')\s*\/?>$/i.exec(source)
  const attributes = attributesForLegacyId(legacy?.[1] ?? legacy?.[2])
  return attributes ? parsedAttributes(attributes) : null
}
