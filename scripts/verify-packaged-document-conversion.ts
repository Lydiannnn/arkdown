import { spawn as spawnChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, realpathSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  DocumentConversionComponentDescriptor,
  DocumentConversionFormat,
} from '../src/shared/document-conversion.ts'
import type {
  MarkItDownSpawn,
  MarkItDownSpawnedChild,
  MarkItDownSpawnOptions,
} from '../src/main/document-conversion/markitdown-runner.ts'

const ENTRY_USAGE = 'Usage: verify-packaged-document-conversion --package-root <absolute-path> --sample-root <absolute-path>\n'
const SHA256 = /^[0-9a-f]{64}$/u
const WAIT_TIMEOUT_MS = 30_000
const EPUB_FIXTURE_GENERATOR_TIMEOUT_MS = 30_000
const TEMPORARY_ROOT_ALLOCATION_COUNT = 4

interface AuthorizedSample {
  id: 'pdf-1' | 'pdf-2' | 'pdf-3' | 'pptx-1' | 'pptx-2' | 'xlsx-1' | 'xlsx-large'
  format: Exclude<DocumentConversionFormat, 'epub'>
  relativePath: string
  relativeNameSha256: string
}

const AUTHORIZED_SAMPLES: readonly AuthorizedSample[] = Object.freeze([
  { id: 'pdf-1', format: 'pdf', relativePath: '爱员工offer letter-杨鹏飞.pdf', relativeNameSha256: 'aa87f500583ca0b85d7163c54a4412e251bf1887d8823eda1e54049acb948df3' },
  { id: 'pdf-2', format: 'pdf', relativePath: '个人简历(1).pdf', relativeNameSha256: '6374565a7336f494993bee9683b442b3bc73d872c8cd267f91cb0c836b3af7db' },
  { id: 'pdf-3', format: 'pdf', relativePath: 'assets/weekly_report_2026_0706_0710.pdf', relativeNameSha256: '0a0b5ff98c4f34a0d7f4dd7750307f36c5878508131bdb5751dd2035e7a97ed4' },
  { id: 'pptx-1', format: 'pptx', relativePath: '车管家咨询服务讨论案.pptx', relativeNameSha256: 'a87524f0a468e60af20d9630d0c00683f6c320b9f628478b98e1b4a162ddc28c' },
  { id: 'pptx-2', format: 'pptx', relativePath: 'DirectX_11_Technology_Update_US.pptx', relativeNameSha256: 'ace1c76cd2e6975a8d1f2314e82f0bf9fcc4525bf602a5cb52e6ac038c6957af' },
  { id: 'xlsx-1', format: 'xlsx', relativePath: '模板规则速查表.xlsx', relativeNameSha256: '897bd7e5ca02f5782aba8d3131e989c51fb48f180da537713fedd835cc7a85bf' },
  { id: 'xlsx-large', format: 'xlsx', relativePath: '吉香居资料.xlsx', relativeNameSha256: 'ac390cf33e6524c93bc6fcc92a4aa1f960ced941e3a3dd99e54ef05192b1ca9c' },
])

interface SourceIdentity {
  bytes: number
  mtimeNs: string
  sha256: string
}

interface StructuralCounts {
  bytes: number
  characters: number
  headings: number
  listItems: number
  tableRows: number
  replacementCharacters: number
}

export interface PackagedDocumentConversionSampleReport {
  id: AuthorizedSample['id'] | 'epub-1'
  format: DocumentConversionFormat
  sourceBefore: SourceIdentity
  sourceAfter: SourceIdentity
  coldElapsedMs: number
  warmElapsedMs: number
  coldSpawnCount: number
  warmSpawnCount: number
  cacheReused: boolean
  fingerprint: string
  outputSha256: string
  structure: StructuralCounts
}

export interface PackagedDocumentConversionVerificationReport {
  schemaVersion: 1
  component: {
    initialStatus: 'absent'
    installedStatus: 'installed'
    removedStatus: 'absent'
    reinstalledStatus: 'installed'
    version: string
  }
  samples: PackagedDocumentConversionSampleReport[]
  sourceModification: {
    id: 'modified-copy'
    beforeFingerprint: string
    afterFingerprint: string
    invalidated: true
    spawnCount: 2
  }
  cancellation: {
    id: 'xlsx-large-cancel-copy'
    cancelled: true
    childKilled: boolean
    taskDirectoriesRemaining: number
  }
  removal: {
    activeRemaining: boolean
    backupEntriesRemaining: number
    stagingEntriesRemaining: number
  }
  shutdown: {
    drained: boolean
    childKilled: boolean
    leaseReleased: boolean
    taskDirectoriesRemaining: number
  }
  timeoutBoundsMs: Readonly<Record<DocumentConversionFormat, number>>
  cleanup: {
    pythonChildrenRemaining: number
    harnessRootsRemaining: number
  }
}

export interface VerifyPackagedDocumentConversionOptions {
  packageRoot: string
  sampleRoot: string
  repositoryRoot: string
  tempParent?: string
  descriptor?: DocumentConversionComponentDescriptor
  spawn?: MarkItDownSpawn
  fixtureGeneratorTimeoutMs?: number
  cleanupTimeoutMs?: number
  failTemporaryRootAllocationAt?: number
}

interface ProductionModules {
  PackagedArtifactSource: typeof import('../src/main/document-conversion/component-artifact-source.ts').PackagedArtifactSource
  CosComponentArtifactSource: typeof import('../src/main/document-conversion/component-artifact-source.ts').CosComponentArtifactSource
  releaseBaseUrl: string
  createDocumentConversionComponentManager: typeof import('../src/main/document-conversion/component-manager.ts').createDocumentConversionComponentManager
  createMarkItDownRunner: typeof import('../src/main/document-conversion/markitdown-runner.ts').createMarkItDownRunner
  DocumentConversionService: typeof import('../src/main/document-conversion/document-conversion-service.ts').DocumentConversionService
  createDocumentConversionRuntimeLifecycle: typeof import('../src/main/document-conversion/document-conversion-lifecycle.ts').createDocumentConversionRuntimeLifecycle
  descriptor: DocumentConversionComponentDescriptor
  documentConversionTimeoutMs: typeof import('../src/shared/document-conversion.ts').documentConversionTimeoutMs
}

let productionModules: Promise<ProductionModules> | undefined

async function loadProductionModules(): Promise<ProductionModules> {
  productionModules ??= Promise.all([
    import('../src/main/document-conversion/component-artifact-source.ts'),
    import('../src/main/document-conversion/component-manager.ts'),
    import('../src/main/document-conversion/markitdown-runner.ts'),
    import('../src/main/document-conversion/document-conversion-service.ts'),
    import('../src/main/document-conversion/document-conversion-lifecycle.ts'),
    import('../src/shared/document-conversion-component-manifest.ts'),
    import('../src/shared/document-conversion.ts'),
  ]).then(([artifactSource, componentManager, runner, service, lifecycle, manifest, shared]) => ({
    PackagedArtifactSource: artifactSource.PackagedArtifactSource,
    CosComponentArtifactSource: artifactSource.CosComponentArtifactSource,
    releaseBaseUrl: manifest.DOCUMENT_CONVERSION_COMPONENT_RELEASE_BASE_URL,
    createDocumentConversionComponentManager: componentManager.createDocumentConversionComponentManager,
    createMarkItDownRunner: runner.createMarkItDownRunner,
    DocumentConversionService: service.DocumentConversionService,
    createDocumentConversionRuntimeLifecycle: lifecycle.createDocumentConversionRuntimeLifecycle,
    descriptor: manifest.DOCUMENT_CONVERSION_COMPONENT_MANIFEST,
    documentConversionTimeoutMs: shared.documentConversionTimeoutMs,
  }))
  return productionModules
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

function equalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

async function sourceIdentity(filePath: string): Promise<SourceIdentity> {
  const before = await lstat(filePath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || !equalPath(await realpath(filePath), path.resolve(filePath))) {
    throw new Error('authorized_sample_set_mismatch')
  }
  const digest = await sha256File(filePath)
  const after = await lstat(filePath, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink()
    || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error('authorized_sample_changed_during_identity_read')
  }
  const bytes = Number(after.size)
  if (!Number.isSafeInteger(bytes)) throw new Error('authorized_sample_set_mismatch')
  return { bytes, mtimeNs: after.mtimeNs.toString(), sha256: digest }
}

function sameIdentity(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.bytes === right.bytes && left.mtimeNs === right.mtimeNs && left.sha256 === right.sha256
}

async function resolveAuthorizedSamples(sampleRoot: string): Promise<Array<AuthorizedSample & {
  sourcePath: string
  before: SourceIdentity
}>> {
  const root = path.resolve(sampleRoot)
  const rootMetadata = await lstat(root)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || !equalPath(await realpath(root), root)) {
    throw new Error('authorized_sample_set_mismatch')
  }
  return await Promise.all(AUTHORIZED_SAMPLES.map(async (sample) => {
    if (sha256Bytes(sample.relativePath.normalize('NFC')) !== sample.relativeNameSha256) {
      throw new Error('authorized_sample_identity_configuration_invalid')
    }
    const sourcePath = path.resolve(root, ...sample.relativePath.split('/'))
    const relative = path.relative(root, sourcePath)
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('authorized_sample_set_mismatch')
    }
    return { ...sample, sourcePath, before: await sourceIdentity(sourcePath) }
  }))
}

function structuralCounts(markdown: string): StructuralCounts {
  const lines = markdown.split(/\r?\n/u)
  return {
    bytes: Buffer.byteLength(markdown, 'utf8'),
    characters: [...markdown].length,
    headings: lines.filter((line) => /^#{1,6}\s+\S/u.test(line)).length,
    listItems: lines.filter((line) => /^\s*(?:[-+*]|\d+[.)])\s+\S/u.test(line)).length,
    tableRows: lines.filter((line) => /^\s*\|.*\|\s*$/u.test(line)).length,
    replacementCharacters: [...markdown].filter((character) => character === '\uFFFD').length,
  }
}

interface SpawnRecord {
  child: MarkItDownSpawnedChild
  inputPath?: string
  killed: boolean
  sequence: number
}

export function createTrackedSpawn(
  baseSpawn?: MarkItDownSpawn,
  waitTimeoutMs = WAIT_TIMEOUT_MS,
): {
  spawn: MarkItDownSpawn
  activeCount(): number
  conversionCount(inputPath: string): number
  killActive(): void
  waitForConversion(inputPath: string, afterCount: number): Promise<SpawnRecord>
  waitForIdle(): Promise<void>
} {
  const actualSpawn: MarkItDownSpawn = baseSpawn ?? ((command, args, options) => (
    spawnChild(command, [...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'] }) as MarkItDownSpawnedChild
  ))
  const active = new Set<SpawnRecord>()
  const records: SpawnRecord[] = []
  const killAttempts = new Map<SpawnRecord, Array<{
    signal: NodeJS.Signals | number
    accepted?: boolean
    closeObserved: boolean
  }>>()
  const waiters = new Set<{
    inputPath: string
    afterCount: number
    resolve(record: SpawnRecord): void
  }>()
  let sequence = 0
  const normalized = (value: string): string => process.platform === 'win32'
    ? path.resolve(value).toLocaleLowerCase('en-US')
    : path.resolve(value)
  const inputFrom = (args: readonly string[]): string | undefined => {
    const index = args.indexOf('--input')
    return index >= 0 && typeof args[index + 1] === 'string' ? normalized(args[index + 1]!) : undefined
  }
  const conversionCount = (inputPath: string): number => {
    const target = normalized(inputPath)
    return records.filter((record) => record.inputPath === target).length
  }
  const requestKill = (record: SpawnRecord, signal?: NodeJS.Signals | number): boolean => {
    const attempt = {
      signal: signal ?? 'SIGTERM',
      accepted: undefined as boolean | undefined,
      closeObserved: false,
    }
    killAttempts.get(record)?.push(attempt)
    try {
      attempt.accepted = record.child.kill(signal)
      if (attempt.accepted && attempt.closeObserved) record.killed = true
      return attempt.accepted
    } catch {
      attempt.accepted = false
      return false
    }
  }
  return {
    spawn(command, args, options) {
      const child = actualSpawn(command, args, options)
      const record: SpawnRecord = {
        child,
        inputPath: inputFrom(args),
        killed: false,
        sequence: ++sequence,
      }
      records.push(record)
      active.add(record)
      killAttempts.set(record, [])
      child.once('error', () => {
        if (typeof (child as MarkItDownSpawnedChild & { pid?: number }).pid !== 'number') {
          active.delete(record)
        }
      })
      child.once('close', (_code, signal) => {
        active.delete(record)
        if (signal === null) return
        for (const attempt of killAttempts.get(record) ?? []) {
          if (typeof attempt.signal !== 'string' || attempt.signal !== signal) continue
          attempt.closeObserved = true
          if (attempt.accepted === true) record.killed = true
        }
      })
      const wrapper: MarkItDownSpawnedChild = {
        stdout: child.stdout,
        stderr: child.stderr,
        once(event, listener) {
          if (event === 'error') child.once('error', listener as (error: Error) => void)
          else child.once('close', listener as (code: number | null, signal: NodeJS.Signals | null) => void)
          return wrapper
        },
        kill(signal) {
          return requestKill(record, signal)
        },
      }
      for (const waiter of [...waiters]) {
        if (record.inputPath === waiter.inputPath
          && conversionCount(waiter.inputPath) > waiter.afterCount) {
          waiters.delete(waiter)
          waiter.resolve(record)
        }
      }
      return wrapper
    },
    activeCount: () => active.size,
    conversionCount,
    killActive() {
      for (const record of active) {
        requestKill(record, 'SIGTERM')
      }
    },
    waitForIdle: async () => {
      await waitUntil(() => active.size === 0, 'python_child_cleanup', waitTimeoutMs)
    },
    async waitForConversion(inputPath, afterCount) {
      const target = normalized(inputPath)
      const existing = records.find((record) => record.inputPath === target && record.sequence > 0)
      if (existing && conversionCount(target) > afterCount) {
        return records.filter((record) => record.inputPath === target).at(-1)!
      }
      return await new Promise<SpawnRecord>((resolve, reject) => {
        const waiter = { inputPath: target, afterCount, resolve }
        waiters.add(waiter)
        const timeout = setTimeout(() => {
          waiters.delete(waiter)
          reject(new Error('conversion_spawn_wait_timeout'))
        }, waitTimeoutMs)
        const originalResolve = waiter.resolve
        waiter.resolve = (record) => {
          clearTimeout(timeout)
          originalResolve(record)
        }
      })
    },
  }
}

async function runFixtureGenerator(options: {
  destination: string
  repositoryRoot: string
  runtime: { pythonExecutable: string; root: string }
  spawn: MarkItDownSpawn
  timeoutMs: number
}): Promise<void> {
  const script = path.resolve(options.repositoryRoot, 'scripts', 'markitdown', 'create_epub_fixture.py')
  const scriptMetadata = await lstat(script)
  if (!scriptMetadata.isFile() || scriptMetadata.isSymbolicLink()) throw new Error('epub_fixture_generator_missing')
  await new Promise<void>((resolve, reject) => {
    const child = options.spawn(options.runtime.pythonExecutable, ['-I', script, options.destination], {
      cwd: options.runtime.root,
      windowsHide: true,
      shell: false,
      env: {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONDONTWRITEBYTECODE: '1',
      },
    })
    child.stdout.resume()
    child.stderr.resume()
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error('epub_fixture_generation_timeout'))
    }, options.timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error('epub_fixture_generation_failed'))
    })
  })
  await sourceIdentity(options.destination)
}

async function directoryEntries(root: string): Promise<number> {
  try { return (await readdir(root)).length } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

async function pathExists(target: string): Promise<boolean> {
  try { await lstat(target); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`${label}_timeout`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface VerifierTemporaryRoots {
  runRoot: string
  userData: string
  taskRoot: string
  copiesRoot: string
}

async function allocateVerifierTemporaryRoots(
  tempParent: string,
  failTemporaryRootAllocationAt?: number,
): Promise<VerifierTemporaryRoots> {
  const ownedRoots: string[] = []
  let allocationIndex = 0
  const allocate = async (prefix: string): Promise<string> => {
    allocationIndex += 1
    if (allocationIndex === failTemporaryRootAllocationAt) {
      throw new Error('injected_temporary_root_allocation_failure')
    }
    const created = path.resolve(await mkdtemp(prefix))
    const expectedParent = path.dirname(prefix)
    const expectedPrefix = path.basename(prefix)
    const actualName = path.basename(created)
    const prefixMatches = process.platform === 'win32'
      ? actualName.toLocaleLowerCase('en-US').startsWith(expectedPrefix.toLocaleLowerCase('en-US'))
      : actualName.startsWith(expectedPrefix)
    const relative = path.relative(path.resolve(expectedParent), created)
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative) || !prefixMatches) {
      throw new Error('invalid_temporary_root')
    }
    ownedRoots.push(created)
    const metadata = await lstat(created)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('invalid_temporary_root')
    return created
  }
  try {
    const runRoot = await allocate(path.join(tempParent, 'arkdown-packaged-doc-verifier-'))
    const userData = await allocate(path.join(runRoot, 'user-data-'))
    const taskRoot = await allocate(path.join(runRoot, 'tasks-'))
    const copiesRoot = await allocate(path.join(runRoot, 'copies-'))
    if (new Set([userData, taskRoot, copiesRoot]).size !== 3) {
      throw new Error('temporary_root_collision')
    }
    return { runRoot, userData, taskRoot, copiesRoot }
  } catch (error) {
    let cleanupFailed = false
    for (const ownedRoot of ownedRoots.reverse()) {
      try {
        await rm(ownedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch {
        cleanupFailed = true
      }
    }
    throw new Error(cleanupFailed
      ? 'temporary_root_allocation_cleanup_failed'
      : 'temporary_root_allocation_failed', { cause: error })
  }
}

async function verifySample(options: {
  id: PackagedDocumentConversionSampleReport['id']
  format: DocumentConversionFormat
  sourcePath: string
  before: SourceIdentity
  service: { convertLocal(pathname: string, signal: AbortSignal): Promise<import('../src/shared/document-conversion.ts').ConvertedDocument> }
  tracker: ReturnType<typeof createTrackedSpawn>
}): Promise<PackagedDocumentConversionSampleReport> {
  const coldSpawnBefore = options.tracker.conversionCount(options.sourcePath)
  const coldStarted = performance.now()
  const cold = await options.service.convertLocal(options.sourcePath, new AbortController().signal)
  const coldElapsedMs = Math.max(0, Math.round(performance.now() - coldStarted))
  const coldSpawnCount = options.tracker.conversionCount(options.sourcePath) - coldSpawnBefore
  const warmSpawnBefore = options.tracker.conversionCount(options.sourcePath)
  const warmStarted = performance.now()
  const warm = await options.service.convertLocal(options.sourcePath, new AbortController().signal)
  const warmElapsedMs = Math.max(0, Math.round(performance.now() - warmStarted))
  const warmSpawnCount = options.tracker.conversionCount(options.sourcePath) - warmSpawnBefore
  if (coldSpawnCount !== 1 || warmSpawnCount !== 0
    || cold.fingerprint !== warm.fingerprint
    || cold.markdown !== warm.markdown) {
    throw new Error('cache_verification_failed')
  }
  return {
    id: options.id,
    format: options.format,
    sourceBefore: options.before,
    sourceAfter: await sourceIdentity(options.sourcePath),
    coldElapsedMs,
    warmElapsedMs,
    coldSpawnCount,
    warmSpawnCount,
    cacheReused: true,
    fingerprint: cold.fingerprint,
    outputSha256: sha256Bytes(cold.markdown),
    structure: structuralCounts(cold.markdown),
  }
}

export async function verifyPackagedDocumentConversion(
  options: VerifyPackagedDocumentConversionOptions,
): Promise<PackagedDocumentConversionVerificationReport> {
  if (!path.isAbsolute(options.packageRoot) || !path.isAbsolute(options.sampleRoot)
    || !path.isAbsolute(options.repositoryRoot)
    || (options.tempParent !== undefined && !path.isAbsolute(options.tempParent))
    || (options.fixtureGeneratorTimeoutMs !== undefined
      && (!Number.isFinite(options.fixtureGeneratorTimeoutMs) || options.fixtureGeneratorTimeoutMs <= 0))
    || (options.cleanupTimeoutMs !== undefined
      && (!Number.isFinite(options.cleanupTimeoutMs) || options.cleanupTimeoutMs <= 0))
    || (options.failTemporaryRootAllocationAt !== undefined
      && (!Number.isInteger(options.failTemporaryRootAllocationAt)
        || options.failTemporaryRootAllocationAt < 1
        || options.failTemporaryRootAllocationAt > TEMPORARY_ROOT_ALLOCATION_COUNT))) {
    throw new Error('invalid_packaged_verifier_configuration')
  }
  const modules = await loadProductionModules()
  const descriptor = options.descriptor ?? modules.descriptor
  const authorized = await resolveAuthorizedSamples(options.sampleRoot)
  let temporaryRoots: VerifierTemporaryRoots
  try {
    temporaryRoots = await allocateVerifierTemporaryRoots(
      options.tempParent ?? tmpdir(),
      options.failTemporaryRootAllocationAt,
    )
  } catch (error) {
    throw new Error('packaged_document_conversion_verification_failed', { cause: error })
  }
  const { runRoot, userData, taskRoot, copiesRoot } = temporaryRoots

  const tracker = createTrackedSpawn(options.spawn, options.cleanupTimeoutMs ?? WAIT_TIMEOUT_MS)
  let manager: Awaited<ReturnType<ProductionModules['createDocumentConversionComponentManager']>> | undefined
  let lifecycle: ReturnType<ProductionModules['createDocumentConversionRuntimeLifecycle']> | undefined
  let reportWithoutCleanup: Omit<PackagedDocumentConversionVerificationReport, 'cleanup'> | undefined
  let runFailure: unknown
  let originalsUnchanged = true
  let harnessRootsRemaining = 1
  try {
    const source = descriptor.source === 'https'
      ? new modules.CosComponentArtifactSource(descriptor, modules.releaseBaseUrl)
      : new modules.PackagedArtifactSource(descriptor, path.join(options.packageRoot, 'resources'))
    manager = await modules.createDocumentConversionComponentManager({
      userData,
      descriptor,
      source,
    })
    const initial = manager.getState()
    if (initial.status !== 'absent') throw new Error('component_initial_state_mismatch')
    const installed = await manager.install('packaged-verifier-install')
    if (installed.status !== 'installed') throw new Error('component_install_failed')
    const runtime = manager.resolveRuntime()
    if (!runtime) throw new Error('component_runtime_missing')
    const runner = modules.createMarkItDownRunner({ tempRoot: taskRoot, spawn: tracker.spawn })
    const service = new modules.DocumentConversionService({ manager, runner })
    lifecycle = modules.createDocumentConversionRuntimeLifecycle({ conversions: service, manager })

    const epubPath = path.join(copiesRoot, 'deterministic.epub')
    await runFixtureGenerator({
      destination: epubPath,
      repositoryRoot: options.repositoryRoot,
      runtime,
      spawn: tracker.spawn,
      timeoutMs: options.fixtureGeneratorTimeoutMs ?? EPUB_FIXTURE_GENERATOR_TIMEOUT_MS,
    })
    const epubBefore = await sourceIdentity(epubPath)
    const samples: PackagedDocumentConversionSampleReport[] = []
    for (const sample of authorized) {
      samples.push(await verifySample({
        id: sample.id,
        format: sample.format,
        sourcePath: sample.sourcePath,
        before: sample.before,
        service,
        tracker,
      }))
    }
    samples.push(await verifySample({
      id: 'epub-1',
      format: 'epub',
      sourcePath: epubPath,
      before: epubBefore,
      service,
      tracker,
    }))

    const modifiedPath = path.join(copiesRoot, 'modified.pdf')
    await copyFile(authorized[0]!.sourcePath, modifiedPath)
    const firstModified = await service.convertLocal(modifiedPath, new AbortController().signal)
    const modifiedMetadata = await stat(modifiedPath)
    await utimes(modifiedPath, modifiedMetadata.atime, new Date(modifiedMetadata.mtimeMs + 10_000))
    const secondModified = await service.convertLocal(modifiedPath, new AbortController().signal)
    if (firstModified.fingerprint === secondModified.fingerprint
      || tracker.conversionCount(modifiedPath) !== 2) {
      throw new Error('source_modification_invalidation_failed')
    }

    const xlsxLarge = authorized.find((sample) => sample.id === 'xlsx-large')!
    const cancellationPath = path.join(copiesRoot, 'cancellation.xlsx')
    await copyFile(xlsxLarge.sourcePath, cancellationPath)
    const cancellationController = new AbortController()
    const cancellationOutcome = service.convertLocal(cancellationPath, cancellationController.signal).then(
      () => ({ resolved: true as const }),
      () => ({ resolved: false as const }),
    )
    const cancellationRecord = await tracker.waitForConversion(cancellationPath, 0)
    cancellationController.abort(new DOMException('cancelled', 'AbortError'))
    if ((await cancellationOutcome).resolved) throw new Error('cancellation_verification_failed')
    await waitUntil(() => manager!.getState().busy === false, 'cancellation_cleanup')
    const cancellationTaskEntries = await directoryEntries(taskRoot)
    if (!cancellationRecord.killed || cancellationTaskEntries !== 0) {
      throw new Error('cancellation_cleanup_failed')
    }

    const removed = await manager.remove()
    const componentRoot = path.join(userData, 'document-conversion')
    const removal = {
      activeRemaining: await pathExists(path.join(componentRoot, 'active')),
      backupEntriesRemaining: await directoryEntries(path.join(componentRoot, 'backup')),
      stagingEntriesRemaining: await directoryEntries(path.join(componentRoot, 'staging')),
    }
    if (removed.status !== 'absent' || removal.activeRemaining
      || removal.backupEntriesRemaining !== 0 || removal.stagingEntriesRemaining !== 0) {
      throw new Error('component_remove_cleanup_failed')
    }

    const reinstalled = await manager.install('packaged-verifier-reinstall')
    if (reinstalled.status !== 'installed') throw new Error('component_reinstall_failed')
    const drainBefore = tracker.conversionCount(cancellationPath)
    const drainOutcome = service.convertLocal(cancellationPath, new AbortController().signal).then(
      () => ({ resolved: true as const }),
      () => ({ resolved: false as const }),
    )
    const drainRecord = await tracker.waitForConversion(cancellationPath, drainBefore)
    await lifecycle.dispose()
    if ((await drainOutcome).resolved) throw new Error('shutdown_drain_did_not_cancel')
    const shutdownTaskEntries = await directoryEntries(taskRoot)
    const shutdown = {
      drained: tracker.activeCount() === 0,
      childKilled: drainRecord.killed,
      leaseReleased: manager.getState().busy === false,
      taskDirectoriesRemaining: shutdownTaskEntries,
    }
    if (!shutdown.drained || !shutdown.childKilled || !shutdown.leaseReleased
      || shutdown.taskDirectoriesRemaining !== 0) {
      throw new Error('shutdown_drain_cleanup_failed')
    }

    for (const sample of authorized) {
      const after = await sourceIdentity(sample.sourcePath)
      originalsUnchanged &&= sameIdentity(sample.before, after)
    }
    if (!originalsUnchanged || samples.some((sample) => !sameIdentity(sample.sourceBefore, sample.sourceAfter))) {
      throw new Error('authorized_source_changed')
    }
    reportWithoutCleanup = {
      schemaVersion: 1,
      component: {
        initialStatus: initial.status,
        installedStatus: installed.status,
        removedStatus: removed.status,
        reinstalledStatus: reinstalled.status,
        version: descriptor.version,
      },
      samples,
      sourceModification: {
        id: 'modified-copy',
        beforeFingerprint: firstModified.fingerprint,
        afterFingerprint: secondModified.fingerprint,
        invalidated: true,
        spawnCount: 2,
      },
      cancellation: {
        id: 'xlsx-large-cancel-copy',
        cancelled: true,
        childKilled: cancellationRecord.killed,
        taskDirectoriesRemaining: cancellationTaskEntries,
      },
      removal,
      shutdown,
      timeoutBoundsMs: {
        pdf: modules.documentConversionTimeoutMs('pdf'),
        pptx: modules.documentConversionTimeoutMs('pptx'),
        xlsx: modules.documentConversionTimeoutMs('xlsx'),
        epub: modules.documentConversionTimeoutMs('epub'),
      },
    }
  } catch (error) {
    runFailure = error
  } finally {
    try { await lifecycle?.dispose() } catch { runFailure ??= new Error('lifecycle_cleanup_failed') }
    if (tracker.activeCount() > 0) tracker.killActive()
    try { await tracker.waitForIdle() } catch {
      runFailure ??= new Error('python_child_cleanup_failed')
    }
    for (const sample of authorized) {
      try { originalsUnchanged &&= sameIdentity(sample.before, await sourceIdentity(sample.sourcePath)) } catch {
        originalsUnchanged = false
      }
    }
    if (!originalsUnchanged) runFailure = new Error('authorized_source_changed')
    try {
      await rm(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      harnessRootsRemaining = await pathExists(runRoot) ? 1 : 0
    } catch {
      runFailure ??= new Error('harness_root_cleanup_failed')
    }
  }

  if (runFailure !== undefined || !reportWithoutCleanup
    || tracker.activeCount() !== 0 || harnessRootsRemaining !== 0) {
    throw new Error('packaged_document_conversion_verification_failed', { cause: runFailure })
  }
  return {
    ...reportWithoutCleanup,
    cleanup: {
      pythonChildrenRemaining: tracker.activeCount(),
      harnessRootsRemaining,
    },
  }
}

export function renderPackagedDocumentConversionMarkdown(
  report: PackagedDocumentConversionVerificationReport,
): string {
  const lines = [
    '## Formal packaged-service verification',
    '',
    `- Component version: ${report.component.version}`,
    `- Lifecycle: ${report.component.initialStatus} -> ${report.component.installedStatus} -> ${report.component.removedStatus} -> ${report.component.reinstalledStatus}`,
    `- Timeout bounds: PDF/PPTX/EPUB ${report.timeoutBoundsMs.pdf} ms; XLSX ${report.timeoutBoundsMs.xlsx} ms (deterministic runner tests; no wall-clock timeout wait).`,
    '',
    '| Sample | Format | Source SHA-256 before | Source SHA-256 after | Bytes | mtime ns before | mtime ns after | Cold ms | Warm ms | Cache | Fingerprint | Output SHA-256 | Output bytes | Chars | Headings | List items | Table rows | U+FFFD |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.samples.map((sample) => `| ${[
      sample.id,
      sample.format,
      sample.sourceBefore.sha256,
      sample.sourceAfter.sha256,
      sample.sourceBefore.bytes,
      sample.sourceBefore.mtimeNs,
      sample.sourceAfter.mtimeNs,
      sample.coldElapsedMs,
      sample.warmElapsedMs,
      sample.cacheReused ? 'reused' : 'missed',
      sample.fingerprint,
      sample.outputSha256,
      sample.structure.bytes,
      sample.structure.characters,
      sample.structure.headings,
      sample.structure.listItems,
      sample.structure.tableRows,
      sample.structure.replacementCharacters,
    ].join(' | ')} |`),
    '',
    `- Source modification invalidation: ${report.sourceModification.invalidated ? 'pass' : 'fail'} (${report.sourceModification.spawnCount} conversions).`,
    `- Cancellation: ${report.cancellation.cancelled && report.cancellation.childKilled ? 'pass' : 'fail'}; task remnants=${report.cancellation.taskDirectoriesRemaining}.`,
    `- Removal: active=${report.removal.activeRemaining ? 'present' : 'absent'}; staging=${report.removal.stagingEntriesRemaining}; backup=${report.removal.backupEntriesRemaining}.`,
    `- Shutdown drain: ${report.shutdown.drained && report.shutdown.leaseReleased ? 'pass' : 'fail'}; task remnants=${report.shutdown.taskDirectoriesRemaining}.`,
    `- Final cleanup: Python children=${report.cleanup.pythonChildrenRemaining}; harness roots=${report.cleanup.harnessRootsRemaining}.`,
    '',
    'No source paths, file names, or extracted Markdown are retained in this verification record.',
  ]
  return `${lines.join('\n')}\n`
}

function installProductionTypeScriptResolver(repositoryRoot: string): void {
  const sourceRoot = realpathSync(path.resolve(repositoryRoot, 'src'))
  const isWithinSourceRoot = (candidate: string): boolean => {
    const relative = path.relative(sourceRoot, candidate)
    return relative === ''
      || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }
  const rejectEscape = (): never => { throw new Error('raw_node_resolver_escape') }
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parentURL = context.parentURL
      if (!parentURL?.startsWith('file:')) return nextResolve(specifier, context)
      let parentPath: string
      try {
        parentPath = realpathSync(fileURLToPath(parentURL))
      } catch {
        return nextResolve(specifier, context)
      }
      if (!isWithinSourceRoot(parentPath)) return nextResolve(specifier, context)

      const relativeSpecifier = specifier.startsWith('.')
      const absoluteSpecifier = path.isAbsolute(specifier)
      const fileUrlSpecifier = specifier.startsWith('file:')
      if (!relativeSpecifier && !absoluteSpecifier && !fileUrlSpecifier) {
        return nextResolve(specifier, context)
      }
      let candidatePath: string
      try {
        candidatePath = fileUrlSpecifier
          ? fileURLToPath(specifier)
          : absoluteSpecifier
            ? path.resolve(specifier)
            : path.resolve(path.dirname(parentPath), specifier)
      } catch {
        return rejectEscape()
      }
      if (!isWithinSourceRoot(candidatePath)) return rejectEscape()

      const validate = <T extends { url: string }>(result: T): T => {
        if (!result.url.startsWith('file:')) return rejectEscape()
        let resolvedPath: string
        try {
          resolvedPath = realpathSync(fileURLToPath(result.url))
        } catch {
          return rejectEscape()
        }
        if (!isWithinSourceRoot(resolvedPath)) return rejectEscape()
        return result
      }
      try {
        return validate(nextResolve(specifier, context))
      } catch (error) {
        if (!relativeSpecifier || path.extname(specifier)
          || (error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error
        return validate(nextResolve(`${specifier}.ts`, context))
      }
    },
  })
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  try {
    installProductionTypeScriptResolver(repositoryRoot)
    await loadProductionModules()
  } catch {
    process.stderr.write('packaged_document_conversion_verification_failed\n')
    return 1
  }
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(ENTRY_USAGE)
    return 0
  }
  if (argv.length !== 4 || argv[0] !== '--package-root' || argv[2] !== '--sample-root'
    || !path.isAbsolute(argv[1]!) || !path.isAbsolute(argv[3]!)) {
    process.stderr.write(ENTRY_USAGE)
    return 2
  }
  try {
    const report = await verifyPackagedDocumentConversion({
      packageRoot: path.resolve(argv[1]!),
      repositoryRoot,
      sampleRoot: path.resolve(argv[3]!),
    })
    process.stdout.write(`${JSON.stringify(report)}\n`)
    return 0
  } catch {
    process.stderr.write('packaged_document_conversion_verification_failed\n')
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().then(
    (code) => { process.exitCode = code },
    () => {
      process.stderr.write('packaged_document_conversion_verification_failed\n')
      process.exitCode = 1
    },
  )
}
