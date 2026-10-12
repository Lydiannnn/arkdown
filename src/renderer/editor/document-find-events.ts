export const DOCUMENT_FIND_EVENT = 'arkdown:document-find'
export const DOCUMENT_FIND_SNAPSHOT_EVENT = 'arkdown:document-find-snapshot'

export interface DocumentFindSnapshot {
  query: string
  current: number
  total: number
  revision: number
}

export const EMPTY_DOCUMENT_FIND_SNAPSHOT: DocumentFindSnapshot = Object.freeze({
  query: '',
  current: 0,
  total: 0,
  revision: 0,
})

export type DocumentFindAction =
  | { type: 'query'; query: string }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'close' }

export function dispatchDocumentFind(action: DocumentFindAction): void {
  window.dispatchEvent(new CustomEvent<DocumentFindAction>(DOCUMENT_FIND_EVENT, {
    detail: action,
  }))
}

export function readDocumentFindAction(event: Event): DocumentFindAction | null {
  const detail = (event as CustomEvent<unknown>).detail
  if (!detail || typeof detail !== 'object' || !('type' in detail)) return null
  if (detail.type === 'query') {
    if (!('query' in detail) || typeof detail.query !== 'string') return null
    return { type: 'query', query: detail.query }
  }
  if (detail.type === 'next' || detail.type === 'previous' || detail.type === 'close') {
    return { type: detail.type }
  }
  return null
}

export function dispatchDocumentFindSnapshot(snapshot: DocumentFindSnapshot): void {
  window.dispatchEvent(new CustomEvent<DocumentFindSnapshot>(DOCUMENT_FIND_SNAPSHOT_EVENT, {
    detail: snapshot,
  }))
}

export function readDocumentFindSnapshot(event: Event): DocumentFindSnapshot | null {
  const detail = (event as CustomEvent<unknown>).detail
  if (!detail || typeof detail !== 'object') return null
  const candidate = detail as Partial<DocumentFindSnapshot>
  if (
    typeof candidate.query !== 'string'
    || candidate.query.length > 1_000_000
    || !Number.isSafeInteger(candidate.current)
    || !Number.isSafeInteger(candidate.total)
    || !Number.isSafeInteger(candidate.revision)
    || candidate.current! < 0
    || candidate.total! < 0
    || candidate.revision! < 0
    || candidate.current! > candidate.total!
    || (candidate.total === 0 && candidate.current !== 0)
  ) return null
  return {
    query: candidate.query,
    current: candidate.current!,
    total: candidate.total!,
    revision: candidate.revision!,
  }
}
