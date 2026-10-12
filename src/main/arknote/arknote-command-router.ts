import { z } from 'zod'
import type { ArknoteCommand } from '../../shared/arknote-protocol'
import {
  isCanonicalStickyNoteId,
  STICKY_NOTE_MARKDOWN_MAX_BYTES,
  type CreateStickyNoteInput,
  type StickyNoteContentMeasurement,
  type StickyNoteSelectionImportInput,
  type StickyNoteStatus,
  type StickyNoteLineSpacingMode,
} from '../../shared/sticky-notes'
import {
  parseStickyNoteStyleReference,
  type StickyNoteStyleReference,
} from '../../shared/sticky-note-preferences'
import { isThemeColor, normalizeThemeColor } from '../../shared/theme-color'
import { parseStickyNoteContentMeasurement } from '../sticky-notes/sticky-note-window-sizing'
import {
  importStickyNoteSchema,
  importStickyNoteSelectionSchema,
  deleteArchivedStickyNotesSchema,
  restoreArchivedStickyNotesSchema,
  stickyNoteIdSchema,
  stickyNoteForegroundSourceIdSchema,
  stickyNoteQuerySchema,
  stickyNoteSearchSchema,
  setStickyNoteLineSpacingModeSchema,
} from '../ipc/sticky-note-schemas'
import type { ArknoteLaunchCommand } from './arknote-second-instance'

interface ArknoteNotesTarget {
  list(status: StickyNoteStatus): Promise<unknown>
  reorder(noteIds: readonly string[]): Promise<unknown>
  read(noteId: string): Promise<unknown>
  create(input: CreateStickyNoteInput): Promise<unknown>
  rename(noteId: string, name: string): Promise<unknown>
  archive(noteId: string): Promise<unknown>
  restore(noteId: string): Promise<unknown>
  restoreArchived(noteIds: readonly string[]): Promise<unknown>
  delete(noteId: string): Promise<unknown>
  deleteArchived(noteIds: readonly string[]): Promise<unknown>
  importFile(absolutePath: string): Promise<unknown>
  importSelection(input: StickyNoteSelectionImportInput): Promise<unknown>
  stageSave(noteId: string, markdown: string): void
  flushSave(noteId: string): Promise<unknown>
  open(noteId: string, findQuery?: string, foregroundSourceId?: string): Promise<unknown>
  close(noteId: string): Promise<unknown>
  release(noteId: string): Promise<unknown>
  reclaim(noteId: string): Promise<unknown>
  setPinned(noteId: string, pinned: boolean): Promise<unknown>
  setStyle(noteId: string, style: StickyNoteStyleReference): Promise<unknown>
  setLineSpacingMode(noteId: string, lineSpacingMode: StickyNoteLineSpacingMode): Promise<unknown>
  resizeToContent(noteId: string, measurement: StickyNoteContentMeasurement): Promise<unknown>
  search(input: { status: StickyNoteStatus; query: string }): Promise<unknown>
}

interface ArknoteSettingsTarget {
  get(): Promise<unknown> | unknown
  set(value: unknown): Promise<unknown>
  previewThemeColor?(themeColor: string): Promise<void>
  setBoxTheme?(theme: unknown): Promise<void>
}

export interface ArknoteCommandRouterOptions {
  executeLaunchCommand(command: ArknoteLaunchCommand): Promise<void>
  quit(): Promise<void>
  prepareUpdate?(): Promise<void>
  cancelUpdate?(): Promise<void>
  notes?: Partial<ArknoteNotesTarget>
  settings?: ArknoteSettingsTarget
}

const MUTATING_COMMANDS = new Set<ArknoteCommand>([
  'launch.new-note',
  'note.create',
  'note.reorder',
  'note.rename',
  'note.archive',
  'note.restore',
  'note.restore-archived-batch',
  'note.delete',
  'note.delete-archived-batch',
  'note.import-file',
  'note.import-selection',
  'note.stage-save',
  'note.flush-save',
  'note.open',
  'note.close',
  'note.release',
  'note.reclaim',
  'note.pin',
  'note.style',
  'note.line-spacing',
  'note.resize',
  'settings.set',
  'settings.preview-theme',
  'settings.box-theme',
])

function invalid(): never {
  throw new Error('Arknote 命令参数无效')
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  const result = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(result)
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.has(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(result, key))
  ) invalid()
  return result
}

function empty(value: unknown): void {
  record(value, [])
}

function noteReference(value: unknown): string {
  const noteId = record(value, ['noteId']).noteId
  if (!isCanonicalStickyNoteId(noteId)) invalid()
  return noteId
}

function noteOrder(value: unknown): string[] {
  const noteIds = record(value, ['noteIds']).noteIds
  if (
    !Array.isArray(noteIds)
    || noteIds.length > 35
    || noteIds.some((noteId) => !isCanonicalStickyNoteId(noteId))
    || new Set(noteIds).size !== noteIds.length
  ) invalid()
  return [...noteIds]
}

function noteStatus(value: unknown): StickyNoteStatus {
  if (value !== 'active' && value !== 'archived') invalid()
  return value
}

function markdown(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') > STICKY_NOTE_MARKDOWN_MAX_BYTES
  ) invalid()
  return value
}

const openNoteSchema = z.object({
  noteId: stickyNoteIdSchema,
  findQuery: stickyNoteQuerySchema.optional(),
  foregroundSourceId: stickyNoteForegroundSourceIdSchema.optional(),
}).strict()

function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) invalid()
  return parsed.data
}

export class ArknoteCommandRouter {
  private acceptingMutations = true
  private inFlightMutations = 0
  private readonly drainWaiters = new Set<() => void>()

  constructor(private readonly options: ArknoteCommandRouterOptions) {}

  setAcceptingMutations(accepting: boolean): void {
    this.acceptingMutations = accepting
  }

  pauseAndDrain(): Promise<void> {
    this.acceptingMutations = false
    if (this.inFlightMutations === 0) return Promise.resolve()
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve))
  }

  resume(): void {
    this.acceptingMutations = true
  }

  private finishMutation(): void {
    this.inFlightMutations -= 1
    if (this.inFlightMutations !== 0) return
    for (const resolve of this.drainWaiters) resolve()
    this.drainWaiters.clear()
  }

  private noteMethod<K extends keyof ArknoteNotesTarget>(name: K): ArknoteNotesTarget[K] {
    const method = this.options.notes?.[name]
    if (typeof method !== 'function') throw new Error('Arknote 命令暂不可用')
    return method.bind(this.options.notes) as ArknoteNotesTarget[K]
  }

  async handle(command: ArknoteCommand, payload: unknown): Promise<unknown> {
    const mutation = MUTATING_COMMANDS.has(command)
    if (mutation && !this.acceptingMutations) throw new Error('Arknote 正在退出')
    if (mutation) this.inFlightMutations += 1
    try {
      return await this.dispatch(command, payload)
    } finally {
      if (mutation) this.finishMutation()
    }
  }

  private async dispatch(command: ArknoteCommand, payload: unknown): Promise<unknown> {
    switch (command) {
      case 'health.ping':
        empty(payload)
        return { ready: true }
      case 'launch.open-box':
        empty(payload)
        await this.options.executeLaunchCommand('open-box')
        return null
      case 'launch.new-note':
        empty(payload)
        await this.options.executeLaunchCommand('new-note')
        return null
      case 'launch.open-settings':
        empty(payload)
        await this.options.executeLaunchCommand('open-settings')
        return null
      case 'note.list': {
        const input = record(payload, ['status'])
        return this.noteMethod('list')(noteStatus(input.status))
      }
      case 'note.reorder':
        return this.noteMethod('reorder')(noteOrder(payload))
      case 'note.read':
        return this.noteMethod('read')(noteReference(payload))
      case 'note.create': {
        const input = record(payload, ['name'], ['markdown', 'style'])
        if (typeof input.name !== 'string') invalid()
        const createInput: CreateStickyNoteInput = { name: input.name }
        if (input.markdown !== undefined) createInput.markdown = markdown(input.markdown)
        if (input.style !== undefined) {
          const style = parseStickyNoteStyleReference(input.style)
          if (!style) invalid()
          createInput.style = style
        }
        return this.noteMethod('create')(createInput)
      }
      case 'note.rename': {
        const input = record(payload, ['noteId', 'name'])
        if (!isCanonicalStickyNoteId(input.noteId) || typeof input.name !== 'string') invalid()
        return this.noteMethod('rename')(input.noteId, input.name)
      }
      case 'note.archive': return this.noteMethod('archive')(noteReference(payload))
      case 'note.restore': return this.noteMethod('restore')(noteReference(payload))
      case 'note.restore-archived-batch': {
        const { noteIds } = parseSchema(restoreArchivedStickyNotesSchema, payload)
        await this.noteMethod('restoreArchived')(noteIds)
        return null
      }
      case 'note.delete': {
        await this.noteMethod('delete')(noteReference(payload))
        return null
      }
      case 'note.delete-archived-batch': {
        const { noteIds } = parseSchema(deleteArchivedStickyNotesSchema, payload)
        await this.noteMethod('deleteArchived')(noteIds)
        return null
      }
      case 'note.import-file': {
        const input = parseSchema(importStickyNoteSchema, payload)
        return this.noteMethod('importFile')(input.absolutePath)
      }
      case 'note.import-selection': {
        const input = parseSchema(importStickyNoteSelectionSchema, payload)
        return this.noteMethod('importSelection')(input)
      }
      case 'note.stage-save': {
        const input = record(payload, ['noteId', 'markdown'])
        if (!isCanonicalStickyNoteId(input.noteId)) invalid()
        this.noteMethod('stageSave')(input.noteId, markdown(input.markdown))
        return null
      }
      case 'note.flush-save': return this.noteMethod('flushSave')(noteReference(payload))
      case 'note.open': {
        const input = parseSchema(openNoteSchema, payload)
        await this.noteMethod('open')(
          input.noteId,
          input.findQuery,
          input.foregroundSourceId,
        )
        return null
      }
      case 'note.close': {
        await this.noteMethod('close')(noteReference(payload))
        return null
      }
      case 'note.release': {
        await this.noteMethod('release')(noteReference(payload))
        return null
      }
      case 'note.reclaim': {
        await this.noteMethod('reclaim')(noteReference(payload))
        return null
      }
      case 'note.pin': {
        const input = record(payload, ['noteId', 'pinned'])
        if (!isCanonicalStickyNoteId(input.noteId) || typeof input.pinned !== 'boolean') invalid()
        await this.noteMethod('setPinned')(input.noteId, input.pinned)
        return null
      }
      case 'note.style': {
        const input = record(payload, ['noteId', 'style'])
        const style = parseStickyNoteStyleReference(input.style)
        if (!isCanonicalStickyNoteId(input.noteId) || !style) invalid()
        return this.noteMethod('setStyle')(input.noteId, style)
      }
      case 'note.line-spacing': {
        const { noteId, lineSpacingMode } = parseSchema(setStickyNoteLineSpacingModeSchema, payload)
        await this.noteMethod('setLineSpacingMode')(noteId, lineSpacingMode)
        return null
      }
      case 'note.resize': {
        const input = record(payload, ['noteId', 'measurement'])
        const measurement = parseStickyNoteContentMeasurement(input.measurement)
        if (!isCanonicalStickyNoteId(input.noteId) || !measurement) invalid()
        await this.noteMethod('resizeToContent')(input.noteId, measurement)
        return null
      }
      case 'note.search': {
        const input = parseSchema(stickyNoteSearchSchema, payload)
        return this.noteMethod('search')(input)
      }
      case 'settings.get':
        empty(payload)
        if (!this.options.settings) throw new Error('Arknote 设置暂不可用')
        return this.options.settings.get()
      case 'settings.set':
        if (!this.options.settings) throw new Error('Arknote 设置暂不可用')
        return this.options.settings.set(payload)
      case 'settings.box-theme': {
        if (!this.options.settings?.setBoxTheme) invalid()
        await this.options.settings.setBoxTheme(payload)
        return null
      }
      case 'settings.preview-theme': {
        const input = record(payload, ['themeColor'])
        if (!isThemeColor(input.themeColor) || !this.options.settings?.previewThemeColor) {
          invalid()
        }
        await this.options.settings!.previewThemeColor!(normalizeThemeColor(input.themeColor))
        return null
      }
      case 'service.quit':
        empty(payload)
        await this.options.quit()
        return null
      case 'service.prepare-update':
        empty(payload)
        if (!this.options.prepareUpdate) invalid()
        await this.options.prepareUpdate!()
        return { prepared: true }
      case 'service.cancel-update':
        empty(payload)
        if (!this.options.cancelUpdate) invalid()
        await this.options.cancelUpdate!()
        return null
      default:
        throw new Error('Arknote 命令不支持')
    }
  }
}
