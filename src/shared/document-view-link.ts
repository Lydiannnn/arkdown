import { parseLinkTarget } from './link-target'

export type DocumentViewLink =
  | { kind: 'relative'; path: string; anchor?: string; line?: number }
  | { kind: 'anchor'; anchor: string }

export function parseLocalFileLink(href: unknown): { kind: 'absolute' | 'relative'; path: string } | null {
  const absolute = parseLinkTarget(href)
  if (absolute?.kind === 'local') return { kind: 'absolute', path: absolute.path }
  const relative = parseDocumentViewLink(href)
  return relative?.kind === 'relative' ? { kind: 'relative', path: relative.path } : null
}

const invalidCharacter = /[\u0000-\u001f\u007f<>:"|?*]/
const reservedDevice = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i

/** Classify the original href before resolving it. Never serialize this decoded path back to markup. */
export function parseDocumentViewLink(href: unknown): DocumentViewLink | null {
  if (typeof href !== 'string' || !href || href.length > 32_767 || /[\u0000-\u001f\u007f]/.test(href)) return null
  const hash = href.indexOf('#')
  const rawPath = hash < 0 ? href : href.slice(0, hash)
  let anchor: string | undefined
  let decodedPath: string
  try {
    if (hash >= 0) {
      anchor = decodeURIComponent(href.slice(hash + 1))
      if (/[\u0000-\u001f\u007f]/.test(anchor)) return null
    }
    // Encoded separators change the original relative grammar and are never needed for filenames.
    if (/%(?:2f|5c|3a)/i.test(rawPath)) return null
    decodedPath = decodeURIComponent(rawPath)
  } catch { return null }
  if (!rawPath) return anchor ? { kind: 'anchor', anchor } : null
  if (/^[\\/]/.test(decodedPath) || /^[a-z]:/i.test(decodedPath) || /^www\./i.test(decodedPath)) return null

  let line: number | undefined
  const suffix = /:(\d+)$/.exec(decodedPath)
  if (suffix) {
    // A bare scheme-like name followed by a number is a URI, not a file line suffix.
    if (!/[\\/]/.test(decodedPath) && !/\.[^.:]+:\d+$/.test(decodedPath)) return null
    line = Number(suffix[1])
    decodedPath = decodedPath.slice(0, -suffix[0].length)
  }
  if (anchor && /^L\d+$/.test(anchor)) {
    line = Number(anchor.slice(1))
    anchor = undefined
  }
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null
  if (!decodedPath || invalidCharacter.test(decodedPath)) return null
  const segments = decodedPath.split(/[\\/]/)
  if (segments.some((segment, index) => {
    if (segment === '.' || segment === '..') return false
    if (!segment) return index !== segments.length - 1
    if (/[. ]$/.test(segment)) return true
    return reservedDevice.test(segment.split('.')[0].replace(/[. ]+$/u, ''))
  })) return null
  return {
    kind: 'relative', path: decodedPath,
    ...(anchor ? { anchor } : {}), ...(line !== undefined ? { line } : {}),
  }
}
