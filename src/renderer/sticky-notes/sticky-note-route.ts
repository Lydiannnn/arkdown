import { isCanonicalStickyNoteId } from '../../shared/sticky-notes'

export interface StickyNoteRoute {
  noteId: string
}

export function stickyNoteRouteFromLocation(search: string): StickyNoteRoute | null {
  const params = new URLSearchParams(search)
  const keys = [...params.keys()]
  if (
    keys.length !== 2
    || keys.some((key) => key !== 'surface' && key !== 'noteId')
    || params.getAll('surface').length !== 1
    || params.getAll('noteId').length !== 1
    || params.get('surface') !== 'sticky-note'
  ) return null
  const noteId = params.get('noteId')
  return isCanonicalStickyNoteId(noteId) ? { noteId } : null
}
