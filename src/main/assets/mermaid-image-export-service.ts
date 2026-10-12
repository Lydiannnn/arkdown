import { Buffer } from 'node:buffer'
import path from 'node:path'
import { SaxesParser, type SaxesAttributeNS } from 'saxes'
import { appError } from '../../shared/public-errors'

const SVG_PREFIX = 'data:image/svg+xml;base64,'
const PNG_PREFIX = 'data:image/png;base64,'
const MAX_SVG_BYTES = 2 * 1024 * 1024
const MAX_PNG_BYTES = 16 * 1024 * 1024
const MAX_IMAGE_EDGE_PX = 4096
const MAX_IMAGE_PIXELS = 16_000_000
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/'
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FRAGMENT_REFERENCE = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/u

const ALLOWED_SVG_ELEMENTS = new Set([
  'svg', 'g', 'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect',
  'text', 'tspan', 'textpath', 'defs', 'marker', 'clippath', 'mask', 'pattern',
  'filter', 'fedropshadow', 'lineargradient', 'radialgradient', 'stop', 'title',
  'desc', 'symbol', 'use',
])

const ALLOWED_SVG_ATTRIBUTES = new Set([
  'id', 'class', 'style', 'version', 'viewbox', 'width', 'height',
  'preserveaspectratio', 'role', 'aria-label', 'aria-labelledby',
  'aria-describedby', 'aria-roledescription', 'aria-hidden', 'tabindex',
  'focusable', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'dy', 'cx', 'cy', 'r', 'rx',
  'ry', 'd', 'points', 'transform', 'pathlength', 'fill', 'fill-opacity',
  'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray',
  'stroke-dashoffset', 'opacity', 'color', 'font-family', 'font-size', 'font-style',
  'font-weight', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'baseline-shift', 'letter-spacing', 'word-spacing', 'text-decoration',
  'visibility', 'display', 'overflow', 'pointer-events', 'vector-effect',
  'paint-order', 'href', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid',
  'marker-end', 'gradientunits', 'gradienttransform', 'spreadmethod', 'offset',
  'stop-color', 'stop-opacity', 'fx', 'fy', 'fr', 'dx', 'stddeviation',
  'flood-opacity', 'flood-color', 'markerwidth', 'markerheight', 'refx', 'refy',
  'orient', 'markerunits', 'patternunits', 'patterncontentunits', 'patterntransform',
  'textlength', 'lengthadjust', 'startoffset', 'method', 'spacing', 'data-edge',
  'data-et', 'data-id', 'data-points', 'data-look', 'name', 'data-type', 'data-from',
  'data-to', 'transform-origin', 'xml:space',
])

const INERT_MERMAID_METADATA_ATTRIBUTES = new Set([
  'name', 'data-type', 'data-from', 'data-to',
])

interface NativeImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  toPNG(): Buffer
}

export interface MermaidImageExportInput {
  svgDataUrl: string
  pngDataUrl: string
}

interface MermaidImageExportDependencies {
  createNativeImage(dataUrl: string): NativeImageLike
  writeClipboardImage(image: NativeImageLike): void
  chooseTarget(): Promise<string | null>
  writeFileAtomic(targetPath: string, bytes: Buffer): Promise<void>
}

function decodeBase64DataUrl(value: string, prefix: string, maxBytes: number): Buffer {
  if (!value.startsWith(prefix)) throw appError('INVALID_INPUT')
  const encoded = value.slice(prefix.length)
  if (
    encoded.length === 0
    || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) throw appError('INVALID_INPUT')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== encoded) {
    throw appError('INVALID_INPUT')
  }
  return bytes
}

function validateCssReferences(css: string): void {
  const normalized = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  if (
    normalized.includes('\\')
    || /@import\b/iu.test(normalized)
    || /\b(?:https?|data|file|javascript|vbscript):|\/\//iu.test(normalized)
    || /(?:^|[^-\w])(?:(?:-webkit-)?image-set|cross-fade|element|paint|src)\s*\(/iu.test(normalized)
    || /expression\s*\(/iu.test(normalized)
    || /(?:^|[;{\s])behavior\s*:/iu.test(normalized)
    || /-moz-binding\s*:/iu.test(normalized)
  ) throw appError('INVALID_INPUT')

  const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/giu
  let match: RegExpExecArray | null
  let unmatched = ''
  let previousEnd = 0
  while ((match = urlPattern.exec(normalized)) !== null) {
    unmatched += normalized.slice(previousEnd, match.index)
    const reference = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!FRAGMENT_REFERENCE.test(reference)) throw appError('INVALID_INPUT')
    previousEnd = urlPattern.lastIndex
  }
  unmatched += normalized.slice(previousEnd)
  if (/url\s*\(/iu.test(unmatched)) throw appError('INVALID_INPUT')
}

function validateSvgAttribute(attribute: SaxesAttributeNS): void {
  const name = attribute.name.toLocaleLowerCase('en-US')
  const localName = attribute.local.toLocaleLowerCase('en-US')
  if (localName.startsWith('on')) throw appError('INVALID_INPUT')
  if (
    attribute.uri
    && ![XLINK_NAMESPACE, XML_NAMESPACE, XMLNS_NAMESPACE].includes(attribute.uri)
  ) throw appError('INVALID_INPUT')

  if (attribute.uri === XMLNS_NAMESPACE || name === 'xmlns') {
    const allowed = (name === 'xmlns' && attribute.value === SVG_NAMESPACE)
      || (name === 'xmlns:xlink' && attribute.value === XLINK_NAMESPACE)
    if (!allowed) throw appError('INVALID_INPUT')
    return
  }
  if (attribute.uri === XLINK_NAMESPACE && localName !== 'href') throw appError('INVALID_INPUT')
  if (attribute.uri === XML_NAMESPACE && name !== 'xml:space') throw appError('INVALID_INPUT')
  const allowedName = attribute.uri === XLINK_NAMESPACE ? 'href' : name
  if (!ALLOWED_SVG_ATTRIBUTES.has(allowedName)) throw appError('INVALID_INPUT')
  if (INERT_MERMAID_METADATA_ATTRIBUTES.has(name)) return
  if (localName === 'href') {
    if (!FRAGMENT_REFERENCE.test(attribute.value.trim())) throw appError('INVALID_INPUT')
    return
  }
  if (name === 'style' || /url\s*\(/iu.test(attribute.value)) {
    validateCssReferences(attribute.value)
  }
  if (
    /\b(?:javascript|vbscript|data|https?|file):/iu.test(attribute.value)
    || /^\s*\/\//u.test(attribute.value)
  ) throw appError('INVALID_INPUT')
}

function validateSvgDocument(svg: string): void {
  const parser = new SaxesParser({ xmlns: true })
  let depth = 0
  let rootSeen = false
  let rootClosed = false
  let styleSeen = false
  let styleDepth: number | null = null
  let styleText = ''

  const reject = (): never => { throw appError('INVALID_INPUT') }
  parser.on('error', reject)
  parser.on('doctype', reject)
  parser.on('processinginstruction', reject)
  parser.on('comment', reject)
  parser.on('cdata', reject)
  parser.on('opentag', (tag) => {
    if (rootClosed || tag.uri !== SVG_NAMESPACE) reject()
    const localName = tag.local.toLocaleLowerCase('en-US')
    if (depth === 0) {
      if (rootSeen || localName !== 'svg') reject()
      rootSeen = true
    } else if (localName === 'style') {
      if (depth !== 1 || styleSeen) reject()
      styleSeen = true
      styleDepth = depth + 1
      styleText = ''
    } else if (!ALLOWED_SVG_ELEMENTS.has(localName)) {
      reject()
    }
    for (const attribute of Object.values(tag.attributes)) validateSvgAttribute(attribute)
    depth += 1
  })
  parser.on('text', (text) => {
    if (styleDepth !== null && depth >= styleDepth) styleText += text
  })
  parser.on('closetag', () => {
    if (styleDepth === depth) {
      validateCssReferences(styleText)
      styleDepth = null
      styleText = ''
    }
    depth -= 1
    if (depth < 0) reject()
    if (depth === 0) rootClosed = true
  })
  try {
    parser.write(svg).close()
  } catch {
    throw appError('INVALID_INPUT')
  }
  if (!rootSeen || !rootClosed || depth !== 0 || styleDepth !== null) reject()
}

export function validateSvg(dataUrl: string): Buffer {
  const bytes = decodeBase64DataUrl(dataUrl, SVG_PREFIX, MAX_SVG_BYTES)
  let svg: string
  try {
    svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')
  } catch {
    throw appError('INVALID_INPUT')
  }
  validateSvgDocument(svg)
  return Buffer.from(svg, 'utf8')
}

function preflightPng(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 33
    || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) throw appError('INVALID_INPUT')
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  const bitDepth = bytes[24] ?? 0
  const colorType = bytes[25] ?? 255
  const validBitDepths: Readonly<Record<number, readonly number[]>> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  }
  if (
    width < 1
    || height < 1
    || width > MAX_IMAGE_EDGE_PX
    || height > MAX_IMAGE_EDGE_PX
    || width * height > MAX_IMAGE_PIXELS
    || !validBitDepths[colorType]?.includes(bitDepth)
    || bytes[26] !== 0
    || bytes[27] !== 0
    || (bytes[28] !== 0 && bytes[28] !== 1)
  ) throw appError('INVALID_INPUT')
  return { width, height }
}

function validatedNativeImage(
  dataUrl: string,
  createNativeImage: MermaidImageExportDependencies['createNativeImage'],
): NativeImageLike {
  const dimensions = preflightPng(decodeBase64DataUrl(dataUrl, PNG_PREFIX, MAX_PNG_BYTES))
  const image = createNativeImage(dataUrl)
  const { width, height } = image.getSize()
  if (
    image.isEmpty()
    || !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width < 1
    || height < 1
    || width > MAX_IMAGE_EDGE_PX
    || height > MAX_IMAGE_EDGE_PX
    || width * height > MAX_IMAGE_PIXELS
    || width !== dimensions.width
    || height !== dimensions.height
  ) throw appError('INVALID_INPUT')
  return image
}

export class MermaidImageExportService {
  constructor(private readonly dependencies: MermaidImageExportDependencies) {}

  async copyPng(pngDataUrl: string): Promise<void> {
    const image = validatedNativeImage(pngDataUrl, this.dependencies.createNativeImage)
    const canonical = image.toPNG()
    if (canonical.length === 0 || canonical.length > MAX_PNG_BYTES) {
      throw appError('INVALID_INPUT')
    }
    this.dependencies.writeClipboardImage(image)
  }

  async save(input: MermaidImageExportInput): Promise<string | null> {
    const target = await this.dependencies.chooseTarget()
    if (target === null) return null
    if (!path.isAbsolute(target)) throw appError('INVALID_INPUT')
    const extension = path.extname(target).toLocaleLowerCase('en-US')
    let bytes: Buffer
    if (extension === '.svg') {
      bytes = validateSvg(input.svgDataUrl)
    } else if (extension === '.png') {
      const image = validatedNativeImage(input.pngDataUrl, this.dependencies.createNativeImage)
      bytes = image.toPNG()
      if (bytes.length === 0 || bytes.length > MAX_PNG_BYTES) throw appError('INVALID_INPUT')
    } else {
      throw appError('INVALID_INPUT')
    }
    await this.dependencies.writeFileAtomic(target, bytes)
    return target
  }
}
