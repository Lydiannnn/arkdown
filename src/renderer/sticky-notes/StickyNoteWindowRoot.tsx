import { StickyNoteActionIcon } from './StickyNoteActionIcon'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type { VisualEditorHandle } from '../editor/VisualEditor'
import { DEFAULT_STICKY_NOTE_FONT_SIZE_PX } from '../../shared/sticky-notes'
import type {
  StickyNoteReadDocument,
  StickyNoteLineSpacingMode,
  StickyNoteSaveState,
} from '../../shared/sticky-notes'
import type { BackgroundPresentation } from '../../shared/background-settings'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  copyStickyNotePreferences,
  type StickyNoteColorPresetId,
  type StickyNotePreferences,
  type StickyNoteTexturePresetId,
} from '../../shared/sticky-note-preferences'
import { DEFAULT_THEME_COLOR, themeColorRgbChannels } from '../../shared/theme-color'
import {
  stickyNoteMaterialDescriptor,
  stickyNoteMaterialPresetIdForStyle,
  type StickyNoteMaterialPresetId,
} from '../../shared/sticky-note-materials'
import { dispatchDocumentFind } from '../editor/document-find-events'
import { StickyNoteEditor } from './StickyNoteEditor'
import { ExternalContextMenuProvider } from '../context-menu/ExternalContextMenuProvider'
import { nextStickyNoteFontSize, type StickyNoteFontSizeChange } from './sticky-note-font-size'
import { StickyNoteSaveStatus } from './StickyNoteSaveStatus'
import { AppIcon } from '../icons/AppIcon'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'
import { StickyNoteToolbar } from './StickyNoteToolbar'
import { stickyNoteStyleCssVariables } from './sticky-note-style'
import { useStickyNoteMaterialEffects } from './use-sticky-note-material-effects'
import { BackgroundImageLayer } from '../backgrounds/BackgroundImageLayer'
import './sticky-note-window.css'

type OperationFailure = { message: string; retry(): void }

export function StickyNoteWindowRoot({ noteId }: { noteId: string }) {
  const businessDialogs = useOptionalBusinessDialog()
  const editorRef = useRef<VisualEditorHandle>(null)
  const latestRevision = useRef(0)
  const initialized = useRef(false)
  const renamePending = useRef(false)
  const pendingEvents = useRef<import('../../shared/sticky-notes').StickyNoteEvent[]>([])
  const [note, setNote] = useState<StickyNoteReadDocument | null>(null)
  const materialEffectStyle = useStickyNoteMaterialEffects(note?.record.style)
  const [markdown, setMarkdown] = useState('')
  const [saveState, setSaveState] = useState<StickyNoteSaveState>({ status: 'idle' })
  const [operationFailure, setOperationFailure] = useState<OperationFailure | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [closePending, setClosePending] = useState(false)
  const [focused, setFocused] = useState(true)
  const [backgroundPresentation, setBackgroundPresentation] = useState<BackgroundPresentation | null>(null)
  const [themeColor, setThemeColor] = useState<string>(DEFAULT_THEME_COLOR)
  const [preferences, setPreferences] = useState<StickyNotePreferences>(() =>
    copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES))

  useEffect(() => {
    document.title = note?.record.name ? note.record.name + ' — Arknote' : '便签 — Arknote'
  }, [note?.record.name])

  useEffect(() => {
    let active = true
    let receivedBackgroundPresentation = false
    initialized.current = false
    pendingEvents.current = []
    const applyEvent = (event: import('../../shared/sticky-notes').StickyNoteEvent) => {
      if (event.type === 'save-state') setSaveState(event.state)
      if (event.type === 'find-request') {
        window.requestAnimationFrame(() => dispatchDocumentFind({ type: 'query', query: event.query }))
        return
      }
      if (!('revision' in event) || event.revision <= latestRevision.current) return
      latestRevision.current = event.revision
      if (event.type === 'note-style-changed') {
        setNote((current) => current ? { ...current, record: { ...current.record, style: event.style } } : current)
      }
      if (event.type === 'note-name-changed') {
        setNote((current) => current ? { ...current, record: { ...current.record, name: event.name } } : current)
      }
      if (event.type === 'note-font-size-changed') {
        setNote((current) => current ? { ...current, record: { ...current.record, fontSizePx: event.fontSizePx } } : current)
      }
      if (event.type === 'note-line-spacing-changed') {
        setNote((current) => current ? {
          ...current,
          record: { ...current.record, lineSpacingMode: event.lineSpacingMode },
        } : current)
      }
      if (event.type === 'note-display-state-changed') {
        setNote((current) => current ? { ...current, record: { ...current.record, released: event.displayed, pinned: event.pinned } } : current)
      }
      // Summaries refresh box data; they must not overwrite an open editor record.
    }
    const unsubscribe = window.arkdown.onStickyNoteEvent((event) => {
      if (!active || event.noteId !== noteId) return
      if (!initialized.current) {
        pendingEvents.current.push(event)
        return
      }
      applyEvent(event)
    })
    const unsubscribeBackgroundPresentation = window.arkdown.onBackgroundPresentation?.((event) => {
      if (
        !active
        || event.target.kind !== 'sticky-note'
        || event.target.noteId !== noteId
      ) return
      receivedBackgroundPresentation = true
      setBackgroundPresentation(event.presentation)
    }) ?? (() => {})
    let themeEventRevision = 0
    const initialThemeRevision = themeEventRevision
    const unsubscribeTheme = window.arkdown.onArknoteThemeColorChanged?.((nextThemeColor) => {
      if (!active) return
      themeEventRevision += 1
      setThemeColor(nextThemeColor)
    }) ?? (() => {})
    void window.arkdown.getArknotePreferences?.().then((result) => {
      if (active && result.ok && themeEventRevision === initialThemeRevision) {
        setThemeColor(result.value.themeColor)
      }
    })
    void window.arkdown.getStickyNotePreferences?.().then((result) => {
      if (active && result.ok) setPreferences(result.value)
    })
    void window.arkdown.readStickyNote(noteId).then((result) => {
      if (!active) return
      if (result.ok) {
        setNote(result.value)
        setMarkdown(result.value.markdown)
        const getBackgroundPresentation = window.arkdown.getBackgroundPresentation
        if (getBackgroundPresentation) {
          void getBackgroundPresentation({ kind: 'sticky-note', noteId }).then((presentation) => {
            if (active && !receivedBackgroundPresentation && presentation.ok) {
              setBackgroundPresentation(presentation.value)
            }
          })
        }
        initialized.current = true
        const queued = pendingEvents.current
        pendingEvents.current = []
        queued.forEach(applyEvent)
      } else {
        setError(result.error.message)
      }
    })
    return () => {
      active = false
      initialized.current = false
      pendingEvents.current = []
      unsubscribe()
      unsubscribeBackgroundPresentation()
      unsubscribeTheme()
    }
  }, [noteId])

  useEffect(() => {
    const onFocus = () => {
      setFocused(true)
      void window.arkdown.getStickyNotePreferences?.().then((result) => {
        if (result.ok) setPreferences(result.value)
      })
    }
    const onBlur = () => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    if (!note) return
    let frame = 0
    let attempts = 0
    let stableFrames = 0
    const measureWhenReady = () => {
      const editor = document.querySelector<HTMLElement>('.sticky-note-editor .ProseMirror')
      if (!editor) {
        attempts += 1
        if (attempts < 120) frame = window.requestAnimationFrame(measureWhenReady)
        return
      }
      stableFrames += 1
      if (stableFrames < 8) {
        frame = window.requestAnimationFrame(measureWhenReady)
        return
      }
      const scrollWidth = Math.max(0, Math.min(10_000, Math.ceil(editor.scrollWidth)))
      const scrollHeight = Math.max(0, Math.min(10_000, Math.ceil(editor.scrollHeight)))
      void window.arkdown.resizeStickyNoteToContent(noteId, { scrollWidth, scrollHeight })
    }
    frame = window.requestAnimationFrame(measureWhenReady)
    return () => window.cancelAnimationFrame(frame)
  }, [note, noteId])

  const stageMarkdown = useCallback((nextMarkdown: string) => {
    setMarkdown(nextMarkdown)
    void window.arkdown.stageStickyNoteSave(noteId, nextMarkdown).then((result) => {
      if (!result.ok) {
        setSaveState({ status: 'error', revision: 0, message: result.error.message })
      }
    })
  }, [noteId])

  const attemptClose = useCallback(async () => {
    setClosePending(true)
    const flushedMarkdown = editorRef.current?.flush()
    if (typeof flushedMarkdown === 'string' && flushedMarkdown !== markdown) {
      setMarkdown(flushedMarkdown)
      const staged = await window.arkdown.stageStickyNoteSave(noteId, flushedMarkdown)
      if (!staged.ok) {
        setSaveState({ status: 'error', revision: 0, message: staged.error.message })
        return
      }
    }
    const saved = await window.arkdown.flushStickyNoteSave(noteId)
    if (!saved.ok) {
      setSaveState({ status: 'error', revision: 0, message: saved.error.message })
      return
    }
    setSaveState(saved.value)
    if (saved.value.status === 'error') return
    const closed = await window.arkdown.closeStickyNote(noteId)
    if (!closed.ok) {
      setSaveState({ status: 'error', revision: 0, message: closed.error.message })
      return
    }
    setClosePending(false)
  }, [markdown, noteId])

  const retrySave = useCallback(async () => {
    const staged = await window.arkdown.stageStickyNoteSave(noteId, markdown)
    if (!staged.ok) { setSaveState({ status: 'error', revision: 0, message: staged.error.message }); return }
    const saved = await window.arkdown.flushStickyNoteSave(noteId)
    if (!saved.ok) { setSaveState({ status: 'error', revision: 0, message: saved.error.message }); return }
    setSaveState(saved.value)
    if (saved.value.status === 'error' || !closePending) return
    const closed = await window.arkdown.closeStickyNote(noteId)
    if (!closed.ok) setSaveState({ status: 'error', revision: 0, message: closed.error.message })
    else setClosePending(false)
  }, [closePending, markdown, noteId])

  const togglePinned = useCallback(async () => {
    if (!note) return
    const pinned = !note.record.pinned
    const result = await window.arkdown.setStickyNotePinned(noteId, pinned)
    if (!result.ok) {
      setOperationFailure({ message: result.error.message, retry: () => void togglePinned() })
      return
    }
    setOperationFailure(null)
    setNote((current) => current ? {
      ...current,
      record: { ...current.record, pinned },
    } : current)
  }, [note, noteId])

  const updateFontSize = useCallback(async (change: StickyNoteFontSizeChange) => {
    if (!note) return
    const fontSizePx = nextStickyNoteFontSize(note.record.fontSizePx ?? DEFAULT_STICKY_NOTE_FONT_SIZE_PX, change)
    if (fontSizePx === null) return
    const setFontSize = window.arkdown.setStickyNoteFontSize
    if (!setFontSize) { setOperationFailure({ message: '字号控制暂不可用', retry: () => void updateFontSize(change) }); return }
    const result = await setFontSize(noteId, fontSizePx)
    if (!result.ok) setOperationFailure({ message: result.error.message, retry: () => void updateFontSize(change) })
    else setOperationFailure(null)
  }, [note, noteId])

  const updateLineSpacingMode = useCallback(async (lineSpacingMode: StickyNoteLineSpacingMode) => {
    if (!note) return
    const setter = window.arkdown.setStickyNoteLineSpacingMode
    if (!setter) {
      setOperationFailure({
        message: '\u884c\u95f4\u8ddd\u63a7\u5236\u6682\u4e0d\u53ef\u7528',
        retry: () => void updateLineSpacingMode(lineSpacingMode),
      })
      return
    }
    const result = await setter(noteId, lineSpacingMode)
    if (!result.ok) {
      setOperationFailure({
        message: result.error.message,
        retry: () => void updateLineSpacingMode(lineSpacingMode),
      })
    } else setOperationFailure(null)
  }, [note, noteId])

  const setStylePart = useCallback(async (
    part: 'color' | 'texture',
    presetId: StickyNoteColorPresetId | StickyNoteTexturePresetId,
  ) => {
    if (!note) return
    const current = note.record.style
    const style = current.mode === 'independent' && part === 'color' && presetId === 'custom'
      ? current
      : current.mode === 'preset'
      ? {
          ...current,
          ...(part === 'color'
            ? { colorPresetId: presetId as StickyNoteColorPresetId }
            : { texturePresetId: presetId as StickyNoteTexturePresetId }),
        }
      : {
          mode: 'preset' as const,
          colorPresetId: part === 'color' ? presetId as StickyNoteColorPresetId : 'yellow' as const,
          texturePresetId: part === 'texture' ? presetId as StickyNoteTexturePresetId : 'plain' as const,
        }
    const result = await window.arkdown.setStickyNoteStyle(noteId, style)
    if (!result.ok) {
      setOperationFailure({
        message: result.error.message,
        retry: () => void setStylePart(part, presetId),
      })
    } else setOperationFailure(null)
  }, [note, noteId])

  const setMaterial = useCallback(async (materialPresetId: StickyNoteMaterialPresetId) => {
    if (!note) return
    const result = await window.arkdown.setStickyNoteStyle(noteId, {
      mode: 'material',
      materialPresetId,
    })
    if (!result.ok) {
      setOperationFailure({
        message: result.error.message,
        retry: () => void setMaterial(materialPresetId),
      })
    } else setOperationFailure(null)
  }, [note, noteId])

  const rename = useCallback(async () => {
    if (!note || renamePending.current) return
    if (!businessDialogs) {
      setOperationFailure({ message: '输入弹窗暂不可用', retry: () => void rename() })
      return
    }
    renamePending.current = true
    try {
      const name = await businessDialogs.prompt({
        title: '重命名便签',
        defaultValue: note.record.name,
        inputLabel: '便签名',
        fieldStyle: 'standard',
        confirmLabel: '重命名',
        cancelLabel: '取消',
      })
      if (name === null) return
      const result = await window.arkdown.renameStickyNote(noteId, name.trim())
      if (!result.ok) setOperationFailure({ message: result.error.message, retry: () => void rename() })
      else setOperationFailure(null)
    } catch {
      setOperationFailure({ message: '重命名未能完成，请重试', retry: () => void rename() })
    } finally {
      renamePending.current = false
    }
  }, [businessDialogs, note, noteId])

  async function archiveAfterConfirmation(): Promise<void> {
    const flushedMarkdown = editorRef.current?.flush()
    if (typeof flushedMarkdown === 'string' && flushedMarkdown !== markdown) {
      setMarkdown(flushedMarkdown)
      const staged = await window.arkdown.stageStickyNoteSave(noteId, flushedMarkdown)
      if (!staged.ok) {
        setOperationFailure({
          message: `保存失败：${staged.error.message}`,
          retry: () => void archiveAfterConfirmation(),
        })
        return
      }
    }
    const saved = await window.arkdown.flushStickyNoteSave(noteId)
    if (!saved.ok) {
      setOperationFailure({
        message: `保存失败：${saved.error.message}`,
        retry: () => void archiveAfterConfirmation(),
      })
      return
    }
    setSaveState(saved.value)
    if (saved.value.status === 'error') {
      setOperationFailure({
        message: `保存失败：${saved.value.message}`,
        retry: () => void archiveAfterConfirmation(),
      })
      return
    }
    const result = await window.arkdown.archiveStickyNote(noteId)
    if (!result.ok) {
      setOperationFailure({
        message: result.error.message,
        retry: () => void archiveAfterConfirmation(),
      })
    } else setOperationFailure(null)
  }

  async function archive(): Promise<void> {
    if (!businessDialogs) {
      setOperationFailure({ message: '确认弹窗暂不可用', retry: () => void archive() })
      return
    }
    const confirmation = await businessDialogs.confirm({
      title: '归档便签',
      description: '确定归档这张便签吗？',
      confirmLabel: '归档',
      cancelLabel: '取消',
    })
    if (confirmation !== 'confirm') return
    await archiveAfterConfirmation()
  }

  const insertImage = useCallback(async () => {
    const chooseImage = window.arkdown.chooseStickyNoteImage
    if (!chooseImage) {
      setOperationFailure({ message: '图片导入暂不可用', retry: () => void insertImage() })
      return
    }
    const result = await chooseImage(noteId)
    if (!result.ok) {
      setOperationFailure({ message: result.error.message, retry: () => void insertImage() })
      return
    }
    if (result.value === null) return
    setOperationFailure(null)
    window.dispatchEvent(new CustomEvent('arkdown:insert-markdown', { detail: result.value }))
  }, [noteId])

  const openBackgroundSettings = useCallback(async () => {
    const opener = window.arkdown.openBackgroundSettings
    if (!opener) {
      setOperationFailure({ message: '背景设置暂不可用', retry: () => void openBackgroundSettings() })
      return
    }
    const result = await opener({ kind: 'sticky-note', noteId })
    if (!result.ok) {
      setOperationFailure({
        message: result.error.message,
        retry: () => void openBackgroundSettings(),
      })
    } else setOperationFailure(null)
  }, [noteId])

  if (error) return <main role="alert">{error}</main>
  if (!note) return <main>正在读取便签...</main>

  const materialPresetId = stickyNoteMaterialPresetIdForStyle(note.record.style)
  const materialDescriptor = materialPresetId
    ? stickyNoteMaterialDescriptor(materialPresetId)
    : null
  return (
    <ExternalContextMenuProvider>
    <main
      className="sticky-note-window"
      data-color-scheme={materialDescriptor?.colorScheme}
      data-focused={focused ? 'true' : 'false'}
      data-line-spacing-mode={note.record.lineSpacingMode}
      data-material-preset={materialPresetId ?? undefined}
      data-surface="sticky-note"
      style={{
        ...stickyNoteStyleCssVariables(note.record.style, preferences),
        ...materialEffectStyle,
        '--sticky-note-font-size': (note.record.fontSizePx ?? DEFAULT_STICKY_NOTE_FONT_SIZE_PX) + 'px',
        '--theme-color-rgb': themeColorRgbChannels(themeColor),
      } as CSSProperties}
    >
      <header className="sticky-note-titlebar">
        <button
          aria-label={note.record.pinned ? '取消置顶' : '置顶便签'}
          aria-pressed={note.record.pinned}
          data-tooltip={note.record.pinned ? '取消置顶' : '置顶便签'}
          onClick={() => void togglePinned()}
          type="button"
        >
          <StickyNoteActionIcon kind={note.record.pinned ? 'pin' : 'unpin'} size={18} />
        </button>
        <h1><span
          className="sticky-note-title-text"
          data-tooltip="双击重命名"
          onDoubleClick={() => void rename()}
        >{note.record.name}</span></h1>
        <button aria-label="关闭便签" onClick={() => void attemptClose()} type="button">
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="sticky-note-editor-region">
        <BackgroundImageLayer
          anchor={(backgroundPresentation?.settings ?? note.record.background).imageAlignment}
          imageUrl={backgroundPresentation?.imageUrl ?? null}
          settings={backgroundPresentation?.settings ?? note.record.background}
        />
        <StickyNoteEditor
          documentKey={noteId + (closePending ? ':closing' : '')}
          documentAbsolutePath={note.documentAbsolutePath}
          readClipboardImage={async () => {
            if (closePending || !window.arkdown.pasteClipboardImage) return null
            const result = await window.arkdown.pasteClipboardImage({ noteId })
            if (!result.ok) throw new Error(result.error.message)
            return result.value
          }}
          focused={focused}
          fontSizePx={note.record.fontSizePx ?? DEFAULT_STICKY_NOTE_FONT_SIZE_PX}
          lineSpacingMode={note.record.lineSpacingMode}
          markdown={markdown}
          preferences={preferences}
          style={note.record.style}
          onAdjustFontSize={updateFontSize}
          onArchive={archive}
          onChange={stageMarkdown}
          onInsertImage={insertImage}
          onOpenBackgroundSettings={openBackgroundSettings}
          onRename={rename}
          onSetColor={(presetId) => void setStylePart('color', presetId)}
          onSetLineSpacingMode={updateLineSpacingMode}
          onSetMaterial={setMaterial}
          onSetTexture={(presetId) => void setStylePart('texture', presetId)}
          ref={editorRef}
        />
      </div>
      <StickyNoteSaveStatus
        state={saveState.status === 'error' ? { status: 'idle' } : saveState}
      />
      {(operationFailure || saveState.status === 'error') && (() => {
        const visible = operationFailure ?? {
          message: saveState.status === 'error' ? `保存失败：${saveState.message}` : '',
          retry: () => void retrySave(),
        }
        return <div className="sticky-note-save-status is-error" role="alert"><span>{visible.message}</span><button onClick={visible.retry} type="button">重试</button>{closePending && !operationFailure && <button onClick={() => setClosePending(false)} type="button">取消关闭</button>}</div>
      })()}
      <StickyNoteToolbar />
    </main>
    </ExternalContextMenuProvider>
  )
}
