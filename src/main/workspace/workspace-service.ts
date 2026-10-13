import { AsyncLocalStorage } from 'node:async_hooks'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { TreeEntry, WorkspaceSummary } from '../../shared/contracts'
import type { DocumentConversionFormat } from '../../shared/document-conversion'
import {
  isEditableDocumentPath,
  isMarkItDownConversionPath,
  isPandocImportPath,
  isVisibleWorkspacePath,
} from '../../shared/document-types'
import { appError } from '../../shared/public-errors'
import { INITIAL_WORKSPACE_MARKER } from '../initial-workspace'
import { queryWindowsReparsePoint } from './windows-reparse-point'
import { resolveExistingInside } from './workspace-path'

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

function relativeForRenderer(root: string, target: string): string {
  return path.relative(root, target).split(/[\\/]+/).join('/')
}

interface DirectoryIdentity {
  dev: bigint
  ino: bigint
}

export interface WorkspaceValidationIo {
  realpath(root: string): Promise<string>
  stat(root: string): Promise<unknown>
  resolveExistingInside(root: string, relativePath: string): Promise<string>
  lstat?(target: string): Promise<unknown>
  queryWindowsReparsePoint?(target: string): Promise<boolean>
}

const nodeWorkspaceValidationIo: WorkspaceValidationIo = {
  realpath,
  stat: async (root) => await stat(root, { bigint: true }),
  resolveExistingInside,
  lstat,
  queryWindowsReparsePoint,
}

function sameWindowsPath(first: string, second: string): boolean {
  return path.normalize(first).toLocaleLowerCase('en-US')
    === path.normalize(second).toLocaleLowerCase('en-US')
}

function requireDirectoryIdentity(metadata: unknown): DirectoryIdentity {
  if (
    typeof metadata !== 'object'
    || metadata === null
    || !('isDirectory' in metadata)
    || typeof metadata.isDirectory !== 'function'
    || !metadata.isDirectory()
  ) {
    throw new Error('Workspace must be a directory')
  }
  const dev = 'dev' in metadata ? metadata.dev : undefined
  const ino = 'ino' in metadata ? metadata.ino : undefined
  if (typeof dev !== 'bigint' || typeof ino !== 'bigint' || dev <= 0n || ino <= 0n) {
    throw new Error('Workspace directory identity is unavailable')
  }
  return { dev, ino }
}

function sameIdentity(first: DirectoryIdentity, second: DirectoryIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino
}

interface FileSnapshot {
  dev: number | bigint
  ino: number | bigint
  size: number | bigint
  mtimeMs: number | bigint
  ctimeMs: number | bigint
}

declare const resolvedConvertibleDocumentBrand: unique symbol

export interface ResolvedConvertibleDocument {
  readonly canonicalPath: string
  readonly fileName: string
  readonly format: DocumentConversionFormat
  readonly bytes: number
  readonly modifiedAtMs: number
  readonly [resolvedConvertibleDocumentBrand]: true
}

export interface ValidatedResolvedConvertibleDocument {
  readonly canonicalPath: string
  readonly fileName: string
  readonly format: DocumentConversionFormat
  readonly bytes: number
  readonly modifiedAtMs: number
  readonly rawModifiedAtMs: number
  readonly device: number | bigint
  readonly inode: number | bigint
}

const resolvedConvertibleDocumentSnapshots = new WeakMap<object, FileSnapshot>()

function snapshotSize(value: number | bigint): number {
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw appError('INVALID_INPUT')
  return numeric
}

function snapshotTime(value: number | bigint): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) throw appError('INVALID_INPUT')
  return numeric
}

function requireRegularFileSnapshot(metadata: unknown): FileSnapshot {
  if (
    typeof metadata !== 'object'
    || metadata === null
    || !('isFile' in metadata)
    || typeof metadata.isFile !== 'function'
    || !metadata.isFile()
    || !('isSymbolicLink' in metadata)
    || typeof metadata.isSymbolicLink !== 'function'
    || metadata.isSymbolicLink()
  ) throw appError('UNSUPPORTED_FILE_TYPE')
  const record = metadata as Record<string, unknown>
  const fields = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const
  if (fields.some((field) => (
    typeof record[field] !== 'number' && typeof record[field] !== 'bigint'
  ))) throw appError('INVALID_INPUT')
  return {
    dev: record.dev as number | bigint,
    ino: record.ino as number | bigint,
    size: record.size as number | bigint,
    mtimeMs: record.mtimeMs as number | bigint,
    ctimeMs: record.ctimeMs as number | bigint,
  }
}

function sameFileSnapshot(first: FileSnapshot, second: FileSnapshot): boolean {
  return first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs
}

async function assertNotAWindowsReparsePoint(
  target: string,
  query: (target: string) => Promise<boolean>,
): Promise<void> {
  try {
    if (await query(target)) throw appError('INVALID_INPUT')
  } catch {
    throw appError('INVALID_INPUT')
  }
}

export async function validateResolvedConvertibleDocument(
  value: ResolvedConvertibleDocument,
): Promise<ValidatedResolvedConvertibleDocument> {
  const snapshot = typeof value === 'object' && value !== null
    ? resolvedConvertibleDocumentSnapshots.get(value)
    : undefined
  if (!snapshot) throw appError('INVALID_INPUT')
  try {
    await assertNotAWindowsReparsePoint(value.canonicalPath, queryWindowsReparsePoint)
    const current = requireRegularFileSnapshot(await lstat(value.canonicalPath))
    if (!sameFileSnapshot(snapshot, current)
      || !sameWindowsPath(await realpath(value.canonicalPath), value.canonicalPath)) {
      throw appError('INVALID_INPUT')
    }
    await assertNotAWindowsReparsePoint(value.canonicalPath, queryWindowsReparsePoint)
    return {
      canonicalPath: value.canonicalPath,
      fileName: value.fileName,
      format: value.format,
      bytes: value.bytes,
      modifiedAtMs: value.modifiedAtMs,
      rawModifiedAtMs: snapshotTime(snapshot.mtimeMs),
      device: snapshot.dev,
      inode: snapshot.ino,
    }
  } catch {
    throw appError('INVALID_INPUT')
  }
}

async function verifyCanonicalDirectory(
  canonical: string,
  io: WorkspaceValidationIo,
): Promise<DirectoryIdentity> {
  const resolved = await io.realpath(canonical)
  if (!sameWindowsPath(resolved, canonical)) throw new Error('Workspace path changed')
  const identity = requireDirectoryIdentity(await io.stat(resolved))

  const fixedRoot = await io.resolveExistingInside(canonical, '')
  if (!sameWindowsPath(fixedRoot, canonical)) throw new Error('Workspace path changed')
  const finalResolved = await io.realpath(canonical)
  if (!sameWindowsPath(finalResolved, canonical)) throw new Error('Workspace path changed')
  const finalIdentity = requireDirectoryIdentity(await io.stat(finalResolved))
  if (!sameIdentity(identity, finalIdentity)) throw new Error('Workspace identity changed')
  return finalIdentity
}

async function verifyExpectedCanonicalDirectory(
  canonical: string,
  expectedIdentity: DirectoryIdentity,
  io: WorkspaceValidationIo,
): Promise<DirectoryIdentity> {
  const identity = await verifyCanonicalDirectory(canonical, io)
  if (!sameIdentity(expectedIdentity, identity)) throw new Error('Workspace identity changed')
  return identity
}

export interface WorkspaceActivation {
  readonly summary: WorkspaceSummary
  commit(): Promise<WorkspaceSummary>
}

export interface WorkspaceActivationSnapshot {
  readonly root: string
  readonly epoch: number
}

export interface ValidatedWorkspaceActivationSnapshot extends WorkspaceActivationSnapshot {
  readonly rootVolumeSerial: string
  readonly rootFileId: string
}

export class WorkspaceService {
  private root: string | null = null
  private rootIdentity: DirectoryIdentity | null = null
  private activationEpoch = 0
  private authorityTail: Promise<void> = Promise.resolve()
  private readonly authorityContext = new AsyncLocalStorage<object>()
  private readonly activeAuthorities = new WeakSet<object>()

  constructor(private readonly validationIo = nodeWorkspaceValidationIo) {}

  private async validateCanonicalRoot(canonical: string): Promise<WorkspaceActivation> {
    const identity = await verifyCanonicalDirectory(canonical, this.validationIo)
    const summary = { name: path.basename(canonical), absolutePath: canonical }
    return {
      summary,
      commit: async () => await this.serializeAuthority(async () => {
        const committedIdentity = await verifyExpectedCanonicalDirectory(canonical, identity, this.validationIo)
        this.root = canonical
        this.rootIdentity = committedIdentity
        this.activationEpoch += 1
        return summary
      }),
    }
  }

  async validateRoot(root: string): Promise<WorkspaceActivation> {
    const canonical = await this.validationIo.realpath(root)
    return await this.validateCanonicalRoot(canonical)
  }

  async restoreCanonicalRoot(savedCanonicalPath: string): Promise<WorkspaceSummary>
  async restoreCanonicalRoot(savedCanonicalPath: null): Promise<null>
  async restoreCanonicalRoot(savedCanonicalPath: string | null): Promise<WorkspaceSummary | null>
  async restoreCanonicalRoot(savedCanonicalPath: string | null): Promise<WorkspaceSummary | null> {
    if (savedCanonicalPath === null) {
      await this.serializeAuthority(async () => {
        this.root = null
        this.rootIdentity = null
        this.activationEpoch += 1
      })
      return null
    }
    if (!path.isAbsolute(savedCanonicalPath)) {
      throw new Error('Persisted workspace path must be absolute')
    }
    const canonical = await this.validationIo.realpath(savedCanonicalPath)
    if (!sameWindowsPath(canonical, savedCanonicalPath)) {
      throw new Error('Persisted workspace path redirected')
    }
    return await (await this.validateCanonicalRoot(canonical)).commit()
  }

  async setRoot(root: string): Promise<WorkspaceSummary> {
    return await (await this.validateRoot(root)).commit()
  }

  getRoot(): string {
    if (!this.root) throw new Error('No workspace is open')
    return this.root
  }

  getActivationSnapshot(): WorkspaceActivationSnapshot {
    if (!this.root || !this.rootIdentity || this.activationEpoch <= 0) {
      throw new Error('No workspace is open')
    }
    return Object.freeze({ root: this.root, epoch: this.activationEpoch })
  }

  async getValidatedActivationSnapshot(): Promise<ValidatedWorkspaceActivationSnapshot> {
    const authority = this.authorityContext.getStore()
    if (authority && this.activeAuthorities.has(authority)) {
      return await this.validateCurrentActivation()
    }
    return await this.serializeAuthority(async () => await this.validateCurrentActivation())
  }

  /** Save As may start from an owned unnamed draft before any workspace is open.
   * An invalid active root is still an error; only the explicitly empty state is allowed. */
  async getSaveAsActivationSnapshot(): Promise<ValidatedWorkspaceActivationSnapshot | { readonly root: null; readonly epoch: number }> {
    return await this.serializeAuthority(async () => {
      if (this.root === null && this.rootIdentity === null) {
        return Object.freeze({ root: null, epoch: this.activationEpoch })
      }
      return await this.validateCurrentActivation()
    })
  }

  async withMutationLease<T>(
    expected: WorkspaceActivationSnapshot,
    operation: (fixedRoot: string) => Promise<T>,
  ): Promise<T> {
    return await this.serializeAuthority(async () => {
      if (!this.root || !this.rootIdentity
        || expected.epoch !== this.activationEpoch
        || !sameWindowsPath(expected.root, this.root)) {
        throw new Error('Workspace activation changed')
      }
      await verifyExpectedCanonicalDirectory(this.root, this.rootIdentity, this.validationIo)
      const authority = {}
      this.activeAuthorities.add(authority)
      try {
        return await this.authorityContext.run(authority, async () => await operation(this.root!))
      } finally {
        this.activeAuthorities.delete(authority)
      }
    })
  }

  private async validateCurrentActivation(): Promise<ValidatedWorkspaceActivationSnapshot> {
    if (!this.root || !this.rootIdentity || this.activationEpoch <= 0) {
      throw new Error('No workspace is open')
    }
    const root = this.root
    const epoch = this.activationEpoch
    const verified = await verifyExpectedCanonicalDirectory(root, this.rootIdentity, this.validationIo)
    return Object.freeze({
      root,
      epoch,
      rootVolumeSerial: verified.dev.toString(16),
      rootFileId: verified.ino.toString(16),
    })
  }

  private async serializeAuthority<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.authorityTail
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.authorityTail = prior.catch(() => undefined).then(() => current)
    await prior.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
    }
  }

  async validateDroppedPath(absolutePath: string): Promise<{
    activation: WorkspaceActivation
    documentPath: string | null
  }> {
    if (!path.isAbsolute(absolutePath)) throw new Error('Dropped path must be absolute')
    const originalMetadata = await lstat(absolutePath)
    if (originalMetadata.isSymbolicLink()) throw new Error('Dropped symbolic links are not supported')
    const canonical = await realpath(absolutePath)
    const metadata = await stat(canonical)
    if (metadata.isDirectory()) {
      return { activation: await this.validateCanonicalRoot(canonical), documentPath: null }
    }
    if (!metadata.isFile() || !isEditableDocumentPath(canonical)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const root = path.dirname(canonical)
    return {
      activation: await this.validateCanonicalRoot(root),
      documentPath: relativeForRenderer(root, canonical),
    }
  }

  async resolveExistingDocument(relativePath: string): Promise<string> {
    const root = this.getRoot()
    const target = await resolveExistingInside(root, relativePath)
    const metadata = await stat(target)
    if (!metadata.isFile() || !isEditableDocumentPath(target)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    return target
  }

  async resolveExistingPandocDocument(relativePath: string): Promise<string> {
    const root = this.getRoot()
    const target = await resolveExistingInside(root, relativePath)
    const metadata = await lstat(target)
    if (
      metadata.isSymbolicLink()
      || !metadata.isFile()
      || !isPandocImportPath(target)
    ) throw appError('UNSUPPORTED_FILE_TYPE')
    return target
  }

  async resolveExistingConvertibleDocument(
    relativePath: string,
  ): Promise<ResolvedConvertibleDocument> {
    if (!isMarkItDownConversionPath(relativePath)) throw appError('UNSUPPORTED_FILE_TYPE')
    const root = this.getRoot()
    const canonical = await this.validationIo.resolveExistingInside(root, relativePath)
    const lexical = path.resolve(root, relativePath)
    if (!sameWindowsPath(lexical, canonical)) throw appError('INVALID_INPUT')
    const readMetadata = this.validationIo.lstat ?? lstat
    const queryReparsePoint = this.validationIo.queryWindowsReparsePoint ?? queryWindowsReparsePoint
    await assertNotAWindowsReparsePoint(canonical, queryReparsePoint)
    const before = requireRegularFileSnapshot(await readMetadata(canonical))

    const verifiedCanonical = await this.validationIo.resolveExistingInside(root, relativePath)
    if (!sameWindowsPath(verifiedCanonical, canonical)) throw appError('INVALID_INPUT')
    await assertNotAWindowsReparsePoint(verifiedCanonical, queryReparsePoint)
    const after = requireRegularFileSnapshot(await readMetadata(verifiedCanonical))
    if (!sameFileSnapshot(before, after)) throw appError('INVALID_INPUT')
    const extension = path.extname(canonical).slice(1).toLocaleLowerCase('en-US')
    const resolved = Object.freeze({
      canonicalPath: canonical,
      fileName: path.basename(canonical),
      format: extension as DocumentConversionFormat,
      bytes: snapshotSize(after.size),
      modifiedAtMs: Math.trunc(snapshotTime(after.mtimeMs)),
    }) as ResolvedConvertibleDocument
    resolvedConvertibleDocumentSnapshots.set(resolved, after)
    return resolved
  }

  async listDirectory(
    relativePath: string,
    expectedActivation?: WorkspaceActivationSnapshot,
  ): Promise<TreeEntry[]> {
    this.getRoot()
    let activation: ValidatedWorkspaceActivationSnapshot
    try {
      activation = await this.requireValidatedActivation(expectedActivation)
    } catch {
      throw new Error('Path is outside the workspace')
    }
    const root = activation.root
    const directory = await resolveExistingInside(root, relativePath)
    const directoryMetadata = await stat(directory, { bigint: true })
    if (!directoryMetadata.isDirectory()) throw new Error('Workspace path must be a directory')
    const directoryIdentity = requireDirectoryIdentity(directoryMetadata)
    const verifiedDirectory = await resolveExistingInside(root, relativePath)
    const entries = await readdir(verifiedDirectory, { withFileTypes: true })
    await resolveExistingInside(root, relativePath)
    const visibleEntries: TreeEntry[] = []

    for (const entry of entries) {
      const candidate = path.join(verifiedDirectory, entry.name)
      try {
        const metadata = await lstat(candidate)
        if (metadata.isSymbolicLink()) continue
        if (!metadata.isDirectory() && (!metadata.isFile() || !isVisibleWorkspacePath(entry.name))) continue

        const canonicalTarget = await resolveExistingInside(root, relativeForRenderer(root, candidate))
        const verifiedMetadata = await lstat(canonicalTarget)
        if (verifiedMetadata.isSymbolicLink()) continue
        if (!verifiedMetadata.isDirectory() && (!verifiedMetadata.isFile() || !isVisibleWorkspacePath(entry.name))) continue
        // Browsing and search share this list; keep initialization state on disk only.
        if (verifiedMetadata.isFile() && entry.name.toLocaleLowerCase('en-US') === INITIAL_WORKSPACE_MARKER) continue
        visibleEntries.push({
          name: entry.name,
          relativePath: relativeForRenderer(root, canonicalTarget),
          kind: verifiedMetadata.isDirectory() ? 'directory' : 'document',
        })
      } catch {
        // Ignore entries that race, cannot be identified safely, or leave the workspace.
      }
    }

    const finalDirectory = await resolveExistingInside(root, relativePath)
    const finalDirectoryIdentity = requireDirectoryIdentity(await stat(finalDirectory, { bigint: true }))
    if (!sameWindowsPath(finalDirectory, verifiedDirectory)
      || !sameIdentity(directoryIdentity, finalDirectoryIdentity)) {
      throw new Error('Workspace directory identity changed')
    }
    await this.requireValidatedActivation(activation)
    return visibleEntries.sort(compareEntries)
  }

  private async requireValidatedActivation(
    expected?: WorkspaceActivationSnapshot,
  ): Promise<ValidatedWorkspaceActivationSnapshot> {
    const current = await this.getValidatedActivationSnapshot()
    if (expected && (current.epoch !== expected.epoch || !sameWindowsPath(current.root, expected.root))) {
      throw new Error('Workspace activation changed')
    }
    return current
  }
}
