const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u
const ENCODED_CONTROL_CHARACTER_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/iu
const WINDOWS_DRIVE_PATH_PATTERN = /^[a-z]:[\\/]/iu
const INVALID_WINDOWS_PATH_CHARACTER_PATTERN = /[<>"|?*]/u
const WINDOWS_RESERVED_DEVICE_BASENAME_PATTERN = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9]|conin\$|conout\$)$/iu
const SAFE_DOCUMENT_EXTENSIONS = new Set([
  'md', 'markdown', 'mmd', 'mkd', 'mdwn', 'mdown', 'mdx',
  'mdtxt', 'mdtext', 'apib', 'rmarkdown', 'rmd', 'qmd', 'txt', 'text',
  'docx', 'pdf', 'xlsx', 'pptx', 'epub',
])

export type AiMessageLinkTarget =
  | { kind: 'web'; target: string; revealOnly: false }
  | { kind: 'local'; target: string; revealOnly: boolean }

function hasReservedWindowsDeviceBasename(segment: string): boolean {
  const withoutTrailingNormalization = segment.normalize('NFC').replace(/[. ]+$/u, '')
  const extensionSeparator = withoutTrailingNormalization.indexOf('.')
  const basename = (extensionSeparator < 0
    ? withoutTrailingNormalization
    : withoutTrailingNormalization.slice(0, extensionSeparator))
    .replace(/[. ]+$/u, '')
  return WINDOWS_RESERVED_DEVICE_BASENAME_PATTERN.test(basename)
}

function classifyWindowsPath(value: string): AiMessageLinkTarget | null {
  if (
    CONTROL_CHARACTER_PATTERN.test(value)
    || !WINDOWS_DRIVE_PATH_PATTERN.test(value)
    || INVALID_WINDOWS_PATH_CHARACTER_PATTERN.test(value.slice(3))
  ) return null
  const normalized = value.replaceAll('/', '\\')
  const remainder = normalized.slice(3)
  const segments = remainder.split('\\')
  const fileName = segments.at(-1) ?? ''
  const extensionSeparator = fileName.lastIndexOf('.')
  const extension = extensionSeparator > 0 && extensionSeparator < fileName.length - 1
    ? fileName.slice(extensionSeparator + 1).toLocaleLowerCase('en-US')
    : ''
  const unsafeWindowsNormalization = (
    value !== value.trim()
    || value.normalize('NFC') !== value
    || normalized.normalize('NFC') !== normalized
    || normalized.slice(2).includes(':')
    || segments.some((segment) => segment === '' || /[. ]$/u.test(segment))
    || segments.some(hasReservedWindowsDeviceBasename)
  )
  return {
    kind: 'local',
    target: normalized,
    revealOnly: unsafeWindowsNormalization || !SAFE_DOCUMENT_EXTENSIONS.has(extension),
  }
}

export function classifyAiMessageLink(value: string): AiMessageLinkTarget | null {
  const candidate = value
  if (
    !candidate
    || CONTROL_CHARACTER_PATTERN.test(candidate)
    || ENCODED_CONTROL_CHARACTER_PATTERN.test(candidate)
  ) return null

  const localPath = classifyWindowsPath(candidate)
  if (localPath) return localPath

  if (/^file:/iu.test(candidate)) return null

  let parsed: URL
  if (!/^https?:\/\//iu.test(candidate) || candidate.includes('\\')) return null
  try {
    parsed = new URL(candidate)
  } catch {
    return null
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== ''
    || parsed.password !== ''
    || !parsed.hostname
  ) return null
  return { kind: 'web', target: parsed.href, revealOnly: false }
}

export function aiMessageLinkHref(target: AiMessageLinkTarget): string {
  if (target.kind === 'web') return target.target
  const normalized = target.target.replaceAll('\\', '/')
  const drive = normalized.slice(0, 2)
  const segments = normalized.slice(3).split('/').map(encodeURIComponent)
  return `file:///${drive}/${segments.join('/')}`
}

function escapeMarkdownLinkLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
}

/** Adds links only to standalone local-path lines; code fences and prose stay byte-for-byte intact. */
export function linkifyAiMessageLocalPaths(markdown: string): string {
  let fence: { character: '`' | '~'; length: number } | null = null
  return markdown.split('\n').map((line) => {
    const fenceRun = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (
        fenceRun
        && fenceRun[1]?.[0] === fence.character
        && fenceRun[1].length >= fence.length
        && fenceRun[2]?.trim() === ''
      ) fence = null
      return line
    }
    if (fenceRun) {
      const run = fenceRun[1]
      const info = fenceRun[2] ?? ''
      if (run && (run[0] === '~' || !info.includes('`'))) {
        fence = { character: run[0] as '`' | '~', length: run.length }
      }
      return line
    }

    if (/^(?: {4}|\t)/u.test(line)) return line

    const withoutIndent = line.trimStart()
    if (withoutIndent !== withoutIndent.trimEnd()) return line
    const content = withoutIndent
    const target = classifyWindowsPath(content)
    if (!target) return line
    const leading = line.slice(0, line.length - line.trimStart().length)
    const trailing = line.slice(line.trimEnd().length)
    // Keep the validated bare-path scheme through Markdown parsing. Only the final
    // anchor renderer may create a file: href; model-provided file: remains denied.
    const destination = target.target.replaceAll('\\', '/').replaceAll('&', '&amp;')
    return `${leading}[${escapeMarkdownLinkLabel(content)}](<${destination}>)${trailing}`
  }).join('\n')
}
