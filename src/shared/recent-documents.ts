import { documentTypeForPath, isEditableDocumentPath } from './document-types'
import { isWindowsAbsolutePath } from './local-resource-path'

export const RECENT_DOCUMENT_LIMIT = 10

// Ten ordinary Windows paths fit comfortably below this ceiling. Keeping the
// file bounded prevents a damaged local store from consuming unbounded memory.
export const RECENT_DOCUMENT_FILE_MAX_BYTES = 64 * 1024

// Normal storage contains at most ten entries. Explicit repair loads tolerate
// extra candidates while the critical startup path uses the exact persisted cap.
export const RECENT_DOCUMENT_CANDIDATE_LIMIT = 100

export interface RecentDocumentsFile {
  version: 1
  paths: string[]
}

export function isSupportedRecentDocumentPath(value: unknown): value is string {
  if (!isWindowsAbsolutePath(value)) return false
  const definition = documentTypeForPath(value)
  return isEditableDocumentPath(value) || definition?.importWithPandoc === true
}

export function isRecentDocumentsFile(value: unknown): value is RecentDocumentsFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Reflect.ownKeys(record).length === 2
    && Object.hasOwn(record, 'version')
    && Object.hasOwn(record, 'paths')
    && record.version === 1
    && Array.isArray(record.paths)
  )
}
