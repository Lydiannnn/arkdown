import DOMPurify from 'dompurify'

import { MERMAID_MAX_SVG_BYTES } from './mermaid-types'

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'

const FORBIDDEN_TAGS = [
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'audio',
  'video',
  'canvas',
  'image',
  'animate',
  'animateMotion',
  'animateTransform',
  'discard',
  'set',
]

const ALLOWED_TAGS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
  'text',
  'tspan',
  'textpath',
  'defs',
  'marker',
  'clippath',
  'mask',
  'pattern',
  'filter',
  'fedropshadow',
  'lineargradient',
  'radialgradient',
  'stop',
  'title',
  'desc',
  'symbol',
  'use',
])

const CANONICAL_SVG_TAG_NAMES = new Map([
  ['clippath', 'clipPath'],
  ['textpath', 'textPath'],
  ['lineargradient', 'linearGradient'],
  ['radialgradient', 'radialGradient'],
  ['fedropshadow', 'feDropShadow'],
])

const ALLOWED_ATTRIBUTES = new Set([
  'id',
  'class',
  'style',
  'version',
  'viewbox',
  'width',
  'height',
  'preserveaspectratio',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'aria-roledescription',
  'aria-hidden',
  'tabindex',
  'focusable',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'dy',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'd',
  'points',
  'transform',
  'pathlength',
  'fill',
  'fill-opacity',
  'fill-rule',
  'clip-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'opacity',
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'letter-spacing',
  'word-spacing',
  'text-decoration',
  'visibility',
  'display',
  'overflow',
  'pointer-events',
  'vector-effect',
  'paint-order',
  'href',
  'clip-path',
  'mask',
  'filter',
  'marker-start',
  'marker-mid',
  'marker-end',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'offset',
  'stop-color',
  'stop-opacity',
  'fx',
  'fy',
  'fr',
  'dx',
  'stddeviation',
  'flood-opacity',
  'flood-color',
  'markerwidth',
  'markerheight',
  'refx',
  'refy',
  'orient',
  'markerunits',
  'patternunits',
  'patterncontentunits',
  'patterntransform',
  'textlength',
  'lengthadjust',
  'startoffset',
  'method',
  'spacing',
  'data-edge',
  'data-et',
  'data-id',
  'data-points',
  'data-look',
  'name',
  'data-type',
  'data-from',
  'data-to',
  'transform-origin',
  'xml:space',
])

const CANONICAL_SVG_ATTRIBUTE_NAMES = new Map([
  ['viewbox', 'viewBox'],
  ['preserveaspectratio', 'preserveAspectRatio'],
  ['pathlength', 'pathLength'],
  ['gradientunits', 'gradientUnits'],
  ['gradienttransform', 'gradientTransform'],
  ['spreadmethod', 'spreadMethod'],
  ['markerwidth', 'markerWidth'],
  ['markerheight', 'markerHeight'],
  ['refx', 'refX'],
  ['refy', 'refY'],
  ['markerunits', 'markerUnits'],
  ['patternunits', 'patternUnits'],
  ['patterncontentunits', 'patternContentUnits'],
  ['patterntransform', 'patternTransform'],
  ['textlength', 'textLength'],
  ['lengthadjust', 'lengthAdjust'],
  ['startoffset', 'startOffset'],
  ['stddeviation', 'stdDeviation'],
])

const FRAGMENT_REFERENCE = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/
const STATIC_TRANSFORM_ORIGIN_LENGTH = /^[+-]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:px|%|em|rem|ex|ch|ic|lh|rlh|vw|vh|vmin|vmax|cm|mm|q|in|pt|pc)|0(?:\.0*)?)$/iu
const STATIC_TRANSFORM_ORIGIN_KEYWORDS = new Set(['left', 'center', 'right', 'top', 'bottom'])
const INERT_MERMAID_METADATA_ATTRIBUTES = new Set(['name', 'data-type', 'data-from', 'data-to'])

export type MermaidCssValidator = (css: string) => string

export interface MermaidSvgSanitizerOptions {
  cssValidator?: MermaidCssValidator
}

function unsafeSvg(): never {
  throw new Error('Unsafe Mermaid SVG')
}

function parseSvg(svg: string): XMLDocument {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(svg)) unsafeSvg()

  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  if (parsed.doctype || parsed.getElementsByTagName('parsererror').length > 0) unsafeSvg()
  if (parsed.documentElement.localName !== 'svg' || parsed.documentElement.namespaceURI !== SVG_NAMESPACE) {
    unsafeSvg()
  }
  return parsed
}

function withoutCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

function validateCssReferences(css: string): void {
  const normalized = withoutCssComments(css)
  if (
    normalized.includes('\\')
    || /@import\b/i.test(normalized)
    || /\b(?:https?|data|file):|\/\//i.test(normalized)
    || /(?:^|[^-\w])(?:(?:-webkit-)?image-set|cross-fade|element|paint|src)\s*\(/i.test(normalized)
    || /expression\s*\(/i.test(normalized)
    || /(?:^|[;{\s])behavior\s*:/i.test(normalized)
    || /-moz-binding\s*:/i.test(normalized)
  ) {
    unsafeSvg()
  }

  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi
  let match: RegExpExecArray | null
  let matchedCss = ''
  let previousEnd = 0
  while ((match = urlPattern.exec(normalized)) !== null) {
    matchedCss += normalized.slice(previousEnd, match.index)
    const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!FRAGMENT_REFERENCE.test(reference)) unsafeSvg()
    previousEnd = urlPattern.lastIndex
  }
  matchedCss += normalized.slice(previousEnd)
  if (/url\s*\(/i.test(matchedCss)) unsafeSvg()
}

function browserCssValidator(css: string): string {
  const sheet = new CSSStyleSheet()
  if (typeof sheet.replaceSync !== 'function') unsafeSvg()
  try {
    sheet.replaceSync(css)
  } catch {
    unsafeSvg()
  }
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n')
}

function splitCssDeclarations(declarations: string): string[] {
  const parts: string[] = []
  let start = 0
  let quote = ''
  let parentheses = 0
  for (let index = 0; index < declarations.length; index += 1) {
    const character = declarations[index]!
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
    } else if (character === '(') {
      parentheses += 1
    } else if (character === ')') {
      parentheses -= 1
      if (parentheses < 0) unsafeSvg()
    } else if (character === ';' && parentheses === 0) {
      parts.push(declarations.slice(start, index))
      start = index + 1
    }
  }
  if (quote || parentheses !== 0) unsafeSvg()
  parts.push(declarations.slice(start))
  return parts
}

function staticizeDeclarations(declarations: string): string {
  const safe: string[] = []
  for (const rawDeclaration of splitCssDeclarations(withoutCssComments(declarations))) {
    const declaration = rawDeclaration.trim()
    if (!declaration) continue
    validateCssReferences(declaration)
    const colon = declaration.indexOf(':')
    if (colon <= 0) unsafeSvg()
    const property = declaration.slice(0, colon).trim().toLowerCase()
    if (/^(?:-[a-z0-9]+-)?(?:animation|transition)(?:-|$)/.test(property)) continue
    safe.push(`${declaration};`)
  }
  return safe.join(' ')
}

function findCssBrace(css: string, start: number): number {
  let quote = ''
  let parentheses = 0
  for (let index = start; index < css.length; index += 1) {
    const character = css[index]!
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses -= 1
    else if (character === '{' && parentheses === 0) return index
  }
  return -1
}

function findMatchingCssBrace(css: string, openBrace: number): number {
  let depth = 0
  let quote = ''
  for (let index = openBrace; index < css.length; index += 1) {
    const character = css[index]!
    if (quote) {
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
      if (depth < 0) unsafeSvg()
    }
  }
  unsafeSvg()
}

function staticizeStylesheet(css: string): string {
  const normalized = withoutCssComments(css)
  const safeRules: string[] = []
  let offset = 0
  while (offset < normalized.length) {
    const openBrace = findCssBrace(normalized, offset)
    if (openBrace < 0) {
      if (normalized.slice(offset).trim()) unsafeSvg()
      break
    }
    const selector = normalized.slice(offset, openBrace).trim()
    if (!selector) unsafeSvg()
    const closeBrace = findMatchingCssBrace(normalized, openBrace)
    if (!selector.startsWith('@')) {
      const body = normalized.slice(openBrace + 1, closeBrace)
      if (/[{}]/.test(body)) unsafeSvg()
      const declarations = staticizeDeclarations(body)
      if (declarations) safeRules.push(`${selector} { ${declarations} }`)
    }
    offset = closeBrace + 1
  }
  return safeRules.join('\n')
}

function rebuildInlineStyle(style: string, cssValidator: MermaidCssValidator): string {
  if (/[{}]/.test(style)) unsafeSvg()
  validateCssReferences(style)
  let canonical: string
  try {
    canonical = cssValidator(`.arkdown-inline{${style}}`)
  } catch {
    unsafeSvg()
  }
  validateCssReferences(canonical)

  const openBrace = canonical.indexOf('{')
  const closeBrace = canonical.lastIndexOf('}')
  if (
    canonical.slice(0, openBrace).trim() !== '.arkdown-inline'
    || openBrace < 0
    || closeBrace <= openBrace
    || canonical.slice(closeBrace + 1).trim() !== ''
  ) {
    unsafeSvg()
  }
  const declarations = canonical.slice(openBrace + 1, closeBrace).trim()
  if (/[{}]/.test(declarations)) unsafeSvg()
  return staticizeDeclarations(declarations)
}

function validateStaticTransformOrigin(value: string): void {
  if (
    /[\u0000-\u001F\u007F-\u009F;()]/u.test(value)
    || /(?:nan|infinity)/iu.test(value)
    || /\b(?:https?|data|file|javascript):/iu.test(value)
    || /^\s*\/\//u.test(value)
  ) {
    unsafeSvg()
  }
  const tokens = value.trim().split(/\s+/u)
  if (tokens.length < 1 || tokens.length > 3 || !tokens.every((token) => (
    STATIC_TRANSFORM_ORIGIN_LENGTH.test(token)
    || STATIC_TRANSFORM_ORIGIN_KEYWORDS.has(token.toLowerCase())
  ))) {
    unsafeSvg()
  }
}

function canonicalSvgTagName(name: string): string {
  return CANONICAL_SVG_TAG_NAMES.get(name.toLowerCase()) ?? name
}

function canonicalSvgAttributeName(attribute: Attr): string {
  return CANONICAL_SVG_ATTRIBUTE_NAMES.get(attribute.name.toLowerCase()) ?? attribute.name
}

function validateAttribute(attribute: Attr): void {
  const normalizedName = attribute.name.toLowerCase()
  const localName = attribute.localName.toLowerCase()
  const namespace = attribute.namespaceURI

  if (localName.startsWith('on')) unsafeSvg()
  if (namespace && ![XLINK_NAMESPACE, XML_NAMESPACE, XMLNS_NAMESPACE].includes(namespace)) unsafeSvg()

  if (namespace === XMLNS_NAMESPACE || normalizedName === 'xmlns') {
    const isSvgNamespace = normalizedName === 'xmlns' && attribute.value === SVG_NAMESPACE
    const isXlinkNamespace = normalizedName === 'xmlns:xlink' && attribute.value === XLINK_NAMESPACE
    if (!isSvgNamespace && !isXlinkNamespace) unsafeSvg()
    return
  }
  if (namespace === XLINK_NAMESPACE && localName !== 'href') unsafeSvg()
  if (namespace === XML_NAMESPACE && normalizedName !== 'xml:space') unsafeSvg()
  if (!ALLOWED_ATTRIBUTES.has(namespace === XLINK_NAMESPACE ? 'href' : normalizedName)) unsafeSvg()

  if (INERT_MERMAID_METADATA_ATTRIBUTES.has(normalizedName)) return

  if (localName === 'href') {
    if (!FRAGMENT_REFERENCE.test(attribute.value.trim())) unsafeSvg()
    return
  }

  if (normalizedName === 'transform-origin') {
    validateStaticTransformOrigin(attribute.value)
    return
  }

  if (normalizedName === 'style' || /url\s*\(/i.test(attribute.value)) {
    validateCssReferences(attribute.value)
  }

  if (/\b(?:javascript|data|https?|file):/i.test(attribute.value) || /^\s*\/\//.test(attribute.value)) {
    unsafeSvg()
  }
}

function inspectUntrustedTree(root: Element): string | undefined {
  let rootStyle: string | undefined
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (element.namespaceURI !== SVG_NAMESPACE) unsafeSvg()

    const localName = element.localName.toLowerCase()
    if (localName === 'style') {
      if (element.parentElement !== root || rootStyle !== undefined) unsafeSvg()
      rootStyle = element.textContent ?? ''
      continue
    }
    if (!ALLOWED_TAGS.has(localName)) unsafeSvg()
    for (const attribute of Array.from(element.attributes)) validateAttribute(attribute)
  }
  return rootStyle
}

function purifySvg(document: XMLDocument): XMLDocument {
  for (const style of Array.from(document.documentElement.children)) {
    if (style.localName.toLowerCase() === 'style') style.remove()
  }
  const serialized = new XMLSerializer().serializeToString(document.documentElement)
  const purified = DOMPurify.sanitize(serialized, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [...FORBIDDEN_TAGS, 'style'],
    FORBID_ATTR: ['onload', 'onclick', 'onerror', 'onbegin', 'onend', 'src'],
  })
  return parseSvg(purified)
}

function copySafeNode(
  source: Node,
  outputDocument: XMLDocument,
  cssValidator: MermaidCssValidator,
): Node | null {
  if (source.nodeType === Node.TEXT_NODE) return outputDocument.createTextNode(source.textContent ?? '')
  if (source.nodeType !== Node.ELEMENT_NODE) return null

  const sourceElement = source as Element
  const normalizedTag = sourceElement.localName.toLowerCase()
  if (sourceElement.namespaceURI !== SVG_NAMESPACE || !ALLOWED_TAGS.has(normalizedTag)) unsafeSvg()

  const output = outputDocument.createElementNS(
    SVG_NAMESPACE,
    canonicalSvgTagName(sourceElement.localName),
  )
  for (const attribute of Array.from(sourceElement.attributes)) {
    validateAttribute(attribute)
    if (attribute.namespaceURI === XMLNS_NAMESPACE || attribute.name === 'xmlns') continue
    const value = attribute.name.toLowerCase() === 'style'
      ? rebuildInlineStyle(attribute.value, cssValidator)
      : attribute.value
    output.setAttributeNS(attribute.namespaceURI, canonicalSvgAttributeName(attribute), value)
  }
  for (const child of Array.from(sourceElement.childNodes)) {
    const copied = copySafeNode(child, outputDocument, cssValidator)
    if (copied) output.appendChild(copied)
  }
  return output
}

export function sanitizeMermaidSvg(svg: string, options: MermaidSvgSanitizerOptions = {}): string {
  const cssValidator = options.cssValidator ?? browserCssValidator
  const untrustedDocument = parseSvg(svg)
  const rootStyle = inspectUntrustedTree(untrustedDocument.documentElement)
  let safeCss: string | undefined
  if (rootStyle !== undefined) {
    validateCssReferences(rootStyle)
    safeCss = staticizeStylesheet(cssValidator(rootStyle))
    validateCssReferences(safeCss)
  }

  const purifiedDocument = purifySvg(untrustedDocument)
  const outputDocument = document.implementation.createDocument(SVG_NAMESPACE, 'svg', null)
  const purifiedRoot = purifiedDocument.documentElement
  const outputRoot = outputDocument.documentElement

  for (const attribute of Array.from(purifiedRoot.attributes)) {
    validateAttribute(attribute)
    if (attribute.namespaceURI === XMLNS_NAMESPACE || attribute.name === 'xmlns') continue
    const value = attribute.name.toLowerCase() === 'style'
      ? rebuildInlineStyle(attribute.value, cssValidator)
      : attribute.value
    outputRoot.setAttributeNS(attribute.namespaceURI, canonicalSvgAttributeName(attribute), value)
  }
  if (safeCss !== undefined) {
    const style = outputDocument.createElementNS(SVG_NAMESPACE, 'style')
    style.textContent = safeCss
    outputRoot.appendChild(style)
  }
  for (const child of Array.from(purifiedRoot.childNodes)) {
    const copied = copySafeNode(child, outputDocument, cssValidator)
    if (copied) outputRoot.appendChild(copied)
  }

  const rebuilt = new XMLSerializer().serializeToString(outputRoot)
  if (new TextEncoder().encode(rebuilt).byteLength > MERMAID_MAX_SVG_BYTES) {
    throw new Error('Mermaid SVG is too large')
  }
  return rebuilt
}

export function svgToDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  if (bytes.byteLength > MERMAID_MAX_SVG_BYTES) throw new Error('Mermaid SVG is too large')
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}
