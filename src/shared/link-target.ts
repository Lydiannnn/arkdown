export const LINK_TARGET_MAX_LENGTH = 32_767

export type LinkTarget =
  | { kind: 'web'; url: string }
  | { kind: 'local'; path: string }

export type AiMessageLinkTarget =
  | { readonly kind: 'web'; readonly url: string }
  | {
      readonly kind: 'local'
      readonly path: string
      readonly scope: 'absolute' | 'workspace-relative'
    }

const malformedEscapePattern = /%(?![0-9a-f]{2})/i
const encodedPathSeparatorPattern = /%(?:2f|5c)/i
const invalidPathCharacterPattern = /[\u0000-\u001f<>:"|?*]/
const rawDriveFileUrlPattern = /^file:\/\/\/[a-z]:\/[^?#\\]*$/i
const rawUncFileUrlPattern = /^file:\/\/[^/?#:@\\]+\/[^/?#\\]+(?:\/[^?#\\]*)?$/i
const aiInvalidPathCharacterPattern = /[\u0000-\u001f<>:"|?*]/
const aiReservedDeviceNames = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
  'COM\u00B9', 'COM\u00B2', 'COM\u00B3', 'LPT\u00B9', 'LPT\u00B2', 'LPT\u00B3',
])

function parseNativeWindowsPath(value: string): LinkTarget | null {
  const nativePath = value.replaceAll('/', '\\')
  if (nativePath.startsWith('\\\\?\\') || nativePath.startsWith('\\\\.\\')) return null

  if (/^[a-z]:\\/i.test(nativePath)) {
    if (invalidPathCharacterPattern.test(nativePath.slice(2))) return null
    return { kind: 'local', path: nativePath }
  }

  if (!nativePath.startsWith('\\\\')) return null
  const segments = nativePath.slice(2).split('\\')
  if (segments.length < 2 || segments[0] === '' || segments[1] === '') return null
  if (segments.some((segment) => invalidPathCharacterPattern.test(segment))) return null
  return { kind: 'local', path: nativePath }
}

function parseFileUrl(value: string): LinkTarget | null {
  if (value.includes('\\')) return null
  const isRawDriveUrl = rawDriveFileUrlPattern.test(value)
  const isRawUncUrl = rawUncFileUrlPattern.test(value)
  if (!isRawDriveUrl && !isRawUncUrl) return null
  if (malformedEscapePattern.test(value)) return null

  try {
    const candidate = new URL(value)
    if (
      candidate.protocol !== 'file:'
      || candidate.username !== ''
      || candidate.password !== ''
      || candidate.port !== ''
      || candidate.search !== ''
      || candidate.hash !== ''
      || encodedPathSeparatorPattern.test(candidate.pathname)
    ) return null

    const decodedPath = decodeURIComponent(candidate.pathname)
    if (isRawDriveUrl) {
      if (candidate.hostname !== '') return null
      if (!/^\/[a-z]:\//i.test(decodedPath)) return null
      return parseNativeWindowsPath(decodedPath.slice(1))
    }

    if (candidate.hostname === '' || !decodedPath.startsWith('/') || decodedPath.length === 1) {
      return null
    }
    return parseNativeWindowsPath(`\\\\${candidate.hostname}${decodedPath}`)
  } catch {
    return null
  }
}

function parseWebUrl(value: string): LinkTarget | null {
  if (
    !/^(?:https?:\/\/|www\.)/i.test(value)
    || /\s/.test(value)
    || malformedEscapePattern.test(value)
  ) return null
  const candidateValue = /^www\./i.test(value) ? `https://${value}` : value
  const rawAuthority = /^https?:\/\/([^/?#]+)/i.exec(candidateValue)?.[1]
  if (!rawAuthority || rawAuthority.includes('\\')) return null

  try {
    const candidate = new URL(candidateValue)
    if (
      (candidate.protocol !== 'https:' && candidate.protocol !== 'http:')
      || candidate.username !== ''
      || candidate.password !== ''
      || candidate.hostname === ''
    ) return null
    return { kind: 'web', url: candidate.href }
  } catch {
    return null
  }
}

export function parseLinkTarget(value: unknown): LinkTarget | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > LINK_TARGET_MAX_LENGTH
  ) return null

  if (/^file:/i.test(value)) return parseFileUrl(value)
  const nativePath = parseNativeWindowsPath(value)
  if (nativePath) return nativePath
  return parseWebUrl(value)
}

function isSafeAiPathSegment(segment: string): boolean {
  if (
    segment.length === 0
    || segment === '.'
    || segment === '..'
    || segment.endsWith('.')
    || segment.endsWith(' ')
    || aiInvalidPathCharacterPattern.test(segment)
  ) return false
  const withoutTrailingNormalization = segment.normalize('NFC').replace(/[. ]+$/u, '')
  const extensionSeparator = withoutTrailingNormalization.indexOf('.')
  const basename = (extensionSeparator < 0
    ? withoutTrailingNormalization
    : withoutTrailingNormalization.slice(0, extensionSeparator))
    .replace(/[. ]+$/u, '')
  return !aiReservedDeviceNames.has(basename.toUpperCase())
}

function safeAiLocalPath(
  nativePath: string,
  scope: 'absolute' | 'workspace-relative',
): AiMessageLinkTarget | null {
  const normalized = nativePath.replaceAll('/', '\\')
  let segments: string[]
  if (scope === 'absolute') {
    if (!/^[a-z]:\\/i.test(normalized) || normalized.startsWith('\\\\')) return null
    const remainder = normalized.slice(3)
    segments = remainder === '' ? [] : remainder.split('\\')
  } else {
    if (
      normalized.startsWith('\\')
      || /^[a-z]:/i.test(normalized)
      || normalized.length === 0
    ) return null
    segments = normalized.split('\\')
  }
  if (segments.some((segment) => !isSafeAiPathSegment(segment))) return null
  return Object.freeze({ kind: 'local', path: normalized, scope })
}

/**
 * Browser-safe syntax boundary for AI message links. Filesystem identity, workspace containment,
 * and reparse-point checks remain main-process responsibilities.
 */
export function parseAiMessageLinkTarget(value: unknown): AiMessageLinkTarget | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > LINK_TARGET_MAX_LENGTH
  ) return null
  if (/^file:/i.test(value)) return null

  const parsed = parseLinkTarget(value)
  if (parsed?.kind === 'web') return Object.freeze({ kind: 'web', url: parsed.url })
  if (parsed?.kind === 'local') return safeAiLocalPath(parsed.path, 'absolute')

  // Any colon in a relative target is either an alternate-data-stream separator or an
  // unsupported URI scheme. Both are rejected before the main process touches the filesystem.
  if (value.includes(':')) return null
  return safeAiLocalPath(value, 'workspace-relative')
}

export function normalizeAutomaticLinkText(value: unknown): LinkTarget | null {
  if (typeof value !== 'string') return null
  const startsWithQuote = value.startsWith('"')
  const endsWithQuote = value.endsWith('"')
  if (!startsWithQuote && !endsWithQuote) return parseLinkTarget(value)
  if (!startsWithQuote || !endsWithQuote || value.length < 3) return null

  const target = parseLinkTarget(value.slice(1, -1))
  return target?.kind === 'local' ? target : null
}
