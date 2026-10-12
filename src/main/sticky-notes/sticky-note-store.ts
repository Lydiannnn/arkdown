import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import {
  copyStickyNoteIndex,
  copyStickyNoteRecord,
  DEFAULT_STICKY_NOTE_FONT_SIZE_PX,
  DEFAULT_STICKY_NOTE_LINE_SPACING_MODE,
  isCanonicalStickyNoteId,
  MAX_ACTIVE_STICKY_NOTES,
  parseStickyNoteIndex,
  parseStickyNoteRecord,
  STICKY_NOTE_MARKDOWN_MAX_BYTES,
  STICKY_NOTE_SCHEMA_VERSION,
  upgradeStickyNoteIndex,
  type CreateStickyNoteInput,
  type StickyNoteDocument,
  type StickyNoteIndex,
  type StickyNoteRecord,
  type StickyNoteStatus,
  type StickyNoteSummary,
} from '../../shared/sticky-notes'
import {
  copyBackgroundSettings,
  DEFAULT_BACKGROUND_SETTINGS,
  parseBackgroundSettings,
  type BackgroundSettings,
} from '../../shared/background-settings'
import {
  copyStickyNoteStyleReference,
  type StickyNoteStyleReference,
} from '../../shared/sticky-note-preferences'
import {
  DEFAULT_STICKY_NOTE_HELP_MARKDOWN,
  LEGACY_DEFAULT_STICKY_NOTE_HELP_MARKDOWN,
  PREVIOUS_DEFAULT_STICKY_NOTE_HELP_MARKDOWN,
} from './default-help-note'
import { documentTypeForPath } from '../../shared/document-types'
import {
  stickyNoteIndexPath,
  stickyNoteBackgroundPath,
  stickyNotePaths,
  stickyNoteRelativePaths,
  stickyNotesRoot,
} from './sticky-note-paths'
import {
  defaultStickyNoteName,
  validateStickyNoteName,
} from './sticky-note-name'

type AtomicWrite = (filePath: string, contents: string) => Promise<void>

const TRANSIENT_ATOMIC_WRITE_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const TRANSIENT_ATOMIC_WRITE_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const
const LEGACY_MATERIAL_PRESET_IDS = new Set(['mica-dark', 'acrylic-dark', 'acrylic-light'])
const STATIC_BACKGROUND_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.svg',
])

export type BackgroundImageUpdate =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'replace'; sourceAbsolutePath: string }

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function retryTransientAtomicWrite(
  atomicWrite: AtomicWrite,
  filePath: string,
  contents: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await atomicWrite(filePath, contents)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const delay = TRANSIENT_ATOMIC_WRITE_RETRY_DELAYS_MS[attempt]
      if (!code || !TRANSIENT_ATOMIC_WRITE_ERROR_CODES.has(code) || delay === undefined) throw error
      await wait(delay)
    }
  }
}

export interface ArchivedDeleteFileSystem {
  realpath(candidate: string): Promise<string>
  rename(source: string, destination: string): Promise<void>
  removeTree(candidate: string): Promise<void>
}

export interface StickyNoteStoreOptions {
  root: string
  getDefaultStyle?: () => StickyNoteStyleReference
  now?: () => Date
  createId?: () => string
  atomicWrite?: AtomicWrite
  createBackupSuffix?: () => string
  reportError?: (message: string, error: unknown) => void
  archivedDeleteFileSystem?: ArchivedDeleteFileSystem
  statusRename?: (source: string, destination: string) => Promise<void>
}

function emptyIndex(): StickyNoteIndex {
  return {
    schemaVersion: STICKY_NOTE_SCHEMA_VERSION,
    notes: [],
    openNoteIdsAtLastSession: [],
    defaultHelpNoteCreated: false,
  }
}

function hasLegacyMaterialPresetId(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const notes = (value as { notes?: unknown }).notes
  if (!Array.isArray(notes)) return false
  return notes.some((note) => {
    if (typeof note !== 'object' || note === null) return false
    const style = (note as { style?: unknown }).style
    if (typeof style !== 'object' || style === null) return false
    const materialPresetId = (style as { materialPresetId?: unknown }).materialPresetId
    return typeof materialPresetId === 'string'
      && LEGACY_MATERIAL_PRESET_IDS.has(materialPresetId)
  })
}

function markdownExcerpt(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, '')
    .replace(/[`*_>#|[\]()-]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160)
}

function validateMarkdown(markdown: string): void {
  if (
    typeof markdown !== 'string'
    || Buffer.byteLength(markdown, 'utf8') > STICKY_NOTE_MARKDOWN_MAX_BYTES
  ) throw new Error('便签内容无效或过大')
}

function defaultStyle() {
  return {
    mode: 'material' as const,
    materialPresetId: 'mica-light' as const,
  }
}

function defaultBackground(): BackgroundSettings {
  return copyBackgroundSettings(DEFAULT_BACKGROUND_SETTINGS)
}

function isStaticBackgroundImagePath(absolutePath: string): boolean {
  return path.isAbsolute(absolutePath)
    && STATIC_BACKGROUND_IMAGE_EXTENSIONS.has(path.extname(absolutePath).toLocaleLowerCase('en-US'))
}

function nextAvailableName(name: string, existingNames: readonly string[]): string {
  const normalized = new Set(
    existingNames.map((candidate) => candidate.toLocaleLowerCase('en-US')),
  )
  if (!normalized.has(name.toLocaleLowerCase('en-US'))) return name
  for (let suffix = 2; suffix <= 100_000; suffix += 1) {
    const candidate = `${name}（${suffix}）`
    if (!normalized.has(candidate.toLocaleLowerCase('en-US'))) return candidate
  }
  throw new Error('无法生成唯一便签名')
}

export class StickyNoteStore {
  private readonly now: () => Date
  private readonly createId: () => string
  private readonly atomicWrite: AtomicWrite
  private readonly createBackupSuffix: () => string
  private readonly reportError: (message: string, error: unknown) => void
  private readonly archivedDeleteFileSystem: ArchivedDeleteFileSystem
  private readonly statusRename: (source: string, destination: string) => Promise<void>
  private current: StickyNoteIndex | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: StickyNoteStoreOptions) {
    this.now = options.now ?? (() => new Date())
    this.createId = options.createId ?? randomUUID
    const atomicWrite = options.atomicWrite ?? ((filePath: string, contents: string) =>
      writeFileAtomic(filePath, contents, { encoding: 'utf8', fsync: true }))
    this.atomicWrite = (filePath, contents) =>
      retryTransientAtomicWrite(atomicWrite, filePath, contents)
    this.createBackupSuffix = options.createBackupSuffix ?? randomUUID
    this.reportError = options.reportError ?? ((message, error) => console.error(message, error))
    this.archivedDeleteFileSystem = options.archivedDeleteFileSystem ?? {
      realpath: (candidate) => realpath(candidate),
      rename: (source, destination) => rename(source, destination),
      removeTree: (candidate) => rm(candidate, { recursive: true, force: true }),
    }
    this.statusRename = options.statusRename ?? ((source, destination) => rename(source, destination))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(operation)
    this.tail = next
    return next
  }

  private async prepareDirectories(): Promise<void> {
    await Promise.all([
      mkdir(stickyNotesRoot(this.options.root), { recursive: true }),
      mkdir(path.join(stickyNotesRoot(this.options.root), 'active'), { recursive: true }),
      mkdir(path.join(stickyNotesRoot(this.options.root), 'archive'), { recursive: true }),
      mkdir(path.join(stickyNotesRoot(this.options.root), '.transactions'), { recursive: true }),
    ])
  }

  private async writeIndex(index: StickyNoteIndex): Promise<void> {
    const validated = parseStickyNoteIndex(index)
    if (validated === undefined) throw new Error('便签注册表状态无效')
    await this.atomicWrite(
      stickyNoteIndexPath(this.options.root),
      `${JSON.stringify(validated, null, 2)}\n`,
    )
  }

  private async backupCorruptIndex(source: string): Promise<void> {
    const backupPath = path.join(
      stickyNotesRoot(this.options.root),
      `index.corrupt-${this.now().getTime()}-${this.createBackupSuffix()}.json`,
    )
    await copyFile(
      stickyNoteIndexPath(this.options.root),
      backupPath,
      constants.COPYFILE_EXCL,
    ).catch((error) => {
      this.reportError('Could not back up corrupt sticky note index', error)
    })
    if (source.length === 0) {
      this.reportError('Sticky note index was empty', new Error('Empty sticky note index'))
    }
  }

  private async rebuildIndex(): Promise<StickyNoteIndex> {
    const notes: StickyNoteRecord[] = []
    for (const status of ['active', 'archived'] as const) {
      const directoryName = status === 'active' ? 'active' : 'archive'
      const directory = path.join(stickyNotesRoot(this.options.root), directoryName)
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() || !isCanonicalStickyNoteId(entry.name)) continue
        const noteDirectory = path.join(directory, entry.name)
        const files = await readdir(noteDirectory, { withFileTypes: true })
        const markdownEntry = files
          .filter((candidate) => (
            candidate.isFile()
            && candidate.name.toLocaleLowerCase('en-US').endsWith('.md')
          ))
          .sort((left, right) => left.name.localeCompare(right.name))[0]
        if (!markdownEntry) continue
        const rawName = markdownEntry.name.slice(0, -3)
        const validatedName = validateStickyNoteName(rawName, [])
        if (!validatedName.ok) continue
        const name = nextAvailableName(
          validatedName.name,
          notes.map((note) => note.name),
        )
        const metadata = await stat(path.join(noteDirectory, markdownEntry.name))
        const timestamp = metadata.mtime.toISOString()
        const identity = { id: entry.name, name, status }
        const relative = stickyNoteRelativePaths(identity)
        const record: StickyNoteRecord = {
          ...identity,
          markdownRelativePath: relative.markdown,
          resourcesRelativePath: relative.resources,
          style: defaultStyle(),
          background: defaultBackground(),
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: status === 'archived' ? timestamp : null,
          released: false,
          pinned: false,
          windowBounds: null,
          lastOpenedAt: null,
          fontSizePx: DEFAULT_STICKY_NOTE_FONT_SIZE_PX,
          lineSpacingMode: DEFAULT_STICKY_NOTE_LINE_SPACING_MODE,
        }
        const expectedPath = stickyNotePaths(this.options.root, record).markdown
        const actualPath = path.join(noteDirectory, markdownEntry.name)
        if (expectedPath !== actualPath) await rename(actualPath, expectedPath)
        await mkdir(stickyNotePaths(this.options.root, record).resources, { recursive: true })
        notes.push(record)
      }
    }
    return {
      schemaVersion: STICKY_NOTE_SCHEMA_VERSION,
      notes,
      openNoteIdsAtLastSession: [],
      defaultHelpNoteCreated: notes.length > 0,
    }
  }

  private createUniqueId(index: StickyNoteIndex): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.createId()
      if (isCanonicalStickyNoteId(id) && !index.notes.some((note) => note.id === id)) {
        return id
      }
    }
    throw new Error('无法生成唯一便签 ID')
  }

  private async createWithinIndex(
    index: StickyNoteIndex,
    input: CreateStickyNoteInput,
  ): Promise<{ index: StickyNoteIndex; document: StickyNoteDocument }> {
    const activeCount = index.notes.filter(({ status }) => status === 'active').length
    if (activeCount >= MAX_ACTIVE_STICKY_NOTES) {
      throw new Error('便签盒子已满，建议将不常用便签进行归档')
    }
    const validatedName = validateStickyNoteName(
      input.name,
      index.notes.map((note) => note.name),
    )
    if (!validatedName.ok) throw new Error(validatedName.message)
    const markdown = input.markdown ?? ''
    validateMarkdown(markdown)
    const id = this.createUniqueId(index)
    const timestamp = this.now().toISOString()
    const identity = { id, name: validatedName.name, status: 'active' as const }
    const relative = stickyNoteRelativePaths(identity)
    const record: StickyNoteRecord = {
      ...identity,
      markdownRelativePath: relative.markdown,
      resourcesRelativePath: relative.resources,
      style: input.style
        ? copyStickyNoteStyleReference(input.style)
        : copyStickyNoteStyleReference(this.options.getDefaultStyle?.() ?? defaultStyle()),
      background: defaultBackground(),
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      released: false,
      pinned: false,
      windowBounds: null,
      lastOpenedAt: null,
      fontSizePx: DEFAULT_STICKY_NOTE_FONT_SIZE_PX,
      lineSpacingMode: DEFAULT_STICKY_NOTE_LINE_SPACING_MODE,
    }
    if (parseStickyNoteRecord(record) === undefined) throw new Error('便签记录无效')
    const paths = stickyNotePaths(this.options.root, record)
    await mkdir(paths.resources, { recursive: true })
    try {
      await this.atomicWrite(paths.markdown, markdown)
      const next = {
        ...copyStickyNoteIndex(index),
        notes: [...index.notes.map(copyStickyNoteRecord), record],
      }
      await this.writeIndex(next)
      return {
        index: next,
        document: { record: copyStickyNoteRecord(record), markdown },
      }
    } catch (error) {
      await rm(paths.directory, { recursive: true, force: true }).catch((rollbackError) => {
        this.reportError('Could not roll back sticky note creation', rollbackError)
      })
      throw error
    }
  }

  private async migrateLegacyDefaultHelpNote(index: StickyNoteIndex): Promise<void> {
    for (const record of index.notes) {
      const markdownPath = stickyNotePaths(this.options.root, record).markdown
      let markdown: string
      try {
        markdown = await readFile(markdownPath, 'utf8')
      } catch {
        continue
      }
      if (markdown !== LEGACY_DEFAULT_STICKY_NOTE_HELP_MARKDOWN) continue
      try {
        await this.atomicWrite(markdownPath, PREVIOUS_DEFAULT_STICKY_NOTE_HELP_MARKDOWN)
      } catch (error) {
        this.reportError('Could not migrate the default sticky note help document', error)
      }
      return
    }
  }

  private async loadOrInitialize(): Promise<StickyNoteIndex> {
    if (this.current) return this.current
    await this.prepareDirectories()
    const indexPath = stickyNoteIndexPath(this.options.root)
    let index: StickyNoteIndex
    let shouldWrite = false
    try {
      const source = await readFile(indexPath, 'utf8')
      const sourceValue = JSON.parse(source) as unknown
      const parsed = parseStickyNoteIndex(sourceValue) ?? upgradeStickyNoteIndex(sourceValue)
      if (parsed === undefined) throw new Error('Invalid sticky note index')
      index = parsed
      shouldWrite = (sourceValue as { schemaVersion?: unknown }).schemaVersion !== STICKY_NOTE_SCHEMA_VERSION
        || hasLegacyMaterialPresetId(sourceValue)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        index = emptyIndex()
      } else {
        const source = await readFile(indexPath, 'utf8').catch(() => '')
        await this.backupCorruptIndex(source)
        index = await this.rebuildIndex()
      }
      shouldWrite = true
    }

    if (!index.defaultHelpNoteCreated) {
      const result = await this.createWithinIndex(index, {
        name: defaultStickyNoteName(this.now(), index.notes.map((note) => note.name)),
        markdown: DEFAULT_STICKY_NOTE_HELP_MARKDOWN,
      })
      index = {
        ...result.index,
        defaultHelpNoteCreated: true,
      }
      await this.writeIndex(index)
      shouldWrite = false
    }
    await this.migrateLegacyDefaultHelpNote(index)
    if (shouldWrite) await this.writeIndex(index)
    this.current = copyStickyNoteIndex(index)
    return this.current
  }

  private requireRecord(index: StickyNoteIndex, noteId: string): StickyNoteRecord {
    if (!isCanonicalStickyNoteId(noteId)) throw new Error('便签 ID 无效')
    const record = index.notes.find(({ id }) => id === noteId)
    if (!record) throw new Error('便签不存在')
    return record
  }

  async initialize(): Promise<StickyNoteIndex> {
    return this.enqueue(async () => copyStickyNoteIndex(await this.loadOrInitialize()))
  }

  async readOpenNoteIds(): Promise<string[]> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      return [...index.openNoteIdsAtLastSession]
    })
  }

  async writeOpenNoteIds(noteIds: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const restorableIds = new Set(
        index.notes
          .filter((record) => record.status === 'active')
          .map((record) => record.id),
      )
      const seen = new Set<string>()
      const openNoteIdsAtLastSession = noteIds.filter((noteId) => {
        if (!restorableIds.has(noteId) || seen.has(noteId)) return false
        seen.add(noteId)
        return true
      })
      const next = {
        ...copyStickyNoteIndex(index),
        openNoteIdsAtLastSession,
      }
      await this.writeIndex(next)
      this.current = next
    })
  }

  async list(status: StickyNoteStatus): Promise<StickyNoteSummary[]> {
    return this.enqueue(async () => {
      if (status !== 'active' && status !== 'archived') throw new Error('便签状态无效')
      const index = await this.loadOrInitialize()
      const records = index.notes.filter((record) => record.status === status)
      if (status === 'archived') {
        records.sort((left, right) => (
          (right.archivedAt ?? '').localeCompare(left.archivedAt ?? '')
        ))
      }
      return Promise.all(records.map(async (record) => {
        const markdown = await readFile(
          stickyNotePaths(this.options.root, record).markdown,
          'utf8',
        )
        return { record: copyStickyNoteRecord(record), excerpt: markdownExcerpt(markdown) }
      }))
    })
  }

  async get(noteId: string): Promise<StickyNoteDocument> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const record = this.requireRecord(index, noteId)
      const markdown = await readFile(stickyNotePaths(this.options.root, record).markdown, 'utf8')
      return { record: copyStickyNoteRecord(record), markdown }
    })
  }

  async create(input: CreateStickyNoteInput): Promise<StickyNoteDocument> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const result = await this.createWithinIndex(index, input)
      this.current = copyStickyNoteIndex(result.index)
      return result.document
    })
  }

  async reorderActiveNotes(noteIds: readonly string[]): Promise<StickyNoteSummary[]> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const active = index.notes.filter(({ status }) => status === 'active')
      const activeIds = new Set(active.map(({ id }) => id))
      if (
        noteIds.length !== active.length
        || new Set(noteIds).size !== noteIds.length
        || noteIds.some((noteId) => !activeIds.has(noteId))
      ) throw new Error('Sticky note order is invalid')

      const byId = new Map(active.map((record) => [record.id, record] as const))
      let activeIndex = 0
      const ordered = noteIds.map((noteId) => copyStickyNoteRecord(byId.get(noteId)!))
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.map((record) => (
          record.status === 'active'
            ? ordered[activeIndex++]
            : copyStickyNoteRecord(record)
        )),
      }
      await this.writeIndex(next)
      this.current = next

      return Promise.all(ordered.map(async (record) => ({
        record: copyStickyNoteRecord(record),
        excerpt: markdownExcerpt(await readFile(
          stickyNotePaths(this.options.root, record).markdown,
          'utf8',
        )),
      })))
    })
  }

  async copyImageResource(noteId: string, absolutePath: string): Promise<string> {
    if (!path.isAbsolute(absolutePath) || documentTypeForPath(absolutePath)?.category !== 'image') {
      throw new Error('便签图片无效')
    }
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const record = this.requireRecord(index, noteId)
      const metadata = await lstat(absolutePath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('便签图片无效')
      const extension = path.extname(absolutePath).toLocaleLowerCase('en-US')
      const fileName = randomUUID() + extension
      const target = path.join(stickyNotePaths(this.options.root, record).resources, fileName)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(absolutePath, target, constants.COPYFILE_EXCL)
      return '![](resources/' + fileName + ')'
    })
  }

  async setBackground(
    noteId: string,
    background: BackgroundSettings,
  ): Promise<StickyNoteRecord> {
    const parsedBackground = parseBackgroundSettings(background)
    if (parsedBackground === undefined) throw new Error('便签背景设置无效')
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const current = this.requireRecord(index, noteId)
      const updated: StickyNoteRecord = {
        ...copyStickyNoteRecord(current),
        background: {
          ...copyBackgroundSettings(parsedBackground),
          imageRelativePath: current.background.imageRelativePath,
        },
        updatedAt: this.now().toISOString(),
      }
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.map((candidate) => (
          candidate.id === noteId ? updated : copyStickyNoteRecord(candidate)
        )),
      }
      await this.writeIndex(next)
      this.current = next
      return copyStickyNoteRecord(updated)
    })
  }

  async applyBackground(
    noteId: string,
    background: BackgroundSettings,
    imageUpdate: BackgroundImageUpdate,
    assertCurrent: () => void = () => undefined,
  ): Promise<StickyNoteRecord> {
    const parsedBackground = parseBackgroundSettings(background)
    if (parsedBackground === undefined) throw new Error('便签背景设置无效')
    if (
      imageUpdate.kind !== 'keep'
      && imageUpdate.kind !== 'remove'
      && (
        imageUpdate.kind !== 'replace'
        || !isStaticBackgroundImagePath(imageUpdate.sourceAbsolutePath)
      )
    ) throw new Error('背景图片无效')

    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      assertCurrent()
      const current = this.requireRecord(index, noteId)
      const paths = stickyNotePaths(this.options.root, current)
      let copiedPath: string | null = null
      let imageRelativePath = current.background.imageRelativePath

      if (imageUpdate.kind === 'remove') {
        imageRelativePath = null
      } else if (imageUpdate.kind === 'replace') {
        const metadata = await lstat(imageUpdate.sourceAbsolutePath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('背景图片无效')
        const extension = path.extname(imageUpdate.sourceAbsolutePath).toLocaleLowerCase('en-US')
        const fileName = `${randomUUID()}${extension}`
        imageRelativePath = `resources/${fileName}`
        copiedPath = path.join(paths.resources, fileName)
        await mkdir(paths.resources, { recursive: true })
        await copyFile(imageUpdate.sourceAbsolutePath, copiedPath, constants.COPYFILE_EXCL)
      }

      const updated: StickyNoteRecord = {
        ...copyStickyNoteRecord(current),
        background: {
          ...copyBackgroundSettings(parsedBackground),
          imageRelativePath,
        },
        updatedAt: this.now().toISOString(),
      }
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.map((candidate) => (
          candidate.id === noteId ? updated : copyStickyNoteRecord(candidate)
        )),
      }

      try {
        assertCurrent()
        await this.writeIndex(next)
      } catch (error) {
        if (copiedPath !== null) {
          await rm(copiedPath, { force: true }).catch((rollbackError) => {
            this.reportError('Could not roll back sticky note background copy', rollbackError)
          })
        }
        throw error
      }

      const previous = stickyNoteBackgroundPath(this.options.root, current)
      if (
        imageUpdate.kind !== 'keep'
        && previous !== null
        && previous !== copiedPath
      ) {
        await rm(previous, { force: true }).catch((error) => {
          this.reportError('Could not remove replaced sticky note background', error)
        })
      }
      this.current = next
      return copyStickyNoteRecord(updated)
    })
  }

  async replaceBackgroundImage(noteId: string, absolutePath: string): Promise<StickyNoteRecord> {
    if (!isStaticBackgroundImagePath(absolutePath)) throw new Error('背景图片无效')
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const current = this.requireRecord(index, noteId)
      const metadata = await lstat(absolutePath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('背景图片无效')

      const extension = path.extname(absolutePath).toLocaleLowerCase('en-US')
      const fileName = `${randomUUID()}${extension}`
      const imageRelativePath = `resources/${fileName}`
      const paths = stickyNotePaths(this.options.root, current)
      const target = path.join(paths.resources, fileName)
      const updated: StickyNoteRecord = {
        ...copyStickyNoteRecord(current),
        background: {
          ...copyBackgroundSettings(current.background),
          imageRelativePath,
        },
        updatedAt: this.now().toISOString(),
      }
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.map((candidate) => (
          candidate.id === noteId ? updated : copyStickyNoteRecord(candidate)
        )),
      }

      await mkdir(paths.resources, { recursive: true })
      await copyFile(absolutePath, target, constants.COPYFILE_EXCL)
      try {
        await this.writeIndex(next)
      } catch (error) {
        await rm(target, { force: true }).catch((rollbackError) => {
          this.reportError('Could not roll back sticky note background copy', rollbackError)
        })
        throw error
      }
      const previous = stickyNoteBackgroundPath(this.options.root, current)
      if (previous !== null && previous !== target) {
        await rm(previous, { force: true }).catch((error) => {
          this.reportError('Could not remove replaced sticky note background', error)
        })
      }
      this.current = next
      return copyStickyNoteRecord(updated)
    })
  }

  async resolveBackgroundImagePath(noteId: string): Promise<string | null> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const record = this.requireRecord(index, noteId)
      const backgroundPath = stickyNoteBackgroundPath(this.options.root, record)
      if (backgroundPath === null) return null
      const metadata = await lstat(backgroundPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (metadata === null) return null
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('背景图片无效')
      return backgroundPath
    })
  }

  async writeMarkdown(noteId: string, markdown: string): Promise<StickyNoteDocument> {
    validateMarkdown(markdown)
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const record = this.requireRecord(index, noteId)
      const paths = stickyNotePaths(this.options.root, record)
      const previous = await readFile(paths.markdown, 'utf8')
      const nextRecord = { ...copyStickyNoteRecord(record), updatedAt: this.now().toISOString() }
      const nextIndex = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.map((candidate) => (
          candidate.id === noteId ? nextRecord : copyStickyNoteRecord(candidate)
        )),
      }
      try {
        await this.atomicWrite(paths.markdown, markdown)
        await this.writeIndex(nextIndex)
      } catch (error) {
        await this.atomicWrite(paths.markdown, previous).catch((rollbackError) => {
          this.reportError('Could not roll back sticky note markdown', rollbackError)
        })
        throw error
      }
      this.current = nextIndex
      return { record: copyStickyNoteRecord(nextRecord), markdown }
    })
  }

  async updateRecord(
    noteId: string,
    updater: (record: StickyNoteRecord) => StickyNoteRecord,
  ): Promise<StickyNoteRecord> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const current = this.requireRecord(index, noteId)
      const updated = updater(copyStickyNoteRecord(current))
      const parsed = parseStickyNoteRecord(updated)
      if (
        parsed === undefined
        || parsed.id !== current.id
        || parsed.name !== current.name
        || parsed.status !== current.status
        || parsed.markdownRelativePath !== current.markdownRelativePath
        || parsed.resourcesRelativePath !== current.resourcesRelativePath
      ) throw new Error('便签记录更新无效')
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.map((candidate) => (
          candidate.id === noteId ? parsed : copyStickyNoteRecord(candidate)
        )),
        openNoteIdsAtLastSession: index.openNoteIdsAtLastSession.filter((id) => (
          id !== noteId || parsed.status === 'active'
        )),
      }
      await this.writeIndex(next)
      this.current = next
      return copyStickyNoteRecord(parsed)
    })
  }

  async rename(noteId: string, name: string): Promise<StickyNoteDocument> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const current = this.requireRecord(index, noteId)
      const validated = validateStickyNoteName(
        name,
        index.notes.map((note) => note.name),
        current.name,
      )
      if (!validated.ok) throw new Error(validated.message)
      const markdown = await readFile(stickyNotePaths(this.options.root, current).markdown, 'utf8')
      if (validated.name === current.name) {
        return { record: copyStickyNoteRecord(current), markdown }
      }
      const identity = { id: current.id, name: validated.name, status: current.status }
      const relative = stickyNoteRelativePaths(identity)
      const updated: StickyNoteRecord = {
        ...copyStickyNoteRecord(current),
        name: validated.name,
        markdownRelativePath: relative.markdown,
        resourcesRelativePath: relative.resources,
        updatedAt: this.now().toISOString(),
      }
      const oldPaths = stickyNotePaths(this.options.root, current)
      const newPaths = stickyNotePaths(this.options.root, updated)
      await stat(newPaths.markdown).then(
        () => { throw new Error('目标便签文件已存在') },
        (error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        },
      )
      await rename(oldPaths.markdown, newPaths.markdown)
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.map((candidate) => (
          candidate.id === noteId ? updated : copyStickyNoteRecord(candidate)
        )),
      }
      try {
        await this.writeIndex(next)
      } catch (error) {
        await rename(newPaths.markdown, oldPaths.markdown).catch((rollbackError) => {
          this.reportError('Could not roll back sticky note rename', rollbackError)
        })
        throw error
      }
      this.current = next
      return { record: copyStickyNoteRecord(updated), markdown }
    })
  }

  private async moveStatus(
    noteId: string,
    targetStatus: StickyNoteStatus,
  ): Promise<StickyNoteDocument> {
    const index = await this.loadOrInitialize()
    const current = this.requireRecord(index, noteId)
    if (current.status === targetStatus) {
      const markdown = await readFile(stickyNotePaths(this.options.root, current).markdown, 'utf8')
      return { record: copyStickyNoteRecord(current), markdown }
    }
    if (
      targetStatus === 'active'
      && index.notes.filter(({ status }) => status === 'active').length >= MAX_ACTIVE_STICKY_NOTES
    ) throw new Error('便签盒子已满，建议将不常用便签进行归档')

    const timestamp = this.now().toISOString()
    const identity = { id: current.id, name: current.name, status: targetStatus }
    const relative = stickyNoteRelativePaths(identity)
    const updated: StickyNoteRecord = {
      ...copyStickyNoteRecord(current),
      status: targetStatus,
      markdownRelativePath: relative.markdown,
      resourcesRelativePath: relative.resources,
      archivedAt: targetStatus === 'archived' ? timestamp : null,
      updatedAt: timestamp,
      released: false,
      pinned: false,
    }
    const oldPaths = stickyNotePaths(this.options.root, current)
    const newPaths = stickyNotePaths(this.options.root, updated)
    await mkdir(path.dirname(newPaths.directory), { recursive: true })
    await rename(oldPaths.directory, newPaths.directory)
    const next = {
      ...copyStickyNoteIndex(index),
      notes: index.notes.map((candidate) => (
        candidate.id === noteId ? updated : copyStickyNoteRecord(candidate)
      )),
      openNoteIdsAtLastSession: index.openNoteIdsAtLastSession.filter((id) => id !== noteId),
    }
    try {
      await this.writeIndex(next)
    } catch (error) {
      await rename(newPaths.directory, oldPaths.directory).catch((rollbackError) => {
        this.reportError('Could not roll back sticky note move', rollbackError)
      })
      throw error
    }
    this.current = next
    const markdown = await readFile(newPaths.markdown, 'utf8')
    return { record: copyStickyNoteRecord(updated), markdown }
  }

  async archive(noteId: string): Promise<StickyNoteDocument> {
    return this.enqueue(() => this.moveStatus(noteId, 'archived'))
  }

  async restore(noteId: string): Promise<StickyNoteDocument> {
    return this.enqueue(() => this.moveStatus(noteId, 'active'))
  }

  async restoreArchived(noteIds: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const ids = [...new Set(noteIds)]
      if (ids.length === 0) throw new Error('请选择要恢复的归档便签')
      const index = await this.loadOrInitialize()
      const records = ids.map((id) => this.requireRecord(index, id))
      if (records.some((record) => record.status !== 'archived')) {
        throw new Error('只能批量恢复归档便签')
      }
      const activeCount = index.notes.filter(({ status }) => status === 'active').length
      if (activeCount + records.length > MAX_ACTIVE_STICKY_NOTES) {
        throw new Error('便签盒子剩余位置不足，无法恢复所选便签')
      }

      const timestamp = this.now().toISOString()
      const transitions = records.map((record) => {
        const relative = stickyNoteRelativePaths({ id: record.id, name: record.name, status: 'active' })
        const updated: StickyNoteRecord = {
          ...copyStickyNoteRecord(record),
          status: 'active',
          markdownRelativePath: relative.markdown,
          resourcesRelativePath: relative.resources,
          archivedAt: null,
          updatedAt: timestamp,
          released: false,
          pinned: false,
        }
        return {
          updated,
          source: stickyNotePaths(this.options.root, record).directory,
          destination: stickyNotePaths(this.options.root, updated).directory,
        }
      })
      await mkdir(path.join(stickyNotesRoot(this.options.root), 'active'), { recursive: true })
      const moved: typeof transitions[number][] = []
      try {
        for (const transition of transitions) {
          await this.statusRename(transition.source, transition.destination)
          moved.push(transition)
        }
        const updates = new Map(transitions.map(({ updated }) => [updated.id, updated]))
        const next = {
          ...copyStickyNoteIndex(index),
          notes: index.notes.map((record) => (
            updates.has(record.id)
              ? copyStickyNoteRecord(updates.get(record.id)!)
              : copyStickyNoteRecord(record)
          )),
          openNoteIdsAtLastSession: index.openNoteIdsAtLastSession
            .filter((id) => !updates.has(id)),
        }
        await this.writeIndex(next)
        this.current = next
      } catch (error) {
        for (const transition of moved.reverse()) {
          await this.statusRename(transition.destination, transition.source).catch((rollbackError) => {
            this.reportError('Could not roll back archived note batch restore', rollbackError)
          })
        }
        throw error
      }
    })
  }

  private async resolveArchivedDeleteSources(
    records: readonly StickyNoteRecord[],
  ): Promise<readonly string[]> {
    const archiveRoot = await this.archivedDeleteFileSystem.realpath(
      path.join(stickyNotesRoot(this.options.root), 'archive'),
    )
    const sources: string[] = []
    const canonicalSources = new Set<string>()
    for (const record of records) {
      const source = await this.archivedDeleteFileSystem.realpath(
        stickyNotePaths(this.options.root, record).directory,
      )
      const relative = path.relative(archiveRoot, source)
      if (
        relative.length === 0
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) throw new Error('\u5f52\u6863\u4fbf\u7b7e\u8def\u5f84\u8d85\u51fa\u5f52\u6863\u76ee\u5f55')
      if (canonicalSources.has(source)) {
        throw new Error('\u5f52\u6863\u4fbf\u7b7e\u76ee\u5f55\u65e0\u6548')
      }
      const metadata = await stat(source)
      if (!metadata.isDirectory()) throw new Error('\u5f52\u6863\u4fbf\u7b7e\u76ee\u5f55\u65e0\u6548')
      canonicalSources.add(source)
      sources.push(source)
    }
    return sources
  }

  private async commitArchivedDeleteTransaction(
    index: StickyNoteIndex,
    records: readonly StickyNoteRecord[],
    sources: readonly string[],
  ): Promise<void> {
    const transactionRoot = path.join(
      stickyNotesRoot(this.options.root),
      '.transactions',
      `delete-archived-${this.createBackupSuffix()}`,
    )
    await mkdir(transactionRoot)
    const staged: Array<{ source: string; destination: string }> = []
    try {
      for (let index = 0; index < records.length; index += 1) {
        const source = sources[index]
        const destination = path.join(transactionRoot, records[index].id)
        await this.archivedDeleteFileSystem.rename(source, destination)
        staged.push({ source, destination })
      }
      const deletedIds = new Set(records.map(({ id }) => id))
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes
          .filter(({ id }) => !deletedIds.has(id))
          .map(copyStickyNoteRecord),
        openNoteIdsAtLastSession: index.openNoteIdsAtLastSession
          .filter((id) => !deletedIds.has(id)),
      }
      await this.writeIndex(next)
      this.current = next
    } catch (error) {
      for (const entry of staged.reverse()) {
        await this.archivedDeleteFileSystem
          .rename(entry.destination, entry.source)
          .catch((rollbackError) => {
            this.reportError('Could not roll back archived note batch deletion', rollbackError)
          })
      }
      throw error
    }
    await this.archivedDeleteFileSystem.removeTree(transactionRoot).catch((error) => {
      this.reportError('Could not remove archived note deletion transaction', error)
    })
  }

  async deleteArchived(noteIds: readonly string[]): Promise<void> {
    return this.enqueue(async () => {
      const ids = [...new Set(noteIds)]
      if (ids.length === 0) {
        throw new Error('\u8bf7\u9009\u62e9\u8981\u5220\u9664\u7684\u5f52\u6863\u4fbf\u7b7e')
      }
      const index = await this.loadOrInitialize()
      const records = ids.map((id) => this.requireRecord(index, id))
      if (records.some((record) => record.status !== 'archived')) {
        throw new Error('\u53ea\u80fd\u6c38\u4e45\u5220\u9664\u5f52\u6863\u4fbf\u7b7e')
      }
      const sources = await this.resolveArchivedDeleteSources(records)
      await this.commitArchivedDeleteTransaction(index, records, sources)
    })
  }

  async delete(noteId: string): Promise<void> {
    return this.enqueue(async () => {
      const index = await this.loadOrInitialize()
      const current = this.requireRecord(index, noteId)
      const paths = stickyNotePaths(this.options.root, current)
      const transactionDirectory = path.join(
        stickyNotesRoot(this.options.root),
        '.transactions',
        `delete-${noteId}-${this.createBackupSuffix()}`,
      )
      await rename(paths.directory, transactionDirectory)
      const next = {
        ...copyStickyNoteIndex(index),
        notes: index.notes.filter(({ id }) => id !== noteId).map(copyStickyNoteRecord),
        openNoteIdsAtLastSession: index.openNoteIdsAtLastSession.filter((id) => id !== noteId),
      }
      try {
        await this.writeIndex(next)
      } catch (error) {
        await rename(transactionDirectory, paths.directory).catch((rollbackError) => {
          this.reportError('Could not roll back sticky note deletion', rollbackError)
        })
        throw error
      }
      this.current = next
      await rm(transactionDirectory, { recursive: true, force: true }).catch((error) => {
        this.reportError('Could not remove deleted sticky note transaction', error)
      })
    })
  }
}
