import { useEffect, useState } from 'react'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  copyStickyNotePreferences,
  type StickyNotePreferences,
} from '../../shared/sticky-note-preferences'
import type { StickyNoteDocument } from '../../shared/sticky-notes'
import { stickyNoteMaterialPresetIdForStyle } from '../../shared/sticky-note-materials'
import { VisualEditor } from '../editor/VisualEditor'
import { dispatchDocumentFind } from '../editor/document-find-events'
import { stickyNoteStyleCssVariables } from './sticky-note-style'

interface ArchivedStickyNotePreviewProps {
  noteId: string
  onClose(): void
  initialPreferences?: StickyNotePreferences
  initialQuery?: string
}

export function ArchivedStickyNotePreview({
  noteId,
  onClose,
  initialPreferences = DEFAULT_STICKY_NOTE_PREFERENCES,
  initialQuery = '',
}: ArchivedStickyNotePreviewProps) {
  const [note, setNote] = useState<StickyNoteDocument | null>(null)
  const [preferences, setPreferences] = useState<StickyNotePreferences>(() =>
    copyStickyNotePreferences(initialPreferences))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void window.arkdown.getStickyNotePreferences?.().then((result) => {
      if (active && result.ok) setPreferences(result.value)
    })
    void window.arkdown.readStickyNote(noteId).then((result) => {
      if (!active) return
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.value.record.status !== 'archived') {
        setError('该便签已不在归档中')
        return
      }
      setNote(result.value)
    })
    return () => { active = false }
  }, [noteId])

  useEffect(() => {
    if (!note || !initialQuery.trim()) return
    const frame = window.requestAnimationFrame(() => {
      dispatchDocumentFind({ type: 'query', query: initialQuery.trim() })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [initialQuery, note])

  return (
    <section aria-label="归档便签预览" className="archived-sticky-note-preview">
      <header>
        <button aria-label="返回归档列表" onClick={onClose} type="button">←</button>
        <h2>{note?.record.name ?? '归档便签'}</h2>
      </header>
      {error && <p className="sticky-note-box-error" role="alert">{error}</p>}
      {!error && !note && <p className="sticky-note-box-message">正在读取归档便签…</p>}
      {note && (
        <div
          className="archived-sticky-note-preview-surface"
          data-line-spacing-mode={note.record.lineSpacingMode}
          data-material-preset={stickyNoteMaterialPresetIdForStyle(note.record.style) ?? undefined}
          style={stickyNoteStyleCssVariables(note.record.style, preferences)}
        >
          <VisualEditor markdown={note.markdown} onChange={() => undefined} readOnly />
        </div>
      )}
    </section>
  )
}
