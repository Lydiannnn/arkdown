import { StickyNoteActionIcon } from './StickyNoteActionIcon'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import { MAX_ACTIVE_STICKY_NOTES, type StickyNoteStatus, type StickyNoteSummary } from '../../shared/sticky-notes'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  copyStickyNotePreferences,
  type StickyNoteColorPresetId,
  type StickyNotePreferences,
  type StickyNoteTexturePresetId,
} from '../../shared/sticky-note-preferences'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'
import { STICKY_NOTE_CARD_DRAG_TYPE, StickyNoteGrid } from './StickyNoteGrid'
import { StickyNoteNameDialog } from './StickyNoteNameDialog'
import { buildActiveStickyNoteMenu } from './sticky-note-menu-model'
import { stickyNoteMaterialForCommand } from './sticky-note-context-menu'
import { buildArchivedStickyNoteMenu } from './archived-sticky-note-menu-model'
import { defaultStickyNoteName } from '../../main/sticky-notes/sticky-note-name'
import { ArchivedStickyNotePreview } from './ArchivedStickyNotePreview'
import { StickyNoteSearch } from './StickyNoteSearch'
import { StickyNoteStartupHint } from './StickyNoteStartupHint'
import { StickyNoteArchiveToast } from './StickyNoteArchiveToast'
import { AppIcon } from '../icons/AppIcon'
import { arknotePreferencesForUpdate, type ArknotePreferences } from '../../shared/arknote-preferences'
import type { ApiResult } from '../../shared/contracts'
import {
  ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE,
  applyArchivedMarquee,
  decodeArchivedStickyNoteDragIds,
  selectArchivedCard,
  type ArchivedSelectionState,
  type SelectionModifiers,
} from './archived-sticky-note-selection'
import './sticky-note-box.css'

interface StickyNoteBoxPanelProps { onClose(): void }
const IMPORTABLE_NOTE_PATTERN = /\.(?:md|markdown|txt)$/iu
function fileNameFromPath(path: string): string { return path.split(/[\\/]/u).at(-1) ?? path }
function thrownOperationMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '操作未能完成'
}
async function callApi<T>(operation: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await operation()
  } catch (error) {
    return { ok: false, error: { code: 'OPERATION_FAILED', message: thrownOperationMessage(error) } }
  }
}

export function StickyNoteBoxPanel({ onClose }: StickyNoteBoxPanelProps) {
  const contextMenu = useOptionalContextMenu()
  const businessDialogs = useOptionalBusinessDialog()
  const [view, setView] = useState<StickyNoteStatus>('active')
  const currentView = useRef(view)
  currentView.current = view
  const [notes, setNotes] = useState<StickyNoteSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const loadVersion = useRef(0)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<StickyNoteSummary | null>(null)
  const [previewNoteId, setPreviewNoteId] = useState<string | null>(null)
  const [previewQuery, setPreviewQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [activeCount, setActiveCount] = useState(0)
  const [createNames, setCreateNames] = useState<string[]>([])
  const [createInitialName, setCreateInitialName] = useState('')
  const [arknotePreferences, setArknotePreferences] = useState<ArknotePreferences | null>(null)
  const [archiveToastToken, setArchiveToastToken] = useState(0)
  const [cardDragging, setCardDragging] = useState(false)
  const [archiveSelection, setArchiveSelection] = useState<ArchivedSelectionState>({
    selectedIds: new Set(),
    anchorId: null,
  })
  const pendingNoteOperations = useRef(new Set<string>())
  const [preferences, setPreferences] = useState<StickyNotePreferences>(() =>
    copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES))
  const load = useCallback(async (background = false) => {
    if (currentView.current !== view) return
    const version = ++loadVersion.current
    if (!background) setLoading(true)
    const [result, activeResult] = await Promise.all([
      callApi(() => window.arkdown.listStickyNotes(view)),
      view === 'active'
        ? Promise.resolve(null)
        : callApi(() => window.arkdown.listStickyNotes('active')),
    ])
    if (version !== loadVersion.current || currentView.current !== view) return
    if (result.ok) {
      const nextNotes = view === 'archived'
        ? [...result.value].sort((left, right) =>
            (right.record.archivedAt ?? '').localeCompare(left.record.archivedAt ?? ''))
        : result.value
      setNotes(nextNotes)
      if (view === 'active') setActiveCount(nextNotes.length)
      else if (activeResult?.ok) setActiveCount(activeResult.value.length)
      setListError(null)
    } else {
      setListError(result.error.message)
    }
    setLoading(false)
  }, [view])
  useEffect(() => {
    setNotes([])
    setListError(null)
    void load()
    return () => { loadVersion.current += 1 }
  }, [load])
  useEffect(() => {
    setArchiveSelection({ selectedIds: new Set(), anchorId: null })
  }, [view, searchOpen, previewNoteId])
  useEffect(() => {
    let active = true
    void window.arkdown.getArknotePreferences?.().then((result) => {
      if (active && result.ok && !result.value.startupHintDismissed) setArknotePreferences(result.value)
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true
    void window.arkdown.getStickyNotePreferences?.().then((result) => {
      if (active && result.ok) setPreferences(result.value)
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const refreshPreferences = () => {
      void window.arkdown.getStickyNotePreferences?.().then((result) => {
        if (result.ok) setPreferences(result.value)
      })
    }
    window.addEventListener('focus', refreshPreferences)
    return () => window.removeEventListener('focus', refreshPreferences)
  }, [])
  useEffect(() => window.arkdown.onStickyNoteEvent((event) => {
    if (event.type === 'index-changed') {
      void load(true)
      return
    }
    if (event.type === 'note-display-state-changed') {
      setNotes((current) => current.map((note) => note.record.id === event.noteId
        ? {
            ...note,
            record: {
              ...note.record,
              released: event.displayed,
              pinned: event.pinned,
            },
          }
        : note))
      return
    }
    if (event.type === 'note-summary-changed') {
      setNotes((current) => current.map((note) =>
        note.record.id === event.noteId ? event.summary : note,
      ))
    }
  }), [load])
  const names = useMemo(() => notes.map((note) => note.record.name), [notes])
  const full = view === 'active' && notes.length >= MAX_ACTIVE_STICKY_NOTES
  const archivedOrder = useMemo(
    () => view === 'archived' ? notes.map(({ record }) => record.id) : [],
    [notes, view],
  )

  const selectArchived = (note: StickyNoteSummary, modifiers: SelectionModifiers) => {
    setArchiveSelection((current) =>
      selectArchivedCard(current, note.record.id, archivedOrder, modifiers))
  }

  const beginArchivedDrag = (note: StickyNoteSummary): readonly string[] => {
    const next = archiveSelection.selectedIds.has(note.record.id)
      ? archiveSelection
      : selectArchivedCard(
          archiveSelection,
          note.record.id,
          archivedOrder,
          { ctrlKey: false, shiftKey: false },
        )
    if (next !== archiveSelection) setArchiveSelection(next)
    return archivedOrder.filter((id) => next.selectedIds.has(id))
  }

  const deleteSelectedArchives = async (noteIds: readonly string[]) => {
    const selectedNotes = noteIds
      .map((id) => notes.find(({ record }) => record.id === id))
      .filter((note): note is StickyNoteSummary => Boolean(note))
    if (selectedNotes.length === 0) return
    const message = selectedNotes.length === 1
      ? `确定要永久删除“${selectedNotes[0].record.name}”吗？此操作不可恢复。`
      : `确定永久删除选中的 ${selectedNotes.length} 个便签吗？`
    if (!businessDialogs) {
      setOperationError('确认弹窗暂不可用')
      return
    }
    const confirmation = await businessDialogs.confirm({
      title: '永久删除便签',
      description: message,
      confirmLabel: '永久删除',
      cancelLabel: '取消',
      tone: 'danger',
    })
    if (confirmation !== 'confirm') return
    const remove = window.arkdown.deleteArchivedStickyNotes
    if (!remove) {
      setOperationError('永久删除服务不可用')
      return
    }
    setOperationError(null)
    const operation = await callApi(() => remove(selectedNotes.map(({ record }) => record.id)))
    if (!operation.ok) {
      setOperationError(operation.error.message)
      return
    }
    const removed = new Set(selectedNotes.map(({ record }) => record.id))
    setNotes((current) => current.filter(({ record }) => !removed.has(record.id)))
    setArchiveSelection({ selectedIds: new Set(), anchorId: null })
    setOperationError(null)
  }

  const beginCreate = async () => {
    setOperationError(null)
    const archived = await callApi(() => window.arkdown.listStickyNotes('archived'))
    if (!archived.ok) {
      setOperationError(archived.error.message)
      return
    }
    const combined = [...names, ...archived.value.map(({ record }) => record.name)]
    setCreateNames(combined)
    setCreateInitialName(defaultStickyNoteName(new Date(), combined))
    setCreating(true)
  }

  const archiveNote = async (note: StickyNoteSummary) => {
    if (pendingNoteOperations.current.has(note.record.id)) return false
    setOperationError(null)
    pendingNoteOperations.current.add(note.record.id)
    try {
      if (note.record.released) {
        const flushed = await callApi(() => window.arkdown.flushStickyNoteSave(note.record.id))
        if (!flushed.ok) { setOperationError(flushed.error.message); return false }
      }
      const operation = await callApi(() => window.arkdown.archiveStickyNote(note.record.id))
      if (!operation.ok) { setOperationError(operation.error.message); return false }
      setNotes((current) => current.filter(({ record }) => record.id !== note.record.id))
      setActiveCount((current) => Math.max(0, current - 1))
      setArchiveToastToken((current) => current + 1)
      await load()
      return true
    } finally {
      pendingNoteOperations.current.delete(note.record.id)
    }
  }

  const toggleNote = async (note: StickyNoteSummary) => {
    if (pendingNoteOperations.current.has(note.record.id)) return
    setOperationError(null)
    pendingNoteOperations.current.add(note.record.id)
    try {
      const operation = note.record.released
        ? await callApi(() => window.arkdown.closeStickyNote(note.record.id))
        : await callApi(() => window.arkdown.openStickyNote(note.record.id))
      if (!operation.ok) { setOperationError(operation.error.message); return }
      setNotes((current) => current.map((candidate) => candidate.record.id === note.record.id
        ? { ...candidate, record: { ...candidate.record, released: !note.record.released } }
        : candidate))
    } finally {
      pendingNoteOperations.current.delete(note.record.id)
    }
  }

  const persistOrder = async (noteIds: readonly string[]) => {
    const reorder = window.arkdown.reorderStickyNotes
    if (!reorder) return false
    setOperationError(null)
    const result = await callApi(() => reorder(noteIds))
    if (!result.ok) { setOperationError(result.error.message); return false }
    setNotes([...result.value])
    return true
  }

  const runCommand = async (
    command: string,
    note: StickyNoteSummary,
    targetIds: readonly string[] = [note.record.id],
  ) => {
    setFeedback(null); setOperationError(null)
    let result: Awaited<ReturnType<typeof window.arkdown.setStickyNoteStyle>> | null = null
    const materialPresetId = stickyNoteMaterialForCommand(command)
    if (materialPresetId) {
      result = await callApi(() => window.arkdown.setStickyNoteStyle(note.record.id, {
        mode: 'material', materialPresetId,
      }))
    } else if (command.startsWith('sticky-color-')) {
      const colorPresetId = command.slice('sticky-color-'.length) as StickyNoteColorPresetId
      const texturePresetId = note.record.style.mode === 'preset' ? note.record.style.texturePresetId : 'plain'
      result = await callApi(() => window.arkdown.setStickyNoteStyle(note.record.id,
        note.record.style.mode === 'independent' && colorPresetId === 'custom'
          ? note.record.style
          : { mode: 'preset', colorPresetId, texturePresetId }))
    } else if (command.startsWith('sticky-texture-')) {
      const texturePresetId = command.slice('sticky-texture-'.length) as StickyNoteTexturePresetId
      const colorPresetId = note.record.style.mode === 'preset' ? note.record.style.colorPresetId : 'yellow'
      result = await callApi(() => window.arkdown.setStickyNoteStyle(note.record.id, { mode: 'preset', colorPresetId, texturePresetId }))
    } else if (command === 'sticky-release') {
      const operation = await callApi(() => window.arkdown.releaseStickyNote(note.record.id))
      if (!operation.ok) setOperationError(operation.error.message)
    } else if (command === 'sticky-reclaim') {
      const operation = await callApi(() => window.arkdown.reclaimStickyNote(note.record.id))
      if (!operation.ok) setOperationError(operation.error.message)
    } else if (command === 'sticky-rename') {
      if (targetIds.length > 1) return
      setRenaming(note); return
    } else if (command === 'sticky-restore') {
      if (activeCount + targetIds.length > MAX_ACTIVE_STICKY_NOTES) {
        setOperationError('便签盒子剩余位置不足，无法恢复所选便签')
        return
      }
      const restoreArchived = window.arkdown.restoreArchivedStickyNotes
      if (!restoreArchived) {
        setOperationError('批量恢复服务不可用')
        return
      }
      const operation = await callApi(() => restoreArchived(targetIds))
      if (!operation.ok) {
        setOperationError(operation.error.message)
        return
      }
      setArchiveSelection({ selectedIds: new Set(), anchorId: null })
      setPreviewNoteId(null)
    } else if (command === 'sticky-archive') {
      await archiveNote(note)
    } else if (command === 'sticky-delete') {
      if (view === 'archived') {
        await deleteSelectedArchives(targetIds)
        return
      }
      const message = `确定要删除“${note.record.name}”吗？此操作无法撤销。`
      if (!businessDialogs) {
        setOperationError('确认弹窗暂不可用')
        return
      }
      const confirmation = await businessDialogs.confirm({
        title: '删除便签',
        description: message,
        confirmLabel: '删除',
        cancelLabel: '取消',
        tone: 'danger',
      })
      if (confirmation !== 'confirm') return
      const operation = await callApi(() => window.arkdown.deleteStickyNote(note.record.id))
      if (!operation.ok) setOperationError(operation.error.message)
    }
    if (result && !result.ok) setOperationError(result.error.message)
    await load()
  }

  const openNoteMenu = (event: MouseEvent, note: StickyNoteSummary) => {
    if (!contextMenu) return
    event.preventDefault(); event.stopPropagation()
    const target = event.currentTarget as HTMLElement
    let targetIds: readonly string[] = [note.record.id]
    if (view === 'archived') {
      if (archiveSelection.selectedIds.has(note.record.id)) {
        targetIds = archivedOrder.filter((id) => archiveSelection.selectedIds.has(id))
      } else {
        setArchiveSelection({
          selectedIds: new Set([note.record.id]),
          anchorId: note.record.id,
        })
      }
    }
    const remainingSlots = Math.max(0, MAX_ACTIVE_STICKY_NOTES - activeCount)
    contextMenu.openMenu({
      x: event.clientX,
      y: event.clientY,
      widthCssPx: 200,
      submenuWidthCssPx: 200,
      rootIconGutter: 'none',
      items: view === 'active'
        ? buildActiveStickyNoteMenu(note, preferences)
        : buildArchivedStickyNoteMenu(note, remainingSlots, targetIds.length),
      execute: (command) => runCommand(command, note, targetIds),
      restoreFocus: () => target.focus(),
    })
  }

  const importFiles = async (files: FileList) => {
    if (view !== 'active') return
    setFeedback(null); setOperationError(null)
    let available = Math.max(0, MAX_ACTIVE_STICKY_NOTES - notes.length)
    if (available === 0) { setFeedback('标签盒子已满，建议将不常用标签进行归档'); return }
    const unsupported: string[] = []
    const warningNames: string[] = []
    for (const file of Array.from(files)) {
      if (!IMPORTABLE_NOTE_PATTERN.test(file.name)) { unsupported.push(file.name); continue }
      if (available === 0) { setFeedback('标签盒子已满，建议将不常用标签进行归档'); break }
      const absolutePath = window.arkdown.pathForDroppedFile(file)
      if (!absolutePath) { setOperationError(`无法读取拖入文件的 Windows 路径：${file.name}`); continue }
      const result = await callApi(() => window.arkdown.importStickyNote(absolutePath))
      if (!result.ok) { setOperationError(result.error.message); continue }
      available -= 1
      warningNames.push(...result.value.warnings.map((warning) => fileNameFromPath(warning.source)))
    }
    const messages: string[] = []
    if (unsupported.length) messages.push(`不支持导入：${unsupported.join('、')}`)
    if (warningNames.length) messages.push(`部分引用资源未能复制：${warningNames.join('、')}`)
    if (messages.length) setFeedback(messages.join('；'))
    await load()
  }

  return <aside
    aria-label="便签盒子"
    className="sticky-note-box-panel"
    data-card-dragging={cardDragging}
    data-view={view}
    onKeyDown={(event) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== 'f') return
      event.preventDefault()
      setSearchOpen((current) => !current)
    }}
    tabIndex={-1}
  >
    <header className="sticky-note-box-header">
      <h2>{view === 'active' ? '便签盒子 — Arknote' : '归档'}</h2>
      <button
        aria-label={view === 'active' ? '关闭便签盒子' : '返回便签盒子'}
        onClick={() => {
          if (view === 'active') {
            onClose()
            return
          }
          setFeedback(null)
          setPreviewNoteId(null)
          setPreviewQuery('')
          setSearchOpen(false)
          setView('active')
        }}
        type="button"
      ><AppIcon name="close" size={18} /></button>
    </header>
    <div className="sticky-note-box-content" data-view={view}>
      {previewNoteId && view === 'archived'
        ? <ArchivedStickyNotePreview
            initialPreferences={preferences}
            initialQuery={previewQuery}
            noteId={previewNoteId}
            onClose={() => { setPreviewNoteId(null); setPreviewQuery('') }}
          />
        : searchOpen
          ? <StickyNoteSearch
              onClose={() => setSearchOpen(false)}
              onSelect={(result, query) => {
                if (view === 'active') {
                  setOperationError(null)
                  void callApi(() => window.arkdown.openStickyNote(result.noteId, query)).then((operation) => {
                    if (!operation.ok) setOperationError(operation.error.message)
                  })
                } else {
                  setSearchOpen(false)
                  setPreviewQuery(query)
                  setPreviewNoteId(result.noteId)
                }
              }}
              status={view}
            />
          : <>
            {loading && <p className="sticky-note-box-message">正在读取便签…</p>}
            {listError && <p className="sticky-note-box-error" role="alert">{listError}</p>}
            {operationError && <p className="sticky-note-box-error" role="alert">{operationError}</p>}
            {!loading && (view === 'active'
              ? <StickyNoteGrid
                  createDisabled={full}
                  label="便签"
                  notes={notes}
                  onContextMenu={openNoteMenu}
                  onCreate={() => { void beginCreate() }}
                  onDropFiles={importFiles}
                  onDragStateChange={setCardDragging}
                  onOpen={(note) => { void toggleNote(note) }}
                  onReorder={persistOrder}
                  preferences={preferences}
                  showCreate
                />
              : <StickyNoteGrid
                  interactionMode="archive"
                  label="归档便签"
                  notes={notes}
                  onArchiveDragStart={beginArchivedDrag}
                  onContextMenu={openNoteMenu}
                  onDragStateChange={setCardDragging}
                  onMarqueeChange={(hitIds, ctrlKey) => {
                    setArchiveSelection((current) =>
                      applyArchivedMarquee(current, hitIds, ctrlKey))
                  }}
                  onOpenArchived={(note) => {
                    setPreviewQuery('')
                    setPreviewNoteId(note.record.id)
                  }}
                  onSelectArchived={selectArchived}
                  preferences={preferences}
                  selectedIds={archiveSelection.selectedIds}
                />)}
            {full && <p className="sticky-note-box-capacity" role="status">标签盒子已满，建议将不常用标签进行归档</p>}
            {feedback && feedback !== '标签盒子已满，建议将不常用标签进行归档' && <p className="sticky-note-box-feedback" role="status">{feedback}</p>}
          </>}
      {view === 'archived' && !previewNoteId && !searchOpen && <button
        aria-label="永久删除归档便签"
        className="sticky-note-permanent-delete-target"
        onDragOver={(event: DragEvent<HTMLButtonElement>) => {
          if (!event.dataTransfer.types.includes(ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event: DragEvent<HTMLButtonElement>) => {
          const noteIds = decodeArchivedStickyNoteDragIds(
            event.dataTransfer.getData(ARCHIVED_STICKY_NOTE_CARD_DRAG_TYPE),
          )
          if (noteIds.length === 0) return
          event.preventDefault()
          event.stopPropagation()
          setCardDragging(false)
          void deleteSelectedArchives(noteIds)
        }}
        type="button"
      ><StickyNoteActionIcon className="sticky-note-drop-target-icon" kind="trash" /></button>}
    </div>
    <div aria-label="便签视图" className="sticky-note-box-tabs" role="tablist">
      {view === 'active' && <button
        aria-label="归档便签"
        className="sticky-note-recycle-target"
        onDragOver={(event: DragEvent<HTMLButtonElement>) => {
          if (!event.dataTransfer.types.includes(STICKY_NOTE_CARD_DRAG_TYPE)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }}
        onDrop={(event: DragEvent<HTMLButtonElement>) => {
          const noteId = event.dataTransfer.getData(STICKY_NOTE_CARD_DRAG_TYPE)
          const note = notes.find(({ record }) => record.id === noteId)
          if (!note) return
          event.preventDefault()
          event.stopPropagation()
          setCardDragging(false)
          void archiveNote(note)
        }}
        type="button"
      ><StickyNoteActionIcon className="sticky-note-drop-target-icon" kind="archive" /></button>}
      <button
        aria-selected={view === 'active'}
        onClick={() => {
          setFeedback(null)
          setPreviewNoteId(null)
          setPreviewQuery('')
          setSearchOpen(false)
          setView('active')
        }}
        role="tab"
        type="button"
      >便签</button>
      <button
        aria-selected={view === 'archived'}
        onClick={() => {
          setFeedback(null)
          setPreviewNoteId(null)
          setPreviewQuery('')
          setSearchOpen(false)
          setView('archived')
        }}
        role="tab"
        type="button"
      >归档</button>
    </div>
    <StickyNoteArchiveToast token={archiveToastToken} />
    {arknotePreferences && <StickyNoteStartupHint
      onDismiss={async () => {
        const setPreferences = window.arkdown.setArknotePreferences
        if (!setPreferences) return false
        const result = await setPreferences(arknotePreferencesForUpdate(arknotePreferences, { startupHintDismissed: true }))
        if (!result.ok) { setOperationError(result.error.message); return false }
        setArknotePreferences(result.value)
        return true
      }}
      onEnable={async () => {
        const setPreferences = window.arkdown.setArknotePreferences
        if (!setPreferences) return false
        const result = await setPreferences(arknotePreferencesForUpdate(arknotePreferences, { launchAtLogin: true, startupHintDismissed: true }))
        if (!result.ok) { setOperationError(result.error.message); return false }
        setArknotePreferences(null)
        return true
      }}
    />}
    {creating && <StickyNoteNameDialog existingNames={createNames} initialValue={createInitialName} onCancel={() => setCreating(false)} onSubmit={async (name) => {
      setOperationError(null)
      const result = await callApi(() => window.arkdown.createStickyNote({ name })); if (!result.ok) return result.error.message
      setNotes((current) => current.some(({ record }) => record.id === result.value.record.id)
        ? current
        : [...current, { record: result.value.record, excerpt: '' }])
      setActiveCount((current) => Math.min(MAX_ACTIVE_STICKY_NOTES, current + 1))
      await load()
      const opened = await callApi(() => window.arkdown.openStickyNote(result.value.record.id))
      if (!opened.ok) setOperationError(`已创建，但打开失败：${opened.error.message}`)
      return null
    }} title="创建新便签" />}
    {renaming && <StickyNoteNameDialog confirmLabel="重命名" currentName={renaming.record.name} existingNames={names} initialValue={renaming.record.name} onCancel={() => setRenaming(null)} onSubmit={async (name) => {
      setOperationError(null)
      const result = await callApi(() => window.arkdown.renameStickyNote(renaming.record.id, name)); if (!result.ok) return result.error.message
      await load(); return null
    }} title="重命名便签" />}
  </aside>
}
