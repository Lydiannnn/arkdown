import type {
  CreateStickyNoteInput,
  StickyNoteContentMeasurement,
  StickyNoteDocument,
  StickyNoteEvent,
  StickyNoteImportResult,
  StickyNoteLineSpacingMode,
  StickyNoteSelectionImportInput,
  StickyNoteRecord,
  StickyNoteSaveState,
  StickyNoteSearchInput,
  StickyNoteSearchResult,
  StickyNoteStatus,
  StickyNoteSummary,
} from '../../shared/sticky-notes'
import { MAX_STICKY_NOTE_FONT_SIZE_PX, MIN_STICKY_NOTE_FONT_SIZE_PX } from '../../shared/sticky-notes'
import type { StickyNoteStyleReference } from '../../shared/sticky-note-preferences'
import type { BackgroundSettings } from '../../shared/background-settings'
import type { BackgroundImageUpdate } from './sticky-note-store'

interface StickyNoteRuntimeStore {
  list(status: StickyNoteStatus): Promise<StickyNoteSummary[]>
  reorderActiveNotes?(noteIds: readonly string[]): Promise<StickyNoteSummary[]>
  get(noteId: string): Promise<StickyNoteDocument>
  create(input: CreateStickyNoteInput): Promise<StickyNoteDocument>
  rename(noteId: string, name: string): Promise<StickyNoteDocument>
  archive(noteId: string): Promise<StickyNoteDocument>
  restore(noteId: string): Promise<StickyNoteDocument>
  restoreArchived?(noteIds: readonly string[]): Promise<void>
  delete(noteId: string): Promise<void>
  deleteArchived?(noteIds: readonly string[]): Promise<void>
  updateRecord(
    noteId: string,
    updater: (record: StickyNoteRecord) => StickyNoteRecord,
  ): Promise<StickyNoteRecord>
  copyImageResource?(noteId: string, absolutePath: string): Promise<string>
  setBackground?(noteId: string, background: BackgroundSettings): Promise<StickyNoteRecord>
  applyBackground?(
    noteId: string,
    background: BackgroundSettings,
    imageUpdate: BackgroundImageUpdate,
    assertCurrent?: () => void,
  ): Promise<StickyNoteRecord>
  replaceBackgroundImage?(noteId: string, absolutePath: string): Promise<StickyNoteRecord>
  resolveBackgroundImagePath?(noteId: string): Promise<string | null>
}

interface StickyNoteRuntimeImporter {
  importFile(absolutePath: string): Promise<StickyNoteImportResult>
  importMarkdown?(input: {
    suggestedName: string
    markdown: string
    sourceDirectory: string | null
  }): Promise<StickyNoteImportResult>
}

interface StickyNoteRuntimeSaveCoordinator {
  stage(noteId: string, markdown: string): void
  flush(noteId: string): Promise<StickyNoteSaveState>
  subscribe(
    listener: (noteId: string, state: StickyNoteSaveState) => void,
  ): () => void
}

interface StickyNoteRuntimeSearchIndex {
  search(input: StickyNoteSearchInput): Promise<StickyNoteSearchResult[]>
  refresh(noteId: string): Promise<void>
}

interface StickyNoteRuntimeWindows {
  open(noteId: string, options?: { autoSize?: boolean; findQuery?: string }): Promise<void>
  close(noteId: string): Promise<void>
  reclaim(noteId: string): Promise<void>
  applyStyle(noteId: string, style: StickyNoteStyleReference): void
  setPinned(noteId: string, pinned: boolean): Promise<void>
  resizeToContent(
    noteId: string,
    measurement: StickyNoteContentMeasurement,
  ): Promise<void>
}

export interface StickyNoteRuntimeOptions {
  store: StickyNoteRuntimeStore
  importer: StickyNoteRuntimeImporter
  saveCoordinator: StickyNoteRuntimeSaveCoordinator
  windows: StickyNoteRuntimeWindows
  searchIndex?: StickyNoteRuntimeSearchIndex
  reportError?: (error: unknown) => void
}

function summaryExcerpt(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/[\x60*_>#|[\]()-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160)
}

export class StickyNoteRuntime {
  private readonly listeners = new Set<(event: StickyNoteEvent) => void>()
  private readonly revisions = new Map<string, number>()
  private readonly reportError: (error: unknown) => void

  constructor(private readonly options: StickyNoteRuntimeOptions) {
    this.reportError = options.reportError ?? (() => undefined)
    options.saveCoordinator.subscribe((noteId, state) => {
      this.emit({ type: 'save-state', noteId, state })
      if (state.status === 'saved') {
        void options.searchIndex?.refresh(noteId)
        void this.emitSummary(noteId)
      }
    })
  }

  private nextRevision(noteId: string): number {
    const revision = (this.revisions.get(noteId) ?? 0) + 1
    this.revisions.set(noteId, revision)
    return revision
  }

  private async emitSummary(noteId: string): Promise<void> {
    const revision = this.nextRevision(noteId)
    try {
      const note = await this.options.store.get(noteId)
      this.emit({
        type: 'note-summary-changed', noteId, revision,
        summary: { record: note.record, excerpt: summaryExcerpt(note.markdown) },
      })
    } catch {
      // Reading a just-saved summary must not alter the retryable save result.
    }
  }

  private emit(event: StickyNoteEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A renderer subscriber cannot break persistence or window lifecycle.
      }
    }
  }

  subscribe(listener: (event: StickyNoteEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  list(status: StickyNoteStatus): Promise<StickyNoteSummary[]> {
    return this.options.store.list(status)
  }

  async reorder(noteIds: readonly string[]): Promise<StickyNoteSummary[]> {
    if (!this.options.store.reorderActiveNotes) throw new Error('Sticky note reorder is unavailable')
    const summaries = await this.options.store.reorderActiveNotes(noteIds)
    this.emit({ type: 'index-changed', noteId: null })
    return summaries
  }

  read(noteId: string): Promise<StickyNoteDocument> {
    return this.options.store.get(noteId)
  }

  search(input: StickyNoteSearchInput): Promise<StickyNoteSearchResult[]> {
    if (!this.options.searchIndex) throw new Error('便签搜索暂不可用')
    return this.options.searchIndex.search(input)
  }

  private refreshSearch(noteId: string): Promise<void> {
    return this.options.searchIndex?.refresh(noteId) ?? Promise.resolve()
  }

  async create(input: CreateStickyNoteInput): Promise<StickyNoteDocument> {
    const note = await this.options.store.create(input)
    await this.refreshSearch(note.record.id)
    this.emit({ type: 'index-changed', noteId: note.record.id })
    return note
  }

  async rename(noteId: string, name: string): Promise<StickyNoteDocument> {
    const note = await this.options.store.rename(noteId, name)
    await this.refreshSearch(noteId)
    this.emit({ type: 'index-changed', noteId })
    this.emit({ type: 'note-name-changed', noteId, revision: this.nextRevision(noteId), name: note.record.name })
    return note
  }

  async archive(noteId: string): Promise<StickyNoteDocument> {
    await this.options.windows.close(noteId)
    const note = await this.options.store.archive(noteId)
    await this.refreshSearch(noteId)
    this.emit({ type: 'index-changed', noteId })
    return note
  }

  async restore(noteId: string): Promise<StickyNoteDocument> {
    const note = await this.options.store.restore(noteId)
    await this.refreshSearch(noteId)
    this.emit({ type: 'index-changed', noteId })
    return note
  }

  async restoreArchived(noteIds: readonly string[]): Promise<void> {
    if (!this.options.store.restoreArchived) {
      throw new Error('Sticky note archived batch restore is unavailable')
    }
    const uniqueIds = [...new Set(noteIds)]
    await this.options.store.restoreArchived(uniqueIds)
    const refreshResults = await Promise.allSettled(
      uniqueIds.map((noteId) => this.refreshSearch(noteId)),
    )
    for (const result of refreshResults) {
      if (result.status !== 'rejected') continue
      try {
        this.reportError(result.reason)
      } catch {
        // Error reporting cannot overturn a committed restore.
      }
    }
    this.emit({ type: 'index-changed', noteId: null })
  }

  async delete(noteId: string): Promise<void> {
    await this.options.windows.close(noteId)
    await this.options.store.delete(noteId)
    await this.refreshSearch(noteId)
    this.emit({ type: 'index-changed', noteId })
  }

  async deleteArchived(noteIds: readonly string[]): Promise<void> {
    if (!this.options.store.deleteArchived) {
      throw new Error('Sticky note archived batch deletion is unavailable')
    }
    const uniqueIds = [...new Set(noteIds)]
    await this.options.store.deleteArchived(uniqueIds)
    const refreshResults = await Promise.allSettled(
      uniqueIds.map((noteId) => this.refreshSearch(noteId)),
    )
    for (const result of refreshResults) {
      if (result.status !== 'rejected') continue
      try {
        this.reportError(result.reason)
      } catch {
        // Error reporting cannot overturn a committed deletion.
      }
    }
    this.emit({ type: 'index-changed', noteId: null })
  }

  async importFile(absolutePath: string): Promise<StickyNoteImportResult> {
    const result = await this.options.importer.importFile(absolutePath)
    await this.refreshSearch(result.note.record.id)
    this.emit({ type: 'index-changed', noteId: result.note.record.id })
    return result
  }

  async importSelection(
    input: StickyNoteSelectionImportInput,
  ): Promise<StickyNoteImportResult> {
    if (!this.options.importer.importMarkdown) {
      throw new Error('便签选区导入暂不可用')
    }
    const result = await this.options.importer.importMarkdown({
      suggestedName: '',
      markdown: input.markdown,
      sourceDirectory: null,
    })
    await this.refreshSearch(result.note.record.id)
    this.emit({ type: 'index-changed', noteId: result.note.record.id })
    return result
  }

  stageSave(noteId: string, markdown: string): void {
    this.options.saveCoordinator.stage(noteId, markdown)
  }

  flushSave(noteId: string): Promise<StickyNoteSaveState> {
    return this.options.saveCoordinator.flush(noteId)
  }

  async open(
    noteId: string,
    findQuery?: string,
    foregroundSourceId?: string,
  ): Promise<void> {
    await this.options.store.updateRecord(noteId, (current) => ({ ...current, released: true }))
    const openOptions = {
      ...(findQuery ? { findQuery } : {}),
      ...(foregroundSourceId ? { foregroundSourceId } : {}),
    }
    if (Object.keys(openOptions).length > 0) {
      await this.options.windows.open(noteId, openOptions)
    } else {
      await this.options.windows.open(noteId)
    }
  }

  async close(noteId: string): Promise<void> {
    await this.options.windows.close(noteId)
  }

  async release(noteId: string): Promise<void> {
    await this.options.store.updateRecord(noteId, (current) => ({
      ...current,
      released: true,
    }))
    await this.options.windows.open(noteId, { autoSize: true })
    this.emit({ type: 'index-changed', noteId })
  }

  async reclaim(noteId: string): Promise<void> {
    await this.options.windows.reclaim(noteId)
    this.emit({ type: 'index-changed', noteId })
  }

  async setPinned(noteId: string, pinned: boolean): Promise<void> {
    await this.options.windows.setPinned(noteId, pinned)
    this.emit({ type: 'index-changed', noteId })
  }

  windowStateChanged(noteId: string, displayed: boolean, pinned: boolean): void {
    this.emit({ type: 'note-display-state-changed', noteId, revision: this.nextRevision(noteId), displayed, pinned })
  }

  copyImage(noteId: string, absolutePath: string): Promise<string> {
    if (!this.options.store.copyImageResource) throw new Error('便签图片导入不可用')
    return this.options.store.copyImageResource(noteId, absolutePath)
  }

  async setBackground(
    noteId: string,
    background: BackgroundSettings,
  ): Promise<StickyNoteRecord> {
    if (!this.options.store.setBackground) throw new Error('便签背景设置不可用')
    const record = await this.options.store.setBackground(noteId, background)
    this.emit({ type: 'index-changed', noteId })
    return record
  }

  async applyBackground(
    noteId: string,
    background: BackgroundSettings,
    imageUpdate: BackgroundImageUpdate,
    assertCurrent?: () => void,
  ): Promise<StickyNoteRecord> {
    if (!this.options.store.applyBackground) throw new Error('便签背景设置不可用')
    const record = await this.options.store.applyBackground(noteId, background, imageUpdate, assertCurrent)
    assertCurrent?.()
    this.emit({ type: 'index-changed', noteId })
    return record
  }

  async replaceBackgroundImage(
    noteId: string,
    absolutePath: string,
  ): Promise<StickyNoteRecord> {
    if (!this.options.store.replaceBackgroundImage) throw new Error('便签背景图片导入不可用')
    const record = await this.options.store.replaceBackgroundImage(noteId, absolutePath)
    this.emit({ type: 'index-changed', noteId })
    return record
  }

  resolveBackgroundImagePath(noteId: string): Promise<string | null> {
    if (!this.options.store.resolveBackgroundImagePath) {
      throw new Error('便签背景图片读取不可用')
    }
    return this.options.store.resolveBackgroundImagePath(noteId)
  }

  async setFontSize(noteId: string, fontSizePx: number): Promise<void> {
    if (!Number.isSafeInteger(fontSizePx) || fontSizePx < MIN_STICKY_NOTE_FONT_SIZE_PX || fontSizePx > MAX_STICKY_NOTE_FONT_SIZE_PX) throw new Error('便签字号无效')
    await this.options.store.updateRecord(noteId, (current) => ({ ...current, fontSizePx }))
    this.emit({ type: 'note-font-size-changed', noteId, revision: this.nextRevision(noteId), fontSizePx })
  }

  async setLineSpacingMode(
    noteId: string,
    lineSpacingMode: StickyNoteLineSpacingMode,
  ): Promise<void> {
    await this.options.store.updateRecord(noteId, (current) => ({
      ...current,
      lineSpacingMode,
    }))
    this.emit({
      type: 'note-line-spacing-changed',
      noteId,
      revision: this.nextRevision(noteId),
      lineSpacingMode,
    })
  }

  resizeToContent(
    noteId: string,
    measurement: StickyNoteContentMeasurement,
  ): Promise<void> {
    return this.options.windows.resizeToContent(noteId, measurement)
  }

  async setStyle(
    noteId: string,
    style: StickyNoteStyleReference,
  ): Promise<StickyNoteRecord> {
    const record = await this.options.store.updateRecord(noteId, (current) => ({
      ...current,
      style,
    }))
    this.options.windows.applyStyle(noteId, record.style)
    this.emit({ type: 'index-changed', noteId })
    this.emit({ type: 'note-style-changed', noteId, revision: this.nextRevision(noteId), style: record.style })
    return record
  }
}
