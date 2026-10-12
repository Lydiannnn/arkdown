import { createRoot } from 'react-dom/client'
import { StickyNoteGrid } from '../../../src/renderer/sticky-notes/StickyNoteGrid'
import { ArchivedStickyNotePreview } from '../../../src/renderer/sticky-notes/ArchivedStickyNotePreview'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../../src/shared/background-settings'
import { DEFAULT_STICKY_NOTE_PREFERENCES } from '../../../src/shared/sticky-note-preferences'
import type { StickyNoteDocument } from '../../../src/shared/sticky-notes'
import '../../../src/renderer/sticky-notes/sticky-note-box.css'

export function mountPreviewFixture() {
  const notes: StickyNoteDocument[] = (['mica-light', 'flowing-glass'] as const).map((materialPresetId, index) => ({
    record: {
      id: `00000000-0000-4000-8000-00000000000${index + 1}`, name: materialPresetId,
      status: 'archived', markdownRelativePath: `archive/${index}/note.md`, resourcesRelativePath: `archive/${index}/resources`,
      style: { mode: 'material', materialPresetId }, background: { ...DEFAULT_BACKGROUND_SETTINGS },
      createdAt: '2026-09-07T00:00:00Z', updatedAt: '2026-09-07T00:00:00Z', archivedAt: '2026-09-07T00:00:00Z',
      released: false, pinned: false, windowBounds: null, lastOpenedAt: null, fontSizePx: 13, lineSpacingMode: 'compact',
    },
    markdown: '#### Material preview\n\nReadable content',
  }))
  Object.assign(window.arkdown, {
    getStickyNotePreferences: async () => ({ ok: true, value: DEFAULT_STICKY_NOTE_PREFERENCES }),
    readStickyNote: async (id: string) => ({ ok: true, value: notes.find(note => note.record.id === id)! }),
  })
  const host = document.createElement('div')
  host.id = 'sticky-preview-fixture'
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white;padding:24px;overflow:auto;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px'
  document.body.append(host)
  createRoot(host).render(<>
    <StickyNoteGrid label="Material cards" notes={notes.map(note => ({ record: note.record, excerpt: note.markdown }))} onOpen={() => undefined} showCreate={false} />
    <div>{notes.map(note => <ArchivedStickyNotePreview key={note.record.id} noteId={note.record.id} onClose={() => undefined} />)}</div>
  </>)
}
