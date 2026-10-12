import type { ApiResult } from '../../shared/contracts'
import type { StickyNoteSelectionExport } from './sticky-note-selection-export'

interface SelectionStickyNoteApi {
  importStickyNoteSelection(
    input: import('../../shared/sticky-notes').StickyNoteSelectionImportInput,
  ): Promise<ApiResult<{ note: { record: { id: string } }; warnings: readonly unknown[] }>>
  releaseStickyNote(noteId: string): Promise<ApiResult<null>>
}

export interface CreateStickyNoteFromSelectionInput {
  api: SelectionStickyNoteApi
  snapshot: StickyNoteSelectionExport | null
}

export async function createStickyNoteFromSelection(
  input: CreateStickyNoteFromSelectionInput,
): Promise<ApiResult<{ note: { record: { id: string } }; warnings: readonly unknown[] }>> {
  if (!input.snapshot || input.snapshot.markdown.trim() === '') {
    return {
      ok: false,
      error: { code: 'INVALID_INPUT', message: '请先选择要建立便签的内容。' },
    }
  }

  const imported = await input.api.importStickyNoteSelection({
    markdown: input.snapshot.markdown,
    localResources: input.snapshot.localResources,
  })
  if (!imported.ok) return imported

  const released = await input.api.releaseStickyNote(imported.value.note.record.id)
  if (!released.ok) return released
  return imported
}
