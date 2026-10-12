import {
  copyStickyNoteStyleReference,
  parseStickyNoteStyleReference,
  type StickyNoteStyleReference,
} from './sticky-note-preferences'
import {
  copyBackgroundSettings,
  DEFAULT_BACKGROUND_SETTINGS,
  parseBackgroundSettings,
  type BackgroundSettings,
} from './background-settings'

export type {
  StickyNoteColorPreset,
  StickyNoteColorPresetId,
  StickyNotePreferences,
  StickyNoteStyleReference,
  StickyNoteTexturePattern,
  StickyNoteTexturePreset,
  StickyNoteTexturePresetId,
  StickyNoteTextureSnapshot,
} from './sticky-note-preferences'

export const STICKY_NOTE_SCHEMA_VERSION = 5
export const MAX_ACTIVE_STICKY_NOTES = 35
export const STICKY_NOTE_WINDOW_OPACITY_PERCENT = 100
export const STICKY_NOTE_NAME_MAX_LENGTH = 80
export const STICKY_NOTE_MARKDOWN_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_STICKY_NOTE_FONT_SIZE_PX = 14
export const MIN_STICKY_NOTE_FONT_SIZE_PX = 11
export const MAX_STICKY_NOTE_FONT_SIZE_PX = 20

export type StickyNoteStatus = 'active' | 'archived'
export type StickyNoteLineSpacingMode = 'compact' | 'standard'

export const DEFAULT_STICKY_NOTE_LINE_SPACING_MODE: StickyNoteLineSpacingMode = 'compact'

export interface StickyNoteWindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface StickyNoteContentMeasurement {
  scrollWidth: number
  scrollHeight: number
}

export interface StickyNoteRecord {
  id: string
  name: string
  status: StickyNoteStatus
  markdownRelativePath: string
  resourcesRelativePath: string
  style: StickyNoteStyleReference
  background: BackgroundSettings
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  released: boolean
  pinned: boolean
  windowBounds: StickyNoteWindowBounds | null
  lastOpenedAt: string | null
  fontSizePx: number
  lineSpacingMode: StickyNoteLineSpacingMode
}

export interface StickyNoteIndex {
  schemaVersion: 5
  notes: StickyNoteRecord[]
  openNoteIdsAtLastSession: string[]
  defaultHelpNoteCreated: boolean
}

export interface StickyNoteSummary {
  record: StickyNoteRecord
  excerpt: string
}

export interface StickyNoteDocument {
  record: StickyNoteRecord
  markdown: string
}

// Window-read presentation metadata; never persisted in the note index/document.
export interface StickyNoteReadDocument extends StickyNoteDocument {
  documentAbsolutePath?: string
}

export interface CreateStickyNoteInput {
  name: string
  markdown?: string
  style?: StickyNoteStyleReference
}

export interface StickyNoteImportWarning {
  source: string
  reason: 'missing' | 'unreadable' | 'unsupported'
}

export interface StickyNoteImportResult {
  note: StickyNoteDocument
  warnings: StickyNoteImportWarning[]
}

export interface StickyNoteSelectionResource {
  originalReference: string
  absolutePath: string
}

export interface StickyNoteSelectionImportInput {
  markdown: string
  localResources: readonly StickyNoteSelectionResource[]
}

export type StickyNoteSaveState =
  | { status: 'idle' }
  | { status: 'saving'; revision: number }
  | { status: 'saved'; revision: number; savedAt: string }
  | { status: 'error'; revision: number; message: string }

export const STICKY_NOTE_SEARCH_QUERY_MAX_LENGTH = 500

export interface StickyNoteSearchInput {
  status: StickyNoteStatus
  query: string
}

export interface StickyNoteSearchResult {
  noteId: string
  name: string
  excerpt: string
  archivedAt: string | null
}

export type StickyNoteEvent =
  | { type: 'index-changed'; noteId: string | null }
  | { type: 'save-state'; noteId: string; state: StickyNoteSaveState }
  | { type: 'window-state'; noteId: string; open: boolean; pinned: boolean }
  | { type: 'find-request'; noteId: string; query: string }
  | { type: 'note-summary-changed'; noteId: string; revision: number; summary: StickyNoteSummary }
  | { type: 'note-style-changed'; noteId: string; revision: number; style: StickyNoteStyleReference }
  | { type: 'note-display-state-changed'; noteId: string; revision: number; displayed: boolean; pinned: boolean }
  | { type: 'note-name-changed'; noteId: string; revision: number; name: string }
  | { type: 'note-font-size-changed'; noteId: string; revision: number; fontSizePx: number }
  | { type: 'note-line-spacing-changed'; noteId: string; revision: number; lineSpacingMode: StickyNoteLineSpacingMode }

const NOTE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isCanonicalStickyNoteId(value: unknown): value is string {
  return typeof value === 'string' && NOTE_ID_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
}

function isExactArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || !keys.includes('length')) return false
  return value.every((_entry, index) => Object.hasOwn(value, String(index)))
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isSafeNoteName(value: unknown): value is string {
  return (
    typeof value === 'string'
    && value === value.trim()
    && value.length >= 1
    && value.length <= STICKY_NOTE_NAME_MAX_LENGTH
    && !/[\u0000-\u001f\u007f<>:"/\\|?*]/u.test(value)
    && !/[. ]$/u.test(value)
  )
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 1024
    || value.startsWith('/')
    || value.includes('\\')
    || /^[a-z]:/iu.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return false
  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function parseWindowBounds(value: unknown): StickyNoteWindowBounds | null | undefined {
  if (value === null) return null
  if (!isRecord(value) || !hasExactOwnKeys(value, ['x', 'y', 'width', 'height'])) {
    return undefined
  }
  const { x, y, width, height } = value
  if (
    typeof x !== 'number'
    || !Number.isSafeInteger(x)
    || Math.abs(x) > 100_000
    || typeof y !== 'number'
    || !Number.isSafeInteger(y)
    || Math.abs(y) > 100_000
    || typeof width !== 'number'
    || !Number.isSafeInteger(width)
    || width < 180
    || width > 10_000
    || typeof height !== 'number'
    || !Number.isSafeInteger(height)
    || height < 180
    || height > 10_000
  ) return undefined
  return { x, y, width, height }
}

export function copyStickyNoteRecord(record: StickyNoteRecord): StickyNoteRecord {
  return {
    ...record,
    style: copyStickyNoteStyleReference(record.style),
    background: copyBackgroundSettings(record.background),
    windowBounds: record.windowBounds ? { ...record.windowBounds } : null,
  }
}

function parseStickyNoteRecordWithStyleParser(
  value: unknown,
  parseStyleReference: (value: unknown) => StickyNoteStyleReference | undefined,
): StickyNoteRecord | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'id',
    'name',
    'status',
    'markdownRelativePath',
    'resourcesRelativePath',
    'style',
    'background',
    'createdAt',
    'updatedAt',
    'archivedAt',
    'released',
    'pinned',
    'windowBounds',
    'lastOpenedAt',
    'fontSizePx',
    'lineSpacingMode',
  ])) return undefined

  const style = parseStyleReference(value.style)
  const background = parseBackgroundSettings(value.background)
  const windowBounds = parseWindowBounds(value.windowBounds)
  if (
    !isCanonicalStickyNoteId(value.id)
    || !isSafeNoteName(value.name)
    || (value.status !== 'active' && value.status !== 'archived')
    || !isSafeRelativePath(value.markdownRelativePath)
    || !isSafeRelativePath(value.resourcesRelativePath)
    || style === undefined
    || background === undefined
    || !isStickyNoteBackgroundImagePath(background.imageRelativePath)
    || !isCanonicalTimestamp(value.createdAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || !(value.archivedAt === null || isCanonicalTimestamp(value.archivedAt))
    || typeof value.released !== 'boolean'
    || typeof value.pinned !== 'boolean'
    || windowBounds === undefined
    || !(value.lastOpenedAt === null || isCanonicalTimestamp(value.lastOpenedAt))
    || !Number.isSafeInteger(value.fontSizePx)
    || Number(value.fontSizePx) < MIN_STICKY_NOTE_FONT_SIZE_PX
    || Number(value.fontSizePx) > MAX_STICKY_NOTE_FONT_SIZE_PX
    || (value.lineSpacingMode !== 'compact' && value.lineSpacingMode !== 'standard')
  ) return undefined

  const root = value.status === 'active' ? 'active' : 'archive'
  const markdownParts = value.markdownRelativePath.split('/')
  const expectedResources = `${root}/${value.id}/resources`
  if (
    markdownParts.length !== 3
    || markdownParts[0] !== root
    || markdownParts[1] !== value.id
    || !markdownParts[2].toLocaleLowerCase('en-US').endsWith('.md')
    || value.resourcesRelativePath !== expectedResources
    || (value.status === 'active' && value.archivedAt !== null)
    || (value.status === 'archived' && value.archivedAt === null)
    || (value.pinned && !value.released)
  ) return undefined

  return {
    id: value.id,
    name: value.name,
    status: value.status,
    markdownRelativePath: value.markdownRelativePath,
    resourcesRelativePath: value.resourcesRelativePath,
    style,
    background,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    archivedAt: value.archivedAt,
    released: value.released,
    pinned: value.pinned,
    windowBounds,
    lastOpenedAt: value.lastOpenedAt,
    fontSizePx: Number(value.fontSizePx),
    lineSpacingMode: value.lineSpacingMode,
  }
}

function isStickyNoteBackgroundImagePath(value: string | null): boolean {
  if (value === null) return true
  if (!isSafeRelativePath(value)) return false
  const parts = value.split('/')
  return parts.length === 2 && parts[0] === 'resources' && parts[1].length > 0
}

export function parseStickyNoteRecord(value: unknown): StickyNoteRecord | undefined {
  return parseStickyNoteRecordWithStyleParser(value, parseStickyNoteStyleReference)
}

function upgradeV1StickyNoteRecord(value: unknown): StickyNoteRecord | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'id',
    'name',
    'status',
    'markdownRelativePath',
    'resourcesRelativePath',
    'style',
    'createdAt',
    'updatedAt',
    'archivedAt',
    'released',
    'pinned',
    'windowBounds',
    'lastOpenedAt',
  ])) return undefined
  return parseStickyNoteRecord({
    ...value,
    fontSizePx: DEFAULT_STICKY_NOTE_FONT_SIZE_PX,
    lineSpacingMode: DEFAULT_STICKY_NOTE_LINE_SPACING_MODE,
    background: copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS),
  })
}

function upgradeV2StickyNoteRecord(value: unknown): StickyNoteRecord | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'id',
    'name',
    'status',
    'markdownRelativePath',
    'resourcesRelativePath',
    'style',
    'createdAt',
    'updatedAt',
    'archivedAt',
    'released',
    'pinned',
    'windowBounds',
    'lastOpenedAt',
    'fontSizePx',
  ])) return undefined
  return parseStickyNoteRecord({
    ...value,
    lineSpacingMode: DEFAULT_STICKY_NOTE_LINE_SPACING_MODE,
    background: copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS),
  })
}

function parseV3StickyNoteStyleReference(
  value: unknown,
): StickyNoteStyleReference | undefined {
  const style = parseStickyNoteStyleReference(value)
  return style?.mode === 'material' ? undefined : style
}

function upgradeV3StickyNoteRecord(value: unknown): StickyNoteRecord | undefined {
  if (!isRecord(value)) return undefined
  return parseStickyNoteRecordWithStyleParser({
    ...value,
    background: copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS),
  }, parseV3StickyNoteStyleReference)
}

function upgradeV4StickyNoteRecord(value: unknown): StickyNoteRecord | undefined {
  if (!isRecord(value)) return undefined
  return parseStickyNoteRecord({
    ...value,
    background: copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS),
  })
}

export function copyStickyNoteIndex(index: StickyNoteIndex): StickyNoteIndex {
  return {
    schemaVersion: STICKY_NOTE_SCHEMA_VERSION,
    notes: index.notes.map(copyStickyNoteRecord),
    openNoteIdsAtLastSession: [...index.openNoteIdsAtLastSession],
    defaultHelpNoteCreated: index.defaultHelpNoteCreated,
  }
}

export function parseStickyNoteIndex(value: unknown): StickyNoteIndex | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'schemaVersion',
    'notes',
    'openNoteIdsAtLastSession',
    'defaultHelpNoteCreated',
  ])) return undefined
  if (
    value.schemaVersion !== STICKY_NOTE_SCHEMA_VERSION
    || !isExactArray(value.notes)
    || value.notes.length > 100_000
    || !isExactArray(value.openNoteIdsAtLastSession)
    || typeof value.defaultHelpNoteCreated !== 'boolean'
  ) return undefined

  const notes: StickyNoteRecord[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const candidate of value.notes) {
    const note = parseStickyNoteRecord(candidate)
    const normalizedName = note?.name.toLocaleLowerCase('en-US')
    if (
      note === undefined
      || ids.has(note.id)
      || normalizedName === undefined
      || names.has(normalizedName)
    ) return undefined
    ids.add(note.id)
    names.add(normalizedName)
    notes.push(note)
  }

  const openNoteIdsAtLastSession: string[] = []
  const openIds = new Set<string>()
  for (const candidate of value.openNoteIdsAtLastSession) {
    const note = typeof candidate === 'string'
      ? notes.find(({ id }) => id === candidate)
      : undefined
    if (
      note === undefined
      || note.status !== 'active'
      || openIds.has(note.id)
    ) return undefined
    openIds.add(note.id)
    openNoteIdsAtLastSession.push(note.id)
  }

  return {
    schemaVersion: STICKY_NOTE_SCHEMA_VERSION,
    notes,
    openNoteIdsAtLastSession,
    defaultHelpNoteCreated: value.defaultHelpNoteCreated,
  }
}

export function upgradeStickyNoteIndex(value: unknown): StickyNoteIndex | undefined {
  const current = parseStickyNoteIndex(value)
  if (current) return current
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    'schemaVersion',
    'notes',
    'openNoteIdsAtLastSession',
    'defaultHelpNoteCreated',
  ])) return undefined
  if (
    (value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4)
    || !isExactArray(value.notes)
    || value.notes.length > 100_000
    || !isExactArray(value.openNoteIdsAtLastSession)
    || typeof value.defaultHelpNoteCreated !== 'boolean'
  ) return undefined

  const upgradeRecord = value.schemaVersion === 1
    ? upgradeV1StickyNoteRecord
      : value.schemaVersion === 2
      ? upgradeV2StickyNoteRecord
      : value.schemaVersion === 3
        ? upgradeV3StickyNoteRecord
        : upgradeV4StickyNoteRecord
  const upgradedNotes: StickyNoteRecord[] = []
  for (const candidate of value.notes) {
    const note = upgradeRecord(candidate)
    if (!note) return undefined
    upgradedNotes.push(note)
  }
  return parseStickyNoteIndex({
    schemaVersion: STICKY_NOTE_SCHEMA_VERSION,
    notes: upgradedNotes,
    openNoteIdsAtLastSession: value.openNoteIdsAtLastSession,
    defaultHelpNoteCreated: value.defaultHelpNoteCreated,
  })
}
export function parseStickyNoteDocument(
  value: unknown,
): StickyNoteDocument | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['record', 'markdown'])) {
    return undefined
  }
  const record = parseStickyNoteRecord(value.record)
  if (
    record === undefined
    || typeof value.markdown !== 'string'
    || Buffer.byteLength(value.markdown, 'utf8') > STICKY_NOTE_MARKDOWN_MAX_BYTES
  ) return undefined
  return { record, markdown: value.markdown }
}

export function parseStickyNoteSummary(
  value: unknown,
): StickyNoteSummary | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['record', 'excerpt'])) {
    return undefined
  }
  const record = parseStickyNoteRecord(value.record)
  if (
    record === undefined
    || typeof value.excerpt !== 'string'
    || value.excerpt.length > 160
  ) return undefined
  return { record, excerpt: value.excerpt }
}

export function parseStickyNoteSearchResults(
  value: unknown,
): StickyNoteSearchResult[] | undefined {
  if (!isExactArray(value) || value.length > 100_000) return undefined
  const results: StickyNoteSearchResult[] = []
  for (const candidate of value) {
    if (!isRecord(candidate) || !hasExactOwnKeys(candidate, [
      'noteId', 'name', 'excerpt', 'archivedAt',
    ])) return undefined
    if (
      !isCanonicalStickyNoteId(candidate.noteId)
      || !isSafeNoteName(candidate.name)
      || typeof candidate.excerpt !== 'string'
      || candidate.excerpt.length > 160
      || !(candidate.archivedAt === null || isCanonicalTimestamp(candidate.archivedAt))
    ) return undefined
    results.push({
      noteId: candidate.noteId,
      name: candidate.name,
      excerpt: candidate.excerpt,
      archivedAt: candidate.archivedAt,
    })
  }
  return results
}

export function parseStickyNoteSummaries(
  value: unknown,
): StickyNoteSummary[] | undefined {
  if (!isExactArray(value) || value.length > 100_000) return undefined
  const summaries: StickyNoteSummary[] = []
  for (const candidate of value) {
    const summary = parseStickyNoteSummary(candidate)
    if (summary === undefined) return undefined
    summaries.push(summary)
  }
  return summaries
}

function parseStickyNoteImportWarning(
  value: unknown,
): StickyNoteImportWarning | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['source', 'reason'])) {
    return undefined
  }
  if (
    typeof value.source !== 'string'
    || value.source.length < 1
    || value.source.length > 32_767
    || !['missing', 'unreadable', 'unsupported'].includes(String(value.reason))
  ) return undefined
  return {
    source: value.source,
    reason: value.reason as StickyNoteImportWarning['reason'],
  }
}

export function parseStickyNoteImportResult(
  value: unknown,
): StickyNoteImportResult | undefined {
  if (!isRecord(value) || !hasExactOwnKeys(value, ['note', 'warnings'])) {
    return undefined
  }
  const note = parseStickyNoteDocument(value.note)
  if (note === undefined || !isExactArray(value.warnings) || value.warnings.length > 10_000) {
    return undefined
  }
  const warnings: StickyNoteImportWarning[] = []
  for (const candidate of value.warnings) {
    const warning = parseStickyNoteImportWarning(candidate)
    if (warning === undefined) return undefined
    warnings.push(warning)
  }
  return { note, warnings }
}

export function parseStickyNoteSaveState(
  value: unknown,
): StickyNoteSaveState | undefined {
  if (!isRecord(value) || typeof value.status !== 'string') return undefined
  if (value.status === 'idle') {
    return hasExactOwnKeys(value, ['status']) ? { status: 'idle' } : undefined
  }
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return undefined
  if (value.status === 'saving' && hasExactOwnKeys(value, ['status', 'revision'])) {
    return { status: 'saving', revision: Number(value.revision) }
  }
  if (
    value.status === 'saved'
    && hasExactOwnKeys(value, ['status', 'revision', 'savedAt'])
    && isCanonicalTimestamp(value.savedAt)
  ) {
    return { status: 'saved', revision: Number(value.revision), savedAt: value.savedAt }
  }
  if (
    value.status === 'error'
    && hasExactOwnKeys(value, ['status', 'revision', 'message'])
    && typeof value.message === 'string'
    && value.message.length >= 1
    && value.message.length <= 500
  ) {
    return { status: 'error', revision: Number(value.revision), message: value.message }
  }
  return undefined
}

export function parseStickyNoteEvent(
  value: unknown,
): StickyNoteEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  if (value.type === 'index-changed' && hasExactOwnKeys(value, ['type', 'noteId'])) {
    if (!(value.noteId === null || isCanonicalStickyNoteId(value.noteId))) return undefined
    return { type: 'index-changed', noteId: value.noteId }
  }
  if (
    value.type === 'save-state'
    && hasExactOwnKeys(value, ['type', 'noteId', 'state'])
    && isCanonicalStickyNoteId(value.noteId)
  ) {
    const state = parseStickyNoteSaveState(value.state)
    return state ? { type: 'save-state', noteId: value.noteId, state } : undefined
  }
  if (
    value.type === 'find-request'
    && hasExactOwnKeys(value, ['type', 'noteId', 'query'])
    && isCanonicalStickyNoteId(value.noteId)
    && typeof value.query === 'string'
    && value.query === value.query.trim()
    && value.query.length >= 1
    && value.query.length <= STICKY_NOTE_SEARCH_QUERY_MAX_LENGTH
  ) {
    return { type: 'find-request', noteId: value.noteId, query: value.query }
  }
  if (
    value.type === 'window-state'
    && hasExactOwnKeys(value, ['type', 'noteId', 'open', 'pinned'])
    && isCanonicalStickyNoteId(value.noteId)
    && typeof value.open === 'boolean'
    && typeof value.pinned === 'boolean'
  ) {
    return {
      type: 'window-state',
      noteId: value.noteId,
      open: value.open,
      pinned: value.pinned,
    }
  }
  if (!isCanonicalStickyNoteId(value.noteId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return undefined
  if (value.type === 'note-summary-changed' && hasExactOwnKeys(value, ['type', 'noteId', 'revision', 'summary'])) {
    const summary = parseStickyNoteSummary(value.summary)
    return summary ? { type: 'note-summary-changed', noteId: value.noteId, revision: Number(value.revision), summary } : undefined
  }
  if (value.type === 'note-style-changed' && hasExactOwnKeys(value, ['type', 'noteId', 'revision', 'style'])) {
    const style = parseStickyNoteStyleReference(value.style)
    return style ? { type: 'note-style-changed', noteId: value.noteId, revision: Number(value.revision), style } : undefined
  }
  if (value.type === 'note-display-state-changed' && hasExactOwnKeys(value, ['type', 'noteId', 'revision', 'displayed', 'pinned']) && typeof value.displayed === 'boolean' && typeof value.pinned === 'boolean') {
    return { type: 'note-display-state-changed', noteId: value.noteId, revision: Number(value.revision), displayed: value.displayed, pinned: value.pinned }
  }
  if (value.type === 'note-name-changed' && hasExactOwnKeys(value, ['type', 'noteId', 'revision', 'name']) && isSafeNoteName(value.name)) {
    return { type: 'note-name-changed', noteId: value.noteId, revision: Number(value.revision), name: value.name }
  }
  if (value.type === 'note-font-size-changed' && hasExactOwnKeys(value, ['type', 'noteId', 'revision', 'fontSizePx']) && Number.isSafeInteger(value.fontSizePx) && Number(value.fontSizePx) >= MIN_STICKY_NOTE_FONT_SIZE_PX && Number(value.fontSizePx) <= MAX_STICKY_NOTE_FONT_SIZE_PX) {
    return { type: 'note-font-size-changed', noteId: value.noteId, revision: Number(value.revision), fontSizePx: Number(value.fontSizePx) }
  }
  if (value.type === 'note-line-spacing-changed' && hasExactOwnKeys(value, ['type', 'noteId', 'revision', 'lineSpacingMode']) && (value.lineSpacingMode === 'compact' || value.lineSpacingMode === 'standard')) {
    return { type: 'note-line-spacing-changed', noteId: value.noteId, revision: Number(value.revision), lineSpacingMode: value.lineSpacingMode }
  }
  return undefined
}
