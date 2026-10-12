import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { isProxy } from 'node:util/types'
import {
  lstat,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  AiCreateWorkspaceDocumentArguments,
  AiDeleteWorkspaceDocumentArguments,
  AiEditWorkspaceDocumentArguments,
  AiFileVersion,
  AiListWorkspaceEntriesArguments,
  AiMutationToolName,
  AiOperationManifest,
  AiReadWorkspaceDocumentArguments,
  AiRenameWorkspaceDocumentArguments,
  AiWorkspaceDirectoryVersion,
  AiWorkspaceToolResult,
} from '../../shared/ai-conversation'
import {
  AI_RECYCLE_UNAVAILABLE_GUIDANCE,
  isCanonicalWorkspaceRelativePath,
  parseAiOperationManifest,
} from '../../shared/ai-conversation'
import type { ConvertedDocument } from '../../shared/document-conversion'
import {
  isAiWorkspaceDocumentPath,
  isMarkItDownConversionPath,
  isPandocImportPath,
} from '../../shared/document-types'

import type { DocumentService } from '../documents/document-service'
import { encodeDocument } from '../documents/document-codec'
import {
  canonicalFileIdentityFromStats,
  type CanonicalFileIdentity,
} from '../documents/document-identity'
import {
  type WorkspaceAiEditorBoundary,
  type WorkspaceAiEditorPlanResult,
  type WorkspaceAiEditorTarget,
} from '../documents/workspace-ai-editor-boundary'
import type { ImportedDocxText } from '../docx/docx-service'
import type { ResolvedConvertibleDocument } from './workspace-service'
import {
  AiOperationJournal,
  AiOperationOutcomeUnknownError,
} from './ai-operation-journal'
import { queryWindowsReparsePoint } from './windows-reparse-point'
import {
  assertWorkspaceRelativePath,
  resolveExistingInside,
  resolveNewInside,
} from './workspace-path'
import type {
  ValidatedWorkspaceActivationSnapshot,
  WorkspaceService,
} from './workspace-service'

const MAX_PAGE_CHARS = 48_000

function isAiWorkspaceManagedPath(path: string): boolean {
  return isAiWorkspaceDocumentPath(path) || isMarkItDownConversionPath(path) || isPandocImportPath(path)
}

export type WorkspaceAiFileErrorCode =
  | 'AI_INVALID_PATH'
  | 'AI_UNSUPPORTED_EDIT'
  | 'AI_FILE_CHANGED'
  | 'AI_WORKSPACE_CHANGED'
  | 'AI_OPERATION_INVALID'
  | 'AI_COMMIT_UNAVAILABLE'
  | 'AI_RECYCLE_UNAVAILABLE'
  | 'STALE_TARGET'

export class WorkspaceAiFileError extends Error {
  constructor(readonly code: WorkspaceAiFileErrorCode, message: string) {
    super(message)
    this.name = 'WorkspaceAiFileError'
  }
}

export interface WorkspaceRootCapability {
  readonly windowId: number
  readonly workspaceId: string
  readonly rootGeneration: number
  readonly workspaceGeneration: string
  readonly rootFinalPath: string
  readonly rootVolumeSerial: string
  readonly rootFileId: string
}

export type WorkspaceAiLocalAudit = {
  readonly kind: 'edited' | 'created' | 'renamed' | 'recycled'
  readonly absolutePaths: readonly string[]
}

export interface WorkspaceAiMutationExecution {
  readonly result: Extract<AiWorkspaceToolResult, { kind: 'mutation' }>
  readonly localAudit: WorkspaceAiLocalAudit
  readonly successorVersion?: AiFileVersion
}

export interface WorkspaceAiCommitRootIdentity {
  readonly rootFinalPath: string
  readonly activationEpoch: number
  readonly rootVolumeSerial: string
  readonly rootFileId: string
}

export interface WorkspaceAiCommitFileIdentity {
  readonly absolutePath: string
  readonly relativePath: string
  readonly fileId: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeNs: string
  readonly revision: string
}

export interface WorkspaceAiCommitDirectoryIdentity {
  readonly absolutePath: string
  readonly relativePath: string
  readonly fileId: string
}

export type WorkspaceAiCommitRequest =
  | {
    readonly kind: 'edit'
    readonly root: WorkspaceAiCommitRootIdentity
    readonly source: WorkspaceAiCommitFileIdentity
    readonly parents: readonly WorkspaceAiCommitDirectoryIdentity[]
    readonly bytes: Buffer
  }
  | {
    readonly kind: 'create'
    readonly root: WorkspaceAiCommitRootIdentity
    readonly destination: { readonly absolutePath: string; readonly relativePath: string }
    readonly parents: readonly WorkspaceAiCommitDirectoryIdentity[]
    readonly bytes: Buffer
  }
  | {
    readonly kind: 'rename'
    readonly root: WorkspaceAiCommitRootIdentity
    readonly source: WorkspaceAiCommitFileIdentity
    readonly destination: { readonly absolutePath: string; readonly relativePath: string }
    readonly parents: readonly WorkspaceAiCommitDirectoryIdentity[]
  }
  | {
    readonly kind: 'recycle'
    readonly root: WorkspaceAiCommitRootIdentity
    readonly source: WorkspaceAiCommitFileIdentity
    readonly parents: readonly WorkspaceAiCommitDirectoryIdentity[]
  }

export type WorkspaceAiCommitOutcome =
  | { readonly status: 'committed' }
  | { readonly status: 'rejected'; readonly reason: 'root-changed' | 'parent-changed' | 'source-changed' | 'destination-exists' | 'unsupported' | 'recycle-unavailable' }
  | { readonly status: 'unknown'; readonly reason: string }

/**
 * Native Windows commit boundary. Implementations must keep root, parent, source, and destination
 * handles open through commit; compare the supplied identities at the final side effect; reject all
 * reparse points; use no-replace semantics for create/rename; and recycle the opened source identity,
 * never a later pathname occupant. Any result that may have crossed the side-effect boundary without
 * complete post-commit verification must be returned as `unknown`.
 */
export interface WindowsWorkspaceCommitAdapter {
  commit(request: WorkspaceAiCommitRequest): Promise<WorkspaceAiCommitOutcome>
  /** Ordinary editor saves are separate from AI tools and their permission protocol. */
  replaceDocumentFile?(request: import('../documents/document-replacement').DocumentReplacementRequest): Promise<void>
}

const REJECTED_COMMIT_REASONS: ReadonlySet<string> = new Set([
  'root-changed', 'parent-changed', 'source-changed', 'destination-exists', 'unsupported',
] as const)

function parseCommitOutcome(value: unknown, requestKind: WorkspaceAiCommitRequest['kind']): WorkspaceAiCommitOutcome | undefined {
  if (typeof value !== 'object' || value === null || isProxy(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== 'string')) return undefined
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      return undefined
    }
  }
  const status = descriptors.status?.value
  if (status === 'committed') {
    return keys.length === 1 && keys[0] === 'status' ? Object.freeze({ status }) : undefined
  }
  if (status === 'rejected') {
    const reason = descriptors.reason?.value
    return keys.length === 2 && keys.includes('status') && keys.includes('reason')
      && typeof reason === 'string' && (REJECTED_COMMIT_REASONS.has(reason)
        || reason === 'recycle-unavailable' && requestKind === 'recycle')
      ? Object.freeze({ status, reason: reason as Extract<WorkspaceAiCommitOutcome, { status: 'rejected' }>['reason'] })
      : undefined
  }
  if (status === 'unknown') {
    const reason = descriptors.reason?.value
    return keys.length === 2 && keys.includes('status') && keys.includes('reason')
      && typeof reason === 'string' && reason.length > 0 && reason.length <= 512
      ? Object.freeze({ status, reason })
      : undefined
  }
  return undefined
}

interface DocumentConversionReader {
  convertResolved(
    resolved: ResolvedConvertibleDocument,
    signal: AbortSignal,
  ): Promise<ConvertedDocument>
}

interface DocxImportReader {
  importText(sourceAbsolutePath: string, options: {
    signal: AbortSignal
    timeoutMs: number
  }): Promise<ImportedDocxText>
}

const AI_DOCX_IMPORT_TIMEOUT_MS = 60_000

export interface WorkspaceAiFileServiceOptions {
  readonly windowId: number
  readonly workspace: WorkspaceService
  readonly documents: Pick<DocumentService, 'readForMain'>
  readonly editorBoundary: WorkspaceAiEditorBoundary
  readonly conversions: DocumentConversionReader
  readonly docx?: DocxImportReader
  readonly commitAdapter?: WindowsWorkspaceCommitAdapter
  readonly journal?: AiOperationJournal<WorkspaceAiMutationExecution>
  readonly operationId?: () => string
  readonly nonce?: () => string
}

interface FileState {
  readonly absolutePath: string
  readonly relativePath: string
  readonly identity: CanonicalFileIdentity
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeNs: bigint
}

type PlannedOperation =
  | {
    readonly kind: 'edit'
    readonly content: string
    readonly source: FileState
    readonly parents: readonly FileState[]
    readonly route:
      | Readonly<{ kind: 'closed' }>
      | Readonly<{
        kind: 'editor'
        plan: Extract<WorkspaceAiEditorPlanResult, { status: 'planned' }>
        snapshotSize: number
      }>
  }
  | { readonly kind: 'create'; readonly content: string; readonly destination: string; readonly parents: readonly FileState[] }
  | { readonly kind: 'rename'; readonly source: FileState; readonly destination: string; readonly parents: readonly FileState[] }
  | { readonly kind: 'delete'; readonly source: FileState; readonly parents: readonly FileState[] }

const CONTROL_DIRECTORY_NAMES = new Set([
  '.git', '.hg', '.svn', '.arkdown', '.arkdown-dev-data', '.arkdown-ai-quarantine', '.codex', '.agents', 'node_modules',
])

function aiError(code: WorkspaceAiFileErrorCode, message: string): WorkspaceAiFileError {
  return new WorkspaceAiFileError(code, message)
}

function safeNumber(value: bigint): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) {
    throw aiError('AI_OPERATION_INVALID', 'Filesystem metadata is unavailable')
  }
  return number
}

function identity(metadata: BigIntStats): CanonicalFileIdentity {
  try {
    return canonicalFileIdentityFromStats(metadata)
  } catch {
    throw aiError('AI_OPERATION_INVALID', 'Filesystem identity is unavailable')
  }
}

function slashSeparated(root: string, target: string): string {
  return path.relative(root, target).split(/[\\/]+/).join('/')
}

function sameWindowsPath(first: string, second: string): boolean {
  return path.normalize(first).toLocaleLowerCase('en-US')
    === path.normalize(second).toLocaleLowerCase('en-US')
}

function sameFileState(first: FileState, second: FileState): boolean {
  return first.identity === second.identity
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeNs === second.ctimeNs
    && sameWindowsPath(first.absolutePath, second.absolutePath)
}

function sameVersion(actual: AiFileVersion, expected: AiFileVersion): boolean {
  return actual.fileId === expected.fileId
    && actual.revision === expected.revision
    && actual.size === expected.size
    && actual.mtimeMs === expected.mtimeMs
}

function page(markdown: string, cursor: number, requestedMax: number): {
  content: string
  nextCursor: number | null
  hasMore: boolean
  totalChars: number
} {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > markdown.length
    || !Number.isSafeInteger(requestedMax) || requestedMax <= 0) {
    throw aiError('AI_OPERATION_INVALID', 'Invalid document page')
  }
  if (cursor > 0 && cursor < markdown.length
    && /[\uDC00-\uDFFF]/u.test(markdown[cursor])
    && /[\uD800-\uDBFF]/u.test(markdown[cursor - 1])) {
    throw aiError('AI_OPERATION_INVALID', 'Document cursor splits a character')
  }
  let end = Math.min(markdown.length, cursor + Math.min(requestedMax, MAX_PAGE_CHARS))
  if (end < markdown.length
    && /[\uD800-\uDBFF]/u.test(markdown[end - 1])
    && /[\uDC00-\uDFFF]/u.test(markdown[end])) end -= 1
  const content = markdown.slice(cursor, end)
  return {
    content,
    nextCursor: end < markdown.length ? end : null,
    hasMore: end < markdown.length,
    totalChars: markdown.length,
  }
}

function versionFor(state: FileState, revision: string): AiFileVersion {
  return {
    fileId: state.identity,
    revision,
    size: state.size,
    mtimeMs: state.mtimeMs,
  }
}

function editorVersion(
  identity: CanonicalFileIdentity,
  editorRevision: number,
  contentHash: string,
  markdown: string,
): AiFileVersion {
  return {
    fileId: identity,
    revision: contentHash,
    size: Buffer.byteLength(markdown, 'utf8'),
    mtimeMs: editorRevision,
  }
}

function manifestEquals(first: AiOperationManifest, second: AiOperationManifest): boolean {
  return first.operationId === second.operationId
    && first.idempotencyKey === second.idempotencyKey
    && first.nonce === second.nonce
    && first.workspaceGeneration === second.workspaceGeneration
    && first.toolName === second.toolName
    && JSON.stringify(first.relativePaths) === JSON.stringify(second.relativePaths)
    && JSON.stringify(first.expectedVersions) === JSON.stringify(second.expectedVersions)
}

export class WorkspaceAiFileService {
  private readonly journal: AiOperationJournal<WorkspaceAiMutationExecution>
  private readonly editorBoundary: WorkspaceAiEditorBoundary
  private readonly plans = new Map<string, PlannedOperation>()
  private capability: WorkspaceRootCapability | undefined
  private structuralTail: Promise<void> = Promise.resolve()

  constructor(private readonly options: WorkspaceAiFileServiceOptions) {
    if (!Number.isSafeInteger(options.windowId) || options.windowId <= 0) {
      throw new Error('Invalid workspace AI window identity')
    }
    if (!options.editorBoundary) throw new Error('Workspace AI editor boundary is required')
    this.journal = options.journal ?? new AiOperationJournal()
    this.editorBoundary = options.editorBoundary
  }

  /** Main-only source lookup for a ticketed transition. Null means the workspace
   * is explicitly empty, never a missing, redirected or unreadable active root. */
  async getWorkspaceSwitchSourceCapability(): Promise<WorkspaceRootCapability | null> {
    const source = await this.options.workspace.getSaveAsActivationSnapshot()
    if (source.root === null) return null
    const capability = await this.getRootCapability()
    if (source.epoch !== capability.rootGeneration
      || !sameWindowsPath(source.root, capability.rootFinalPath)) {
      throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
    }
    return capability
  }

  async getRootCapability(): Promise<WorkspaceRootCapability> {
    const announced = this.options.workspace.getActivationSnapshot()
    let activation: ValidatedWorkspaceActivationSnapshot
    try {
      activation = await this.options.workspace.getValidatedActivationSnapshot()
    } catch {
      throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
    }
    const currentActivation = this.options.workspace.getActivationSnapshot()
    if (announced.epoch !== activation.epoch
      || currentActivation.epoch !== activation.epoch
      || !sameWindowsPath(announced.root, activation.root)
      || !sameWindowsPath(currentActivation.root, activation.root)) {
      throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
    }
    const canonical = activation.root
    const volume = activation.rootVolumeSerial
    const fileId = activation.rootFileId
    if (this.capability
      && this.capability.rootGeneration === activation.epoch
      && sameWindowsPath(this.capability.rootFinalPath, canonical)
      && this.capability.rootVolumeSerial === volume
      && this.capability.rootFileId === fileId) return this.capability

    const workspaceId = createHash('sha256')
      .update(canonical.toLocaleLowerCase('en-US'))
      .update('\0')
      .update(volume)
      .update('\0')
      .update(fileId)
      .digest('hex')
    this.capability = Object.freeze({
      windowId: this.options.windowId,
      workspaceId,
      rootGeneration: activation.epoch,
      workspaceGeneration: `${activation.epoch}.${randomBytes(16).toString('hex')}`,
      rootFinalPath: canonical,
      rootVolumeSerial: volume,
      rootFileId: fileId,
    })
    return this.capability
  }

  async listEntries(
    input: AiListWorkspaceEntriesArguments,
    signal?: AbortSignal,
  ): Promise<Extract<AiWorkspaceToolResult, { kind: 'entries' }>> {
    signal?.throwIfAborted()
    if (input.path) this.assertProviderPath(input.path)
    const capability = await this.getRootCapability()
    signal?.throwIfAborted()
    const directory = await this.inspectDirectory(capability, input.path)
    let entries: Awaited<ReturnType<WorkspaceService['listDirectory']>>
    try {
      entries = (await this.options.workspace.listDirectory(input.path, {
        root: capability.rootFinalPath,
        epoch: capability.rootGeneration,
      })).filter((entry) => !this.hasControlDirectory(entry.relativePath)
        && (entry.kind === 'directory' || isAiWorkspaceManagedPath(entry.relativePath)))
    } catch {
      signal?.throwIfAborted()
      throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
    }
    signal?.throwIfAborted()
    const verifiedDirectory = await this.inspectDirectory(capability, input.path)
    signal?.throwIfAborted()
    if (!sameFileState(directory, verifiedDirectory)) {
      throw aiError('AI_FILE_CHANGED', 'The workspace directory changed')
    }
    const revision = createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    const directoryVersion: AiWorkspaceDirectoryVersion = {
      workspaceGeneration: capability.workspaceGeneration,
      directoryId: directory.identity,
      revision,
    }
    if (input.cursor > 0) {
      const requestedVersion = input.directoryVersion
      if (!requestedVersion
        || requestedVersion.workspaceGeneration !== directoryVersion.workspaceGeneration
        || requestedVersion.directoryId !== directoryVersion.directoryId
        || requestedVersion.revision !== directoryVersion.revision) {
        throw aiError('AI_FILE_CHANGED', 'The workspace directory changed')
      }
    }
    const selected = entries.slice(input.cursor, input.cursor + input.maxEntries)
    const next = input.cursor + selected.length
    return {
      kind: 'entries',
      directoryPath: input.path,
      directoryVersion,
      cursor: input.cursor,
      entries: selected.map((entry) => ({
        path: entry.relativePath,
        name: entry.name,
        kind: entry.kind,
      })),
      nextCursor: next < entries.length ? next : null,
    }
  }

  async readDocument(
    input: AiReadWorkspaceDocumentArguments,
    signal?: AbortSignal,
  ): Promise<Extract<AiWorkspaceToolResult, { kind: 'document' }>> {
    signal?.throwIfAborted()
    this.assertProviderPath(input.path)
    if (!isAiWorkspaceManagedPath(input.path)) {
      throw aiError('AI_UNSUPPORTED_EDIT', 'Unsupported workspace document')
    }
    const capability = await this.getRootCapability()
    return await this.withWorkspaceAuthority(capability, async () => (
      await this.readDocumentWithinAuthority(capability, input, signal)
    ))
  }

  private async readDocumentWithinAuthority(
    capability: WorkspaceRootCapability,
    input: AiReadWorkspaceDocumentArguments,
    signal?: AbortSignal,
  ): Promise<Extract<AiWorkspaceToolResult, { kind: 'document' }>> {
    signal?.throwIfAborted()
    const source = await this.inspectFile(capability, input.path)
    signal?.throwIfAborted()
    const target = this.editorTarget(capability, source.identity)
    return await this.editorBoundary.withIdentityLease(target, async () => {
      signal?.throwIfAborted()
      const current = await this.reinspectPlannedSource(capability, source)
      signal?.throwIfAborted()
      if (!sameFileState(source, current)) throw this.staleTarget()
      const lookup = await this.editorBoundary.lookup(target)
      signal?.throwIfAborted()
      if (lookup.status === 'open') {
        const snapshot = await this.editorBoundary.captureReadSnapshot({
          target,
          registrationToken: lookup.registrationToken,
          registrationRevision: lookup.registrationRevision,
          bindingToken: lookup.bindingToken,
          bindingRevision: lookup.bindingRevision,
        }, signal ?? new AbortController().signal)
        signal?.throwIfAborted()
        if (snapshot.status !== 'captured'
          || createHash('sha256').update(snapshot.markdown).digest('hex') !== snapshot.contentHash) {
          throw this.staleTarget()
        }
        return {
          kind: 'document',
          path: current.relativePath,
          displayName: path.basename(current.relativePath),
          sourceFormat: path.extname(current.relativePath).slice(1).toLocaleLowerCase('en-US'),
          cursor: input.cursor,
          ...page(snapshot.markdown, input.cursor, input.maxChars),
          version: editorVersion(
            current.identity,
            snapshot.editorRevision,
            snapshot.contentHash,
            snapshot.markdown,
          ),
        }
      }
      if (lookup.status !== 'closed') throw this.staleTarget()
      return await this.readClosedDocument(capability, current, input, signal)
    })
  }

  private async readClosedDocument(
    capability: WorkspaceRootCapability,
    source: FileState,
    input: AiReadWorkspaceDocumentArguments,
    signal?: AbortSignal,
  ): Promise<Extract<AiWorkspaceToolResult, { kind: 'document' }>> {
    signal?.throwIfAborted()
    const relativePath = source.relativePath
    if (isAiWorkspaceDocumentPath(relativePath)) {
      const snapshot = await this.options.documents.readForMain(relativePath)
      signal?.throwIfAborted()
      const after = await this.inspectFile(capability, relativePath)
      signal?.throwIfAborted()
      if (!sameFileState(source, after) || snapshot.identity !== after.identity) {
        throw aiError('AI_FILE_CHANGED', 'The document changed while reading')
      }
      return {
        kind: 'document',
        path: relativePath,
        displayName: path.basename(relativePath),
        sourceFormat: path.extname(relativePath).slice(1).toLocaleLowerCase('en-US'),
        cursor: input.cursor,
        ...page(snapshot.document.markdown, input.cursor, input.maxChars),
        version: versionFor(after, snapshot.document.revision),
      }
    }
    if (isMarkItDownConversionPath(relativePath)) {
      const resolved = await this.options.workspace.resolveExistingConvertibleDocument(relativePath)
      signal?.throwIfAborted()
      const converted = await this.options.conversions.convertResolved(
        resolved,
        signal ?? new AbortController().signal,
      )
      signal?.throwIfAborted()
      const after = await this.inspectFile(capability, relativePath)
      signal?.throwIfAborted()
      if (!sameFileState(source, after)) throw aiError('AI_FILE_CHANGED', 'The document changed while converting')
      return {
        kind: 'document',
        path: relativePath,
        displayName: path.basename(relativePath),
        sourceFormat: converted.source.format,
        cursor: input.cursor,
        ...page(converted.markdown, input.cursor, input.maxChars),
        version: versionFor(after, converted.fingerprint),
      }
    }
    if (isPandocImportPath(relativePath)) {
      if (!this.options.docx) throw aiError('AI_UNSUPPORTED_EDIT', 'DOCX conversion is unavailable')
      const resolvedSource = await this.options.workspace.resolveExistingPandocDocument(relativePath)
      signal?.throwIfAborted()
      const imported = await this.options.docx.importText(resolvedSource, {
        signal: signal ?? new AbortController().signal,
        timeoutMs: AI_DOCX_IMPORT_TIMEOUT_MS,
      })
      signal?.throwIfAborted()
      const after = await this.inspectFile(capability, relativePath)
      signal?.throwIfAborted()
      if (!sameFileState(source, after)) {
        throw aiError('AI_FILE_CHANGED', 'The document changed while converting')
      }
      const revision = createHash('sha256')
        .update(after.identity)
        .update('\0')
        .update(String(after.size))
        .update('\0')
        .update(String(after.mtimeMs))
        .update('\0')
        .update(imported.text)
        .digest('hex')
      return {
        kind: 'document',
        path: relativePath,
        displayName: path.basename(relativePath),
        sourceFormat: 'docx',
        cursor: input.cursor,
        ...page(imported.text, input.cursor, input.maxChars),
        version: versionFor(after, revision),
      }
    }
    throw aiError('AI_UNSUPPORTED_EDIT', 'Unsupported workspace document')
  }

  async planEdit(
    input: AiEditWorkspaceDocumentArguments,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AiOperationManifest> {
    signal?.throwIfAborted()
    const duplicate = this.journal.getByIdempotencyKey(idempotencyKey)
    if (duplicate) return duplicate.manifest
    this.assertProviderPath(input.path)
    if (!isAiWorkspaceDocumentPath(input.path)) {
      throw aiError('AI_UNSUPPORTED_EDIT', 'Only Markdown and plain-text documents are editable')
    }
    const capability = await this.getRootCapability()
    signal?.throwIfAborted()
    return await this.withWorkspaceAuthority(capability, async () => {
      signal?.throwIfAborted()
      const source = await this.inspectFile(capability, input.path)
      signal?.throwIfAborted()
      const target = this.editorTarget(capability, source.identity)
      const operationId = this.options.operationId?.() ?? randomUUID()
      return await this.editorBoundary.withIdentityLease(target, async () => {
        signal?.throwIfAborted()
        const currentState = await this.reinspectPlannedSource(capability, source)
        signal?.throwIfAborted()
        if (!sameFileState(source, currentState)) throw this.staleTarget()
        const lookup = await this.editorBoundary.lookup(target)
        signal?.throwIfAborted()
        let actualVersion: AiFileVersion
        let route: Extract<PlannedOperation, { kind: 'edit' }>['route']
        if (lookup.status === 'open') {
          const snapshot = await this.editorBoundary.captureReadSnapshot({
            target,
            registrationToken: lookup.registrationToken,
            registrationRevision: lookup.registrationRevision,
            bindingToken: lookup.bindingToken,
            bindingRevision: lookup.bindingRevision,
          }, signal ?? new AbortController().signal)
          signal?.throwIfAborted()
          if (snapshot.status !== 'captured') throw this.staleTarget()
          const snapshotSize = Buffer.byteLength(snapshot.markdown, 'utf8')
          actualVersion = {
            fileId: currentState.identity,
            revision: snapshot.contentHash,
            size: snapshotSize,
            mtimeMs: snapshot.editorRevision,
          }
          if (!sameVersion(actualVersion, input.expectedVersion)) throw this.staleTarget()
          const planned = await this.editorBoundary.planReplacement({
            target,
            registrationToken: lookup.registrationToken,
            registrationRevision: lookup.registrationRevision,
            bindingToken: lookup.bindingToken,
            bindingRevision: lookup.bindingRevision,
            operationId,
            expectedEditorRevision: snapshot.editorRevision,
            expectedContentHash: snapshot.contentHash,
            replacementMarkdown: input.content,
          }, signal ?? new AbortController().signal)
          signal?.throwIfAborted()
          if (planned.status !== 'planned') throw this.staleTarget()
          route = Object.freeze({ kind: 'editor', plan: planned, snapshotSize })
        } else if (lookup.status === 'closed') {
          const current = await this.options.documents.readForMain(currentState.relativePath)
          signal?.throwIfAborted()
          const after = await this.inspectFile(capability, currentState.relativePath)
          signal?.throwIfAborted()
          if (!sameFileState(currentState, after) || current.identity !== after.identity) {
            throw this.staleTarget()
          }
          actualVersion = versionFor(after, current.document.revision)
          route = Object.freeze({ kind: 'closed' })
        } else {
          throw this.staleTarget()
        }
        if (!sameVersion(actualVersion, input.expectedVersion)) throw this.staleTarget()
        const parents = [await this.inspectParent(capability, currentState.relativePath)]
        signal?.throwIfAborted()
        return this.recordPlan(
          capability,
          'edit_workspace_document',
          [currentState.relativePath],
          [actualVersion],
          idempotencyKey,
          {
            kind: 'edit',
            content: input.content,
            source: currentState,
            parents,
            route,
          },
          operationId,
        )
      })
    })
  }

  async planCreate(
    input: AiCreateWorkspaceDocumentArguments,
    idempotencyKey: string,
  ): Promise<AiOperationManifest> {
    this.assertProviderPath(input.path)
    if (!isAiWorkspaceDocumentPath(input.path)) {
      throw aiError('AI_UNSUPPORTED_EDIT', 'Only Markdown and plain-text documents can be created')
    }
    const duplicate = this.journal.getByIdempotencyKey(idempotencyKey)
    if (duplicate) return duplicate.manifest
    const capability = await this.getRootCapability()
    const destination = await this.requireNewFilePath(capability, input.path)
    return this.recordPlan(
      capability,
      'create_workspace_document',
      [destination],
      [],
      idempotencyKey,
      {
        kind: 'create',
        destination,
        content: input.content,
        parents: [await this.inspectParent(capability, destination)],
      },
    )
  }

  async planRename(
    input: AiRenameWorkspaceDocumentArguments,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AiOperationManifest> {
    signal?.throwIfAborted()
    const duplicate = this.journal.getByIdempotencyKey(idempotencyKey)
    if (duplicate) return duplicate.manifest
    this.assertProviderPath(input.path)
    this.assertProviderPath(input.newPath)
    if (!isAiWorkspaceManagedPath(input.path) || !isAiWorkspaceManagedPath(input.newPath)) {
      throw aiError('AI_UNSUPPORTED_EDIT', 'Unsupported workspace file operation')
    }
    const capability = await this.getRootCapability()
    signal?.throwIfAborted()
    return await this.withWorkspaceAuthority(capability, async () => {
      signal?.throwIfAborted()
      const source = await this.inspectFile(capability, input.path)
      signal?.throwIfAborted()
      const destination = await this.requireNewFilePath(capability, input.newPath)
      signal?.throwIfAborted()
      const target = this.editorTarget(capability, source.identity)
      return await this.editorBoundary.withIdentityLease(target, async () => {
        signal?.throwIfAborted()
        const current = await this.reinspectPlannedSource(capability, source)
        signal?.throwIfAborted()
        if (!sameFileState(source, current)) throw this.staleTarget()
        if ((await this.editorBoundary.lookup(target)).status !== 'closed') throw this.staleTarget()
        signal?.throwIfAborted()
        await this.assertExpectedVersion(capability, current, input.expectedVersion, signal)
        signal?.throwIfAborted()
        const parents = await this.distinctParents(capability, [current.relativePath, destination])
        signal?.throwIfAborted()
        return this.recordPlan(
          capability,
          'rename_workspace_document',
          [current.relativePath, destination],
          [input.expectedVersion],
          idempotencyKey,
          {
            kind: 'rename',
            source: current,
            destination,
            parents,
          },
        )
      })
    })
  }

  async planDelete(
    input: AiDeleteWorkspaceDocumentArguments,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AiOperationManifest> {
    signal?.throwIfAborted()
    const duplicate = this.journal.getByIdempotencyKey(idempotencyKey)
    if (duplicate) return duplicate.manifest
    this.assertProviderPath(input.path)
    if (!isAiWorkspaceManagedPath(input.path)) {
      throw aiError('AI_UNSUPPORTED_EDIT', 'Unsupported workspace file operation')
    }
    const capability = await this.getRootCapability()
    signal?.throwIfAborted()
    return await this.withWorkspaceAuthority(capability, async () => {
      signal?.throwIfAborted()
      const source = await this.inspectFile(capability, input.path)
      signal?.throwIfAborted()
      const target = this.editorTarget(capability, source.identity)
      return await this.editorBoundary.withIdentityLease(target, async () => {
        signal?.throwIfAborted()
        const current = await this.reinspectPlannedSource(capability, source)
        signal?.throwIfAborted()
        if (!sameFileState(source, current)) throw this.staleTarget()
        if ((await this.editorBoundary.lookup(target)).status !== 'closed') throw this.staleTarget()
        signal?.throwIfAborted()
        await this.assertExpectedVersion(capability, current, input.expectedVersion, signal)
        signal?.throwIfAborted()
        const parents = [await this.inspectParent(capability, current.relativePath)]
        signal?.throwIfAborted()
        return this.recordPlan(
          capability,
          'delete_workspace_document',
          [current.relativePath],
          [input.expectedVersion],
          idempotencyKey,
          {
            kind: 'delete',
            source: current,
            parents,
          },
        )
      })
    })
  }

  /** Main-only evidence: the validated plan targets this window's live editor. */
  isPlannedEditorEdit(manifest: AiOperationManifest): boolean {
    const current = this.requirePlan(manifest)
    const plan = this.plans.get(manifest.operationId)
    return current.state === 'awaitingApproval' && manifest.toolName === 'edit_workspace_document'
      && plan?.kind === 'edit' && plan.route.kind === 'editor'
  }

  authorize(manifest: AiOperationManifest, nonce: string): void {
    const current = this.requirePlan(manifest)
    if (current.state === 'awaitingApproval') this.journal.authorize(manifest.operationId, nonce)
    else throw aiError('AI_OPERATION_INVALID', 'The operation cannot be authorized')
  }

  abandon(manifest: AiOperationManifest, reason: string): void {
    const current = this.requirePlan(manifest)
    if (current.state !== 'awaitingApproval' && current.state !== 'authorized') {
      throw aiError('AI_OPERATION_INVALID', 'The operation cannot be abandoned')
    }
    const boundedReason = typeof reason === 'string' && reason.length > 0 && reason.length <= 128
      ? reason : 'authorization-abandoned'
    this.journal.transition(manifest.operationId, 'failed', {
      error: aiError('AI_OPERATION_INVALID', boundedReason),
    })
    this.plans.delete(manifest.operationId)
  }

  async executeAuthorized(
    manifest: AiOperationManifest,
    nonce?: string,
  ): Promise<WorkspaceAiMutationExecution> {
    const current = this.requirePlan(manifest)
    if (current.state === 'succeeded') return current.result!
    if (current.state === 'failed' || current.state === 'unknown') {
      if (current.error) throw current.error
      throw aiError('AI_OPERATION_INVALID', 'The operation is terminal')
    }
    if (current.state === 'awaitingApproval') {
      if (nonce === undefined) throw aiError('AI_OPERATION_INVALID', 'Authorization is required')
      try {
        this.journal.authorize(manifest.operationId, nonce)
      } catch (error) {
        throw aiError('AI_OPERATION_INVALID', error instanceof Error ? error.message : 'Authorization failed')
      }
    }
    const completed = await this.journal.execute(manifest.operationId, async () => {
      const plan = this.plans.get(manifest.operationId)!
      let capability: WorkspaceRootCapability
      try {
        capability = await this.requireGeneration(manifest.workspaceGeneration)
      } catch (error) {
        if (plan.kind === 'edit') throw this.staleTarget()
        throw error
      }
      const execute = async () => {
        try {
          return await this.options.workspace.withMutationLease(
            { root: capability.rootFinalPath, epoch: capability.rootGeneration },
            async (fixedRoot) => {
              if (!sameWindowsPath(fixedRoot, capability.rootFinalPath)) {
                throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
              }
              if (plan.kind === 'create') return await this.executePlan(capability, manifest, plan)
              return await this.editorBoundary.withIdentityLease(
                this.editorTarget(capability, plan.source.identity),
                () => this.executePlan(capability, manifest, plan),
              )
            },
          )
        } catch (error) {
          if (error instanceof WorkspaceAiFileError
            || error instanceof AiOperationOutcomeUnknownError) throw error
          throw plan.kind === 'edit'
            ? this.staleTarget()
            : aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
        }
      }
      return plan.kind === 'edit' ? await execute() : await this.serializeStructural(execute)
    })
    if (!completed.result) throw completed.error ?? aiError('AI_OPERATION_INVALID', 'Operation failed')
    return completed.result
  }

  private recordPlan(
    capability: WorkspaceRootCapability,
    toolName: AiMutationToolName,
    relativePaths: readonly string[],
    expectedVersions: readonly AiFileVersion[],
    idempotencyKey: string,
    plan: PlannedOperation,
    operationId?: string,
  ): AiOperationManifest {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 512) {
      throw aiError('AI_OPERATION_INVALID', 'Invalid idempotency key')
    }
    const manifest: AiOperationManifest = {
      operationId: operationId ?? this.options.operationId?.() ?? randomUUID(),
      idempotencyKey,
      nonce: this.options.nonce?.() ?? randomBytes(32).toString('hex'),
      workspaceGeneration: capability.workspaceGeneration,
      toolName,
      relativePaths,
      expectedVersions,
    }
    if (!parseAiOperationManifest(manifest)) {
      throw aiError('AI_OPERATION_INVALID', 'Invalid AI operation manifest')
    }
    const entry = this.journal.plan(manifest)
    if (entry.manifest.operationId === manifest.operationId) {
      this.plans.set(manifest.operationId, plan)
      this.journal.transition(manifest.operationId, 'awaitingApproval')
    }
    return entry.manifest
  }

  private requirePlan(manifest: AiOperationManifest) {
    const entry = this.journal.get(manifest.operationId)
    if (!entry || !this.plans.has(manifest.operationId) || !manifestEquals(entry.manifest, manifest)) {
      throw aiError('AI_OPERATION_INVALID', 'Invalid AI operation manifest')
    }
    return entry
  }

  private async executePlan(
    capability: WorkspaceRootCapability,
    manifest: AiOperationManifest,
    plan: PlannedOperation,
  ): Promise<WorkspaceAiMutationExecution> {
    for (const parent of plan.parents) {
      const current = await this.reinspectPlannedDirectory(capability, parent)
      if (current.identity !== parent.identity
        || !sameWindowsPath(current.absolutePath, parent.absolutePath)) {
        throw plan.kind === 'edit'
          ? this.staleTarget()
          : aiError('AI_FILE_CHANGED', 'A workspace parent changed')
      }
    }
    const root = this.commitRoot(capability)
    let request: WorkspaceAiCommitRequest
    let auditKind: WorkspaceAiLocalAudit['kind']
    let auditPaths: readonly string[]
    if (plan.kind === 'edit') {
      const source = await this.reinspectPlannedSource(capability, plan.source)
      if (!sameFileState(source, plan.source)) throw this.staleTarget()
      const target = this.editorTarget(capability, source.identity)
      const lookup = await this.editorBoundary.lookup(target)
      if (plan.route.kind === 'editor') {
        if (lookup.status !== 'open'
          || lookup.registrationToken !== plan.route.plan.registrationToken
          || lookup.registrationRevision !== plan.route.plan.registrationRevision
          || lookup.bindingToken !== plan.route.plan.bindingToken
          || lookup.bindingRevision !== plan.route.plan.bindingRevision
          || manifest.operationId !== plan.route.plan.operationId
          || manifest.expectedVersions[0].fileId !== source.identity
          || manifest.expectedVersions[0].revision !== plan.route.plan.contentHash
          || manifest.expectedVersions[0].mtimeMs !== plan.route.plan.editorRevision
          || manifest.expectedVersions[0].size !== plan.route.snapshotSize) {
          throw this.staleTarget()
        }
        const attempted = await this.editorBoundary.applyTransaction({
          target,
          plan: plan.route.plan,
          replacementMarkdown: plan.content,
        })
        if (attempted.status === 'stale') throw this.staleTarget()
        let applied: Extract<typeof attempted, { status: 'applied' }>
        if (attempted.status === 'unknown') {
          const queried = await this.editorBoundary.queryOutcome({
            target,
            plan: plan.route.plan,
            replacementMarkdown: plan.content,
          })
          if (queried.status === 'stale' || queried.status === 'not-applied') {
            throw this.staleTarget()
          }
          if (queried.status !== 'applied') return this.unknown(manifest.operationId)
          applied = queried
        } else {
          applied = attempted
        }
        const successor = editorVersion(
          source.identity,
          applied.editorRevision,
          applied.contentHash,
          plan.content,
        )
        return this.execution(manifest, 'edited', [source.absolutePath], successor)
      }
      if (lookup.status !== 'closed') throw this.staleTarget()
      const snapshot = await this.options.documents.readForMain(source.relativePath)
      const current = await this.inspectFile(capability, source.relativePath)
      const actual = versionFor(current, snapshot.document.revision)
      if (!sameFileState(current, source) || snapshot.identity !== current.identity
        || !sameVersion(actual, manifest.expectedVersions[0])) throw this.staleTarget()
      request = {
        kind: 'edit', root, source: this.commitFile(source, actual.revision),
        parents: plan.parents.map((parent) => this.commitDirectory(parent)),
        bytes: encodeDocument(
          plan.content,
          snapshot.document.encoding,
          snapshot.document.newline,
        ),
      }
      auditKind = 'edited'
      auditPaths = [source.absolutePath]
    } else if (plan.kind === 'create') {
      const destination = path.resolve(capability.rootFinalPath, plan.destination)
      request = {
        kind: 'create', root,
        destination: { absolutePath: destination, relativePath: plan.destination },
        parents: plan.parents.map((parent) => this.commitDirectory(parent)),
        bytes: encodeDocument(plan.content, 'utf8', 'lf'),
      }
      auditKind = 'created'
      auditPaths = [destination]
    } else if (plan.kind === 'rename') {
      const source = await this.requireClosedPlannedSource(
        capability,
        plan.source,
        manifest.expectedVersions[0],
      )
      const destination = path.resolve(capability.rootFinalPath, plan.destination)
      request = {
        kind: 'rename', root, source: this.commitFile(source, manifest.expectedVersions[0].revision),
        destination: { absolutePath: destination, relativePath: plan.destination },
        parents: plan.parents.map((parent) => this.commitDirectory(parent)),
      }
      auditKind = 'renamed'
      auditPaths = [source.absolutePath, destination]
    } else {
      const source = await this.requireClosedPlannedSource(
        capability,
        plan.source,
        manifest.expectedVersions[0],
      )
      request = {
        kind: 'recycle', root, source: this.commitFile(source, manifest.expectedVersions[0].revision),
        parents: plan.parents.map((parent) => this.commitDirectory(parent)),
      }
      auditKind = 'recycled'
      auditPaths = [source.absolutePath]
    }

    const adapter = this.options.commitAdapter
    if (!adapter) throw aiError('AI_COMMIT_UNAVAILABLE', 'The Windows workspace commit adapter is unavailable')
    let outcome: WorkspaceAiCommitOutcome | undefined
    try {
      outcome = parseCommitOutcome(await adapter.commit(request), request.kind)
    } catch {
      return this.unknown(manifest.operationId)
    }
    if (!outcome) return this.unknown(manifest.operationId)
    if (outcome.status === 'unknown') return this.unknown(manifest.operationId)
    if (outcome.status === 'rejected') {
      if (outcome.reason === 'recycle-unavailable') {
        throw aiError('AI_RECYCLE_UNAVAILABLE', AI_RECYCLE_UNAVAILABLE_GUIDANCE)
      }
      if (outcome.reason === 'unsupported') {
        throw aiError('AI_COMMIT_UNAVAILABLE', 'The Windows workspace commit adapter rejected the operation')
      }
      throw aiError('AI_FILE_CHANGED', 'The workspace changed at commit')
    }
    let successorVersion: AiFileVersion | undefined
    if (plan.kind === 'edit') {
      try {
        const successor = await this.options.documents.readForMain(plan.source.relativePath)
        const successorState = await this.inspectFile(capability, plan.source.relativePath)
        if (successor.identity !== successorState.identity
          || successor.document.markdown !== plan.content) return this.unknown(manifest.operationId)
        successorVersion = versionFor(successorState, successor.document.revision)
      } catch {
        return this.unknown(manifest.operationId)
      }
    }
    return this.execution(manifest, auditKind, auditPaths, successorVersion)
  }

  private execution(
    manifest: AiOperationManifest,
    kind: WorkspaceAiLocalAudit['kind'],
    absolutePaths: readonly string[],
    successorVersion?: AiFileVersion,
  ): WorkspaceAiMutationExecution {
    return {
      result: {
        kind: 'mutation',
        operationId: manifest.operationId,
        state: 'succeeded',
        paths: [...manifest.relativePaths],
      },
      localAudit: { kind, absolutePaths: [...absolutePaths] },
      ...(successorVersion === undefined ? {} : { successorVersion: { ...successorVersion } }),
    }
  }

  private unknown(operationId: string): never {
    const error = new AiOperationOutcomeUnknownError()
    this.journal.transition(operationId, 'unknown', { error })
    throw error
  }

  private staleTarget(): WorkspaceAiFileError {
    return aiError('STALE_TARGET', 'The workspace target changed')
  }

  private editorTarget(
    capability: WorkspaceRootCapability,
    fileIdentity: CanonicalFileIdentity,
  ): WorkspaceAiEditorTarget {
    return Object.freeze({
      windowId: capability.windowId,
      workspaceId: capability.workspaceId,
      generation: capability.workspaceGeneration,
      fileIdentity,
    })
  }

  private commitRoot(capability: WorkspaceRootCapability): WorkspaceAiCommitRootIdentity {
    return Object.freeze({
      rootFinalPath: capability.rootFinalPath,
      activationEpoch: capability.rootGeneration,
      rootVolumeSerial: capability.rootVolumeSerial,
      rootFileId: capability.rootFileId,
    })
  }

  private commitFile(state: FileState, revision: string): WorkspaceAiCommitFileIdentity {
    return Object.freeze({
      absolutePath: state.absolutePath,
      relativePath: state.relativePath,
      fileId: state.identity,
      size: state.size,
      mtimeMs: state.mtimeMs,
      ctimeNs: String(state.ctimeNs),
      revision,
    })
  }

  private commitDirectory(state: FileState): WorkspaceAiCommitDirectoryIdentity {
    return Object.freeze({
      absolutePath: state.absolutePath,
      relativePath: state.relativePath,
      fileId: state.identity,
    })
  }

  private async serializeStructural<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.structuralTail
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.structuralTail = prior.catch(() => undefined).then(() => current)
    await prior.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async withWorkspaceAuthority<T>(
    capability: WorkspaceRootCapability,
    operation: () => Promise<T>,
  ): Promise<T> {
    let entered = false
    try {
      return await this.options.workspace.withMutationLease(
        { root: capability.rootFinalPath, epoch: capability.rootGeneration },
        async (fixedRoot) => {
          entered = true
          if (!sameWindowsPath(fixedRoot, capability.rootFinalPath)) {
            throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
          }
          return await operation()
        },
      )
    } catch (error) {
      if (entered) throw error
      throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
    }
  }

  private async requireGeneration(workspaceGeneration: string): Promise<WorkspaceRootCapability> {
    const capability = await this.getRootCapability()
    if (capability.workspaceGeneration !== workspaceGeneration) {
      throw aiError('AI_WORKSPACE_CHANGED', 'The loaded workspace changed')
    }
    return capability
  }

  private assertProviderPath(relativePath: string): void {
    try {
      assertWorkspaceRelativePath(relativePath)
      if (!isCanonicalWorkspaceRelativePath(relativePath)
        || this.hasControlDirectory(relativePath)) throw new Error('Control path')
    } catch {
      throw aiError('AI_INVALID_PATH', 'Invalid workspace-relative path')
    }
  }

  private hasControlDirectory(relativePath: string): boolean {
    return relativePath.split(/[\\/]+/).some((component) => (
      CONTROL_DIRECTORY_NAMES.has(component.toLocaleLowerCase('en-US'))
    ))
  }

  private async inspectParent(
    capability: WorkspaceRootCapability,
    relativePath: string,
  ): Promise<FileState> {
    const parent = path.posix.dirname(relativePath)
    return await this.inspectDirectory(capability, parent === '.' ? '' : parent)
  }

  private async distinctParents(
    capability: WorkspaceRootCapability,
    relativePaths: readonly string[],
  ): Promise<readonly FileState[]> {
    const parents = new Map<string, FileState>()
    for (const relativePath of relativePaths) {
      const parent = await this.inspectParent(capability, relativePath)
      parents.set(parent.identity, parent)
    }
    return [...parents.values()]
  }

  private async requireExistingFilePath(
    capability: WorkspaceRootCapability,
    requestedPath: string,
  ): Promise<string> {
    return (await this.inspectFile(capability, requestedPath)).relativePath
  }

  private async requireNewFilePath(
    capability: WorkspaceRootCapability,
    requestedPath: string,
  ): Promise<string> {
    const absolute = await this.requireNewAbsolutePath(capability, requestedPath)
    return slashSeparated(capability.rootFinalPath, absolute)
  }

  private async requireNewAbsolutePath(
    capability: WorkspaceRootCapability,
    requestedPath: string,
  ): Promise<string> {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      throw aiError('AI_INVALID_PATH', 'Invalid workspace-relative path')
    }
    await this.requireGeneration(capability.workspaceGeneration)
    try {
      const target = await resolveNewInside(capability.rootFinalPath, requestedPath)
      const lexical = path.resolve(capability.rootFinalPath, requestedPath)
      if (!sameWindowsPath(target, lexical)) throw new Error('Workspace path redirected')
      await this.assertSafeComponents(capability.rootFinalPath, path.dirname(target))
      return target
    } catch (error) {
      if (error instanceof WorkspaceAiFileError) throw error
      throw aiError('AI_INVALID_PATH', 'Invalid workspace-relative path')
    }
  }

  private async inspectDirectory(
    capability: WorkspaceRootCapability,
    requestedPath: string,
  ): Promise<FileState> {
    return await this.inspectPath(capability, requestedPath, true)
  }

  private async inspectFile(
    capability: WorkspaceRootCapability,
    requestedPath: string,
  ): Promise<FileState> {
    if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
      throw aiError('AI_INVALID_PATH', 'Invalid workspace-relative file path')
    }
    return await this.inspectPath(capability, requestedPath, false)
  }

  private async inspectPath(
    capability: WorkspaceRootCapability,
    requestedPath: string,
    directory: boolean,
  ): Promise<FileState> {
    await this.requireGeneration(capability.workspaceGeneration)
    try {
      const target = await resolveExistingInside(capability.rootFinalPath, requestedPath)
      const lexical = path.resolve(capability.rootFinalPath, requestedPath)
      if (!sameWindowsPath(target, lexical)) throw new Error('Workspace path redirected')
      await this.assertSafeComponents(capability.rootFinalPath, target)
      const metadata = await stat(target, { bigint: true })
      if (directory ? !metadata.isDirectory() : !metadata.isFile()) {
        throw new Error('Workspace path has unsupported type')
      }
      if (!directory && metadata.nlink !== 1n) {
        throw new Error('Workspace hardlinks are not allowed')
      }
      await this.requireGeneration(capability.workspaceGeneration)
      const verified = await resolveExistingInside(capability.rootFinalPath, requestedPath)
      const after = await stat(verified, { bigint: true })
      if (!sameWindowsPath(target, verified)
        || identity(metadata) !== identity(after)
        || metadata.size !== after.size
        || metadata.mtimeNs !== after.mtimeNs
        || metadata.ctimeNs !== after.ctimeNs
        || (!directory && after.nlink !== 1n)) throw new Error('Workspace path changed')
      return {
        absolutePath: verified,
        relativePath: slashSeparated(capability.rootFinalPath, verified),
        identity: identity(after),
        size: safeNumber(after.size),
        mtimeMs: Math.trunc(Number(after.mtimeNs / 1_000_000n)),
        ctimeNs: after.ctimeNs,
      }
    } catch (error) {
      if (error instanceof WorkspaceAiFileError) throw error
      throw aiError('AI_INVALID_PATH', 'Invalid workspace-relative path')
    }
  }

  private async assertSafeComponents(root: string, target: string): Promise<void> {
    const relative = path.relative(root, target)
    const components = relative ? relative.split(path.sep) : []
    let current = root
    for (const component of components) {
      current = path.join(current, component)
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink() || await queryWindowsReparsePoint(current)) {
        throw aiError('AI_INVALID_PATH', 'Workspace reparse points are not allowed')
      }
    }
  }

  private async assertExpectedVersion(
    capability: WorkspaceRootCapability,
    state: FileState,
    expected: AiFileVersion,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted()
    if (state.identity !== expected.fileId
      || state.size !== expected.size
      || state.mtimeMs !== expected.mtimeMs) {
      throw aiError('AI_FILE_CHANGED', 'The document changed')
    }
    const read = await this.readDocumentWithinAuthority(
      capability,
      { path: state.relativePath, cursor: 0, maxChars: 1 },
      signal,
    )
    signal?.throwIfAborted()
    if (!sameVersion(read.version, expected)) throw aiError('AI_FILE_CHANGED', 'The document changed')
  }

  private async reinspectPlannedSource(
    capability: WorkspaceRootCapability,
    planned: FileState,
  ): Promise<FileState> {
    try {
      return await this.inspectFile(capability, planned.relativePath)
    } catch (error) {
      if (error instanceof WorkspaceAiFileError && error.code === 'AI_WORKSPACE_CHANGED') throw error
      throw aiError('AI_FILE_CHANGED', 'The document identity changed')
    }
  }

  private async reinspectPlannedDirectory(
    capability: WorkspaceRootCapability,
    planned: FileState,
  ): Promise<FileState> {
    try {
      return await this.inspectDirectory(capability, planned.relativePath)
    } catch (error) {
      if (error instanceof WorkspaceAiFileError && error.code === 'AI_WORKSPACE_CHANGED') throw error
      throw aiError('AI_FILE_CHANGED', 'A workspace parent changed')
    }
  }

  private async requirePlannedSource(
    capability: WorkspaceRootCapability,
    planned: FileState,
    expected: AiFileVersion,
  ): Promise<FileState> {
    const source = await this.reinspectPlannedSource(capability, planned)
    if (!sameFileState(source, planned)) throw aiError('AI_FILE_CHANGED', 'The document identity changed')
    await this.assertExpectedVersion(capability, source, expected)
    return source
  }

  private async requireClosedPlannedSource(
    capability: WorkspaceRootCapability,
    planned: FileState,
    expected: AiFileVersion,
  ): Promise<FileState> {
    const source = await this.reinspectPlannedSource(capability, planned)
    if (!sameFileState(source, planned)) throw aiError('AI_FILE_CHANGED', 'The document identity changed')
    const target = this.editorTarget(capability, planned.identity)
    if ((await this.editorBoundary.lookup(target)).status !== 'closed') throw this.staleTarget()
    await this.assertExpectedVersion(capability, source, expected)
    return source
  }
}
