export interface MermaidViewerSnapshot {
  svgDataUrl: string
  colorScheme: 'light' | 'dark'
  themeColor: string
}

const SVG_PREFIX = 'data:image/svg+xml;base64,'
const MAX_DATA_URL_LENGTH = SVG_PREFIX.length + Math.ceil(2 * 1024 * 1024 / 3) * 4

/** Transport validation only. Main and viewer independently validate the SVG content. */
export function parseMermaidViewerSnapshot(value: unknown): MermaidViewerSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const fields = Object.getOwnPropertyDescriptors(value)
  const names = Reflect.ownKeys(fields)
  if (names.length !== 3 || names.some(name => !['svgDataUrl', 'colorScheme', 'themeColor'].includes(String(name)))) return undefined
  if (names.some(name => !('value' in fields[name as string]!))) return undefined
  const { svgDataUrl, colorScheme, themeColor } = Object.fromEntries(names.map(name => [name, fields[name as string]!.value]))
  if (typeof svgDataUrl !== 'string' || svgDataUrl.length > MAX_DATA_URL_LENGTH || !svgDataUrl.startsWith(SVG_PREFIX)) return undefined
  const encoded = svgDataUrl.slice(SVG_PREFIX.length)
  if (!encoded.length || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) return undefined
  if (colorScheme !== 'light' && colorScheme !== 'dark') return undefined
  if (typeof themeColor !== 'string' || !/^#[0-9a-f]{6}$/iu.test(themeColor)) return undefined
  return { svgDataUrl, colorScheme, themeColor }
}
