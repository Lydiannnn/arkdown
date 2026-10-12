const SVG_PREFIX = 'data:image/svg+xml;base64,'
const PNG_PREFIX = 'data:image/png;base64,'
const MAX_PNG_DATA_URL_LENGTH = 24 * 1024 * 1024
const MAX_EDGE_PX = 4096
const MAX_PIXELS = 16_000_000

interface Canvas2dLike {
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void
}

interface CanvasLike {
  width: number
  height: number
  getContext(contextId: '2d'): Canvas2dLike | null
  toDataURL(type: 'image/png'): string
}

export interface MermaidRasterAdapters {
  loadImage(source: string): Promise<CanvasImageSource>
  createCanvas(): CanvasLike
}

function decodeSvgDataUrl(source: string): string {
  if (!source.startsWith(SVG_PREFIX)) throw new Error('Invalid Mermaid SVG image')
  const encoded = source.slice(SVG_PREFIX.length)
  if (
    encoded.length === 0
    || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)
  ) throw new Error('Invalid Mermaid SVG image')
  let binary: string
  try {
    binary = atob(encoded)
  } catch {
    throw new Error('Invalid Mermaid SVG image')
  }
  const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Invalid Mermaid SVG image')
  }
}

function positiveDimension(value: string | null): number | null {
  if (!value || !/^\d+(?:\.\d+)?(?:px)?$/iu.test(value.trim())) return null
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function svgDimensions(source: string): { width: number; height: number } {
  const parsed = new DOMParser().parseFromString(decodeSvgDataUrl(source), 'image/svg+xml')
  const svg = parsed.documentElement
  if (svg.localName.toLocaleLowerCase('en-US') !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('Invalid Mermaid SVG image')
  }
  const width = positiveDimension(svg.getAttribute('width'))
  const height = positiveDimension(svg.getAttribute('height'))
  if (width && height) return { width, height }
  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/u).map(Number)
  const viewBoxWidth = viewBox?.length === 4 ? viewBox[2] : undefined
  const viewBoxHeight = viewBox?.length === 4 ? viewBox[3] : undefined
  if (
    !Number.isFinite(viewBoxWidth)
    || !Number.isFinite(viewBoxHeight)
    || (viewBoxWidth ?? 0) <= 0
    || (viewBoxHeight ?? 0) <= 0
  ) throw new Error('Mermaid SVG has no usable dimensions')
  return { width: viewBoxWidth!, height: viewBoxHeight! }
}

function boundedRasterSize(
  dimensions: { width: number; height: number },
  pixelRatio: number,
): { width: number; height: number } {
  const density = Number.isFinite(pixelRatio) ? Math.min(2, Math.max(1, pixelRatio)) : 1
  const requestedWidth = Math.max(1, dimensions.width * density)
  const requestedHeight = Math.max(1, dimensions.height * density)
  const scale = Math.min(
    1,
    MAX_EDGE_PX / requestedWidth,
    MAX_EDGE_PX / requestedHeight,
    Math.sqrt(MAX_PIXELS / (requestedWidth * requestedHeight)),
  )
  return {
    width: Math.max(1, Math.floor(requestedWidth * scale)),
    height: Math.max(1, Math.floor(requestedHeight * scale)),
  }
}

const browserAdapters: MermaidRasterAdapters = {
  loadImage: (source) => new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Unable to rasterize Mermaid image'))
    image.src = source
  }),
  createCanvas: () => document.createElement('canvas'),
}

export async function rasterizeMermaidSvgDataUrl(
  source: string,
  adapters: MermaidRasterAdapters = browserAdapters,
  pixelRatio = window.devicePixelRatio,
): Promise<string> {
  const size = boundedRasterSize(svgDimensions(source), pixelRatio)
  const image = await adapters.loadImage(source)
  const canvas = adapters.createCanvas()
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Unable to rasterize Mermaid image')
  context.drawImage(image, 0, 0, size.width, size.height)
  const pngDataUrl = canvas.toDataURL('image/png')
  if (
    !pngDataUrl.startsWith(PNG_PREFIX)
    || pngDataUrl.length < PNG_PREFIX.length + 4
    || pngDataUrl.length > MAX_PNG_DATA_URL_LENGTH
  ) throw new Error('Unable to rasterize Mermaid image')
  return pngDataUrl
}
