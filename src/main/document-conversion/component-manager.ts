import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename as renameFile,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import * as tar from 'tar'
import { appError, PublicError, type PublicErrorCode } from '../../shared/public-errors'
import type {
  ComponentInstallProgress,
  DocumentConversionComponentDescriptor,
  DocumentConversionComponentState,
} from '../../shared/document-conversion'
import {
  parseDocumentConversionComponentDescriptor,
  parseDocumentConversionComponentState,
} from '../../shared/document-conversion'
import type { ComponentArtifactSource } from './component-artifact-source'

const COMPONENT_MANIFEST_NAME = 'component-manifest.json'
const COMPONENT_MANIFEST_MAX_BYTES = 8 * 1024 * 1024
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u
const UUID_DIRECTORY_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

interface ComponentTreeFile {
  path: string
  bytes: number
  sha256: string
}

interface ComponentTreeManifest {
  schemaVersion: 1
  version: string
  pythonVersion: string
  platform: string
  lockSha256: string
  files: ComponentTreeFile[]
}

export interface DocumentConversionRuntime {
  readonly version: string
  readonly root: string
  readonly pythonExecutable: string
  readonly entryScript: string
}

export interface DocumentConversionComponentLease {
  readonly runtime: DocumentConversionRuntime
  release(): void
}

export interface DocumentConversionComponentManager {
  getState(): DocumentConversionComponentState
  ensureVerified(): Promise<void>
  install(ownerId: string): Promise<DocumentConversionComponentState>
  cancelInstall(ownerId: string): Promise<DocumentConversionComponentState>
  remove(): Promise<DocumentConversionComponentState>
  resolveRuntime(): DocumentConversionRuntime | undefined
  subscribe(listener: (state: DocumentConversionComponentState) => void): () => void
  acquireLease(): DocumentConversionComponentLease
  dispose(): Promise<void>
}

export interface DocumentConversionComponentManagerOptions {
  userData: string
  descriptor: DocumentConversionComponentDescriptor
  source: ComponentArtifactSource
  bundledRoot?: string
  bundledTreeManifestSha256?: string
  treeManifestSha256?: string
  rename?(from: string, to: string): Promise<void>
  /** @internal Main-process filesystem observation seam for deterministic lifecycle tests. */
  beforeReadDirectory?(root: string): void
  /** @internal Full-audit observation seam used to prove startup stays hash-free. */
  beforeHashFile?(filePath: string): void
}

interface OwnerRequest {
  promise: Promise<DocumentConversionComponentState>
  resolve(state: DocumentConversionComponentState): void
}

interface InstallFlight {
  controller: AbortController
  owners: Map<string, OwnerRequest>
  requests: Set<OwnerRequest>
  baseline: DocumentConversionComponentState
  task: Promise<void>
}

type ComponentStatePublication = Omit<DocumentConversionComponentState, 'revision'>

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function equalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function canonicalComponentVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return parseDocumentConversionComponentDescriptor({
    source: 'packaged',
    version: value,
    archiveName: 'component.tar.gz',
    bytes: 1,
    sha256: '0'.repeat(64),
    url: null,
  }) !== undefined
}

function safeRelativeFile(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value === COMPONENT_MANIFEST_NAME
    || value.startsWith('/') || value.includes('\\') || value.includes(':')) return false
  const segments = value.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
    && path.posix.normalize(value) === value
}

function parseTreeManifest(value: unknown): ComponentTreeManifest | undefined {
  if (!exactRecord(value, [
    'schemaVersion', 'version', 'pythonVersion', 'platform', 'lockSha256', 'files',
  ]) || value.schemaVersion !== 1 || !canonicalComponentVersion(value.version)
    || typeof value.pythonVersion !== 'string' || value.pythonVersion.length === 0
    || typeof value.platform !== 'string' || value.platform.length === 0
    || typeof value.lockSha256 !== 'string' || !LOWERCASE_SHA256.test(value.lockSha256)
    || !Array.isArray(value.files) || value.files.length === 0) return undefined

  const files: ComponentTreeFile[] = []
  const names = new Set<string>()
  for (const candidate of value.files) {
    if (!exactRecord(candidate, ['path', 'bytes', 'sha256'])
      || !safeRelativeFile(candidate.path)
      || !Number.isSafeInteger(candidate.bytes) || (candidate.bytes as number) < 0
      || typeof candidate.sha256 !== 'string' || !LOWERCASE_SHA256.test(candidate.sha256)) return undefined
    const comparisonName = process.platform === 'win32'
      ? candidate.path.toLocaleLowerCase('en-US')
      : candidate.path
    if (names.has(comparisonName)) return undefined
    names.add(comparisonName)
    files.push({ path: candidate.path, bytes: candidate.bytes as number, sha256: candidate.sha256 })
  }
  if (!names.has('python.exe') || !names.has('arkdown_markitdown.py')) return undefined
  return {
    schemaVersion: 1,
    version: value.version,
    pythonVersion: value.pythonVersion,
    platform: value.platform,
    lockSha256: value.lockSha256,
    files,
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

function immutableState(state: DocumentConversionComponentState): DocumentConversionComponentState {
  const progress = state.progress ? Object.freeze({ ...state.progress }) : null
  const snapshot = Object.freeze({ ...state, progress })
  if (!parseDocumentConversionComponentState(snapshot)) throw new Error('Invalid document conversion component state')
  return snapshot
}

function publicationFrom(
  state: DocumentConversionComponentState,
): ComponentStatePublication {
  const { revision: _revision, ...publication } = state
  return publication
}

function immutableRuntime(root: string, version: string): DocumentConversionRuntime {
  return Object.freeze({
    version,
    root,
    pythonExecutable: path.join(root, 'python.exe'),
    entryScript: path.join(root, 'arkdown_markitdown.py'),
  })
}

function abortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && (error === signal.reason
    || (error instanceof Error && (error.name === 'AbortError' || error.message === 'This operation was aborted')))
}

const INSTALL_FAILURE_CODES = new Set<PublicErrorCode>([
  'DOCUMENT_CONVERSION_PACKAGE_MISSING',
  'DOCUMENT_CONVERSION_COMPONENT_INVALID',
  'DOCUMENT_CONVERSION_INSTALL_FAILED',
  'DOCUMENT_CONVERSION_DOWNLOAD_FAILED',
])

function installFailureCode(error: unknown): PublicErrorCode {
  return error instanceof PublicError && INSTALL_FAILURE_CODES.has(error.code)
    ? error.code
    : 'DOCUMENT_CONVERSION_INSTALL_FAILED'
}

export async function createDocumentConversionComponentManager(
  options: DocumentConversionComponentManagerOptions,
): Promise<DocumentConversionComponentManager> {
  const descriptor = parseDocumentConversionComponentDescriptor(options.descriptor)
  if (!descriptor || descriptor.source !== options.source.kind) {
    throw new Error('Invalid document conversion component descriptor')
  }
  const rename = options.rename ?? renameFile
  const trustedTreeHash = options.treeManifestSha256 ?? options.bundledTreeManifestSha256
  const hashFile = async (filePath: string): Promise<string> => {
    options.beforeHashFile?.(filePath)
    return fileSha256(filePath)
  }
  const readDirectoryNames = async (root: string): Promise<string[]> => {
    options.beforeReadDirectory?.(root)
    return readdir(root)
  }
  const componentRoot = path.resolve(options.userData, 'document-conversion')
  const activeRoot = path.join(componentRoot, 'active')
  const stagingRoot = path.join(componentRoot, 'staging')
  const backupRoot = path.join(componentRoot, 'backup')

  const assertOwnedPath = (target: string): void => {
    const resolved = path.resolve(target)
    const relative = path.relative(componentRoot, resolved)
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Refusing filesystem mutation outside the component root')
    }
  }
  const removeOwned = async (target: string, recursive = true): Promise<void> => {
    assertOwnedPath(target)
    await rm(target, { recursive, force: true })
  }
  const pathExists = async (target: string): Promise<boolean> => {
    try { await lstat(target); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  await mkdir(componentRoot, { recursive: true })
  const rootInfo = await lstat(componentRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()
    || !equalPath(await realpath(componentRoot), componentRoot)) {
    throw new Error('Invalid document conversion component root')
  }
  const ensureManagedDirectory = async (root: string): Promise<void> => {
    assertOwnedPath(root)
    await mkdir(root, { recursive: true })
    const metadata = await lstat(root)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()
      || !equalPath(await realpath(root), root)) {
      throw new Error('Invalid document conversion managed directory')
    }
  }
  await ensureManagedDirectory(stagingRoot)
  await ensureManagedDirectory(backupRoot)

  const verifyPinnedArchive = async (archivePath: string): Promise<void> => {
    const resolvedArchive = path.resolve(archivePath)
    const relative = path.relative(stagingRoot, resolvedArchive)
    const segments = relative.split(path.sep)
    if (segments.length !== 2 || !UUID_DIRECTORY_NAME.test(segments[0] ?? '')
      || segments[1] !== descriptor.archiveName || path.isAbsolute(relative)
      || relative.startsWith(`..${path.sep}`) || relative === '..') {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    const [stagingMetadata, archiveMetadata, canonicalStaging, canonicalArchive] = await Promise.all([
      lstat(stagingRoot),
      lstat(resolvedArchive),
      realpath(stagingRoot),
      realpath(resolvedArchive),
    ])
    if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()
      || !archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()
      || archiveMetadata.size !== descriptor.bytes
      || !equalPath(canonicalStaging, stagingRoot)
      || !equalPath(canonicalArchive, resolvedArchive)) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    if (await hashFile(resolvedArchive) !== descriptor.sha256) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    const verifiedMetadata = await lstat(resolvedArchive)
    if (!verifiedMetadata.isFile() || verifiedMetadata.isSymbolicLink()
      || verifiedMetadata.size !== descriptor.bytes
      || !equalPath(await realpath(resolvedArchive), resolvedArchive)) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
  }

  const auditTree = async (
    root: string,
    expectedVersion?: string,
  ): Promise<DocumentConversionRuntime | undefined> => {
    try {
      const rootMetadata = await lstat(root)
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
        || !equalPath(await realpath(root), root)) return undefined
      const actualFiles: string[] = []
      const actualDirectories: string[] = []
      const visit = async (directory: string): Promise<void> => {
        const entries = await readdir(directory, { withFileTypes: true })
        entries.sort((left, right) => ordinalCompare(left.name, right.name))
        for (const entry of entries) {
          const absolute = path.join(directory, entry.name)
          const relative = path.relative(root, absolute).replaceAll('\\', '/')
          if (!safeRelativeFile(relative) && relative !== COMPONENT_MANIFEST_NAME) {
            throw new Error('Unsafe component tree path')
          }
          const metadata = await lstat(absolute)
          if (entry.isSymbolicLink() || metadata.isSymbolicLink()
            || !equalPath(await realpath(absolute), absolute)) throw new Error('Component tree reparse point')
          if (entry.isDirectory() && metadata.isDirectory()) {
            actualDirectories.push(relative)
            await visit(absolute)
          } else if (entry.isFile() && metadata.isFile()) {
            actualFiles.push(relative)
          } else {
            throw new Error('Component tree contains a non-file entry')
          }
        }
      }
      await visit(root)
      actualFiles.sort(ordinalCompare)
      actualDirectories.sort(ordinalCompare)
      if (!actualFiles.includes(COMPONENT_MANIFEST_NAME)) return undefined

      const manifestPath = path.join(root, COMPONENT_MANIFEST_NAME)
      const manifestInfo = await lstat(manifestPath)
      if (manifestInfo.size > COMPONENT_MANIFEST_MAX_BYTES) return undefined
      if (trustedTreeHash && await fileSha256(manifestPath) !== trustedTreeHash) return undefined
      const manifest = parseTreeManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
      if (!manifest || (expectedVersion !== undefined && manifest.version !== expectedVersion)) return undefined
      const declaredFiles = manifest.files.map((file) => file.path)
      const expectedFiles = [...declaredFiles, COMPONENT_MANIFEST_NAME].sort(ordinalCompare)
      if (actualFiles.length !== expectedFiles.length
        || actualFiles.some((name, index) => name !== expectedFiles[index])) return undefined
      const expectedDirectories = [...new Set(declaredFiles.flatMap((file) => {
        const segments = file.split('/')
        return segments.slice(0, -1).map((_segment, index) => segments.slice(0, index + 1).join('/'))
      }))].sort(ordinalCompare)
      if (actualDirectories.length !== expectedDirectories.length
        || actualDirectories.some((name, index) => name !== expectedDirectories[index])) return undefined

      for (const file of manifest.files) {
        const absolute = path.resolve(root, ...file.path.split('/'))
        const relative = path.relative(root, absolute)
        if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) return undefined
        const metadata = await lstat(absolute)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== file.bytes
          || !equalPath(await realpath(absolute), absolute)
          || await hashFile(absolute) !== file.sha256) return undefined
      }
      return immutableRuntime(root, manifest.version)
    } catch {
      return undefined
    }
  }

  const inspectTree = async (
    root: string,
    expectedVersion?: string,
  ): Promise<DocumentConversionRuntime | undefined> => {
    try {
      const rootMetadata = await lstat(root)
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
        || !equalPath(await realpath(root), root)) return undefined
      const manifestPath = path.join(root, COMPONENT_MANIFEST_NAME)
      const manifestInfo = await lstat(manifestPath)
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()
        || manifestInfo.size > COMPONENT_MANIFEST_MAX_BYTES
        || !equalPath(await realpath(manifestPath), manifestPath)) return undefined
      if (trustedTreeHash && await fileSha256(manifestPath) !== trustedTreeHash) return undefined
      const manifest = parseTreeManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
      if (!manifest || (expectedVersion !== undefined && manifest.version !== expectedVersion)) {
        return undefined
      }
      for (const relative of ['python.exe', 'arkdown_markitdown.py']) {
        const comparison = process.platform === 'win32'
          ? relative.toLocaleLowerCase('en-US')
          : relative
        const declared = manifest.files.find((file) => (
          process.platform === 'win32'
            ? file.path.toLocaleLowerCase('en-US') === comparison
            : file.path === comparison
        ))
        if (!declared) return undefined
        const absolute = path.join(root, relative)
        const metadata = await lstat(absolute)
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== declared.bytes
          || !equalPath(await realpath(absolute), absolute)) return undefined
      }
      return immutableRuntime(root, manifest.version)
    } catch {
      return undefined
    }
  }

  const cleanDirectoryChildren = async (root: string): Promise<void> => {
    for (const entry of await readDirectoryNames(root)) await removeOwned(path.join(root, entry))
  }

  await cleanDirectoryChildren(stagingRoot)
  let runtime = await inspectTree(activeRoot)
  if (runtime) {
    await cleanDirectoryChildren(backupRoot)
  } else {
    const backups = (await readDirectoryNames(backupRoot)).sort(ordinalCompare)
    let selected: string | undefined
    for (const name of backups) {
      const candidate = path.join(backupRoot, name)
      if (!selected && UUID_DIRECTORY_NAME.test(name) && await inspectTree(candidate)) selected = candidate
      else await removeOwned(candidate)
    }
    if (await pathExists(activeRoot)) await removeOwned(activeRoot)
    if (selected) {
      await rename(selected, activeRoot)
      runtime = await inspectTree(activeRoot)
      if (!runtime) {
        await removeOwned(activeRoot)
        throw new Error('Recovered document conversion component failed audit')
      }
    }
    await cleanDirectoryChildren(backupRoot)
  }

  if (options.bundledRoot) runtime = await inspectTree(options.bundledRoot, descriptor.version) ?? runtime
  const isBundled = () => Boolean(options.bundledRoot && runtime?.root === options.bundledRoot)
  let currentState = immutableState({
    revision: 0,
    source: descriptor.source,
    ...(isBundled() ? { bundled: true } : {}),
    status: runtime
      ? runtime.version === descriptor.version ? 'installed' : 'update-available'
      : 'absent',
    installedVersion: runtime?.version ?? null,
    availableVersion: descriptor.version,
    progress: null,
    errorCode: null,
    busy: false,
  })
  let disposed = false
  let runtimeVerified = false
  let verificationFlight: Promise<void> | undefined
  let flight: InstallFlight | undefined
  let activeMutation: Promise<unknown> | undefined
  let disposePromise: Promise<void> | undefined
  const listeners = new Set<(state: DocumentConversionComponentState) => void>()
  const leaseTokens = new Set<symbol>()
  let mutationLocked = false

  const publish = (next: ComponentStatePublication): DocumentConversionComponentState => {
    const revision = currentState.revision + 1
    if (!Number.isSafeInteger(revision)) {
      throw new Error('Document conversion component revision exhausted')
    }
    currentState = immutableState({ revision, ...next, ...(options.bundledRoot ? { bundled: isBundled() } : {}) })
    if (!disposed) {
      for (const listener of [...listeners]) {
        try { listener(currentState) } catch { /* Subscriber failures cannot corrupt manager state. */ }
      }
    }
    return currentState
  }
  const installProgress = (progress: ComponentInstallProgress): void => {
    if (disposed || !flight) return
    publish({
      source: descriptor.source,
      status: 'installing',
      installedVersion: runtime?.version ?? null,
      availableVersion: descriptor.version,
      progress,
      errorCode: null,
      busy: true,
    })
  }
  const deferredOwner = (): OwnerRequest => {
    let resolve!: (state: DocumentConversionComponentState) => void
    const promise = new Promise<DocumentConversionComponentState>((done) => { resolve = done })
    return { promise, resolve }
  }
  const extractionEntryAllowed = (rawPath: string): boolean => {
    const candidate = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
    return safeRelativeFile(candidate) || candidate === COMPONENT_MANIFEST_NAME
  }
  const trackMutation = <T>(task: Promise<T>): Promise<T> => {
    activeMutation = task
    void task.finally(() => {
      if (activeMutation === task) activeMutation = undefined
    }).catch(() => undefined)
    return task
  }

  const performInstall = async (activeFlight: InstallFlight): Promise<void> => {
    const transactionRoot = path.join(stagingRoot, randomUUID())
    const extractionRoot = path.join(transactionRoot, 'tree')
    const archivePath = path.join(transactionRoot, descriptor.archiveName)
    const backup = path.join(backupRoot, randomUUID())
    let oldMoved = false
    let newActivated = false
    try {
      await mkdir(extractionRoot, { recursive: true })
      await options.source.copyTo(archivePath, activeFlight.controller.signal, installProgress)
      activeFlight.controller.signal.throwIfAborted()
      await verifyPinnedArchive(archivePath)
      activeFlight.controller.signal.throwIfAborted()
      installProgress({ phase: 'verifying', receivedBytes: descriptor.bytes, totalBytes: descriptor.bytes })
      installProgress({ phase: 'extracting', receivedBytes: 0, totalBytes: descriptor.bytes })
      let unsafeArchiveEntry = false
      await tar.x({
        cwd: extractionRoot,
        file: archivePath,
        strict: true,
        preservePaths: false,
        filter(entryPath, entry) {
          const allowed = 'type' in entry && 'path' in entry && 'linkpath' in entry
            && entry.path === entryPath
            && extractionEntryAllowed(entry.path)
            && ['File', 'OldFile', 'Directory'].includes(entry.type)
            && !entry.linkpath
          if (!allowed) unsafeArchiveEntry = true
          return allowed
        },
      })
      if (unsafeArchiveEntry) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
      activeFlight.controller.signal.throwIfAborted()
      installProgress({ phase: 'extracting', receivedBytes: descriptor.bytes, totalBytes: descriptor.bytes })
      const stagedRuntime = await auditTree(extractionRoot, descriptor.version)
      activeFlight.controller.signal.throwIfAborted()
      if (disposed) throw new Error('Document conversion component manager is disposed')
      if (!stagedRuntime) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
      mutationLocked = true
      if (leaseTokens.size > 0) throw new Error('Document conversion component is active')

      if (await pathExists(activeRoot)) {
        await rename(activeRoot, backup)
        oldMoved = true
      }
      try {
        await rename(extractionRoot, activeRoot)
        newActivated = true
        const activated = await auditTree(activeRoot, descriptor.version)
        if (!activated) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
        runtime = activated
        runtimeVerified = true
      } catch (error) {
        if (newActivated && await pathExists(activeRoot)) await removeOwned(activeRoot)
        if (oldMoved && await pathExists(backup)) await rename(backup, activeRoot)
        runtime = await auditTree(activeRoot)
        runtimeVerified = Boolean(runtime)
        throw error
      }
      if (oldMoved && await pathExists(backup)) await removeOwned(backup)
      publish({
        source: descriptor.source,
        status: 'installed',
        installedVersion: descriptor.version,
        availableVersion: descriptor.version,
        progress: null,
        errorCode: null,
        busy: false,
      })
    } catch (error) {
      runtime = await auditTree(activeRoot)
      runtimeVerified = Boolean(runtime)
      if (abortError(error, activeFlight.controller.signal) && activeFlight.owners.size === 0) {
        publish({
          ...publicationFrom(activeFlight.baseline),
          installedVersion: runtime?.version ?? activeFlight.baseline.installedVersion,
          progress: null,
          busy: false,
        })
      } else {
        publish({
          source: descriptor.source,
          status: 'failed',
          installedVersion: runtime?.version ?? null,
          availableVersion: descriptor.version,
          progress: null,
          errorCode: installFailureCode(error),
          busy: false,
        })
      }
    } finally {
      mutationLocked = false
      await removeOwned(transactionRoot).catch(() => undefined)
      const result = currentState
      if (flight === activeFlight) flight = undefined
      for (const request of activeFlight.requests) request.resolve(result)
    }
  }

  const manager: DocumentConversionComponentManager = {
    getState() {
      return currentState
    },
    ensureVerified() {
      if (disposed || !runtime) {
        return Promise.reject(appError('OPERATION_FAILED'))
      }
      if (runtimeVerified) return Promise.resolve()
      if (verificationFlight) return verificationFlight
      if (mutationLocked) return Promise.reject(appError('OPERATION_FAILED'))
      mutationLocked = true
      const expectedVersion = runtime.version
      const expectedRoot = runtime.root
      const task = (async () => {
        let audited = await auditTree(expectedRoot, expectedVersion)
        if (!audited && expectedRoot === options.bundledRoot) audited = await auditTree(activeRoot, expectedVersion)
        if (disposed) throw appError('OPERATION_FAILED')
        if (!audited) {
          runtime = undefined
          runtimeVerified = false
          publish({
            source: descriptor.source,
            status: 'failed',
            installedVersion: null,
            availableVersion: descriptor.version,
            progress: null,
            errorCode: 'DOCUMENT_CONVERSION_COMPONENT_INVALID',
            busy: false,
          })
          throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
        }
        runtime = audited
        runtimeVerified = true
        if (options.bundledRoot && Boolean(currentState.bundled) !== isBundled()) {
          publish({ ...publicationFrom(currentState), bundled: isBundled() })
        }
      })().finally(() => {
        mutationLocked = false
        if (verificationFlight === task) verificationFlight = undefined
      })
      verificationFlight = task
      return task
    },
    install(ownerId) {
      if (disposed || mutationLocked || typeof ownerId !== 'string' || !ownerId.trim() || leaseTokens.size > 0) {
        return Promise.reject(appError('OPERATION_FAILED'))
      }
      if (runtime?.version === descriptor.version && currentState.status === 'installed') {
        return Promise.resolve(currentState)
      }
      if (flight) {
        const existing = flight.owners.get(ownerId)
        if (existing) return existing.promise
        const request = deferredOwner()
        flight.owners.set(ownerId, request)
        flight.requests.add(request)
        return request.promise
      }
      const request = deferredOwner()
      const controller = new AbortController()
      const activeFlight: InstallFlight = {
        controller,
        owners: new Map([[ownerId, request]]),
        requests: new Set([request]),
        baseline: currentState,
        task: Promise.resolve(),
      }
      flight = activeFlight
      publish({
        source: descriptor.source,
        status: 'installing',
        installedVersion: runtime?.version ?? null,
        availableVersion: descriptor.version,
        progress: {
          phase: descriptor.source === 'https' ? 'downloading' : 'reading',
          receivedBytes: 0,
          totalBytes: descriptor.bytes,
        },
        errorCode: null,
        busy: true,
      })
      activeFlight.task = trackMutation(performInstall(activeFlight))
      return request.promise
    },
    cancelInstall(ownerId) {
      const activeFlight = flight
      const request = activeFlight?.owners.get(ownerId)
      if (!activeFlight || !request) return Promise.resolve(currentState)
      activeFlight.owners.delete(ownerId)
      if (activeFlight.owners.size === 0) activeFlight.controller.abort()
      else request.resolve(currentState)
      return request.promise
    },
    remove() {
      if (disposed || flight || mutationLocked || leaseTokens.size > 0 || isBundled()) {
        return Promise.reject(appError('OPERATION_FAILED'))
      }
      mutationLocked = true
      const transactionRoot = path.join(stagingRoot, randomUUID())
      const removalRoot = path.join(transactionRoot, 'removed')
      return trackMutation((async () => {
        try {
          const activeExists = await pathExists(activeRoot)
          if (disposed) throw new Error('Document conversion component manager is disposed')
          if (!activeExists) {
            runtime = undefined
            runtimeVerified = false
            return publish({
              source: descriptor.source, status: 'absent', installedVersion: null,
              availableVersion: descriptor.version, progress: null, errorCode: null, busy: false,
            })
          }
          await mkdir(transactionRoot, { recursive: true })
          if (disposed) throw new Error('Document conversion component manager is disposed')
          await rename(activeRoot, removalRoot)
          await removeOwned(removalRoot)
          runtime = undefined
          runtimeVerified = false
          return publish({
            source: descriptor.source, status: 'absent', installedVersion: null,
            availableVersion: descriptor.version, progress: null, errorCode: null, busy: false,
          })
        } catch {
          if (!await pathExists(activeRoot) && await pathExists(removalRoot)) {
            await rename(removalRoot, activeRoot).catch(() => undefined)
          }
          runtime = await auditTree(activeRoot)
          runtimeVerified = Boolean(runtime)
          throw appError('OPERATION_FAILED')
        } finally {
          mutationLocked = false
          await removeOwned(transactionRoot).catch(() => undefined)
        }
      })())
    },
    resolveRuntime() {
      return disposed ? undefined : runtime
    },
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
      }
    },
    acquireLease() {
      if (disposed || mutationLocked || !runtime || !runtimeVerified) throw appError('OPERATION_FAILED')
      const leasedRuntime = runtime
      const token = Symbol('document-conversion-lease')
      const firstLease = leaseTokens.size === 0
      leaseTokens.add(token)
      if (firstLease && !currentState.busy
        && (currentState.status === 'installed' || currentState.status === 'update-available')) {
        publish({ ...publicationFrom(currentState), busy: true })
      }
      let released = false
      return Object.freeze({
        runtime: leasedRuntime,
        release() {
          if (released) return
          released = true
          if (!leaseTokens.delete(token) || leaseTokens.size !== 0 || disposed
            || !currentState.busy
            || (currentState.status !== 'installed'
              && currentState.status !== 'update-available')) return
          publish({ ...publicationFrom(currentState), busy: false })
        },
      })
    },
    dispose() {
      disposePromise ??= (async () => {
        disposed = true
        listeners.clear()
        flight?.owners.clear()
        flight?.controller.abort()
        const pendingMutation = activeMutation ?? flight?.task
        await Promise.allSettled([
          ...(pendingMutation ? [pendingMutation] : []),
          ...(verificationFlight ? [verificationFlight] : []),
        ])
        leaseTokens.clear()
        await cleanDirectoryChildren(stagingRoot)
      })()
      return disposePromise
    },
  }
  return manager
}
