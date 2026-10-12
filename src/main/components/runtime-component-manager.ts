import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename as renameFile, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { createGunzip } from 'node:zlib'
import * as tar from 'tar'
import { GitHubReleaseArtifactSource, type ComponentArtifactSource } from '../document-conversion/component-artifact-source'
import { parseDocumentConversionComponentDescriptor } from '../../shared/document-conversion'
import { PublicError } from '../../shared/public-errors'
import type { RuntimeComponentDefinition, RuntimeComponentState } from '../../shared/runtime-component'

const MANIFEST = 'component-manifest.json'
const MAX_ARCHIVE_BYTES = 1024 ** 3
const MAX_TREE_BYTES = 2 * 1024 ** 3
const MAX_FILE_BYTES = 512 * 1024 ** 2
const MAX_MANIFEST_BYTES = 8 * 1024 ** 2
const MAX_ENTRIES = 20_000
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const INVALID = '组件校验失败，请重新下载安装'
const INSTALL_FAILED = '组件安装失败，请重试'
const DOWNLOAD_FAILED = '组件下载失败，请检查网络连接后重试'

interface TreeFile { path: string; bytes: number; sha256: string }

function invalid(): Error { return new Error(INVALID) }
function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}
function safeName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 1000 || !value || value.includes('\\')) return false
  return value.split('/').every((part) => part.length > 0 && part.length <= 255
    && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f<>:"|?*]/u.test(part)
    && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part))
}
function allowedName(value: string): boolean { return safeName(value) }
function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}
function parseTree(value: unknown, version: string, entry: string): TreeFile[] {
  if (!exactRecord(value, ['schemaVersion', 'version', 'entry', 'files'])
    || value.schemaVersion !== 1 || value.version !== version || value.entry !== entry
    || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_ENTRIES) throw invalid()
  const files: TreeFile[] = []
  const names = new Set<string>()
  let totalBytes = 0
  for (const file of value.files) {
    if (!exactRecord(file, ['path', 'bytes', 'sha256']) || !safeName(file.path)
      || !allowedName(file.path) || file.path === MANIFEST
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > MAX_FILE_BYTES
      || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(file.sha256)) throw invalid()
    const key = file.path.toLowerCase()
    if (names.has(key)) throw invalid()
    names.add(key)
    totalBytes += file.bytes as number
    if (totalBytes > MAX_TREE_BYTES) throw invalid()
    files.push({ path: file.path, bytes: file.bytes as number, sha256: file.sha256 })
  }
  if (!files.some((file) => file.path === entry && file.bytes > 0)) throw invalid()
  return files
}
async function exists(target: string): Promise<boolean> {
  try { await lstat(target); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
async function checkPath(target: string, directory: boolean): Promise<void> {
  const info = await lstat(target)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())
    || (!directory && info.nlink !== 1)
    || !samePath(await realpath(target), path.resolve(target))) throw invalid()
}
async function ensureDirectory(target: string): Promise<void> {
  if (!await exists(target)) {
    await ensureDirectory(path.dirname(target))
    await mkdir(target)
  }
  await checkPath(target, true)
}
async function hashFile(target: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(target, { highWaterMark: 64 * 1024, signal })) {
    signal?.throwIfAborted()
    digest.update(chunk)
  }
  return digest.digest('hex')
}
function failureMessage(error: unknown): string {
  if (error instanceof PublicError) {
    if (error.code === 'DOCUMENT_CONVERSION_DOWNLOAD_FAILED') return DOWNLOAD_FAILED
    if (error.code === 'DOCUMENT_CONVERSION_COMPONENT_INVALID') return INVALID
  }
  return error instanceof Error && error.message === INVALID ? INVALID : INSTALL_FAILED
}

/** Streaming limits also cover tar padding and metadata, not only declared file sizes. */
async function unpack(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  let inflatedBytes = 0
  let declaredBytes = 0
  let unsafe = false
  const names = new Set<string>()
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      inflatedBytes += chunk.length
      callback(unsafe || inflatedBytes > MAX_TREE_BYTES + MAX_MANIFEST_BYTES + MAX_ENTRIES * 2048 ? invalid() : null, chunk)
    },
  })
  const extractor = tar.x({
    cwd: destination, strict: true, preservePaths: false, maxMetaEntrySize: 64 * 1024,
    filter(raw, entry) {
      if (unsafe) return false
      const name = raw.endsWith('/') ? raw.slice(0, -1) : raw
      const key = name.toLowerCase()
      const size = entry.size ?? 0
      const isFile = 'type' in entry && ['File', 'OldFile'].includes(entry.type)
      const isDirectory = 'type' in entry && entry.type === 'Directory'
      const allowed = !signal.aborted && !unsafe && 'path' in entry && entry.path === raw
        && allowedName(name) && !names.has(key) && names.size < MAX_ENTRIES
        && 'linkpath' in entry && !entry.linkpath && (isFile || isDirectory)
        && Number.isSafeInteger(size) && size >= 0
        && size <= (name === MANIFEST ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES)
        && (!isDirectory || (size === 0 && name !== MANIFEST))
      names.add(key)
      declaredBytes += size
      if (!allowed || declaredBytes > MAX_TREE_BYTES + MAX_MANIFEST_BYTES) unsafe = true
      return !unsafe
    },
  })
  try {
    await pipeline(createReadStream(archive), createGunzip(), limiter, extractor, { signal })
    if (unsafe) throw invalid()
  } catch (error) {
    if (signal.aborted) throw signal.reason
    // Tar diagnostics include entry names and local paths; keep them internal.
    if (unsafe || !(error as NodeJS.ErrnoException).code?.match(/^(?:ENOSPC|EACCES|EPERM|EIO)$/u)) throw invalid()
    throw error
  }
}

export interface RuntimeComponentManager {
  getState(): RuntimeComponentState
  subscribe(listener: (state: RuntimeComponentState) => void): () => void
  install(): Promise<void>
  cancel(): Promise<void>
  ensureRuntime(): Promise<string | undefined>
  dispose(): Promise<void>
}

export interface RuntimeComponentManagerOptions {
  dataRoot: string
  definition: RuntimeComponentDefinition
  bundledRoot?: string
  artifactSource?: ComponentArtifactSource
  /** Filesystem operation seam for deterministic activation/rollback failure tests. */
  rename?(from: string, to: string): Promise<void>
}

export async function createRuntimeComponentManager(
  options: RuntimeComponentManagerOptions,
): Promise<RuntimeComponentManager> {
  const rename = options.rename ?? renameFile
  const descriptor = parseDocumentConversionComponentDescriptor(options.definition.descriptor)
  if (!descriptor || descriptor.source !== 'https' || descriptor.bytes > MAX_ARCHIVE_BYTES
    || !safeName(descriptor.archiveName) || descriptor.archiveName.includes('/')) throw invalid()
  const treeManifestSha256 = options.definition.treeManifestSha256
  if (!/^[0-9a-f]{64}$/u.test(treeManifestSha256)) throw invalid()
  const artifactSource = options.artifactSource ?? new GitHubReleaseArtifactSource(
    descriptor, (descriptor.url as string).slice(0, (descriptor.url as string).lastIndexOf('/') + 1),
  )
  if (artifactSource.kind !== descriptor.source) throw invalid()
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(options.definition.id) || !safeName(options.definition.entry)) throw invalid()
  const ENTRY = options.definition.entry
  const componentRoot = path.resolve(options.dataRoot, 'components', options.definition.id)
  const activeRoot = path.join(componentRoot, 'active')
  const stagingRoot = path.join(componentRoot, 'staging')
  const backupRoot = path.join(componentRoot, 'backup')
  try {
    await ensureDirectory(componentRoot)
    await ensureDirectory(stagingRoot)
    await ensureDirectory(backupRoot)
  } catch { throw invalid() }

  const removeOwned = async (target: string): Promise<void> => {
    const relative = path.relative(componentRoot, target)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw invalid()
    await checkPath(path.dirname(target), true)
    if (!await exists(target)) return
    const info = await lstat(target)
    if (info.isSymbolicLink()) { await unlink(target); return }
    if (info.isDirectory()) {
      await checkPath(target, true)
      for (const name of await readdir(target)) await removeOwned(path.join(target, name))
      await rm(target, { recursive: true })
    } else { await unlink(target) }
  }
  // Only this component's staging area is owned; completed installations survive closing.
  try {
    for (const name of await readdir(stagingRoot)) await removeOwned(path.join(stagingRoot, name))
  } catch { throw new Error(INSTALL_FAILED) }

  const audit = async (root: string, signal?: AbortSignal): Promise<string | undefined> => {
    try {
      signal?.throwIfAborted()
      await checkPath(root, true)
      const manifestPath = path.join(root, MANIFEST)
      await checkPath(manifestPath, false)
      if ((await lstat(manifestPath)).size > MAX_MANIFEST_BYTES) throw invalid()
      const manifestBytes = await readFile(manifestPath)
      if (manifestBytes.length > MAX_MANIFEST_BYTES
        || createHash('sha256').update(manifestBytes).digest('hex') !== treeManifestSha256) throw invalid()
      const files = parseTree(JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/u, '')), descriptor.version, ENTRY)
      const expected = new Map(files.map((file) => [file.path, file]))
      const expectedDirectories = new Set(files.flatMap((file) => {
        const parts = file.path.split('/')
        return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'))
      }))
      let entryCount = 0
      const visit = async (directory: string): Promise<void> => {
        signal?.throwIfAborted()
        await checkPath(directory, true)
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (++entryCount > MAX_ENTRIES) throw invalid()
          signal?.throwIfAborted()
          const absolute = path.join(directory, entry.name)
          const relative = path.relative(root, absolute).split(path.sep).join('/')
          if (!allowedName(relative) || entry.isSymbolicLink()) throw invalid()
          if (entry.isDirectory()) {
            if (!expectedDirectories.delete(relative)) throw invalid()
            await visit(absolute)
          } else {
            await checkPath(absolute, false)
            if (relative === MANIFEST) continue
            const file = expected.get(relative)
            if (!file || (await lstat(absolute)).size !== file.bytes) throw invalid()
            if (await hashFile(absolute, signal) !== file.sha256) throw invalid()
            await checkPath(absolute, false)
            if ((await lstat(absolute)).size !== file.bytes) throw invalid()
            expected.delete(relative)
          }
        }
      }
      await visit(root)
      if (expected.size || expectedDirectories.size) throw invalid()
      signal?.throwIfAborted()
      return path.join(root, ENTRY)
    } catch { return undefined }
  }

  // A failed rollback must never destroy its sole old tree. Recover only a
  // fully verified current-version backup; unknown/corrupt backups stay put.
  try {
    if (!await exists(activeRoot)) {
      const backups = (await readdir(backupRoot)).filter((name) => UUID_NAME.test(name)).sort()
      if (backups.length <= 32) for (const name of backups) {
        const backup = path.join(backupRoot, name)
        if (!await audit(backup)) continue
        await checkPath(componentRoot, true)
        await rename(backup, activeRoot)
        break
      }
    }
  } catch { throw new Error(INSTALL_FAILED) }

  const auditAvailable = async (signal?: AbortSignal): Promise<string | undefined> => {
    const bundled = options.bundledRoot ? await audit(options.bundledRoot, signal) : undefined
    return bundled ?? await audit(activeRoot, signal)
  }

  const listeners = new Set<(state: RuntimeComponentState) => void>()
  let disposed = false
  let flight: { controller: AbortController; promise: Promise<void> } | undefined
  let verification: Promise<string | undefined> | undefined
  let disposePromise: Promise<void> | undefined
  let current: RuntimeComponentState
  const publish = (status: RuntimeComponentState['status'], progress: RuntimeComponentState['progress'] = null, error: string | null = null): void => {
    current = Object.freeze({ status, version: descriptor.version, downloadBytes: descriptor.bytes,
      progress: progress ? Object.freeze({ ...progress }) : null,
      error: error?.replace(/^组件/u, options.definition.label) ?? null })
    if (!disposed) for (const listener of [...listeners]) {
      try { listener(current) } catch { /* Observers cannot interrupt installation. */ }
    }
  }
  publish(await auditAvailable() ? 'installed' : 'absent')

  const activateTree = async (tree: string, signal: AbortSignal): Promise<void> => {
    const identity = await lstat(tree)
    const deadline = Date.now() + 5_000
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted()
      await checkPath(componentRoot, true)
      await checkPath(path.dirname(tree), true)
      await checkPath(tree, true)
      const currentIdentity = await lstat(tree)
      if (currentIdentity.dev !== identity.dev || currentIdentity.ino !== identity.ino
        || await exists(activeRoot)) throw invalid()
      signal.throwIfAborted()
      try { await rename(tree, activeRoot); return } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        const remaining = deadline - Date.now()
        // Windows may briefly retain a newly extracted executable. Keep the verified tree
        // and retry activation only; permanent failures still retain the previous backup.
        if (attempt >= 25 || remaining <= 0 || (code !== 'EPERM' && code !== 'EACCES')) throw error
        await delay(Math.min(200, remaining), undefined, { signal })
      }
    }
  }

  const install = async (controller: AbortController): Promise<void> => {
    const { signal } = controller
    const transaction = path.join(stagingRoot, randomUUID())
    const tree = path.join(transaction, 'tree')
    const archive = path.join(transaction, descriptor.archiveName)
    const previous = path.join(backupRoot, randomUUID())
    let oldMoved = false
    let activated = false
    try {
      if (verification) await verification
      signal.throwIfAborted()
      if (await auditAvailable(signal)) { publish('installed'); return }
      signal.throwIfAborted()
      await ensureDirectory(tree)
      await artifactSource.copyTo(archive, signal, (progress) => {
        if (!signal.aborted) publish('installing', { ...progress, phase: 'downloading' })
      })
      signal.throwIfAborted()
      publish('installing', { phase: 'verifying', receivedBytes: descriptor.bytes, totalBytes: descriptor.bytes })
      await checkPath(archive, false)
      if ((await lstat(archive)).size !== descriptor.bytes || await hashFile(archive, signal) !== descriptor.sha256) throw invalid()
      signal.throwIfAborted()
      publish('installing', { phase: 'extracting', receivedBytes: 0, totalBytes: descriptor.bytes })
      await unpack(archive, tree, signal)
      if (!await audit(tree, signal)) throw invalid()
      signal.throwIfAborted()
      if (disposed) throw signal.reason ?? invalid()
      await checkPath(componentRoot, true)
      if (await exists(activeRoot)) {
        // Do not rename through a substituted parent or external target.
        await checkPath(activeRoot, true)
        await checkPath(backupRoot, true)
        await rename(activeRoot, previous)
        oldMoved = true
      }
      await activateTree(tree, signal)
      activated = true
      // Cancellation after atomic activation keeps the completed, verified installation.
      publish('installed')
      if (oldMoved) await removeOwned(previous).catch(() => undefined)
    } catch (error) {
      if (!activated && oldMoved) {
        try { if (!await exists(activeRoot)) await rename(previous, activeRoot) }
        catch { /* Retain the backup outside staging for a later recovery. */ }
      }
      if (signal.aborted) publish(await auditAvailable() ? 'installed' : 'absent')
      else publish('failed', null, failureMessage(error))
    } finally {
      await removeOwned(transaction).catch(() => undefined)
    }
  }

  const manager: RuntimeComponentManager = {
    getState: () => current,
    subscribe(listener) {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    install() {
      if (disposed) return Promise.resolve()
      if (flight) return flight.promise
      const controller = new AbortController()
      // Defer work until the flight exists, including synchronous observer callbacks.
      const promise = Promise.resolve().then(() => install(controller)).finally(() => {
        if (flight?.promise === promise) flight = undefined
      })
      flight = { controller, promise }
      publish('installing', { phase: 'downloading', receivedBytes: 0, totalBytes: descriptor.bytes })
      return promise
    },
    async cancel() {
      const pending = flight
      pending?.controller.abort()
      await pending?.promise
    },
    ensureRuntime() {
      if (disposed) return Promise.resolve(undefined)
      if (flight) return current.status === 'installed'
        ? flight.promise.then(() => manager.ensureRuntime()) : Promise.resolve(undefined)
      if (verification) return verification
      const promise = auditAvailable().then((runtime) => {
        if (disposed || flight) return undefined
        if (runtime) { if (current.status !== 'installed') publish('installed') }
        else if (current.status === 'installed') publish('failed', null, INVALID)
        return runtime
      }).finally(() => { if (verification === promise) verification = undefined })
      verification = promise
      return promise
    },
    dispose() {
      disposePromise ??= (async () => {
        disposed = true
        listeners.clear()
        await manager.cancel()
        await verification
      })()
      return disposePromise
    },
  }
  return manager
}
