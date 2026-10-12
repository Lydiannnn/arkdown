import { randomUUID } from 'node:crypto'
import { verifyScreenshotOcrArchive } from './screenshot-ocr-archive-validation'
import { ScreenshotOcrValidationUnavailableError } from './screenshot-ocr-validation'
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename as renameFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import { appError } from '../../shared/public-errors'
import {
  SCREENSHOT_OCR_BUNDLED_VERSION,
  SCREENSHOT_OCR_MEDIUM_ARTIFACTS,
  SCREENSHOT_OCR_MEDIUM_VERSION,
  SCREENSHOT_OCR_SUPPORTED_MEDIUM_MANIFESTS,
  type ScreenshotOcrDownloadArtifact,
} from '../../shared/screenshot-ocr-manifest'
import type {
  ScreenshotOcrModelState,
  ScreenshotOcrTier,
} from '../../shared/screenshot-ocr-models'
import { isCanonicalScreenshotOcrModelVersion, parseObservedOcrPreference, OcrPreferenceConflictError,
  type ObservedOcrPreference, type ObservedScreenshotOcrState } from '../../shared/screenshot-ocr-models'
import type { SettingsAuthority } from '../settings/settings-authority'
import type { SettingsTransactionSnapshot } from '../settings/settings-transaction-types'
import {
  MediumMutationLockBusyError,
  acquireMediumMutationLock,
  mediumMutationWriterPresentSync,
  type MediumMutationLockLease,
} from './medium-mutation-lock'
import {
  currentProcessCreationIdentity,
  processCreationIdentityMatches,
  type ProcessCreationIdentityMatch,
} from './process-creation-identity'

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000
const MANIFEST_NAME = 'manifest.json'
const EXACT_ACTIVE_NAMES = Object.freeze(['manifest.json', 'medium-det.tar', 'medium-rec.tar'])
const MANIFEST_MAX_BYTES = 16 * 1024
const MUTATION_LOCK_NAME = '.mutation-lock'
const LEASES_NAME = '.leases'
const TRANSACTION_NAME = 'transaction.json'
const UUID_NAME_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function managedDirectoryName(name: string, prefix: '.staging-' | '.previous-' | '.removing-' | '.transaction-'): boolean {
  return name.startsWith(prefix) && UUID_NAME_SUFFIX.test(name.slice(prefix.length))
}

interface ActiveManifest {
  version: string
  artifacts: Array<{ name: string; bytes: number; sha256: string }>
}

type ReplacePhase = 'prepared' | 'previous-moved' | 'current-switched' | 'preference-persisted'

type MediumTransaction = (
  | {
    kind: 'replace'
    staging: string
    previous: string
    phase: ReplacePhase
    hadPrevious: boolean
  }
  | {
    kind: 'replace-rollback'
    staging: string
    previous: string
    hadPrevious: boolean
    previousVersion: string | null
    preferredTier: ScreenshotOcrTier
  }
  | { kind: 'remove'; removing: string }
) & { observed?: ObservedOcrPreference }

function observePreference(snapshot: SettingsTransactionSnapshot): ObservedOcrPreference {
  return { revision: snapshot.revision, preferredTier: snapshot.settings.screenshotOcr?.preferredTier ?? 'small',
    tierRevision: snapshot.fieldRevisions.fields['screenshotOcr.preferredTier'] ?? 0 }
}

export interface ScreenshotOcrModelManager {
  getState(): ScreenshotOcrModelState
  getObservedState(): Promise<ObservedScreenshotOcrState>
  downloadMedium(observed: ObservedOcrPreference): Promise<ScreenshotOcrModelState>
  cancelMediumDownload(): Promise<ScreenshotOcrModelState>
  removeMedium(observed: ObservedOcrPreference): Promise<ScreenshotOcrModelState>
  resolveActiveTier(): ScreenshotOcrTier
  reportTierUnavailable(tier: ScreenshotOcrTier): void
  acquireTier(): { tier: ScreenshotOcrTier; release(): void }
  resolveActiveResource(name: 'medium-det.tar' | 'medium-rec.tar'): Promise<Uint8Array | undefined>
  dispose(): Promise<void>
}

export interface ScreenshotOcrModelManagerOptions {
  dataRoot: string
  /** A read-only Full distribution directory containing the pinned legacy three-file layout. */
  bundledMediumRoot?: string
  /** Populate only the two model archives; this manager retains validation, activation, and leases. */
  prepareMedium?(stagingRoot: string, signal: AbortSignal,
    onProgress: (progress: { receivedBytes: number; totalBytes: number }) => void): Promise<void>
  settings: Pick<SettingsAuthority, 'readFresh' | 'getDisplaySnapshot' | 'apply'>
  onState?(state: ScreenshotOcrModelState): void
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  artifacts?: readonly ScreenshotOcrDownloadArtifact[]
  rename?: (from: string, to: string) => Promise<void>
  downloadTimeoutMs?: number
  currentVersion?: string
  supportedManifests?: readonly {
    version: string
    artifacts: readonly ScreenshotOcrDownloadArtifact[]
  }[]
  processId?: number
  processAlive?(pid: number): boolean
  processIdentity?: string
  processIdentityMatches?(
    pid: number,
    expectedIdentity: string,
  ): Promise<ProcessCreationIdentityMatch> | ProcessCreationIdentityMatch
  mutationLockWaitTimeoutMs?: number
  removeLeaseFile?(filePath: string): void
  /** Validate and return the exact artifact bytes; production may delegate CPU work to a worker. */
  verifyArchive?(artifact: ScreenshotOcrDownloadArtifact, bytes: Uint8Array): Promise<Uint8Array>
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function parseTransaction(value: unknown): MediumTransaction | undefined {
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'observed')) {
    const { observed, ...record } = value as Record<string, unknown>
    const parsed = parseObservedOcrPreference(observed)
    const transaction = parsed && parseTransaction(record)
    return transaction ? { ...transaction, observed: parsed } : undefined
  }
  if (exactRecord(value, ['kind', 'staging', 'previous', 'phase', 'hadPrevious']) && value.kind === 'replace'
    && typeof value.staging === 'string' && managedDirectoryName(value.staging, '.staging-')
    && typeof value.previous === 'string' && managedDirectoryName(value.previous, '.previous-')
    && ['prepared', 'previous-moved', 'current-switched', 'preference-persisted'].includes(String(value.phase))
    && typeof value.hadPrevious === 'boolean') {
    return {
      kind: 'replace',
      staging: value.staging,
      previous: value.previous,
      phase: value.phase as ReplacePhase,
      hadPrevious: value.hadPrevious,
    }
  }
  if (exactRecord(value, [
    'kind', 'staging', 'previous', 'hadPrevious', 'previousVersion', 'preferredTier',
  ]) && value.kind === 'replace-rollback'
    && typeof value.staging === 'string' && managedDirectoryName(value.staging, '.staging-')
    && typeof value.previous === 'string' && managedDirectoryName(value.previous, '.previous-')
    && typeof value.hadPrevious === 'boolean'
    && ((value.hadPrevious && typeof value.previousVersion === 'string'
      && isCanonicalScreenshotOcrModelVersion(value.previousVersion))
      || (!value.hadPrevious && value.previousVersion === null))
    && (value.preferredTier === 'small' || value.preferredTier === 'medium')) {
    return {
      kind: 'replace-rollback',
      staging: value.staging,
      previous: value.previous,
      hadPrevious: value.hadPrevious,
      previousVersion: value.previousVersion as string | null,
      preferredTier: value.preferredTier,
    }
  }
  if (exactRecord(value, ['kind', 'removing']) && value.kind === 'remove'
    && typeof value.removing === 'string' && managedDirectoryName(value.removing, '.removing-')) {
    return { kind: 'remove', removing: value.removing }
  }
  return undefined
}

function equalPath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? path.normalize(first).toLocaleLowerCase('en-US') === path.normalize(second).toLocaleLowerCase('en-US')
    : path.normalize(first) === path.normalize(second)
}

function publicState(state: ScreenshotOcrModelState): ScreenshotOcrModelState {
  return {
    ...state,
    progress: state.progress ? { ...state.progress } : null,
  }
}

function manifestFor(version: string, artifacts: readonly ScreenshotOcrDownloadArtifact[]): ActiveManifest {
  return {
    version,
    artifacts: artifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
  }
}

function validManifest(
  value: unknown,
  pinnedArtifactsByVersion: ReadonlyMap<string, readonly ScreenshotOcrDownloadArtifact[]>,
): value is ActiveManifest {
  if (!exactRecord(value, ['version', 'artifacts']) || typeof value.version !== 'string') return false
  const artifacts = pinnedArtifactsByVersion.get(value.version)
  if (!artifacts
    || !Array.isArray(value.artifacts) || value.artifacts.length !== artifacts.length) return false
  return value.artifacts.every((candidate, index) => {
    const expected = artifacts[index]
    return expected && exactRecord(candidate, ['name', 'bytes', 'sha256'])
      && candidate.name === expected.name && candidate.bytes === expected.bytes && candidate.sha256 === expected.sha256
  })
}

async function auditActive(
  root: string,
  pinnedArtifactsByVersion: ReadonlyMap<string, readonly ScreenshotOcrDownloadArtifact[]>,
  verifyArchive: ArchiveValidator,
): Promise<ActiveManifest | undefined> {
  try {
    const rootInfo = await lstat(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !equalPath(await realpath(root), root)) return undefined
    const names = (await readdir(root)).sort()
    if (names.length !== EXACT_ACTIVE_NAMES.length || names.some((name, index) => name !== [...EXACT_ACTIVE_NAMES].sort()[index])) return undefined
    const manifestPath = path.join(root, MANIFEST_NAME)
    const manifestInfo = await lstat(manifestPath)
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MANIFEST_MAX_BYTES
      || !equalPath(await realpath(manifestPath), manifestPath)) return undefined
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown
    if (!validManifest(manifest, pinnedArtifactsByVersion)) return undefined
    const artifacts = pinnedArtifactsByVersion.get(manifest.version)!
    for (const artifact of artifacts) {
      const filePath = path.join(root, artifact.name)
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes
        || !equalPath(await realpath(filePath), filePath)) return undefined
      const bytes = await readFile(filePath)
      await verifyArchive(artifact, bytes)
    }
    return manifest
  } catch (error) {
    if (error instanceof ScreenshotOcrValidationUnavailableError) throw error
    return undefined
  }
}

type ArchiveValidator = (artifact: ScreenshotOcrDownloadArtifact, bytes: Uint8Array) => Promise<Uint8Array>

function allowedDownloadUrl(value: string, allowlist: ReadonlySet<string>): boolean {
  if (!allowlist.has(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'paddle-model-ecology.bj.bcebos.com'
      && !url.username && !url.password && !url.port && !url.search && !url.hash
  } catch {
    return false
  }
}

export function screenshotOcrMediumActiveRoot(dataRoot: string): string {
  return path.join(dataRoot, 'screenshot-ocr', 'medium', 'current')
}

export async function createScreenshotOcrModelManager(
  options: ScreenshotOcrModelManagerOptions,
): Promise<ScreenshotOcrModelManager> {
  await options.settings.readFresh()
  const getPreferredTier = () => observePreference(options.settings.getDisplaySnapshot()).preferredTier
  const setPreferredTier = async (value: ScreenshotOcrTier, observed: ObservedOcrPreference): Promise<void> => {
    const result = await options.settings.apply({ baseRevision: observed.revision, operations: [{
      kind: 'screenshot-ocr.set-tier', value, expected: { value: observed.preferredTier, revision: observed.tierRevision },
    }] })
    if (result.status === 'conflict') throw new OcrPreferenceConflictError()
    if (result.status === 'invalid') throw appError('INVALID_INPUT')
    // Both unchanged and committed (including cleanupPending) acknowledge success.
  }
  const verifyArchive: ArchiveValidator = options.verifyArchive ?? (async (artifact, bytes) => {
    verifyScreenshotOcrArchive(artifact, bytes)
    return bytes
  })
  const artifacts = options.artifacts ?? SCREENSHOT_OCR_MEDIUM_ARTIFACTS
  const currentVersion = options.currentVersion ?? SCREENSHOT_OCR_MEDIUM_VERSION
  const configuredManifests = options.supportedManifests
    ?? (options.currentVersion === undefined && options.artifacts === undefined
      ? SCREENSHOT_OCR_SUPPORTED_MEDIUM_MANIFESTS
      : [{ version: currentVersion, artifacts }])
  const pinnedArtifactsByVersion = new Map<string, readonly ScreenshotOcrDownloadArtifact[]>()
  const ownerProcessId = options.processId ?? process.pid
  const identityMatchesProcess = async (
    pid: number,
    expectedIdentity: string,
  ): Promise<ProcessCreationIdentityMatch> => {
    if (options.processIdentityMatches) return options.processIdentityMatches(pid, expectedIdentity)
    if (options.processAlive) {
      return options.processAlive(pid) && expectedIdentity === `alive:${pid}`
        ? 'alive-match'
        : 'dead-or-mismatch'
    }
    return processCreationIdentityMatches(pid, expectedIdentity)
  }
  let ownerCreationIdentity = options.processIdentity
    ?? (options.processAlive
      ? `alive:${ownerProcessId}`
      : ownerProcessId === process.pid ? await currentProcessCreationIdentity() : undefined)
  const validPinnedArtifacts = (candidate: readonly ScreenshotOcrDownloadArtifact[]): boolean => (
    candidate.length === 2
    && candidate[0]?.name === 'medium-det.tar'
    && candidate[1]?.name === 'medium-rec.tar'
    && candidate.every((artifact) => Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0
      && /^[0-9a-f]{64}$/u.test(artifact.sha256))
  )
  if (!validPinnedArtifacts(artifacts)) {
    throw new Error('Invalid screenshot OCR Medium manifest')
  }
  for (const manifest of configuredManifests) {
    if (!isCanonicalScreenshotOcrModelVersion(manifest.version)
      || pinnedArtifactsByVersion.has(manifest.version)
      || !validPinnedArtifacts(manifest.artifacts)) throw new Error('Invalid screenshot OCR Medium manifest')
    pinnedArtifactsByVersion.set(manifest.version, manifest.artifacts)
  }
  const pinnedCurrent = pinnedArtifactsByVersion.get(currentVersion)
  if (!Number.isSafeInteger(ownerProcessId) || ownerProcessId <= 0
    || (ownerCreationIdentity !== undefined
      && (ownerCreationIdentity.length < 1 || ownerCreationIdentity.length > 128))
    || !isCanonicalScreenshotOcrModelVersion(currentVersion) || !pinnedCurrent
    || pinnedCurrent.some((artifact, index) => {
      const current = artifacts[index]
      return !current || artifact.name !== current.name || artifact.bytes !== current.bytes || artifact.sha256 !== current.sha256
    })) {
    throw new Error('Invalid screenshot OCR Medium manifest')
  }
  const fetchImpl = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const rename = options.rename ?? renameFile
  const removeLeaseFile = options.removeLeaseFile ?? ((filePath: string) => rmSync(filePath, { force: true }))
  const mediumRoot = path.join(options.dataRoot, 'screenshot-ocr', 'medium')
  const activeRoot = screenshotOcrMediumActiveRoot(options.dataRoot)
  const mutationLockRoot = path.join(mediumRoot, MUTATION_LOCK_NAME)
  const leasesRoot = path.join(mediumRoot, LEASES_NAME)
  const transactionPath = path.join(mediumRoot, TRANSACTION_NAME)
  let storageAvailable = ownerCreationIdentity !== undefined
  try { await mkdir(mediumRoot, { recursive: true }); await mkdir(leasesRoot, { recursive: true }) } catch { storageAvailable = false }

  const readBoundedRecord = async (filePath: string): Promise<Record<string, unknown> | undefined> => {
    try {
      const info = await lstat(filePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MANIFEST_MAX_BYTES) return undefined
      const value = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined
    } catch { return undefined }
  }
  const acquireMutationLock = (): Promise<MediumMutationLockLease> => {
    if (!ownerCreationIdentity) return Promise.reject(new Error('OCR_MODEL_STORAGE_UNAVAILABLE'))
    return acquireMediumMutationLock({
      root: mutationLockRoot,
      owner: { pid: ownerProcessId, creationIdentity: ownerCreationIdentity },
      processIdentityMatches: identityMatchesProcess,
      waitTimeoutMs: options.mutationLockWaitTimeoutMs,
    })
  }

  const recoverInterrupted = async (): Promise<void> => {
    const mutationLease = await acquireMutationLock()
    try {
      const transaction = parseTransaction(await readBoundedRecord(transactionPath))
      let activeManifest = await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)
      if (transaction?.kind === 'replace-rollback') {
        const stagingRoot = path.join(mediumRoot, transaction.staging)
        const previousRoot = path.join(mediumRoot, transaction.previous)
        const previousManifest = await auditActive(previousRoot, pinnedArtifactsByVersion, verifyArchive)
        if (transaction.hadPrevious) {
          if (previousManifest) {
            await rm(activeRoot, { recursive: true, force: true }).catch(() => undefined)
            await rename(previousRoot, activeRoot)
            activeManifest = await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)
          }
          if (!activeManifest || activeManifest.version !== transaction.previousVersion) {
            throw new Error('OCR_MODEL_RECOVERY_FAILED')
          }
        } else {
          await rm(activeRoot, { recursive: true, force: true })
          activeManifest = undefined
        }
        // Resource rollback cannot authorize restoring a legacy preference. New
        // operations never roll back an acknowledged preference commit either.
        await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
        await rm(previousRoot, { recursive: true, force: true }).catch(() => undefined)
        await rm(transactionPath, { force: true })
      } else if (transaction?.kind === 'replace') {
        const stagingRoot = path.join(mediumRoot, transaction.staging)
        const previousRoot = path.join(mediumRoot, transaction.previous)
        const stagingManifest = await auditActive(stagingRoot, pinnedArtifactsByVersion, verifyArchive)
        const previousManifest = await auditActive(previousRoot, pinnedArtifactsByVersion, verifyArchive)

        if (transaction.phase === 'prepared' && activeManifest) {
          // The journal has not committed either rename. The audited current
          // generation remains authoritative even if staging is missing or
          // damaged; startup must not reinterpret that as a completed switch.
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
          await rm(previousRoot, { recursive: true, force: true }).catch(() => undefined)
          await rm(transactionPath, { force: true })
        } else if (!activeManifest && previousManifest) {
          await rm(activeRoot, { recursive: true, force: true }).catch(() => undefined)
          await rename(previousRoot, activeRoot)
          activeManifest = await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)
          if (!activeManifest) throw new Error('OCR_MODEL_RECOVERY_FAILED')
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
          await rm(transactionPath, { force: true })
        } else if (transaction.phase !== 'prepared' && activeManifest && !stagingManifest) {
          // Complete only a recorded checked preference operation. A legacy
          // journal or a newer preference cannot authorize another settings write.
          try {
            if (transaction.observed) await setPreferredTier('medium', transaction.observed)
          } catch (error) {
            if (!(error instanceof OcrPreferenceConflictError)) throw error
            // The preference may already have committed before the phase write,
            // or another user changed it. Keep the audited usable generation;
            // never use a fresh snapshot to overwrite that newer preference.
            await options.settings.readFresh()
          }
          await rm(previousRoot, { recursive: true, force: true }).catch(() => undefined)
          await rm(transactionPath, { force: true })
        } else if (!activeManifest && !previousManifest) {
          // A first install never switched. Its staging tree is not active evidence.
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
          await rm(transactionPath, { force: true })
        } else {
          throw new Error('OCR_MODEL_RECOVERY_FAILED')
        }
      }
      const refreshedNames = await readdir(mediumRoot)
      activeManifest = await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)
      if (!activeManifest) {
        const previous = refreshedNames.filter((name) => managedDirectoryName(name, '.previous-'))
        const validPrevious: string[] = []
        for (const name of previous) {
          if (await auditActive(path.join(mediumRoot, name), pinnedArtifactsByVersion, verifyArchive)) validPrevious.push(name)
        }
        const journalPrevious = transaction?.kind === 'replace' && typeof transaction.previous === 'string'
          && managedDirectoryName(transaction.previous, '.previous-')
          && validPrevious.includes(transaction.previous)
          ? transaction.previous
          : undefined
        const recoverablePrevious = journalPrevious ?? (validPrevious.length === 1 ? validPrevious[0] : undefined)
        if (recoverablePrevious) {
          await rm(activeRoot, { recursive: true, force: true }).catch(() => undefined)
          await rename(path.join(mediumRoot, recoverablePrevious), activeRoot)
          activeManifest = await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)
        } else if (getPreferredTier() === 'medium') {
          const removing = refreshedNames.filter((name) => managedDirectoryName(name, '.removing-'))
          const validRemoving: string[] = []
          for (const name of removing) {
            if (await auditActive(path.join(mediumRoot, name), pinnedArtifactsByVersion, verifyArchive)) validRemoving.push(name)
          }
          if (validRemoving.length === 1) {
            await rm(activeRoot, { recursive: true, force: true }).catch(() => undefined)
            await rename(path.join(mediumRoot, validRemoving[0]!), activeRoot)
            activeManifest = await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)
          }
        }
      }
      if (activeManifest) {
        for (const name of refreshedNames) {
          if (managedDirectoryName(name, '.staging-') || managedDirectoryName(name, '.previous-')
            || managedDirectoryName(name, '.removing-') || managedDirectoryName(name, '.transaction-')) {
            await rm(path.join(mediumRoot, name), { recursive: true, force: true }).catch(() => undefined)
          }
        }
        await rm(transactionPath, { force: true }).catch(() => undefined)
      } else {
        for (const name of refreshedNames.filter((candidate) => managedDirectoryName(candidate, '.staging-')
          || managedDirectoryName(candidate, '.transaction-'))) {
          await rm(path.join(mediumRoot, name), { recursive: true, force: true }).catch(() => undefined)
        }
        if (getPreferredTier() === 'small') {
          for (const name of refreshedNames.filter((candidate) => managedDirectoryName(candidate, '.removing-'))) {
            await rm(path.join(mediumRoot, name), { recursive: true, force: true }).catch(() => undefined)
          }
          if (transaction?.kind === 'remove') await rm(transactionPath, { force: true }).catch(() => undefined)
        }
      }
    } finally {
      await mutationLease.release()
    }
  }
  let initializationBusy = false
  if (storageAvailable) {
    try { await recoverInterrupted() } catch (error) {
      if (error instanceof MediumMutationLockBusyError) initializationBusy = true
      else storageAvailable = false
    }
  }
  let installedManifest: Awaited<ReturnType<typeof auditActive>>
  try {
    installedManifest = storageAvailable ? await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive) : undefined
  } catch {
    // Infrastructure failure cannot establish corruption or authorize cleanup.
    storageAvailable = false
  }
  if (initializationBusy && !installedManifest) storageAvailable = false
  let installed = installedManifest !== undefined
  let installedVersion = installedManifest?.version ?? null
  const bundledRoot = options.bundledMediumRoot ? path.resolve(options.bundledMediumRoot) : undefined
  let bundledManifest: Awaited<ReturnType<typeof auditActive>>
  let bundledValidationUnavailable = false
  try { bundledManifest = bundledRoot ? await auditActive(bundledRoot, pinnedArtifactsByVersion, verifyArchive) : undefined }
  catch { bundledValidationUnavailable = true }
  const effectiveVersion = () => installed ? installedVersion : bundledManifest?.version ?? null
  const mediumSource = (): ScreenshotOcrModelState['mediumSource'] => installed ? 'managed' : bundledManifest ? 'bundled' : null
  const hasMedium = () => effectiveVersion() !== null
  if (storageAvailable && !installed && !initializationBusy) {
    await rm(activeRoot, { recursive: true, force: true }).catch(() => undefined)
  }
  let disposed = false
  let disposePromise: Promise<void> | undefined
  let currentFlight: Promise<ScreenshotOcrModelState> | undefined
  let activeAbort: AbortController | undefined
  let cancelActiveDownload: (() => void) | undefined
  let activeMediumLeases = 0
  const leaseFiles = new Map<string, string>()
  const leaseWaiters = new Set<() => void>()
  let activationLocked = false
  let mediumRuntimeFailed = false
  let status: ScreenshotOcrModelState['status'] = (!storageAvailable || bundledValidationUnavailable) && !hasMedium()
    ? 'medium-failed'
    : hasMedium()
      ? effectiveVersion() === currentVersion ? 'medium-installed' : 'medium-update-available'
      : 'medium-absent'
  let progress: ScreenshotOcrModelState['progress'] = null
  let errorCode: ScreenshotOcrModelState['errorCode'] = (storageAvailable && !bundledValidationUnavailable) || hasMedium() ? null : 'OPERATION_FAILED'

  const effectiveStatus = (): ScreenshotOcrModelState['status'] => {
    if (!installed && bundledManifest && status !== 'medium-downloading' && status !== 'medium-failed') {
      if (getPreferredTier() === 'small') return 'medium-disabled'
      return bundledManifest.version === currentVersion ? 'medium-installed' : 'medium-update-available'
    }
    return status
  }

  const state = (): ScreenshotOcrModelState => ({
    activeTier: getPreferredTier() === 'medium' && hasMedium() && !mediumRuntimeFailed ? 'medium' : 'small',
    bundledVersion: SCREENSHOT_OCR_BUNDLED_VERSION,
    mediumVersion: effectiveVersion(),
    mediumSource: mediumSource(),
    availableMediumVersion: effectiveVersion() === currentVersion
      && (effectiveStatus() === 'medium-installed' || effectiveStatus() === 'medium-disabled') ? null : currentVersion,
    status: effectiveStatus(),
    progress,
    errorCode,
  })
  const emit = (): ScreenshotOcrModelState => {
    const snapshot = publicState(state())
    if (!disposed) {
      try { options.onState?.(snapshot) } catch { /* public observers never own model state */ }
    }
    return snapshot
  }

  const allowlist = new Set(artifacts.map(({ url }) => url))
  const downloadResponse = async (artifact: ScreenshotOcrDownloadArtifact, signal: AbortSignal): Promise<Response> => {
    if (!allowedDownloadUrl(artifact.url, allowlist)) throw new Error('OCR_MODEL_DOWNLOAD_FAILED')
    const response = await fetchImpl(artifact.url, { method: 'GET', redirect: 'manual', signal })
    if (response.status !== 200 || !response.body) throw new Error('OCR_MODEL_DOWNLOAD_FAILED')
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== null && (!/^(0|[1-9][0-9]*)$/u.test(declaredLength)
      || Number(declaredLength) !== artifact.bytes)) throw new Error('OCR_MODEL_DOWNLOAD_FAILED')
    return response
  }

  const refreshInstalled = async (): Promise<void> => {
    installedManifest = await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)
    installed = installedManifest !== undefined
    installedVersion = installedManifest?.version ?? null
  }
  const ensureStorage = async (): Promise<boolean> => {
    if (storageAvailable) return true
    try {
      ownerCreationIdentity ??= ownerProcessId === process.pid
        ? await currentProcessCreationIdentity()
        : undefined
      if (!ownerCreationIdentity) return false
      await mkdir(mediumRoot, { recursive: true })
      await mkdir(leasesRoot, { recursive: true })
      await recoverInterrupted()
      storageAvailable = true
      await refreshInstalled()
      return true
    } catch {
      storageAvailable = false
      return false
    }
  }
  const parseLeaseRecord = (value: unknown, token: string): { pid: number; creationIdentity: string } | undefined => {
    if (!exactRecord(value, ['schemaVersion', 'token', 'pid', 'creationIdentity'])
      || value.schemaVersion !== 1 || value.token !== token
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.creationIdentity !== 'string' || value.creationIdentity.length < 1
      || value.creationIdentity.length > 128) return undefined
    return { pid: value.pid, creationIdentity: value.creationIdentity }
  }
  const leaseToken = (name: string): string | undefined => {
    if (!name.endsWith('.lease')) return undefined
    const token = name.slice(0, -'.lease'.length)
    return UUID_NAME_SUFFIX.test(token) ? token : undefined
  }
  const removeOwnedLeaseMarker = (leasePath: string, token: string): boolean => {
    try {
      const info = lstatSync(leasePath)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MANIFEST_MAX_BYTES) return true
      const record = parseLeaseRecord(JSON.parse(readFileSync(leasePath, 'utf8')) as unknown, token)
      if (record?.pid !== ownerProcessId || record.creationIdentity !== ownerCreationIdentity) return true
      removeLeaseFile(leasePath)
      return true
    } catch (error) {
      return error instanceof Error && 'code' in error && error.code === 'ENOENT'
    }
  }
  const hasCrossProcessLease = async (): Promise<boolean> => {
    try {
      let activeLease = false
      for (const name of await readdir(leasesRoot)) {
        const token = leaseToken(name)
        if (!token) continue
        const leasePath = path.join(leasesRoot, name)
        const owner = parseLeaseRecord(await readBoundedRecord(leasePath), token)
        if (!owner) { activeLease = true; continue }
        let identityStatus: ProcessCreationIdentityMatch
        try { identityStatus = await identityMatchesProcess(owner.pid, owner.creationIdentity) } catch { activeLease = true; continue }
        if (identityStatus === 'dead-or-mismatch') {
          await rm(leasePath, { force: true }).catch(() => undefined)
        } else {
          activeLease = true
        }
      }
      return activeLease
    } catch { return true }
  }
  const createMediumLease = (): { release(): void } | undefined => {
    const token = randomUUID()
    const leasePath = path.join(leasesRoot, `${token}.lease`)
    const temporaryPath = path.join(leasesRoot, `.lease-tmp-${token}`)
    try {
      if (mediumMutationWriterPresentSync(mutationLockRoot)) return undefined
      mkdirSync(leasesRoot, { recursive: true })
      writeFileSync(temporaryPath, `${JSON.stringify({
        schemaVersion: 1,
        token,
        pid: ownerProcessId,
        creationIdentity: ownerCreationIdentity,
      })}\n`, { flag: 'wx' })
      renameSync(temporaryPath, leasePath)
      if (mediumMutationWriterPresentSync(mutationLockRoot)) {
        rmSync(leasePath, { force: true })
        return undefined
      }
    } catch {
      try { rmSync(temporaryPath, { force: true }) } catch { /* incomplete private lease is ignored */ }
      try { rmSync(leasePath, { force: true }) } catch { /* publication failed */ }
      return undefined
    }
    leaseFiles.set(leasePath, token)
    activeMediumLeases += 1
    let logicallyReleased = false
    return {
      release() {
        if (removeOwnedLeaseMarker(leasePath, token)) leaseFiles.delete(leasePath)
        else leaseFiles.set(leasePath, token)
        if (logicallyReleased) return
        logicallyReleased = true
        activeMediumLeases -= 1
        if (activeMediumLeases === 0) {
          for (const resolve of leaseWaiters) resolve()
          leaseWaiters.clear()
        }
      },
    }
  }
  const writeTransaction = async (value: MediumTransaction) => {
    const bytes = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(bytes) > MANIFEST_MAX_BYTES) throw new Error('OCR_MODEL_INVALID')
    for (let attempt = 0; ; attempt += 1) {
      try {
        await writeFileAtomic(transactionPath, bytes, { encoding: 'utf8', fsync: true })
        return
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined
        if (attempt >= 9 || (code !== 'EPERM' && code !== 'EACCES')) throw error
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }

  const manager: ScreenshotOcrModelManager = {
    getState: () => publicState(state()),
    async getObservedState() {
      const observed = observePreference(await options.settings.readFresh())
      return { state: publicState(state()), observed: { ...observed, mediumSource: mediumSource() } }
    },
    resolveActiveTier: () => !disposed && getPreferredTier() === 'medium'
      && hasMedium() && !mediumRuntimeFailed && !activationLocked ? 'medium' : 'small',
    reportTierUnavailable(tier) {
      if (disposed || tier !== 'medium' || !hasMedium()) return
      mediumRuntimeFailed = true
      status = 'medium-failed'
      progress = null
      errorCode = 'OPERATION_FAILED'
      emit()
    },
    acquireTier() {
      const tier = manager.resolveActiveTier()
      const mediumLease = tier === 'medium' ? createMediumLease() : undefined
      const leasedTier = tier === 'medium' && !mediumLease ? 'small' : tier
      let released = false
      return {
        tier: leasedTier,
        release() {
          if (released) {
            mediumLease?.release()
            return
          }
          released = true
          mediumLease?.release()
        },
      }
    },
    async resolveActiveResource(name) {
      if (disposed || !hasMedium() || activationLocked) return undefined
      const lease = createMediumLease()
      if (!lease) return undefined
      try {
        const version = effectiveVersion()
        const installedArtifacts = version
          ? pinnedArtifactsByVersion.get(version)
          : undefined
        const artifact = installedArtifacts?.find((candidate) => candidate.name === name)
        if (!artifact) return undefined
        const selectedRoot = installed ? activeRoot : bundledRoot
        if (!selectedRoot) return undefined
        const target = path.join(selectedRoot, name)
        const rootInfo = await lstat(selectedRoot)
        const info = await lstat(target)
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !info.isFile() || info.isSymbolicLink()
          || info.nlink !== 1 || info.size !== artifact.bytes
          || !equalPath(await realpath(selectedRoot), path.resolve(selectedRoot))
          || !equalPath(await realpath(target), path.resolve(target))) return undefined
        const bytes = await readFile(target)
        await verifyArchive(artifact, bytes)
        return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      } catch {
        return undefined
      } finally {
        lease.release()
      }
    },
    downloadMedium(input) {
      const observed = parseObservedOcrPreference(input)
      if (!observed) return Promise.reject(appError('INVALID_INPUT'))
      if (disposed || activeMediumLeases > 0) return Promise.reject(appError('OPERATION_FAILED'))
      if (currentFlight) return currentFlight
      // Full already owns this exact, audited generation. Re-enable through the
      // same writer/lease/CAS boundary without downloading or mutating resources.
      if (!installed && bundledManifest?.version === currentVersion) {
        currentFlight = (async () => {
          let mutationLease: MediumMutationLockLease | undefined
          try {
            if (!await ensureStorage()) throw new Error('OCR_MODEL_STORAGE_UNAVAILABLE')
            activationLocked = true
            mutationLease = await acquireMutationLock()
            await refreshInstalled()
            if (activeMediumLeases > 0 || await hasCrossProcessLease()) throw new Error('OCR_MODEL_ACTIVE')
            if (!installed) {
              const audited = bundledRoot ? await auditActive(bundledRoot, pinnedArtifactsByVersion, verifyArchive) : undefined
              if (!audited || audited.version !== currentVersion) throw new Error('OCR_MODEL_INVALID')
              bundledManifest = audited
            }
            if (effectiveVersion() !== currentVersion) throw new Error('OCR_MODEL_INVALID')
            await setPreferredTier('medium', observed)
            mediumRuntimeFailed = false
            status = 'medium-installed'
            progress = null
            errorCode = null
            return emit()
          } catch (error) {
            if (error instanceof OcrPreferenceConflictError) throw error
            throw appError('OPERATION_FAILED')
          } finally {
            activationLocked = false
            await mutationLease?.release()
            currentFlight = undefined
          }
        })()
        return currentFlight
      }
      const stagingRoot = path.join(mediumRoot, `.staging-${randomUUID()}`)
      const backupRoot = path.join(mediumRoot, `.previous-${randomUUID()}`)
      const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)
      const statusBeforeDownload = status
      const errorBeforeDownload = errorCode
      status = 'medium-downloading'
      progress = { receivedBytes: 0, totalBytes }
      errorCode = null
      emit()
      const controller = new AbortController()
      let cancelledByUser = false
      const requestCancel = () => {
        cancelledByUser = true
        controller.abort()
      }
      const throwIfCancelled = () => {
        if (cancelledByUser) throw new DOMException('cancelled', 'AbortError')
      }
      activeAbort = controller
      cancelActiveDownload = requestCancel
      const timeout = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS)
      currentFlight = (async () => {
        let receivedBytes = 0
        let previousMoved = false
        let currentSwitched = false
        let rollbackFailed = false
        let mutationLease: MediumMutationLockLease | undefined
        try {
          if (!await ensureStorage()) throw new Error('OCR_MODEL_STORAGE_UNAVAILABLE')
          await mkdir(stagingRoot, { recursive: false })
          if (options.prepareMedium) {
            await options.prepareMedium(stagingRoot, controller.signal, (next) => {
              if (controller.signal.aborted || disposed) return
              if (!Number.isSafeInteger(next.receivedBytes) || !Number.isSafeInteger(next.totalBytes)
                || next.receivedBytes < 0 || next.totalBytes <= 0 || next.receivedBytes > next.totalBytes
                || next.totalBytes > 2 * 1024 * 1024 * 1024) throw new Error('OCR_MODEL_DOWNLOAD_FAILED')
              progress = { receivedBytes: next.receivedBytes, totalBytes: next.totalBytes }
              emit()
            })
          } else for (const artifact of artifacts) {
            const response = await downloadResponse(artifact, controller.signal)
            const target = path.join(stagingRoot, artifact.name)
            const handle = await open(target, 'wx')
            let artifactBytes = 0
            try {
              const reader = response.body!.getReader()
              while (true) {
                const chunk = await reader.read()
                if (chunk.done) break
                if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0
                  || artifactBytes + chunk.value.byteLength > artifact.bytes) throw new Error('OCR_MODEL_DOWNLOAD_FAILED')
                await handle.write(chunk.value)
                artifactBytes += chunk.value.byteLength
                receivedBytes += chunk.value.byteLength
                progress = { receivedBytes, totalBytes }
                emit()
              }
            } finally {
              await handle.close()
            }
            if (artifactBytes !== artifact.bytes) throw new Error('OCR_MODEL_DOWNLOAD_FAILED')
            await verifyArchive(artifact, await readFile(target))
          }
          throwIfCancelled()
          await writeFile(path.join(stagingRoot, MANIFEST_NAME), `${JSON.stringify(manifestFor(currentVersion, artifacts), null, 2)}\n`, { flag: 'wx' })
          if (!await auditActive(stagingRoot, pinnedArtifactsByVersion, verifyArchive)) throw new Error('OCR_MODEL_INVALID')
          activationLocked = true
          mutationLease = await acquireMutationLock()
          await refreshInstalled()
          throwIfCancelled()
          if (activeMediumLeases > 0 || await hasCrossProcessLease()) throw new Error('OCR_MODEL_ACTIVE')
          throwIfCancelled()
          const preferredTierBeforeCommit = getPreferredTier()
          const installedBeforeCommit = installed
          const installedVersionBeforeCommit = installed ? installedVersion : null
          if (installedBeforeCommit && installedVersionBeforeCommit === null) {
            throw new Error('OCR_MODEL_INVALID')
          }
          let preferenceCommitted = false
          try {
            await writeTransaction({
              kind: 'replace',
              staging: path.basename(stagingRoot),
              previous: path.basename(backupRoot),
              phase: 'prepared',
              hadPrevious: installed,
              observed,
            })
            throwIfCancelled()
            if (installed) {
              await rename(activeRoot, backupRoot)
              previousMoved = true
              throwIfCancelled()
            }
            await writeTransaction({
              kind: 'replace',
              staging: path.basename(stagingRoot),
              previous: path.basename(backupRoot),
              phase: 'previous-moved',
              hadPrevious: previousMoved,
              observed,
            })
            throwIfCancelled()
            await rename(stagingRoot, activeRoot)
            currentSwitched = true
            throwIfCancelled()
            await writeTransaction({
              kind: 'replace',
              staging: path.basename(stagingRoot),
              previous: path.basename(backupRoot),
              phase: 'current-switched',
              hadPrevious: previousMoved,
              observed,
            })
            throwIfCancelled()
            if (!await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)) throw new Error('OCR_MODEL_INVALID')
            throwIfCancelled()
            await setPreferredTier('medium', observed)
            preferenceCommitted = true
            await writeTransaction({
              kind: 'replace',
              staging: path.basename(stagingRoot),
              previous: path.basename(backupRoot),
              phase: 'preference-persisted',
              hadPrevious: previousMoved,
              observed,
            })
          } catch (error) {
            if (!preferenceCommitted) {
              try {
                await writeTransaction({
                  kind: 'replace-rollback',
                  staging: path.basename(stagingRoot),
                  previous: path.basename(backupRoot),
                  hadPrevious: installedBeforeCommit,
                  previousVersion: installedVersionBeforeCommit,
                  preferredTier: preferredTierBeforeCommit,
                  observed,
                })
                if (currentSwitched) await rm(activeRoot, { recursive: true, force: true })
                if (previousMoved) {
                  await rename(backupRoot, activeRoot)
                  previousMoved = false
                  if (!await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive)) throw new Error('OCR_MODEL_ROLLBACK_FAILED')
                }
                await rm(transactionPath, { force: true })
              } catch {
                rollbackFailed = true
                throw new Error('OCR_MODEL_ROLLBACK_FAILED')
              }
              throw error
            }
            // A postcommit cancellation/phase-cleanup failure cannot undo the
            // acknowledged tier or remove its active model resources.
          }
          installed = true
          installedVersion = currentVersion
          mediumRuntimeFailed = false
          status = 'medium-installed'
          progress = null
          errorCode = null
          await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
          await rm(transactionPath, { force: true }).catch(() => undefined)
          return emit()
        } catch (error) {
          try {
            installedManifest = storageAvailable ? await auditActive(activeRoot, pinnedArtifactsByVersion, verifyArchive) : undefined
          } catch {
            // Preserve all recovery material, settle public progress, and require
            // fresh successful recovery before another mutation can proceed.
            storageAvailable = false
            installedManifest = undefined
            rollbackFailed = true
          }
          installed = installedManifest !== undefined
          installedVersion = installedManifest?.version ?? null
          if (rollbackFailed) {
            status = 'medium-failed'
            progress = null
            errorCode = 'OPERATION_FAILED'
            emit()
            throw appError('OPERATION_FAILED')
          }
          if (cancelledByUser) {
            status = installed
              ? statusBeforeDownload === 'medium-update-available' || statusBeforeDownload === 'medium-failed'
                ? statusBeforeDownload
                : 'medium-installed'
              : 'medium-absent'
            progress = null
            errorCode = status === 'medium-failed' ? errorBeforeDownload : null
            return emit()
          }
          status = 'medium-failed'
          progress = null
          errorCode = 'OPERATION_FAILED'
          const failed = emit()
          if (error instanceof OcrPreferenceConflictError) throw error
          return failed
        } finally {
          activationLocked = false
          await mutationLease?.release()
          clearTimeout(timeout)
          await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined)
          if (!previousMoved) await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
          if (activeAbort === controller) activeAbort = undefined
          if (cancelActiveDownload === requestCancel) cancelActiveDownload = undefined
          currentFlight = undefined
        }
      })()
      return currentFlight
    },
    cancelMediumDownload() {
      cancelActiveDownload?.()
      return currentFlight ?? Promise.resolve(publicState(state()))
    },
    removeMedium(input) {
      const observed = parseObservedOcrPreference(input)
      if (!observed) return Promise.reject(appError('INVALID_INPUT'))
      if (disposed || currentFlight || activeMediumLeases > 0) return Promise.reject(appError('OPERATION_FAILED'))
      const removalRoot = path.join(mediumRoot, `.removing-${randomUUID()}`)
      currentFlight = (async () => {
        let mutationLease: MediumMutationLockLease | undefined
        try {
          if (!await ensureStorage()) throw new Error('OCR_MODEL_STORAGE_UNAVAILABLE')
          activationLocked = true
          mutationLease = await acquireMutationLock()
          await refreshInstalled()
          if (activeMediumLeases > 0 || await hasCrossProcessLease()) throw new Error('OCR_MODEL_ACTIVE')
          if (observed.mediumSource !== undefined && observed.mediumSource !== mediumSource()) throw new OcrPreferenceConflictError()
          if (!installed) {
            await setPreferredTier('small', observed)
            status = 'medium-absent'
            progress = null
            errorCode = null
            return emit()
          }
          await writeTransaction({ kind: 'remove', removing: path.basename(removalRoot), observed })
          await rename(activeRoot, removalRoot)
          try {
            await setPreferredTier('small', observed)
          } catch (error) {
            await rename(removalRoot, activeRoot)
            throw error
          }
          installed = false
          installedManifest = undefined
          installedVersion = null
          mediumRuntimeFailed = false
          status = 'medium-absent'
          progress = null
          errorCode = null
          await rm(transactionPath, { force: true }).catch(() => undefined)
          await rm(removalRoot, { recursive: true, force: true }).catch(() => undefined)
          return emit()
        } catch (error) {
          if (error instanceof OcrPreferenceConflictError) throw error
          if (error instanceof Error && 'code' in error && error.code === 'OPERATION_FAILED') throw error
          throw appError('OPERATION_FAILED')
        } finally {
          activationLocked = false
          await mutationLease?.release()
          currentFlight = undefined
        }
      })()
      return currentFlight
    },
    dispose() {
      disposePromise ??= (async () => {
        disposed = true
        activeAbort?.abort()
        await currentFlight?.catch(() => undefined)
        if (activeMediumLeases > 0) {
          await new Promise<void>((resolve) => leaseWaiters.add(resolve))
        }
        for (const [leasePath, token] of leaseFiles) {
          if (removeOwnedLeaseMarker(leasePath, token)) leaseFiles.delete(leasePath)
        }
        // This namespace is shared by every Arkdown process using the same data root.
        // Never remove it from one manager's dispose path: another process may be
        // publishing a lease between a directory emptiness check and removal.
      })()
      return disposePromise
    },
  }
  return manager
}
