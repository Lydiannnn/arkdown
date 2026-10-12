import { isCanonicalStickyNoteId } from '../../shared/sticky-notes'
import { isEditorTheme } from '../../shared/editor-appearance-preferences'

export type BackgroundSettingsRoute =
  | { target: 'main' }
  | { noteId: string, target: 'sticky-note' }

export function backgroundSettingsRouteFromLocation(search: string): BackgroundSettingsRoute | null {
  const params = new URLSearchParams(search)
  const hasSingleValue = (key: string) => params.getAll(key).length === 1
  if (params.has('theme') && (!hasSingleValue('theme') || !isEditorTheme(params.get('theme')))) return null
  const keys = [...params.keys()].filter(key => key !== 'theme')

  if (
    !hasSingleValue('surface')
    || !hasSingleValue('target')
    || params.get('surface') !== 'background-settings'
  ) return null

  if (params.get('target') === 'main') {
    return keys.length === 2 && keys.every((key) => key === 'surface' || key === 'target')
      ? { target: 'main' }
      : null
  }

  if (
    params.get('target') !== 'sticky-note'
    || !hasSingleValue('noteId')
    || keys.length !== 3
    || keys.some((key) => key !== 'surface' && key !== 'target' && key !== 'noteId')
  ) return null

  const noteId = params.get('noteId')
  return isCanonicalStickyNoteId(noteId) ? { noteId, target: 'sticky-note' } : null
}
