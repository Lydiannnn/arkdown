import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { DocumentEncoding, NewlineStyle } from '../../shared/contracts'
import { draftPaths, isClipboardAssetName, isDraftId } from './draft-paths'
import type {
  DraftAssetRecord,
  DraftManifest,
  DraftSummary,
  RecoveredDraft,
  DraftLifecycleRecord,
} from './draft-types'

const REVISION = /^[0-9a-f]{64}$/
const MAX_MARKDOWN_BYTES = 16 * 1024 * 1024

export interface SaveDraftRecord {
  draftId: string
  markdown: string
  originalAbsolutePath: string | null
  workspaceAbsolutePath: string | null
  originalRevision: string | null
  originalMtimeMs: number | null
  encoding: DocumentEncoding
  newline: NewlineStyle
}

type AtomicWrite = (filePath: string, contents: string) => Promise<void>

export interface DraftServiceOptions {
  root: string
  appVersion: string
  now?: () => Date
  atomicWrite?: AtomicWrite
  removeDirectory?: (directory: string) => Promise<void>
}

export interface DraftFinalizeTransaction {
  readonly retainsAssets?: true
  commit(): Promise<void>
  rollback(): Promise<void>
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function summaryOf(manifest: DraftManifest): DraftSummary {
  return {
    draftId: manifest.draftId,
    originalAbsolutePath: manifest.originalAbsolutePath,
    workspaceAbsolutePath: manifest.workspaceAbsolutePath,
    originalRevision: manifest.originalRevision,
    originalMtimeMs: manifest.originalMtimeMs,
    encoding: manifest.encoding,
    newline: manifest.newline,
    updatedAt: manifest.updatedAt,
    ignoredAt: manifest.ignoredAt,
  }
}

function isNullableAbsolutePath(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && path.isAbsolute(value))
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isAsset(value: unknown): value is DraftAssetRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.assetId === 'string'
    && REVISION.test(record.assetId)
    && typeof record.fileName === 'string'
    && record.fileName.length > 0
    && path.basename(record.fileName) === record.fileName
    && typeof record.sha256 === 'string'
    && REVISION.test(record.sha256)
  )
}

function parseManifest(value: unknown, expectedDraftId: string): DraftManifest {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid draft manifest')
  const record = value as Record<string, unknown>
  if (
    record.version !== 1
    || record.draftId !== expectedDraftId
    || !isDraftId(expectedDraftId)
    || !isNullableAbsolutePath(record.originalAbsolutePath)
    || !isNullableAbsolutePath(record.workspaceAbsolutePath)
    || !(record.originalRevision === null
      || (typeof record.originalRevision === 'string' && REVISION.test(record.originalRevision)))
    || !isNullableFiniteNumber(record.originalMtimeMs)
    || (record.encoding !== 'utf8' && record.encoding !== 'utf8-bom')
    || (record.newline !== 'lf' && record.newline !== 'crlf')
    || typeof record.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(record.updatedAt))
    || typeof record.appVersion !== 'string'
    || !(record.ignoredAt === null
      || (typeof record.ignoredAt === 'string' && Number.isFinite(Date.parse(record.ignoredAt))))
    || typeof record.bodySha256 !== 'string'
    || !REVISION.test(record.bodySha256)
    || !Array.isArray(record.assets)
    || !record.assets.every(isAsset)
  ) {
    throw new Error('Invalid draft manifest')
  }
  return record as unknown as DraftManifest
}

export class DraftService {
  private readonly now: () => Date
  private readonly atomicWrite: AtomicWrite
  private readonly writes = new Map<string, Promise<unknown>>()
  private readonly stagedFinalizations = new Map<string, object>()
  private pendingFinalizationRecovery: Promise<void> | null = null
  private recoveredPendingFinalizations = false
  private readonly unresolvedFinalizations = new Set<string>()
  private readonly savedHistory = new Set<string>()
  // Resource retention does not grant permission to write/recover an ended id.
  private readonly retainedAssetHistory = new Set<string>()
  private readonly owners = new Map<string, object>()

  claim(draftId: string, owner: object): void {
    if (!isDraftId(draftId)) throw new Error('Invalid draft id')
    const existing = this.owners.get(draftId)
    if (existing && existing !== owner) throw new Error('Draft already belongs to another window')
    this.owners.set(draftId, owner)
  }

  releaseOwner(owner: object): void {
    for (const [id, current] of this.owners) if (current === owner) {
      this.owners.delete(id)
      this.savedHistory.delete(id)
      this.retainedAssetHistory.delete(id)
    }
  }

  releaseClaim(draftId: string, owner: object): void {
    if (this.owners.get(draftId) === owner) {
      this.owners.delete(draftId)
      this.savedHistory.delete(draftId)
      this.retainedAssetHistory.delete(draftId)
    }
  }

  isClaimed(draftId: string): boolean { return this.owners.has(draftId) }

  private recordPath(draftId: string): string {
    return path.join(this.options.root, 'records', `${draftId}.json`)
  }

  private endedPath(draftId: string): string {
    return path.join(this.options.root, 'ended', `${draftId}.json`)
  }

  private async lifecycleRecord(draftId: string): Promise<DraftLifecycleRecord | null> {
    const source = await readFile(this.recordPath(draftId), 'utf8').catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return await readFile(this.endedPath(draftId), 'utf8').catch((endedError) => {
          if ((endedError as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw endedError
        })
      }
      throw error
    })
    if (source === null) return null
    const record = JSON.parse(source.replace(/^\uFEFF/, '')) as DraftLifecycleRecord
    if (record.version !== 2) throw new Error('Invalid draft lifecycle record')
    if (record.state === 'ended' && record.draftId === draftId
      && ['saved', 'discarded', 'clean'].includes(record.reason)
      && Number.isFinite(Date.parse(record.endedAt))) return record
    if (record.state === 'active' && typeof record.markdown === 'string') {
      parseManifest(record.manifest, draftId)
      if (sha256(record.markdown) === record.manifest.bodySha256) return record
    }
    throw new Error('Invalid draft lifecycle record')
  }

  private async commitRecord(draftId: string, record: DraftLifecycleRecord): Promise<void> {
    await mkdir(path.dirname(this.recordPath(draftId)), { recursive: true })
    await this.atomicWrite(this.recordPath(draftId), `${JSON.stringify(record)}\n`)
  }

  private async end(draftId: string, reason: 'saved' | 'discarded' | 'clean'): Promise<void> {
    await this.commitRecord(draftId, {
      version: 2, state: 'ended', draftId, reason, endedAt: this.now().toISOString(),
    })
  }

  private async cleanup(directory: string): Promise<void> {
    // Only invoked after a durable terminal commit (or for abandoned staging).
    await (this.options.removeDirectory?.(directory)
      ?? rm(directory, { recursive: true, force: true })).catch(() => undefined)
  }

  private async archiveEndedRecord(draftId: string): Promise<void> {
    // Retain the tombstone, but do not scan every past save during startup.
    // Only fully cleaned content leaves the active enumeration directory.
    try {
      const paths = draftPaths(this.options.root, draftId)
      const exists = async (target: string) => lstat(target).then(() => true, (error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      })
      if (await exists(paths.draftDirectory) || await exists(paths.assetDirectory)) return
      if ((await this.lifecycleRecord(draftId))?.state !== 'ended') return
      await mkdir(path.dirname(this.endedPath(draftId)), { recursive: true })
      await rename(this.recordPath(draftId), this.endedPath(draftId))
    } catch {
      // The committed record remains authoritative; enumeration retries later.
    }
  }

  constructor(private readonly options: DraftServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.atomicWrite = options.atomicWrite ?? ((filePath, contents) =>
      writeFileAtomic(filePath, contents, { encoding: 'utf8', fsync: true }))
  }

  private enqueue<T>(draftId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(draftId) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(operation)
    this.writes.set(draftId, next)
    void next.then(
      () => {
        if (this.writes.get(draftId) === next) this.writes.delete(draftId)
      },
      () => {
        if (this.writes.get(draftId) === next) this.writes.delete(draftId)
      },
    )
    return next
  }

  private validateInput(input: SaveDraftRecord): void {
    if (!isDraftId(input.draftId)) throw new Error('Invalid draft id')
    if (typeof input.markdown !== 'string'
      || Buffer.byteLength(input.markdown, 'utf8') > MAX_MARKDOWN_BYTES) {
      throw new Error('Invalid draft markdown')
    }
    if (!isNullableAbsolutePath(input.originalAbsolutePath)
      || !isNullableAbsolutePath(input.workspaceAbsolutePath)) {
      throw new Error('Invalid draft path')
    }
    if (input.originalRevision !== null && !REVISION.test(input.originalRevision)) {
      throw new Error('Invalid draft revision')
    }
    if (!isNullableFiniteNumber(input.originalMtimeMs)) throw new Error('Invalid draft timestamp')
    if (input.encoding !== 'utf8' && input.encoding !== 'utf8-bom') {
      throw new Error('Invalid draft encoding')
    }
    if (input.newline !== 'lf' && input.newline !== 'crlf') {
      throw new Error('Invalid draft newline')
    }
  }

  private async assetRecords(draftId: string): Promise<DraftAssetRecord[]> {
    const { assetDirectory } = draftPaths(this.options.root, draftId)
    let entries
    try {
      entries = await readdir(assetDirectory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: DraftAssetRecord[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || path.basename(entry.name) !== entry.name) continue
      const contents = await readFile(path.join(assetDirectory, entry.name))
      const digest = sha256(contents)
      records.push({ assetId: digest, fileName: entry.name, sha256: digest })
    }
    return records
  }

  async write(input: SaveDraftRecord): Promise<DraftSummary> {
    this.validateInput(input)
    return this.enqueue(input.draftId, async () => {
      if (this.stagedFinalizations.has(input.draftId)) {
        throw new Error('Draft is being finalized')
      }
      const previousRecord = await this.lifecycleRecord(input.draftId)
      if (previousRecord?.state === 'ended'
        && !this.savedHistory.has(input.draftId)) throw new Error('Draft has ended')
      const paths = draftPaths(this.options.root, input.draftId)
      await mkdir(paths.draftDirectory, { recursive: true })
      const previousBody = await readFile(paths.bodyPath, 'utf8').catch(() => null)
      const previousManifest = await readFile(paths.manifestPath, 'utf8').catch(() => null)
      // Upgrade a valid legacy pair before overwriting either member. A crash
      // during the first v2 backup must still recover the last complete v1 body.
      if (!previousRecord && previousBody !== null && previousManifest !== null) {
        const previous = await this.loadValidated(input.draftId)
        if (previous) await this.commitRecord(input.draftId, { version: 2, state: 'active', ...previous })
      }
      const manifest: DraftManifest = {
        version: 1,
        draftId: input.draftId,
        originalAbsolutePath: input.originalAbsolutePath,
        workspaceAbsolutePath: input.workspaceAbsolutePath,
        originalRevision: input.originalRevision,
        originalMtimeMs: input.originalMtimeMs,
        encoding: input.encoding,
        newline: input.newline,
        updatedAt: this.now().toISOString(),
        appVersion: this.options.appVersion,
        ignoredAt: null,
        bodySha256: sha256(input.markdown),
        assets: await this.assetRecords(input.draftId),
      }
      try {
        await this.atomicWrite(paths.bodyPath, input.markdown)
        await this.atomicWrite(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        await this.commitRecord(input.draftId, { version: 2, state: 'active', manifest, markdown: input.markdown })
      } catch (error) {
        if (previousBody !== null && previousManifest !== null) {
          await this.atomicWrite(paths.bodyPath, previousBody)
          await this.atomicWrite(paths.manifestPath, previousManifest)
        } else {
          await rm(paths.draftDirectory, { recursive: true, force: true })
        }
        throw error
      }
      return summaryOf(manifest)
    })
  }

  private async loadValidated(draftId: string): Promise<{
    manifest: DraftManifest
    markdown: string
  } | null> {
    const paths = draftPaths(this.options.root, draftId)
    const record = await this.lifecycleRecord(draftId)
    if (record?.state === 'ended') return null
    let source: string
    let markdown: string
    try {
      if (record?.state === 'active') {
        source = JSON.stringify(record.manifest)
        markdown = record.markdown
      } else {
        ;[source, markdown] = await Promise.all([
          readFile(paths.manifestPath, 'utf8'),
          readFile(paths.bodyPath, 'utf8'),
        ])
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const manifest = parseManifest(JSON.parse(source.replace(/^\uFEFF/, '')) as unknown, draftId)
    if (sha256(markdown) !== manifest.bodySha256) throw new Error('Draft body hash mismatch')
    for (const asset of manifest.assets) {
      const assetPath = path.join(paths.assetDirectory, asset.fileName)
      const metadata = await lstat(assetPath)
      if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Invalid draft asset')
      if (sha256(await readFile(assetPath)) !== asset.sha256) throw new Error('Draft asset hash mismatch')
    }
    return { manifest, markdown }
  }

  private async recoverPendingFinalizations(): Promise<void> {
    if (this.recoveredPendingFinalizations) return
    if (this.pendingFinalizationRecovery) return await this.pendingFinalizationRecovery
    const recovery = (async () => {
      const pendingRoot = path.join(this.options.root, 'pending-finalize')
      let entries
      try {
        entries = await readdir(pendingRoot, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        const draftId = entry.name.slice(0, 36)
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name[36] !== '-'
          || !isDraftId(draftId)) continue
        await this.enqueue(draftId, async () => {
          if (this.stagedFinalizations.has(draftId)) return
          const stagingRoot = path.join(pendingRoot, entry.name)
          if ((await this.lifecycleRecord(draftId))?.state === 'ended') {
            await this.cleanup(stagingRoot)
            this.unresolvedFinalizations.delete(draftId)
            return
          }
          const stagedDraft = path.join(stagingRoot, 'draft')
          const stagedAssets = path.join(stagingRoot, 'assets')
          const paths = draftPaths(this.options.root, draftId)
          const metadata = async (target: string) => await lstat(target).catch((error) => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
          })
          const [stagedDraftState, stagedAssetsState, draftState, assetState] = await Promise.all([
            metadata(stagedDraft), metadata(stagedAssets),
            metadata(paths.draftDirectory), metadata(paths.assetDirectory),
          ])
          if ((!stagedDraftState && !draftState)
            || (stagedDraftState !== null && (!stagedDraftState.isDirectory() || stagedDraftState.isSymbolicLink()))
            || (stagedDraftState !== null && draftState !== null)
            || (draftState !== null && (!draftState.isDirectory() || draftState.isSymbolicLink()))
            || (stagedAssetsState !== null && assetState !== null)
            || (stagedAssetsState !== null
              && (!stagedAssetsState.isDirectory() || stagedAssetsState.isSymbolicLink()))) {
            this.unresolvedFinalizations.add(draftId)
            return
          }
          let assetsRestored = false
          try {
            if (stagedAssetsState) {
              await mkdir(path.dirname(paths.assetDirectory), { recursive: true })
              await rename(stagedAssets, paths.assetDirectory)
              assetsRestored = true
            }
            if (stagedDraftState) {
              await mkdir(path.dirname(paths.draftDirectory), { recursive: true })
              await rename(stagedDraft, paths.draftDirectory)
            }
          } catch (error) {
            if (assetsRestored) {
              await rename(paths.assetDirectory, stagedAssets).catch(() => undefined)
            }
            throw error
          }
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
          this.unresolvedFinalizations.delete(draftId)
        })
      }
    })()
    this.pendingFinalizationRecovery = recovery
    try {
      await recovery
      this.recoveredPendingFinalizations = this.unresolvedFinalizations.size === 0
    } finally {
      if (this.pendingFinalizationRecovery === recovery) this.pendingFinalizationRecovery = null
    }
  }

  private async quarantine(draftId: string): Promise<void> {
    const { draftDirectory } = draftPaths(this.options.root, draftId)
    const quarantineRoot = path.join(this.options.root, 'quarantine')
    await mkdir(quarantineRoot, { recursive: true })
    const destination = path.join(quarantineRoot, `${draftId}-${Date.now()}-${randomUUID()}`)
    await rename(draftDirectory, destination).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await rename(this.recordPath(draftId), `${destination}.json`).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    await rename(this.endedPath(draftId), `${destination}.ended.json`).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }

  async read(draftId: string): Promise<RecoveredDraft | null> {
    if (!isDraftId(draftId)) throw new Error('Invalid draft id')
    await this.recoverPendingFinalizations()
    return this.enqueue(draftId, async () => {
      if (this.stagedFinalizations.has(draftId) || this.unresolvedFinalizations.has(draftId)) return null
      try {
        const loaded = await this.loadValidated(draftId)
        return loaded
          ? { manifest: summaryOf(loaded.manifest), markdown: loaded.markdown }
          : null
      } catch (error) {
        // Permission/transient I/O failures do not make a valid draft corrupt.
        if ((error as NodeJS.ErrnoException).code) throw error
        await this.quarantine(draftId)
        return null
      }
    })
  }

  async listRecoverable(includeIgnored = false): Promise<DraftSummary[]> {
    await this.recoverPendingFinalizations()
    const draftsRoot = path.join(this.options.root, 'drafts')
    const scan = async (directory: string) => readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    const ids = new Set((await scan(draftsRoot))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && isDraftId(entry.name))
      .map((entry) => entry.name))
    for (const entry of await scan(path.join(this.options.root, 'records'))) {
      if (entry.isFile() && entry.name.endsWith('.json') && isDraftId(entry.name.slice(0, -5))) ids.add(entry.name.slice(0, -5))
    }
    const summaries: DraftSummary[] = []
    for (const id of ids) {
      const draft = await this.read(id)
      if (!draft) {
        await this.enqueue(id, async () => {
          if ((await this.lifecycleRecord(id))?.state !== 'ended') return
          const paths = draftPaths(this.options.root, id)
          await this.cleanup(paths.draftDirectory)
          if (!this.savedHistory.has(id) && !this.retainedAssetHistory.has(id)) await this.cleanup(paths.assetDirectory)
          await this.archiveEndedRecord(id)
        })
        continue
      }
      const normalize = (body: string) => body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
      const original = draft.manifest.originalAbsolutePath
        ? await readFile(draft.manifest.originalAbsolutePath, 'utf8').catch(() => null) : null
      if (original !== null && normalize(original) === normalize(draft.markdown)) continue
      if (includeIgnored || draft.manifest.ignoredAt === null) summaries.push(draft.manifest)
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async markIgnored(draftId: string): Promise<void> {
    if (!isDraftId(draftId)) throw new Error('Invalid draft id')
    await this.enqueue(draftId, async () => {
      if (this.stagedFinalizations.has(draftId)) throw new Error('Draft is being finalized')
      const loaded = await this.loadValidated(draftId)
      if (!loaded) return
      const next: DraftManifest = {
        ...loaded.manifest,
        ignoredAt: this.now().toISOString(),
      }
      await this.atomicWrite(
        draftPaths(this.options.root, draftId).manifestPath,
        `${JSON.stringify(next, null, 2)}\n`,
      )
      await this.commitRecord(draftId, { version: 2, state: 'active', manifest: next, markdown: loaded.markdown })
    })
  }

  private async hasClipboardAssets(draftId: string): Promise<boolean> {
    const directory = draftPaths(this.options.root, draftId).assetDirectory
    const metadata = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (!metadata) return false
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid draft assets')
    return (await readdir(directory, { withFileTypes: true }))
      .some((entry) => entry.isFile() && !entry.isSymbolicLink() && isClipboardAssetName(entry.name))
  }

  async discard(draftId: string, reason: 'saved' | 'discarded' | 'clean' = 'discarded', retainAssetHistory = false): Promise<boolean> {
    if (!isDraftId(draftId)) throw new Error('Invalid draft id')
    return this.enqueue(draftId, async () => {
      if (this.stagedFinalizations.has(draftId)) throw new Error('Draft is being finalized')
      const paths = draftPaths(this.options.root, draftId)
      const retain = retainAssetHistory && await this.hasClipboardAssets(draftId)
      await this.end(draftId, reason)
      this.savedHistory.delete(draftId)
      if (retain) this.retainedAssetHistory.add(draftId)
      else this.retainedAssetHistory.delete(draftId)
      await this.cleanup(paths.draftDirectory)
      if (!retain) await this.cleanup(paths.assetDirectory)
      await this.archiveEndedRecord(draftId)
      return retain
    })
  }

  async retainClipboardHistoryAfterSave(draftId: string): Promise<boolean> {
    return this.enqueue(draftId, async () => {
      const paths = draftPaths(this.options.root, draftId)
      if (this.stagedFinalizations.has(draftId)) throw new Error('Draft is being finalized')
      const assets = await lstat(paths.assetDirectory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!assets) return false
      if (!assets.isDirectory() || assets.isSymbolicLink()) throw new Error('Invalid draft assets')
      const entries = await readdir(paths.assetDirectory, { withFileTypes: true })
      if (!entries.some((entry) => entry.isFile() && isClipboardAssetName(entry.name))) return false
      // The document is durable. Only the active editor's history still needs
      // these immutable originals; a later dirty backup reuses this draft id.
      await this.end(draftId, 'saved')
      this.savedHistory.add(draftId)
      await this.cleanup(paths.draftDirectory)
      return true
    })
  }

  async markClean(draftId: string): Promise<void> {
    if (!isDraftId(draftId)) throw new Error('Invalid draft id')
    await this.enqueue(draftId, async () => {
      if (this.stagedFinalizations.has(draftId)) throw new Error('Draft is being finalized')
      await this.end(draftId, 'clean')
      // The same live editor may redo an image insertion. Keep its immutable
      // assets and allow a new backup; a restarted process cannot reopen this id.
      this.savedHistory.add(draftId)
      await this.cleanup(draftPaths(this.options.root, draftId).draftDirectory)
      await this.archiveEndedRecord(draftId)
    })
  }

  async releaseSavedClipboardHistory(draftId: string): Promise<void> {
    await this.enqueue(draftId, async () => {
      const paths = draftPaths(this.options.root, draftId)
      if (this.stagedFinalizations.has(draftId)) return
      // The per-draft queue drains earlier backups before this check. Any draft
      // directory (even an incomplete recovery record) keeps its assets intact.
      const active = (await this.lifecycleRecord(draftId))?.state === 'active'
      const draft = await lstat(paths.draftDirectory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (active || (draft && (await this.lifecycleRecord(draftId)) === null)) return
      this.savedHistory.delete(draftId)
      this.retainedAssetHistory.delete(draftId)
      const assets = await lstat(paths.assetDirectory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      })
      if (!assets) return
      if (!assets.isDirectory() || assets.isSymbolicLink()) throw new Error('Invalid draft assets')
      for (const entry of await readdir(paths.assetDirectory, { withFileTypes: true })) {
        if (entry.isFile() && isClipboardAssetName(entry.name)) await rm(path.join(paths.assetDirectory, entry.name))
      }
      await rmdir(paths.assetDirectory).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      })
      await this.archiveEndedRecord(draftId)
    })
  }

  async finalizeSaved(draftId: string): Promise<void> {
    const transaction = await this.beginFinalizeSaved(draftId)
    try { await transaction.commit() } catch (error) {
      await transaction.rollback()
      throw error
    }
  }

  async beginFinalizeSaved(draftId: string, options: { retainAssetHistory?: boolean } = {}): Promise<DraftFinalizeTransaction> {
    if (!isDraftId(draftId)) throw new Error('Invalid draft id')
    const token = {}
    const stagingRoot = path.join(
      this.options.root,
      'pending-finalize',
      `${draftId}-${randomUUID()}`,
    )
    const stagedDraft = path.join(stagingRoot, 'draft')
    const stagedAssets = path.join(stagingRoot, 'assets')
    let hasAssets = false
    let retainsAssets = false
    await this.enqueue(draftId, async () => {
      if (this.stagedFinalizations.has(draftId)) throw new Error('Draft is being finalized')
      const paths = draftPaths(this.options.root, draftId)
      retainsAssets = options.retainAssetHistory === true && await this.hasClipboardAssets(draftId)
      await mkdir(stagingRoot, { recursive: true })
      try {
        await rename(paths.draftDirectory, stagedDraft)
      } catch (error) {
        const definitelyEmpty = await lstat(stagedDraft).then(() => false, (inspectionError) => (
          (inspectionError as NodeJS.ErrnoException).code === 'ENOENT'
        ))
        if (definitelyEmpty) await this.cleanup(stagingRoot)
        throw error
      }
      try {
        if (!retainsAssets) {
          await rename(paths.assetDirectory, stagedAssets)
          hasAssets = true
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // If restoration also fails, staging is the last complete copy. Leave
          // it intact for startup recovery rather than deleting uncertain data.
          await rename(stagedDraft, paths.draftDirectory)
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
      }
      this.stagedFinalizations.set(draftId, token)
    })
    let complete = false
    const assertLive = (): void => {
      if (complete || this.stagedFinalizations.get(draftId) !== token) {
        throw new Error('Draft finalization is already complete')
      }
    }
    return Object.freeze({
      ...(retainsAssets ? { retainsAssets: true as const } : {}),
      commit: async (): Promise<void> => {
        assertLive()
        await this.enqueue(draftId, async () => {
          assertLive()
          await this.end(draftId, 'saved')
          this.savedHistory.delete(draftId)
          if (retainsAssets) this.retainedAssetHistory.add(draftId)
          this.stagedFinalizations.delete(draftId)
          complete = true
          await this.cleanup(stagingRoot)
          await this.archiveEndedRecord(draftId)
        })
      },
      rollback: async (): Promise<void> => {
        assertLive()
        await this.enqueue(draftId, async () => {
          assertLive()
          const paths = draftPaths(this.options.root, draftId)
          await mkdir(path.dirname(paths.draftDirectory), { recursive: true })
          await rename(stagedDraft, paths.draftDirectory)
          try {
            if (hasAssets) {
              await mkdir(path.dirname(paths.assetDirectory), { recursive: true })
              await rename(stagedAssets, paths.assetDirectory)
            }
          } catch (error) {
            await rename(paths.draftDirectory, stagedDraft).catch(() => undefined)
            throw error
          }
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
          this.stagedFinalizations.delete(draftId)
          complete = true
        })
      },
    })
  }
}
