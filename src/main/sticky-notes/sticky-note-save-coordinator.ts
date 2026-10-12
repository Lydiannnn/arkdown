import {
  isCanonicalStickyNoteId,
  STICKY_NOTE_MARKDOWN_MAX_BYTES,
  type StickyNoteDocument,
  type StickyNoteSaveState,
} from '../../shared/sticky-notes'

const DEFAULT_DEBOUNCE_MS = 2_000
const DEFAULT_SNAPSHOT_MS = 5_000
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000

interface StickyNoteSaveStore {
  writeMarkdown(noteId: string, markdown: string): Promise<StickyNoteDocument>
}

export interface StickyNoteSaveCoordinatorOptions {
  store: StickyNoteSaveStore
  now?: () => Date
  debounceMs?: number
  snapshotMs?: number
  flushTimeoutMs?: number
  reportError?: (message: string, error: unknown) => void
}

interface StagedRevision {
  revision: number
  markdown: string
}

interface NoteSaveContext {
  revision: number
  staged: StagedRevision | null
  inFlight: StagedRevision | null
  savedMarkdown: string | null
  state: StickyNoteSaveState
  debounceTimer: ReturnType<typeof setTimeout> | null
  snapshotTimer: ReturnType<typeof setTimeout> | null
  drainPromise: Promise<StickyNoteSaveState> | null
}

type StickyNoteSaveListener = (noteId: string, state: StickyNoteSaveState) => void

function idleContext(): NoteSaveContext {
  return {
    revision: 0,
    staged: null,
    inFlight: null,
    savedMarkdown: null,
    state: { status: 'idle' },
    debounceTimer: null,
    snapshotTimer: null,
    drainPromise: null,
  }
}

function validateDelay(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new Error(`${label}无效`)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return '实时保存失败'
}

export class StickyNoteSaveCoordinator {
  private readonly now: () => Date
  private readonly debounceMs: number
  private readonly snapshotMs: number
  private readonly flushTimeoutMs: number
  private readonly reportError: (message: string, error: unknown) => void
  private readonly notes = new Map<string, NoteSaveContext>()
  private readonly listeners = new Set<StickyNoteSaveListener>()

  constructor(private readonly options: StickyNoteSaveCoordinatorOptions) {
    this.now = options.now ?? (() => new Date())
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.snapshotMs = options.snapshotMs ?? DEFAULT_SNAPSHOT_MS
    this.flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS
    this.reportError = options.reportError ?? ((message, error) => console.error(message, error))
    validateDelay(this.debounceMs, '实时保存防抖时间')
    validateDelay(this.snapshotMs, '实时保存快照时间')
    validateDelay(this.flushTimeoutMs, '退出保存超时时间')
    if (this.snapshotMs < this.debounceMs) {
      throw new Error('实时保存快照时间不能短于防抖时间')
    }
  }

  private context(noteId: string): NoteSaveContext {
    let context = this.notes.get(noteId)
    if (!context) {
      context = idleContext()
      this.notes.set(noteId, context)
    }
    return context
  }

  private emit(noteId: string, context: NoteSaveContext, state: StickyNoteSaveState): void {
    context.state = state
    for (const listener of this.listeners) listener(noteId, state)
  }

  private clearDebounce(context: NoteSaveContext): void {
    if (context.debounceTimer !== null) clearTimeout(context.debounceTimer)
    context.debounceTimer = null
  }

  private clearSnapshot(context: NoteSaveContext): void {
    if (context.snapshotTimer !== null) clearTimeout(context.snapshotTimer)
    context.snapshotTimer = null
  }

  private clearTimers(context: NoteSaveContext): void {
    this.clearDebounce(context)
    this.clearSnapshot(context)
  }

  private schedule(noteId: string, context: NoteSaveContext): void {
    this.clearDebounce(context)
    context.debounceTimer = setTimeout(() => {
      context.debounceTimer = null
      void this.flush(noteId)
    }, this.debounceMs)
    if (context.snapshotTimer === null) {
      context.snapshotTimer = setTimeout(() => {
        context.snapshotTimer = null
        void this.flush(noteId)
      }, this.snapshotMs)
    }
  }

  stage(noteId: string, markdown: string): void {
    if (!isCanonicalStickyNoteId(noteId)) throw new Error('便签 ID 无效')
    if (
      typeof markdown !== 'string'
      || Buffer.byteLength(markdown, 'utf8') > STICKY_NOTE_MARKDOWN_MAX_BYTES
    ) throw new Error('便签内容无效或过大')
    const context = this.context(noteId)
    const latestMarkdown = context.staged?.markdown
      ?? context.inFlight?.markdown
      ?? context.savedMarkdown
    if (latestMarkdown === markdown) return
    context.revision += 1
    context.staged = { revision: context.revision, markdown }
    this.schedule(noteId, context)
  }

  private startDrain(noteId: string, context: NoteSaveContext): Promise<StickyNoteSaveState> {
    if (context.drainPromise) return context.drainPromise
    const drain = async (): Promise<StickyNoteSaveState> => {
      while (context.staged) {
        const candidate = context.staged
        context.staged = null
        if (context.savedMarkdown === candidate.markdown) {
          this.emit(noteId, context, {
            status: 'saved',
            revision: candidate.revision,
            savedAt: this.now().toISOString(),
          })
          continue
        }

        context.inFlight = candidate
        this.emit(noteId, context, {
          status: 'saving',
          revision: candidate.revision,
        })
        try {
          await this.options.store.writeMarkdown(noteId, candidate.markdown)
          context.savedMarkdown = candidate.markdown
          this.emit(noteId, context, {
            status: 'saved',
            revision: candidate.revision,
            savedAt: this.now().toISOString(),
          })
        } catch (error) {
          if (!context.staged) context.staged = candidate
          this.emit(noteId, context, {
            status: 'error',
            revision: candidate.revision,
            message: errorMessage(error),
          })
          context.inFlight = null
          return context.state
        }
        context.inFlight = null
      }
      this.clearTimers(context)
      return context.state
    }
    context.drainPromise = drain().finally(() => {
      context.drainPromise = null
    })
    return context.drainPromise
  }

  async flush(noteId: string): Promise<StickyNoteSaveState> {
    if (!isCanonicalStickyNoteId(noteId)) throw new Error('便签 ID 无效')
    const context = this.notes.get(noteId)
    if (!context) return { status: 'idle' }
    this.clearTimers(context)
    if (!context.staged && !context.drainPromise) return context.state
    return this.startDrain(noteId, context)
  }

  async flushAll(): Promise<void> {
    const noteIds = [...this.notes.keys()]
    let timeout: ReturnType<typeof setTimeout> | null = null
    let states: StickyNoteSaveState[]
    try {
      states = await Promise.race([
        Promise.all(noteIds.map((noteId) => this.flush(noteId))),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error('便签退出保存超时（' + this.flushTimeoutMs + 'ms）'))
          }, this.flushTimeoutMs)
        }),
      ])
    } catch (error) {
      this.reportError('Sticky note shutdown flush failed', error)
      throw error
    } finally {
      if (timeout !== null) clearTimeout(timeout)
    }

    const failures = states.flatMap((state, index) => (
      state.status === 'error'
        ? [{ noteId: noteIds[index], message: state.message }]
        : []
    ))
    if (failures.length > 0) {
      const error = new AggregateError(
        failures.map(({ noteId, message }) => new Error(noteId + ': ' + message)),
        failures.map(({ noteId, message }) => noteId + ': ' + message).join('; '),
      )
      this.reportError('Sticky note shutdown flush failed', error)
      throw error
    }
  }

  async dispose(noteId: string): Promise<void> {
    const state = await this.flush(noteId)
    if (state.status === 'error') return
    const context = this.notes.get(noteId)
    if (context) this.clearTimers(context)
    this.notes.delete(noteId)
  }

  state(noteId: string): StickyNoteSaveState {
    return this.notes.get(noteId)?.state ?? { status: 'idle' }
  }

  subscribe(listener: StickyNoteSaveListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
