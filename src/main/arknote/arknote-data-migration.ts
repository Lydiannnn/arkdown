import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { upgradeStickyNoteIndex } from '../../shared/sticky-notes'
import {
  ArknoteSettingsStore,
  arknoteSettingsFromLegacy,
  parseArknoteSettings,
} from './arknote-settings-store'
import {
  assertAbsoluteNormalizedPath,
  pathsOverlap,
} from './arknote-paths'

type CopyDirectory = (source: string, target: string) => Promise<void>
type RenamePath = (source: string, target: string) => Promise<void>
type RemovePathOptions = { recursive: true; force: boolean }
type RemovePath = (target: string, options: RemovePathOptions) => Promise<void>

interface MigrationMarker {
  schemaVersion: 1
  legacyIndexSha256: string
}

const MIGRATION_MARKER_NAME = '.embedded-migration.json'

export interface EmbeddedStickyNoteMigrationInput {
  legacyRoot: string
  arknoteRoot: string
  copyDirectory?: CopyDirectory
  renamePath?: RenamePath
  removePath?: RemovePath
}

export type EmbeddedStickyNoteMigrationResult =
  | 'migrated'
  | 'already-migrated'
  | 'nothing-to-migrate'

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const copyDirectory: CopyDirectory = async (source, target) => {
  await cp(source, target, { recursive: true, errorOnExist: true, force: false })
}

function validateMigrationRoots(input: Pick<
  EmbeddedStickyNoteMigrationInput,
  'legacyRoot' | 'arknoteRoot'
>): void {
  assertAbsoluteNormalizedPath(input.legacyRoot, '旧版数据目录')
  assertAbsoluteNormalizedPath(input.arknoteRoot, 'Arknote 数据目录')
}

function assertIndependentMigrationPaths(
  sources: readonly string[],
  target: string,
): void {
  if (sources.some((source) => pathsOverlap(source, target))) {
    throw new Error('旧版数据目录与 Arknote 数据目录不得重叠')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseMigrationMarker(value: unknown): MigrationMarker | undefined {
  if (!isRecord(value)) return undefined
  const keys = Object.keys(value)
  if (
    keys.length !== 2
    || !keys.includes('schemaVersion')
    || !keys.includes('legacyIndexSha256')
    || value.schemaVersion !== 1
    || typeof value.legacyIndexSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.legacyIndexSha256)
  ) return undefined
  return {
    schemaVersion: 1,
    legacyIndexSha256: value.legacyIndexSha256,
  }
}

async function readOrdinaryFile(filePath: string): Promise<Buffer> {
  const stats = await lstat(filePath)
  if (!stats.isFile()) throw new Error(`迁移文件不是普通文件: ${filePath}`)
  return readFile(filePath)
}

async function assertReadableDirectory(directoryPath: string): Promise<void> {
  const stats = await lstat(directoryPath)
  if (!stats.isDirectory()) throw new Error(`迁移资源路径不是目录: ${directoryPath}`)
  await readdir(directoryPath)
}

async function validateCopiedNotes(
  notesRoot: string,
): Promise<NonNullable<ReturnType<typeof upgradeStickyNoteIndex>>> {
  const indexPath = path.join(notesRoot, 'index.json')
  const source = JSON.parse((await readOrdinaryFile(indexPath)).toString('utf8')) as unknown
  const upgraded = upgradeStickyNoteIndex(source)
  if (!upgraded) throw new Error('旧便签注册表无效')
  for (const note of upgraded.notes) {
    const markdownPath = path.join(notesRoot, ...note.markdownRelativePath.split('/'))
    const resourcesPath = path.join(notesRoot, ...note.resourcesRelativePath.split('/'))
    await readOrdinaryFile(markdownPath)
    await assertReadableDirectory(resourcesPath)
  }
  return upgraded
}

async function legacyIndexSha256(notesRoot: string): Promise<string> {
  const index = await readOrdinaryFile(path.join(notesRoot, 'index.json'))
  return createHash('sha256').update(index).digest('hex')
}

async function readMigrationMarker(notesRoot: string): Promise<MigrationMarker | undefined> {
  try {
    const source = JSON.parse(
      (await readOrdinaryFile(path.join(notesRoot, MIGRATION_MARKER_NAME))).toString('utf8'),
    ) as unknown
    return parseMigrationMarker(source)
  } catch {
    return undefined
  }
}

async function writeMigrationMarker(notesRoot: string, legacyIndexHash: string): Promise<void> {
  const marker: MigrationMarker = {
    schemaVersion: 1,
    legacyIndexSha256: legacyIndexHash,
  }
  await writeFileAtomic(
    path.join(notesRoot, MIGRATION_MARKER_NAME),
    `${JSON.stringify(marker, null, 2)}\n`,
    { encoding: 'utf8', fsync: true },
  )
}

async function syncCopiedRegularFiles(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      await syncCopiedRegularFiles(entryPath)
      continue
    }
    if (!entry.isFile()) continue
    const handle = await open(entryPath, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
}

async function cleanupMatchingSources(
  targetNotes: string,
  sources: string[],
  removePath: RemovePath,
): Promise<void> {
  const marker = await readMigrationMarker(targetNotes)
  if (!marker) return
  for (const source of sources) {
    if (!await exists(source)) continue
    try {
      await validateCopiedNotes(source)
      if (await legacyIndexSha256(source) !== marker.legacyIndexSha256) continue
    } catch {
      continue
    }
    await removePath(source, { recursive: true, force: false })
  }
}

export async function migrateEmbeddedStickyNotes(
  input: EmbeddedStickyNoteMigrationInput,
): Promise<EmbeddedStickyNoteMigrationResult> {
  validateMigrationRoots(input)
  const renamePath = input.renamePath ?? rename
  const removePath = input.removePath ?? rm
  const legacyNotes = path.join(input.legacyRoot, 'notes')
  const backupNotes = path.join(input.legacyRoot, 'notes.migrated-backup')
  const targetNotes = path.join(input.arknoteRoot, 'notes')
  assertIndependentMigrationPaths([legacyNotes, backupNotes], targetNotes)

  const targetExists = await exists(targetNotes)
  let targetIsValid = false
  let targetFailure: unknown
  if (targetExists) {
    try {
      await validateCopiedNotes(targetNotes)
      targetIsValid = true
    } catch (error) {
      targetFailure = error
    }
  }
  if (targetIsValid) {
    await cleanupMatchingSources(targetNotes, [legacyNotes, backupNotes], removePath)
    return 'already-migrated'
  }

  const legacyExists = await exists(legacyNotes)
  const backupExists = await exists(backupNotes)
  let migrationSource: string | undefined
  let sourceFailure: unknown
  for (const candidate of [
    ...(legacyExists ? [legacyNotes] : []),
    ...(backupExists ? [backupNotes] : []),
  ]) {
    try {
      await validateCopiedNotes(candidate)
      migrationSource = candidate
      break
    } catch (error) {
      sourceFailure ??= error
    }
  }

  if (!migrationSource) {
    if (sourceFailure) throw sourceFailure
    if (targetFailure) throw targetFailure
    return 'nothing-to-migrate'
  }

  await mkdir(input.arknoteRoot, { recursive: true })
  const transactionRoot = path.join(input.arknoteRoot, `.migration-${randomUUID()}`)
  const transactionNotes = path.join(transactionRoot, 'notes')
  try {
    await (input.copyDirectory ?? copyDirectory)(migrationSource, transactionNotes)
    const upgraded = await validateCopiedNotes(transactionNotes)
    const copiedLegacyIndexHash = await legacyIndexSha256(transactionNotes)
    await writeFileAtomic(
      path.join(transactionNotes, 'index.json'),
      `${JSON.stringify(upgraded, null, 2)}\n`,
      { encoding: 'utf8', fsync: true },
    )
    await writeMigrationMarker(transactionNotes, copiedLegacyIndexHash)
    await syncCopiedRegularFiles(transactionNotes)
    await validateCopiedNotes(transactionNotes)
    const transactionMarker = await readMigrationMarker(transactionNotes)
    if (transactionMarker?.legacyIndexSha256 !== copiedLegacyIndexHash) {
      throw new Error('Arknote 迁移来源标记无效')
    }

    if (targetExists) {
      await removePath(targetNotes, { recursive: true, force: false })
    }
    await renamePath(transactionNotes, targetNotes)
    await validateCopiedNotes(targetNotes)
    const targetMarker = await readMigrationMarker(targetNotes)
    if (targetMarker?.legacyIndexSha256 !== copiedLegacyIndexHash) {
      throw new Error('Arknote 迁移来源标记无效')
    }
    return 'migrated'
  } finally {
    await removePath(transactionRoot, { recursive: true, force: true })
  }
}

export async function migrateEmbeddedArknoteSettings(
  input: Pick<EmbeddedStickyNoteMigrationInput, 'legacyRoot' | 'arknoteRoot'>,
): Promise<EmbeddedStickyNoteMigrationResult> {
  validateMigrationRoots(input)
  const legacySettings = path.join(input.legacyRoot, 'settings.json')
  const targetSettings = path.join(input.arknoteRoot, 'settings.json')
  assertIndependentMigrationPaths([legacySettings], targetSettings)
  if (await exists(targetSettings)) {
    let targetSource: unknown
    try {
      targetSource = JSON.parse(await readFile(targetSettings, 'utf8')) as unknown
    } catch {
      return 'already-migrated'
    }
    if (
      !isRecord(targetSource)
      || Object.prototype.hasOwnProperty.call(targetSource, 'themeColor')
      || !await exists(legacySettings)
    ) return 'already-migrated'
    const target = parseArknoteSettings(targetSource)
    if (!target) return 'already-migrated'
    let legacySource: unknown
    try {
      legacySource = JSON.parse(await readFile(legacySettings, 'utf8')) as unknown
    } catch {
      return 'already-migrated'
    }
    const legacyThemeColor = arknoteSettingsFromLegacy(legacySource).themeColor
    await new ArknoteSettingsStore(input.arknoteRoot).save({
      ...target,
      themeColor: legacyThemeColor,
    })
    return 'migrated'
  }
  if (!await exists(legacySettings)) return 'nothing-to-migrate'
  const source = JSON.parse(await readFile(legacySettings, 'utf8')) as unknown
  await new ArknoteSettingsStore(input.arknoteRoot).save(arknoteSettingsFromLegacy(source))
  return 'migrated'
}
