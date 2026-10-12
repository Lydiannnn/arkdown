import {
  parseCompleteEditorAppearancePreferences,
  type EditorAppearancePreferences,
} from './editor-appearance-preferences'
import { isWindowsAbsolutePath } from './local-resource-path'

export const PRINT_DOCUMENT_MARKDOWN_LIMIT = 16 * 1024 * 1024
export const PRINT_DOCUMENT_NAME_LIMIT = 260
export const PRINT_DOCUMENT_LAYOUT_RESERVE_MS = 10_000

export interface PrintDocumentInput {
  markdown: string
  documentName: string
  appearance: EditorAppearancePreferences
  /** Required to preserve existing document-relative image resolution in the isolated surface. */
  documentAbsolutePath?: string | null
}

export interface PrintSurfaceDocumentInput extends PrintDocumentInput {
  /** Main-process-owned absolute deadline; renderer code may only shorten it. */
  surfaceDeadlineEpochMs: number
}

function isExactOwnRecordWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  const allowed = new Set([...required, ...optional])
  return (
    keys.every((key) => typeof key === 'string' && allowed.has(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

export function parsePrintDocumentInput(value: unknown): PrintDocumentInput | undefined {
  if (!isExactOwnRecordWithOptional(
    value,
    ['markdown', 'documentName', 'appearance'],
    ['documentAbsolutePath'],
  )) return undefined
  if (
    typeof value.markdown !== 'string'
    || value.markdown.trim().length === 0
    || value.markdown.length > PRINT_DOCUMENT_MARKDOWN_LIMIT
    || typeof value.documentName !== 'string'
    || value.documentName !== value.documentName.trim()
    || value.documentName.length === 0
    || value.documentName.length > PRINT_DOCUMENT_NAME_LIMIT
    || /[\u0000-\u001f\u007f]/u.test(value.documentName)
  ) return undefined

  const appearance = parseCompleteEditorAppearancePreferences(value.appearance)
  if (!appearance) return undefined
  const documentAbsolutePath = value.documentAbsolutePath
  if (
    documentAbsolutePath !== undefined
    && documentAbsolutePath !== null
    && (typeof documentAbsolutePath !== 'string' || !isWindowsAbsolutePath(documentAbsolutePath))
  ) return undefined

  return {
    markdown: value.markdown,
    documentName: value.documentName,
    appearance,
    ...(documentAbsolutePath === undefined ? {} : { documentAbsolutePath }),
  }
}

export function parsePrintSurfaceDocumentInput(
  value: unknown,
): PrintSurfaceDocumentInput | undefined {
  if (!isExactOwnRecordWithOptional(
    value,
    ['markdown', 'documentName', 'appearance', 'surfaceDeadlineEpochMs'],
    ['documentAbsolutePath'],
  )) return undefined
  const surfaceDeadlineEpochMs = value.surfaceDeadlineEpochMs
  if (
    typeof surfaceDeadlineEpochMs !== 'number'
    || !Number.isSafeInteger(surfaceDeadlineEpochMs)
    || surfaceDeadlineEpochMs <= 0
  ) return undefined

  const input = parsePrintDocumentInput({
    markdown: value.markdown,
    documentName: value.documentName,
    appearance: value.appearance,
    ...(Object.prototype.hasOwnProperty.call(value, 'documentAbsolutePath')
      ? { documentAbsolutePath: value.documentAbsolutePath }
      : {}),
  })
  if (!input) return undefined
  return {
    ...input,
    surfaceDeadlineEpochMs,
  }
}

const PRINT_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export function isPrintDocumentToken(value: unknown): value is string {
  return typeof value === 'string' && PRINT_TOKEN_PATTERN.test(value)
}
