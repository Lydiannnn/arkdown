import { createHash, randomBytes } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import {
  open,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  DocumentEncoding,
  DocumentSnapshot,
  NewlineStyle,
  SaveDocumentInput,
  SaveDocumentResult,
} from '../../shared/contracts'
import { isCodeDocumentPath, isEditableDocumentPath } from '../../shared/document-types'
import { appError } from '../../shared/public-errors'
import {
  resolveExistingInside,
  resolveNewInside,
} from '../workspace/workspace-path'
import { WorkspaceService } from '../workspace/workspace-service'
import { decodeDocument, encodeDocument } from './document-codec'
import type { DocumentReplacementRequest } from './document-replacement'
import {
  canonicalFileIdentityFromStats,
  sameCanonicalFileIdentity,
  type CanonicalFileIdentity,
} from './document-identity'

const TEMP_CREATE_ATTEMPTS = 10
const MAX_CODE_DOCUMENT_BYTES = 8 * 1024 * 1024

function validateCodeDocumentBytes(relativePath: string, bytes: Buffer): void {
  if (!isCodeDocumentPath(relativePath)) return
  if (bytes.length > MAX_CODE_DOCUMENT_BYTES) {
    throw Object.assign(new Error('Code document exceeds 8 MiB limit'), { code: 'DOCUMENT_TEXT_TOO_LARGE' })
  }
  decodeDocument(bytes, { preserveNewlines: true })
}

export interface DocumentIO {
  open(filePath: string, flags: 'r' | 'wx'): Promise<FileHandle>
  stat(filePath: string): Promise<BigIntStats>
  rename(source: string, destination: string): Promise<void>
  unlink(filePath: string): Promise<void>
}

export const nodeDocumentIO: DocumentIO = {
  open: (filePath, flags) => open(filePath, flags),
  stat: (filePath) => stat(filePath, { bigint: true }),
  rename,
  unlink,
}

export type DocumentPersistenceStage =
  | 'save-queued'
  | 'save-content-start'
  | 'save-current-bound'
  | 'save-latest-bound'
  | 'save-persisted-bound'

export interface DocumentPersistenceEvent {
  stage: DocumentPersistenceStage
  relativePath: string
  queueTarget: string
  waiting?: boolean
}

export interface DocumentServiceOptions {
  temporarySuffix?: () => string
  onStage?: (event: DocumentPersistenceEvent) => void | Promise<void>
  replaceFile?: (request: DocumentReplacementRequest) => Promise<void>
}

interface VerifiedDocument {
  bytes: Buffer
  identity: CanonicalFileIdentity
  mtimeMs: number
  target: string
}

interface TemporaryDocument {
  identity: CanonicalFileIdentity
  relativePath: string
}

export interface MainDocumentReadResult {
  readonly document: Readonly<DocumentSnapshot>
  readonly identity: CanonicalFileIdentity
}

export interface MainDocumentSaveResult {
  readonly result: Readonly<SaveDocumentResult>
  readonly identity: CanonicalFileIdentity
}

export type CreatedDocumentPublisher = (
  created: MainDocumentReadResult,
) => void | Promise<void>

export type SavedDocumentPublisher = (
  saved: MainDocumentSaveResult,
) => void | Promise<void>

export type DocumentReplacementGuard = (replacement: Readonly<{
  sourceIdentity: CanonicalFileIdentity
  successorIdentity: CanonicalFileIdentity
}>) => void | Promise<void>

function revision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function slashSeparated(root: string, target: string): string {
  return path.relative(root, target).split(/[\\/]+/).join('/')
}

function hasIdentity(metadata: BigIntStats, identity: CanonicalFileIdentity): boolean {
  return sameCanonicalFileIdentity(canonicalFileIdentityFromStats(metadata), identity)
}

function isSameFile(first: BigIntStats, second: BigIntStats): boolean {
  return sameCanonicalFileIdentity(
    canonicalFileIdentityFromStats(first),
    canonicalFileIdentityFromStats(second),
  )
}

function isSameState(first: BigIntStats, second: BigIntStats): boolean {
  return (
    isSameFile(first, second)
    && first.size === second.size
    && first.mtimeNs === second.mtimeNs
    && first.ctimeNs === second.ctimeNs
  )
}

function sameWindowsPath(first: string, second: string): boolean {
  return (
    path.normalize(first).toLocaleLowerCase('en-US')
    === path.normalize(second).toLocaleLowerCase('en-US')
  )
}

function milliseconds(nanoseconds: bigint): number {
  return (
    Number(nanoseconds / 1_000_000n)
    + Number(nanoseconds % 1_000_000n) / 1_000_000
  )
}

function assertEditableDocumentPath(relativePath: unknown): asserts relativePath is string {
  if (typeof relativePath !== 'string' || !isEditableDocumentPath(relativePath)) {
    throw appError('UNSUPPORTED_FILE_TYPE')
  }
}

function assertSaveInput(input: SaveDocumentInput): void {
  if (!input || typeof input !== 'object') throw new Error('Invalid document save input')
  assertEditableDocumentPath(input.relativePath)
  if (typeof input.markdown !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
    throw new Error('Invalid document save input')
  }
  if (input.encoding !== 'utf8' && input.encoding !== 'utf8-bom') {
    throw new Error('Unsupported document encoding')
  }
  if (input.newline !== 'lf' && input.newline !== 'crlf') {
    throw new Error('Unsupported newline style')
  }
}

export class DocumentConflictError extends Error {
  readonly code = 'DOCUMENT_CONFLICT'

  constructor() {
    super('The document changed on disk')
    this.name = 'DocumentConflictError'
  }
}

export class DocumentRollbackIncompleteError extends AggregateError {
  readonly code = 'DOCUMENT_ROLLBACK_INCOMPLETE'

  constructor(primary: unknown, cleanup: unknown) {
    super(
      [
        primary instanceof Error ? primary : new Error('Document operation failed'),
        cleanup instanceof Error ? cleanup : new Error('Document cleanup failed'),
      ],
      'Document operation failed and rollback was incomplete',
    )
    this.name = 'DocumentRollbackIncompleteError'
  }
}

export class DocumentService {
  private readonly saveQueues = new Map<string, Promise<void>>()

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly io: DocumentIO = nodeDocumentIO,
    private readonly options: DocumentServiceOptions = {},
  ) {}

  async create(
    relativePath: string,
    markdown = '',
    format: Readonly<{ encoding: DocumentEncoding; newline: NewlineStyle }> = {
      encoding: 'utf8',
      newline: 'lf',
    },
  ): Promise<DocumentSnapshot> {
    const created = await this.createForMain(relativePath, markdown, format)
    return { ...created.document }
  }

  async createForMain(
    relativePath: string,
    markdown = '',
    format: Readonly<{ encoding: DocumentEncoding; newline: NewlineStyle }> = {
      encoding: 'utf8',
      newline: 'lf',
    },
    publish?: CreatedDocumentPublisher,
  ): Promise<MainDocumentReadResult> {
    assertEditableDocumentPath(relativePath)
    if (typeof markdown !== 'string') throw new Error('Invalid document markdown')
    if ((format.encoding !== 'utf8' && format.encoding !== 'utf8-bom')
      || (format.newline !== 'lf' && format.newline !== 'crlf')) {
      throw new Error('Invalid document format')
    }
    const root = this.workspace.getRoot()
    const target = await resolveNewInside(root, relativePath)
    const bytes = encodeDocument(markdown, format.encoding, format.newline, { preserveNewlines: isCodeDocumentPath(relativePath) })
    validateCodeDocumentBytes(relativePath, bytes)
    const handle = await this.io.open(target, 'wx')
    let complete = false
    let createdState: BigIntStats | null = null
    let primaryFailure: unknown = new Error('Created document was not published')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
      createdState = await handle.stat({ bigint: true })
      const targetState = await this.io.stat(target)
      if (!createdState.isFile() || !targetState.isFile()
        || !isSameFile(createdState, targetState)) {
        throw new DocumentConflictError()
      }
      const decoded = decodeDocument(bytes, { preserveNewlines: isCodeDocumentPath(relativePath) })
      const created = Object.freeze({
        document: Object.freeze({
          relativePath: slashSeparated(root, target),
          ...decoded,
          revision: revision(bytes),
          mtimeMs: milliseconds(createdState.mtimeNs),
        }),
        identity: canonicalFileIdentityFromStats(createdState),
      })
      await publish?.(created)
      complete = true
      return created
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      let cleanupFailure: unknown = null
      if (!complete) {
        try {
          const checkedTarget = await resolveExistingInside(root, relativePath)
          const metadata = await this.io.stat(checkedTarget)
          const handleState = await handle.stat({ bigint: true })
          if (createdState && isSameState(createdState, handleState)
            && metadata.isFile() && isSameFile(handleState, metadata)
            && sameWindowsPath(checkedTarget, target)) {
            await this.io.unlink(checkedTarget)
          } else {
            cleanupFailure = new Error(
              'Created document cleanup could not verify the target identity',
            )
          }
        } catch (error) {
          // Preserve uncertainty instead of pretending an unpublished file was removed.
          cleanupFailure = error
        }
      }
      try {
        await handle.close()
      } catch (error) {
        if (complete) throw error
        if (cleanupFailure === null) cleanupFailure = error
      }
      if (cleanupFailure !== null) {
        throw new DocumentRollbackIncompleteError(primaryFailure, cleanupFailure)
      }
    }
  }

  async read(relativePath: string): Promise<DocumentSnapshot> {
    const main = await this.readForMain(relativePath)
    return { ...main.document }
  }

  async readForMain(relativePath: string): Promise<MainDocumentReadResult> {
    return this.readFromValidatedRootForMain(this.workspace.getRoot(), relativePath)
  }

  // Main-only preflight: callers must obtain this root from WorkspaceService validation.
  async readFromValidatedRootForMain(root: string, relativePath: string): Promise<MainDocumentReadResult> {
    assertEditableDocumentPath(relativePath)
    const opened = await this.readVerified(root, relativePath, false)
    const decoded = decodeDocument(opened.bytes, { preserveNewlines: isCodeDocumentPath(relativePath) })
    const document = Object.freeze({
      relativePath: slashSeparated(root, opened.target),
      ...decoded,
      revision: revision(opened.bytes),
      mtimeMs: opened.mtimeMs,
    })
    return Object.freeze({ document, identity: opened.identity })
  }

  async save(input: SaveDocumentInput): Promise<SaveDocumentResult> {
    const main = await this.saveForMain(input)
    return { ...main.result }
  }

  async saveForMain(
    input: SaveDocumentInput,
    publish?: SavedDocumentPublisher,
    prepareReplacement?: DocumentReplacementGuard,
  ): Promise<MainDocumentSaveResult> {
    assertSaveInput(input)
    const root = this.workspace.getRoot()
    const queueTarget = await resolveExistingInside(root, input.relativePath)
    const queueKey = path.normalize(queueTarget).toLocaleLowerCase('en-US')
    return this.serialize(
      queueKey,
      (waiting) => this.observe({
        stage: 'save-queued',
        relativePath: input.relativePath,
        queueTarget,
        waiting,
      }),
      () => this.saveNow(root, queueTarget, input, publish, prepareReplacement),
    )
  }

  async removeCreatedForRollback(
    relativePath: string,
    expectedIdentity: CanonicalFileIdentity,
    expectedRevision: string,
  ): Promise<void> {
    assertEditableDocumentPath(relativePath)
    if (typeof expectedIdentity !== 'string' || !/^[0-9a-f]+\.[0-9a-f]+$/u.test(expectedIdentity)) {
      throw new Error('Invalid rollback document identity')
    }
    if (typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/u.test(expectedRevision)) {
      throw new Error('Invalid rollback document revision')
    }
    const rollbackRequested = new Error('Created document rollback was requested')
    try {
      const root = this.workspace.getRoot()
      const queueTarget = await resolveExistingInside(root, relativePath)
      const queueKey = path.normalize(queueTarget).toLocaleLowerCase('en-US')
      await this.serialize(queueKey, () => undefined, async () => {
        const current = await this.readVerified(root, relativePath, true, queueTarget)
        if (!sameCanonicalFileIdentity(current.identity, expectedIdentity)
          || revision(current.bytes) !== expectedRevision) {
          throw new Error('Created rollback target changed before cleanup')
        }
        // Node's Windows API cannot bind unlink to both the already-open identity and
        // its verified content revision. A pathname unlink after this read has an
        // unavoidable same-file-id write race, so preserve the file and report an
        // incomplete cleanup rather than deleting potentially user-authored content.
        throw new Error('Created rollback target cannot be safely deleted')
      })
    } catch (error) {
      if (error instanceof DocumentRollbackIncompleteError) throw error
      throw new DocumentRollbackIncompleteError(rollbackRequested, error)
    }
  }

  private async serialize<T>(
    key: string,
    onQueued: (waiting: boolean) => void | Promise<void>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const waiting = this.saveQueues.has(key)
    const previous = this.saveQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queueEntry = previous.then(() => current)
    this.saveQueues.set(key, queueEntry)

    try {
      let observerFailed = false
      let observerError: unknown
      try {
        await onQueued(waiting)
      } catch (error) {
        observerFailed = true
        observerError = error
      }
      await previous
      if (observerFailed) throw observerError
      return await operation()
    } finally {
      release()
      if (this.saveQueues.get(key) === queueEntry) this.saveQueues.delete(key)
    }
  }

  private async observe(event: DocumentPersistenceEvent): Promise<void> {
    await this.options.onStage?.(event)
  }

  private changedDuringAccess(conflict: boolean): never {
    if (conflict) throw new DocumentConflictError()
    throw new Error('The document changed while it was being read')
  }

  private assertExpectedTarget(
    actualTarget: string,
    expectedTarget: string | undefined,
    conflictOnChange: boolean,
  ): void {
    if (expectedTarget && !sameWindowsPath(actualTarget, expectedTarget)) {
      this.changedDuringAccess(conflictOnChange)
    }
  }

  private async readVerified(
    root: string,
    relativePath: string,
    conflictOnChange: boolean,
    expectedTarget?: string,
  ): Promise<VerifiedDocument> {
    const targetBeforeOpen = await resolveExistingInside(
      root,
      expectedTarget ? slashSeparated(root, expectedTarget) : relativePath,
    )
    this.assertExpectedTarget(targetBeforeOpen, expectedTarget, conflictOnChange)
    const handle = await this.io.open(targetBeforeOpen, 'r')

    try {
      const handleBefore = await handle.stat({ bigint: true })
      const targetAfterOpen = await resolveExistingInside(root, relativePath)
      this.assertExpectedTarget(targetAfterOpen, expectedTarget, conflictOnChange)
      const pathAfterOpen = await this.io.stat(targetAfterOpen)
      if (
        !handleBefore.isFile()
        || !pathAfterOpen.isFile()
        || !isSameFile(handleBefore, pathAfterOpen)
      ) {
        this.changedDuringAccess(conflictOnChange)
      }

      const targetBeforeRead = await resolveExistingInside(root, relativePath)
      this.assertExpectedTarget(targetBeforeRead, expectedTarget, conflictOnChange)
      const pathBeforeRead = await this.io.stat(targetBeforeRead)
      if (!pathBeforeRead.isFile() || !isSameFile(handleBefore, pathBeforeRead)) {
        this.changedDuringAccess(conflictOnChange)
      }

      if (isCodeDocumentPath(relativePath) && handleBefore.size > 8n * 1024n * 1024n) {
        throw Object.assign(new Error('Code document exceeds 8 MiB limit'), { code: 'DOCUMENT_TEXT_TOO_LARGE' })
      }
      let bytes: Buffer
      if (isCodeDocumentPath(relativePath)) {
        // The file may grow after stat; bound the actual read as well.
        const buffer = Buffer.allocUnsafe(MAX_CODE_DOCUMENT_BYTES + 1)
        let offset = 0
        while (offset < buffer.length) {
          const result = await handle.read(buffer, offset, buffer.length - offset, offset)
          if (result.bytesRead === 0) break
          offset += result.bytesRead
        }
        bytes = buffer.subarray(0, offset)
      } else {
        bytes = await handle.readFile()
      }
      if (isCodeDocumentPath(relativePath) && bytes.length > 8 * 1024 * 1024) {
        throw Object.assign(new Error('Code document exceeds 8 MiB limit'), { code: 'DOCUMENT_TEXT_TOO_LARGE' })
      }
      const handleAfter = await handle.stat({ bigint: true })
      if (!isSameState(handleBefore, handleAfter)) {
        this.changedDuringAccess(conflictOnChange)
      }

      const targetAfterRead = await resolveExistingInside(root, relativePath)
      this.assertExpectedTarget(targetAfterRead, expectedTarget, conflictOnChange)
      const pathAfterRead = await this.io.stat(targetAfterRead)
      if (
        !pathAfterRead.isFile()
        || !isSameFile(handleAfter, pathAfterRead)
      ) {
        this.changedDuringAccess(conflictOnChange)
      }

      return {
        bytes,
        identity: canonicalFileIdentityFromStats(handleAfter),
        mtimeMs: milliseconds(handleAfter.mtimeNs),
        target: targetAfterRead,
      }
    } finally {
      await handle.close()
    }
  }

  private async resolveBoundTarget(
    root: string,
    relativePath: string,
    queueTarget: string,
  ): Promise<string> {
    try {
      const target = await resolveExistingInside(root, relativePath)
      if (!sameWindowsPath(target, queueTarget)) throw new DocumentConflictError()
      return target
    } catch (error) {
      if (error instanceof DocumentConflictError) throw error
      throw new DocumentConflictError()
    }
  }

  private async saveNow(
    root: string,
    queueTarget: string,
    input: SaveDocumentInput,
    publish?: SavedDocumentPublisher,
    prepareReplacement?: DocumentReplacementGuard,
  ): Promise<MainDocumentSaveResult> {
    await this.observe({
      stage: 'save-content-start',
      relativePath: input.relativePath,
      queueTarget,
    })
    const currentTarget = await this.resolveBoundTarget(root, input.relativePath, queueTarget)
    await this.observe({
      stage: 'save-current-bound',
      relativePath: input.relativePath,
      queueTarget,
    })

    const current = await this.readVerified(
      root,
      input.relativePath,
      true,
      currentTarget,
    )
    if (
      !sameWindowsPath(current.target, queueTarget)
      || revision(current.bytes) !== input.expectedRevision
    ) {
      throw new DocumentConflictError()
    }

    const bytes = encodeDocument(input.markdown, input.encoding, input.newline, { preserveNewlines: isCodeDocumentPath(input.relativePath) })
    validateCodeDocumentBytes(input.relativePath, bytes)
    if (isCodeDocumentPath(input.relativePath) && bytes.equals(current.bytes)) {
      const unchanged = Object.freeze({
        identity: current.identity,
        result: Object.freeze({ revision: input.expectedRevision, mtimeMs: current.mtimeMs }),
      })
      await publish?.(unchanged)
      return unchanged
    }
    const temporary = await this.writeTemporary(root, current.target, bytes)

    try {
      // Guard the successor before rename can expose it to another window. All
      // destination and temporary-file checks still run after this async boundary.
      await prepareReplacement?.(Object.freeze({
        sourceIdentity: current.identity,
        successorIdentity: temporary.identity,
      }))
      const targetBeforeReplace = await resolveExistingInside(root, input.relativePath)
      if (!sameWindowsPath(targetBeforeReplace, queueTarget)) {
        throw new DocumentConflictError()
      }

      const temporarySource = await this.readTemporary(root, temporary)
      if (!temporarySource.bytes.equals(bytes)) throw new DocumentConflictError()

      const latestTarget = await this.resolveBoundTarget(root, input.relativePath, queueTarget)
      await this.observe({
        stage: 'save-latest-bound',
        relativePath: input.relativePath,
        queueTarget,
      })
      const latest = await this.readVerified(
        root,
        input.relativePath,
        true,
        latestTarget,
      )
      if (
        !sameWindowsPath(latest.target, queueTarget)
        || revision(latest.bytes) !== input.expectedRevision
        || (prepareReplacement && !sameCanonicalFileIdentity(latest.identity, current.identity))
      ) {
        throw new DocumentConflictError()
      }

      const finalTemporarySource = await this.readTemporary(root, temporary)
      if (!finalTemporarySource.bytes.equals(bytes)) throw new DocumentConflictError()
      const finalDestination = await this.resolveBoundTarget(
        root,
        input.relativePath,
        queueTarget,
      )
      if (!sameWindowsPath(finalDestination, latest.target)) {
        throw new DocumentConflictError()
      }

      // Windows uses ReplaceFileW to preserve Explorer's file metadata/position.
      // Both publication paths remain pathname operations, not a filesystem CAS.
      if (this.options.replaceFile) {
        await this.options.replaceFile({
          temporaryPath: finalTemporarySource.target,
          destinationPath: finalDestination,
          temporaryIdentity: temporary.identity,
          destinationIdentity: latest.identity,
          replacementRevision: revision(finalTemporarySource.bytes),
          expectedRevision: input.expectedRevision,
        })
      } else {
        await this.io.rename(finalTemporarySource.target, finalDestination)
      }

      const provisional = Object.freeze({
        identity: temporary.identity,
        result: Object.freeze({
          revision: revision(finalTemporarySource.bytes),
          mtimeMs: finalTemporarySource.mtimeMs,
        }),
      })
      await publish?.(provisional)

      const persistedTarget = await this.resolveBoundTarget(
        root,
        input.relativePath,
        queueTarget,
      )
      await this.observe({
        stage: 'save-persisted-bound',
        relativePath: input.relativePath,
        queueTarget,
      })
      const persisted = await this.readVerified(
        root,
        input.relativePath,
        true,
        persistedTarget,
      )
      if (
        !sameWindowsPath(persisted.target, queueTarget)
        || !sameCanonicalFileIdentity(persisted.identity, temporary.identity)
        || !persisted.bytes.equals(bytes)
      ) {
        throw new DocumentConflictError()
      }

      return Object.freeze({
        identity: persisted.identity,
        result: Object.freeze({
          revision: revision(persisted.bytes),
          mtimeMs: persisted.mtimeMs,
        }),
      })
    } finally {
      await this.cleanupTemporary(root, temporary)
    }
  }

  private temporarySuffix(): string {
    const suffix = this.options.temporarySuffix?.() ?? randomBytes(16).toString('hex')
    if (typeof suffix !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(suffix)) {
      throw new Error('Invalid temporary document suffix')
    }
    return suffix
  }

  private async writeTemporary(
    root: string,
    target: string,
    bytes: Buffer,
  ): Promise<TemporaryDocument> {
    const relativeDirectory = slashSeparated(root, path.dirname(target))
    const baseName = path.basename(target)

    for (let attempt = 0; attempt < TEMP_CREATE_ATTEMPTS; attempt += 1) {
      const randomSuffix = this.temporarySuffix()
      const temporaryName = `.${baseName}.${process.pid}.${randomSuffix}.tmp`
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${temporaryName}`
        : temporaryName
      let candidate: string
      try {
        candidate = await resolveNewInside(root, relativePath)
      } catch (error: unknown) {
        if (error instanceof Error && error.message === 'New workspace path already exists') {
          continue
        }
        throw error
      }
      let handle: FileHandle

      try {
        handle = await this.io.open(candidate, 'wx')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }

      let temporary: TemporaryDocument | undefined
      try {
        const handleBefore = await handle.stat({ bigint: true })
        temporary = {
          identity: canonicalFileIdentityFromStats(handleBefore),
          relativePath,
        }

        const verifiedBeforeWrite = await resolveExistingInside(root, relativePath)
        const pathBeforeWrite = await this.io.stat(verifiedBeforeWrite)
        if (
          !handleBefore.isFile()
          || !pathBeforeWrite.isFile()
          || !isSameFile(handleBefore, pathBeforeWrite)
        ) {
          throw new Error('Temporary document identity changed')
        }

        await handle.writeFile(bytes)
        await handle.sync()

        const handleAfter = await handle.stat({ bigint: true })
        const verifiedAfterWrite = await resolveExistingInside(root, relativePath)
        const pathAfterWrite = await this.io.stat(verifiedAfterWrite)
        if (
          !handleAfter.isFile()
          || handleAfter.size !== BigInt(bytes.length)
          || !pathAfterWrite.isFile()
          || !isSameFile(handleAfter, pathAfterWrite)
        ) {
          throw new Error('Temporary document identity changed')
        }

        await handle.close()
        return temporary
      } catch (error) {
        if (!temporary) {
          try {
            const recoveredIdentity = await handle.stat({ bigint: true })
            temporary = {
              identity: canonicalFileIdentityFromStats(recoveredIdentity),
              relativePath,
            }
          } catch {
            // Without a handle identity, deleting the pathname would be unsafe.
          }
        }
        await handle.close().catch(() => undefined)
        if (temporary) await this.cleanupTemporary(root, temporary)
        throw error
      }
    }

    throw new Error('Unable to create a temporary document')
  }

  private async readTemporary(
    root: string,
    temporary: TemporaryDocument,
  ): Promise<{ bytes: Buffer; target: string; mtimeMs: number }> {
    const targetBeforeOpen = await resolveExistingInside(root, temporary.relativePath)
    const handle = await this.io.open(targetBeforeOpen, 'r')

    try {
      const handleBefore = await handle.stat({ bigint: true })
      const targetAfterOpen = await resolveExistingInside(root, temporary.relativePath)
      const pathAfterOpen = await this.io.stat(targetAfterOpen)
      if (
        !handleBefore.isFile()
        || !pathAfterOpen.isFile()
        || !hasIdentity(handleBefore, temporary.identity)
        || !isSameFile(handleBefore, pathAfterOpen)
      ) throw new DocumentConflictError()

      const bytes = await handle.readFile()
      const handleAfter = await handle.stat({ bigint: true })
      if (!isSameState(handleBefore, handleAfter)) throw new DocumentConflictError()

      const targetAfterRead = await resolveExistingInside(root, temporary.relativePath)
      const pathAfterRead = await this.io.stat(targetAfterRead)
      if (
        !pathAfterRead.isFile()
        || !hasIdentity(handleAfter, temporary.identity)
        || !isSameFile(handleAfter, pathAfterRead)
      ) throw new DocumentConflictError()

      return { bytes, target: targetAfterRead, mtimeMs: milliseconds(handleAfter.mtimeNs) }
    } finally {
      await handle.close()
    }
  }


  private async cleanupTemporary(
    root: string,
    temporary: TemporaryDocument,
  ): Promise<void> {
    try {
      const checkedTarget = await resolveExistingInside(root, temporary.relativePath)
      const checkedMetadata = await this.io.stat(checkedTarget)
      if (!checkedMetadata.isFile() || !hasIdentity(checkedMetadata, temporary.identity)) return

      const targetBeforeUnlink = await resolveExistingInside(root, temporary.relativePath)
      const metadataBeforeUnlink = await this.io.stat(targetBeforeUnlink)
      if (
        !sameWindowsPath(checkedTarget, targetBeforeUnlink)
        || !metadataBeforeUnlink.isFile()
        || !hasIdentity(metadataBeforeUnlink, temporary.identity)
      ) return
      await this.io.unlink(targetBeforeUnlink)
    } catch {
      // Best-effort only: Node has no identity-bound unlink on Windows. Repeated fixed-root
      // and identity checks minimize, but cannot eliminate, a hostile pathname-swap race.
    }
  }
}
