import { isCanonicalStickyNoteId, type StickyNoteDocument } from '../../shared/sticky-notes'
import { ARKDOWN_AUTOSTART_ARGUMENT } from './sticky-note-autostart'

interface StickyNoteSessionStateOptions {
  store: {
    readOpenNoteIds(): Promise<string[]>
    writeOpenNoteIds(ids: readonly string[]): Promise<void>
    get(noteId: string): Promise<StickyNoteDocument>
  }
  windows: {
    open(noteId: string, options: { focus: false }): Promise<void>
    openNoteIds(): readonly string[]
  }
  saves: { flushAll(): Promise<void> }
  reportError(error: unknown): void
}

export class StickyNoteSessionState {
  private openIds: Set<string> | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: StickyNoteSessionStateOptions) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(operation)
    this.tail = next
    return next
  }

  private async loadOpenIds(): Promise<Set<string>> {
    if (this.openIds) return this.openIds
    this.openIds = new Set((await this.options.store.readOpenNoteIds())
      .filter(isCanonicalStickyNoteId))
    return this.openIds
  }

  recordWindowState(noteId: string, open: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (!isCanonicalStickyNoteId(noteId)) return
      const ids = await this.loadOpenIds()
      if (open) ids.add(noteId)
      else ids.delete(noteId)
      await this.options.store.writeOpenNoteIds([...ids])
    })
  }

  restore(argv: readonly string[]): Promise<number> {
    if (!argv.includes(ARKDOWN_AUTOSTART_ARGUMENT)) return Promise.resolve(0)
    return this.enqueue(async () => {
      const ids = await this.loadOpenIds()
      const restorable: string[] = []
      for (const noteId of ids) {
        try {
          const note = await this.options.store.get(noteId)
          if (note.record.status !== 'active' || !note.record.released) continue
          await this.options.windows.open(noteId, { focus: false })
          restorable.push(noteId)
        } catch (error) {
          this.options.reportError(error)
        }
      }
      this.openIds = new Set(restorable)
      await this.options.store.writeOpenNoteIds(restorable)
      return restorable.length
    })
  }

  captureAndFlush(): Promise<void> {
    return this.enqueue(async () => {
      const ids = [...this.options.windows.openNoteIds()]
      this.openIds = new Set(ids)
      await this.options.store.writeOpenNoteIds(ids)
      await this.options.saves.flushAll()
    })
  }
}
