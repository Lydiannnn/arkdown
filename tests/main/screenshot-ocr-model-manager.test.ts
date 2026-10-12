import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename as renameFileForTest, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCREENSHOT_OCR_MEDIUM_ARTIFACTS,
  SCREENSHOT_OCR_MEDIUM_VERSION,
} from '../../src/shared/screenshot-ocr-manifest'
import { acquireMediumMutationLock } from '../../src/main/screenshot-translation/medium-mutation-lock'
import { ScreenshotOcrValidationUnavailableError } from '../../src/main/screenshot-translation/screenshot-ocr-validation'
import { createLazyScreenshotOcrModelManager } from '../../src/main/screenshot-translation/lazy-screenshot-ocr-model-manager'
import { DEFAULT_SETTINGS } from '../../src/main/settings/settings-store'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import type { SettingsTransactionRequest, SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'
import { createScreenshotOcrModelManager as createActualScreenshotOcrModelManager,
  type ScreenshotOcrModelManagerOptions } from '../../src/main/screenshot-translation/screenshot-ocr-model-manager'
import type { ObservedOcrPreference } from '../../src/shared/screenshot-ocr-models'

const roots: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'arkdown-ocr-manager-'))
  roots.push(value)
  return value
}

function tar(model: string, payload = model): Uint8Array {
  const entries: Array<[string, Uint8Array, '0' | '5']> = [
    [`${model}/`, new Uint8Array(), '5'],
    [`${model}/inference.onnx`, new TextEncoder().encode(payload), '0'],
    [`${model}/inference.yml`, new TextEncoder().encode(`Global:\n  model_name: ${model.replace('_onnx_infer', '')}\n`), '0'],
  ]
  const blocks: Uint8Array[] = []
  for (const [name, bytes, type] of entries) {
    const header = new Uint8Array(512)
    header.set(new TextEncoder().encode(name), 0)
    header.set(new TextEncoder().encode(bytes.byteLength.toString(8).padStart(11, '0') + '\0'), 124)
    header[156] = type.charCodeAt(0)
    header.set(new TextEncoder().encode('ustar '), 257)
    header[263] = 0x20
    for (let index = 148; index < 156; index += 1) header[index] = 0x20
    const checksum = header.reduce((sum, value) => sum + value, 0)
    header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148)
    blocks.push(header, bytes, new Uint8Array((512 - (bytes.byteLength % 512)) % 512))
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) { result.set(block, offset); offset += block.byteLength }
  return result
}

const detBytes = tar('PP-OCRv6_medium_det_onnx_infer')
const recBytes = tar('PP-OCRv6_medium_rec_onnx_infer')
const priorDetBytes = tar('PP-OCRv6_medium_det_onnx_infer', 'prior-det')
const priorRecBytes = tar('PP-OCRv6_medium_rec_onnx_infer', 'prior-rec')
const fixtureArtifacts = [
  {
    ...SCREENSHOT_OCR_MEDIUM_ARTIFACTS[0],
    bytes: detBytes.byteLength,
    sha256: createHash('sha256').update(detBytes).digest('hex'),
  },
  {
    ...SCREENSHOT_OCR_MEDIUM_ARTIFACTS[1],
    bytes: recBytes.byteLength,
    sha256: createHash('sha256').update(recBytes).digest('hex'),
  },
] as const
const priorFixtureArtifacts = [
  {
    ...SCREENSHOT_OCR_MEDIUM_ARTIFACTS[0],
    bytes: priorDetBytes.byteLength,
    sha256: createHash('sha256').update(priorDetBytes).digest('hex'),
  },
  {
    ...SCREENSHOT_OCR_MEDIUM_ARTIFACTS[1],
    bytes: priorRecBytes.byteLength,
    sha256: createHash('sha256').update(priorRecBytes).digest('hex'),
  },
] as const

function writeTarChecksum(bytes: Uint8Array, headerOffset = 0): void {
  for (let index = headerOffset + 148; index < headerOffset + 156; index += 1) bytes[index] = 0x20
  const checksum = bytes.subarray(headerOffset, headerOffset + 512).reduce((sum, value) => sum + value, 0)
  bytes.set(new TextEncoder().encode(checksum.toString(8).padStart(6, '0') + '\0 '), headerOffset + 148)
}

function chunks(bytes: Uint8Array, size = bytes.byteLength): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size))
      }
      controller.close()
    },
  })
}

function response(bytes: Uint8Array, options: { status?: number; location?: string; length?: string; chunk?: number } = {}): Response {
  const headers = new Headers()
  if (options.location) headers.set('location', options.location)
  headers.set('content-length', options.length ?? String(bytes.byteLength))
  return new Response(chunks(bytes, options.chunk), { status: options.status ?? 200, headers })
}

function successfulFetch() {
  return vi.fn(async (url: string, _init?: RequestInit) => response(url.includes('_det_') ? detBytes : recBytes))
}

function authoritativeSettings() {
  let snapshot: SettingsTransactionSnapshot = { settings: structuredClone(DEFAULT_SETTINGS), revision: 0,
    minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
  const settings = {
    readFresh: async () => structuredClone(snapshot), getDisplaySnapshot: () => structuredClone(snapshot),
    apply: vi.fn(async (request: SettingsTransactionRequest) => {
      const result = reduceSettingsTransaction(snapshot, request)
      if (result.status !== 'prepared') return result
      snapshot = result.snapshot
      return { status: 'committed' as const, cleanupPending: true, snapshot: structuredClone(snapshot) }
    }),
  }
  const setTier = async (value: 'small' | 'medium') => settings.apply({ baseRevision: snapshot.revision,
    operations: [{ kind: 'screenshot-ocr.set-tier', value, expected: {
      value: snapshot.settings.screenshotOcr?.preferredTier ?? 'small',
      revision: snapshot.fieldRevisions.fields['screenshotOcr.preferredTier'] ?? 0,
    } }] })
  return { settings, setTier, snapshot: () => structuredClone(snapshot) }
}

/** Existing resource fixtures keep their injected persistence faults. Production
 * receives only SettingsAuthority; every direct test action captures a new observation. */
async function createScreenshotOcrModelManager(options: Omit<ScreenshotOcrModelManagerOptions, 'settings'> & {
  settings?: ScreenshotOcrModelManagerOptions['settings']; getPreferredTier(): 'small' | 'medium';
  setPreferredTier(value: 'small' | 'medium'): Promise<unknown>;
}) {
  let snapshot: SettingsTransactionSnapshot = { settings: { ...structuredClone(DEFAULT_SETTINGS),
    screenshotOcr: { preferredTier: options.getPreferredTier() } }, revision: 0, minimumBaseRevision: 0,
    fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
  const settings: ScreenshotOcrModelManagerOptions['settings'] = options.settings ?? {
    readFresh: async () => structuredClone(snapshot),
    getDisplaySnapshot: () => ({ ...structuredClone(snapshot), settings: { ...snapshot.settings,
      screenshotOcr: { preferredTier: options.getPreferredTier() } } }),
    apply: async request => {
      const result = reduceSettingsTransaction(snapshot, request)
      if (result.status !== 'prepared') return result
      await options.setPreferredTier(result.snapshot.settings.screenshotOcr!.preferredTier)
      snapshot = result.snapshot
      return { status: 'committed', cleanupPending: false, snapshot: structuredClone(snapshot) }
    },
  }
  const value = await createActualScreenshotOcrModelManager({ ...options, settings })
  const observed = (): ObservedOcrPreference => {
    const current = settings.getDisplaySnapshot()
    return { revision: current.revision, preferredTier: current.settings.screenshotOcr?.preferredTier ?? 'small',
      tierRevision: current.fieldRevisions.fields['screenshotOcr.preferredTier'] ?? 0 }
  }
  return { ...value, downloadMedium: (input: ObservedOcrPreference = observed()) => value.downloadMedium(input),
    removeMedium: (input: ObservedOcrPreference = observed()) => value.removeMedium(input) }
}

async function manager(options: Record<string, unknown> = {}) {

  const dataRoot = await root()
  let preferredTier: 'small' | 'medium' = 'small'
  return {
    dataRoot,
    preferredTier: () => preferredTier,
    value: await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferredTier,
      setPreferredTier: async (tier: 'small' | 'medium') => { preferredTier = tier },
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      ...options,
    }),
  }
}

describe('screenshot OCR Medium model manager', () => {
  it.each([
    { legacy: false, newerSmall: false }, { legacy: false, newerSmall: true }, { legacy: true, newerSmall: true },
  ])('recovers a switched generation without overwriting committed/current preference %j', async ({ legacy, newerSmall }) => {
    const authority = authoritativeSettings()
    const h = await manager({ settings: authority.settings })
    const original = { revision: 0, preferredTier: 'small' as const, tierRevision: 0 }
    await h.value.downloadMedium(original); await h.value.dispose()
    if (newerSmall) await authority.setTier('small')
    const revision = authority.snapshot().revision
    const mediumRoot = path.join(h.dataRoot, 'screenshot-ocr', 'medium')
    await writeFile(path.join(mediumRoot, 'transaction.json'), JSON.stringify({ kind: 'replace',
      staging: '.staging-123e4567-e89b-42d3-a456-426614174000',
      previous: '.previous-223e4567-e89b-42d3-a456-426614174000', phase: 'current-switched', hadPrevious: false,
      ...(legacy ? {} : { observed: original }),
    }))
    authority.settings.apply.mockClear()
    const recovered = await createActualScreenshotOcrModelManager({ dataRoot: h.dataRoot, settings: authority.settings,
      fetch: successfulFetch(), artifacts: fixtureArtifacts })
    expect(authority.snapshot().revision).toBe(revision)
    expect(recovered.getState()).toMatchObject({ activeTier: newerSmall ? 'small' : 'medium',
      status: 'medium-installed', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION })
    expect(await readFile(path.join(mediumRoot, 'current', 'medium-det.tar'))).toEqual(Buffer.from(detBytes))
    if (legacy) expect(authority.settings.apply).not.toHaveBeenCalled()
    else expect(authority.settings.apply).toHaveBeenCalledWith({ baseRevision: 0, operations: [{
      kind: 'screenshot-ocr.set-tier', value: 'medium', expected: { value: 'small', revision: 0 },
    }] })
    await expect(readFile(path.join(mediumRoot, 'transaction.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await recovered.dispose()
  })

  it('keeps the original OCR preference revision across a download and rejects a concurrent ABA without changing it', async () => {
    let snapshot: SettingsTransactionSnapshot = { settings: structuredClone(DEFAULT_SETTINGS), revision: 0,
      minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
    const settings = {
      readFresh: async () => structuredClone(snapshot), getDisplaySnapshot: () => structuredClone(snapshot),
      apply: vi.fn(async (request: SettingsTransactionRequest) => {
        const result = reduceSettingsTransaction(snapshot, request)
        if (result.status !== 'prepared') return result
        snapshot = result.snapshot
        return { status: 'committed' as const, cleanupPending: true, snapshot: structuredClone(snapshot) }
      }),
    }
    const updateTier = async (value: 'small' | 'medium') => settings.apply({ baseRevision: snapshot.revision,
      operations: [{ kind: 'screenshot-ocr.set-tier', value, expected: {
        value: snapshot.settings.screenshotOcr?.preferredTier ?? 'small',
        revision: snapshot.fieldRevisions.fields['screenshotOcr.preferredTier'] ?? 0,
      } }] })
    let finishDownload!: () => void
    const blocked = new Promise<void>(resolve => { finishDownload = resolve })
    const fetch = vi.fn(async (url: string) => { await blocked; return response(url.includes('_det_') ? detBytes : recBytes) })
    const h = await manager({ settings, fetch, getPreferredTier: () => snapshot.settings.screenshotOcr?.preferredTier ?? 'small',
      setPreferredTier: updateTier })
    const input: ObservedOcrPreference = { revision: 0, preferredTier: 'small', tierRevision: 0 }
    const downloading = h.value.downloadMedium(input)
    const rejected = expect(downloading).rejects.toMatchObject({ name: 'OcrPreferenceConflictError' })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    await updateTier('medium'); await updateTier('small')
    input.revision = 2; input.tierRevision = 2 // Caller mutation must not reauthorize the pending download.
    finishDownload()
    await rejected
    expect(snapshot.settings.screenshotOcr?.preferredTier).toBe('small')
    expect(snapshot.revision).toBe(2)
    expect(h.value.getState().mediumVersion).toBeNull()
    await h.value.dispose()
  })

  it('restores a pending removal on preference conflict and permits a new explicit observed removal', async () => {
    const authority = authoritativeSettings()
    const h = await manager({ settings: authority.settings })
    await h.value.downloadMedium((await h.value.getObservedState()).observed)
    const original = (await h.value.getObservedState()).observed
    await authority.setTier('small'); await authority.setTier('medium')
    await expect(h.value.removeMedium(original)).rejects.toMatchObject({ name: 'OcrPreferenceConflictError' })
    expect(h.value.getState()).toMatchObject({ activeTier: 'medium', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION })
    expect(await readFile(path.join(h.dataRoot, 'screenshot-ocr/medium/current/medium-det.tar'))).toEqual(Buffer.from(detBytes))
    expect(authority.snapshot().settings.screenshotOcr?.preferredTier).toBe('medium')
    await expect(h.value.removeMedium((await h.value.getObservedState()).observed)).resolves.toMatchObject({
      activeTier: 'small', status: 'medium-absent', mediumVersion: null,
    })
    await h.value.dispose()
  })

  it('falls back to Small without modifying bundled Medium when its validator cannot start', async () => {
    const bundledMediumRoot = await root()
    await writeFile(path.join(bundledMediumRoot, 'medium-det.tar'), detBytes)
    await writeFile(path.join(bundledMediumRoot, 'medium-rec.tar'), recBytes)
    await writeFile(path.join(bundledMediumRoot, 'manifest.json'), JSON.stringify({ version: SCREENSHOT_OCR_MEDIUM_VERSION,
      artifacts: fixtureArtifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) }))
    const h = await manager({ bundledMediumRoot, getPreferredTier: () => 'medium',
      verifyArchive: async () => { throw new ScreenshotOcrValidationUnavailableError() } })
    expect(h.value.getState()).toMatchObject({ activeTier: 'small', status: 'medium-failed', progress: null, errorCode: 'OPERATION_FAILED' })
    const lease = h.value.acquireTier()
    expect(lease.tier).toBe('small')
    lease.release()
    expect(await readFile(path.join(bundledMediumRoot, 'medium-det.tar'))).toEqual(Buffer.from(detBytes))
    await h.value.dispose()
  })

  it('settles download state and preserves installed files when the recovery validator fails', async () => {
    const { verifyScreenshotOcrArchive } = await import('../../src/main/screenshot-translation/screenshot-ocr-archive-validation')
    let unavailable = false
    const h = await manager({ verifyArchive: async (...args: Parameters<typeof verifyScreenshotOcrArchive>) => {
      if (unavailable) throw new ScreenshotOcrValidationUnavailableError()
      return verifyScreenshotOcrArchive(...args)
    } })
    await h.value.downloadMedium()
    unavailable = true
    await expect(h.value.downloadMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(h.value.getState()).toMatchObject({ status: 'medium-failed', progress: null, errorCode: 'OPERATION_FAILED' })
    expect(await readFile(path.join(h.dataRoot, 'screenshot-ocr', 'medium', 'current', 'medium-det.tar'))).toEqual(Buffer.from(detBytes))
    await expect(h.value.cancelMediumDownload()).resolves.toMatchObject({ status: 'medium-failed' })
    unavailable = false
    await expect(h.value.downloadMedium()).resolves.toMatchObject({ status: 'medium-installed' })
    await h.value.dispose()
  })

  it('preserves installed archives when validation infrastructure is unavailable', async () => {
    const installed = await manager()
    await installed.value.downloadMedium()
    await installed.value.dispose()
    const h = await manager({ dataRoot: installed.dataRoot,
      verifyArchive: async () => { throw new ScreenshotOcrValidationUnavailableError() } })
    expect(h.value.getState()).toMatchObject({ status: 'medium-failed', activeTier: 'small' })
    expect(await readFile(path.join(installed.dataRoot, 'screenshot-ocr', 'medium', 'current', 'medium-det.tar')))
      .toEqual(Buffer.from(detBytes))
    await h.value.dispose()
  })

  it('keeps the real Medium lease alive until release when the lazy facade is disposed', async () => {
    const h = await manager()
    const lazy = createLazyScreenshotOcrModelManager({ dataRoot: h.dataRoot,
      settings: authoritativeSettings().settings }, async () => h.value)
    await lazy.downloadMedium((await h.value.getObservedState()).observed)
    const lease = await lazy.acquireTier()
    expect(lease.tier).toBe('medium')
    let disposed = false
    const closing = lazy.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(await readdir(path.join(h.dataRoot, 'screenshot-ocr', 'medium', '.leases'))).toHaveLength(1)
    lease.release()
    await closing
    expect(await readdir(path.join(h.dataRoot, 'screenshot-ocr', 'medium', '.leases'))).toEqual([])
  })

  it('awaits delegated archive validation before activation and fails closed on rejection', async () => {
    let unblock!: () => void
    const waiting = new Promise<void>((resolve) => { unblock = resolve })
    let validationStarted!: () => void
    const started = new Promise<void>((resolve) => { validationStarted = resolve })
    const h = await manager({ verifyArchive: async () => {
      validationStarted()
      await waiting
      throw new Error('OCR_MODEL_INVALID')
    } })
    const installing = h.value.downloadMedium()
    await started
    expect(h.value.getState()).toMatchObject({ status: 'medium-downloading', mediumVersion: null, activeTier: 'small' })
    unblock()
    expect(await installing).toMatchObject({ status: 'medium-failed', mediumVersion: null, activeTier: 'small' })
    expect(await h.value.resolveActiveResource('medium-det.tar')).toBeUndefined()
    await h.value.dispose()
  })

  it('uses Full preinstalled Medium offline and never removes its files', async () => {
    const bundledMediumRoot = await root()
    await writeFile(path.join(bundledMediumRoot, 'medium-det.tar'), detBytes)
    await writeFile(path.join(bundledMediumRoot, 'medium-rec.tar'), recBytes)
    const manifest = JSON.stringify({ version: SCREENSHOT_OCR_MEDIUM_VERSION,
      artifacts: fixtureArtifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) })
    await writeFile(path.join(bundledMediumRoot, 'manifest.json'), manifest)
    const fetch = vi.fn(async () => { throw new Error('network must stay unused') })
    let preferred: 'small' | 'medium' = 'medium'
    const h = await manager({ bundledMediumRoot, fetch,
      getPreferredTier: () => preferred, setPreferredTier: async (tier: 'small' | 'medium') => { preferred = tier } })
    expect(h.value.getState()).toMatchObject({ status: 'medium-installed', activeTier: 'medium' })
    const lease = h.value.acquireTier()
    expect(lease.tier).toBe('medium')
    expect(await h.value.resolveActiveResource('medium-det.tar')).toEqual(detBytes)
    await expect(h.value.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    lease.release()
    await h.value.removeMedium()
    expect(preferred).toBe('small')
    expect(await readFile(path.join(bundledMediumRoot, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(h.value.getState()).toMatchObject({ status: 'medium-disabled', mediumSource: 'bundled', activeTier: 'small', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION })
    expect(fetch).not.toHaveBeenCalled()
    await h.value.dispose()
  })

  it('persists bundled disable across managers and re-enables it offline without copying or deleting resources', async () => {
    const bundledMediumRoot = await root()
    await writeFile(path.join(bundledMediumRoot, 'medium-det.tar'), detBytes)
    await writeFile(path.join(bundledMediumRoot, 'medium-rec.tar'), recBytes)
    const manifest = JSON.stringify({ version: SCREENSHOT_OCR_MEDIUM_VERSION,
      artifacts: fixtureArtifacts.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })) })
    await writeFile(path.join(bundledMediumRoot, 'manifest.json'), manifest)
    const authority = authoritativeSettings()
    await authority.setTier('medium')
    const fetch = vi.fn(async () => { throw new Error('offline') })
    const dataRoot = await root()
    const config = { dataRoot, bundledMediumRoot, settings: authority.settings, artifacts: fixtureArtifacts, fetch }
    const first = await createActualScreenshotOcrModelManager(config)
    expect((await first.getObservedState()).observed).toMatchObject({ mediumSource: 'bundled' })
    await first.removeMedium((await first.getObservedState()).observed)
    await first.dispose()
    const reopened = await createActualScreenshotOcrModelManager(config)
    expect((await reopened.getObservedState()).state).toMatchObject({ status: 'medium-disabled', mediumSource: 'bundled', activeTier: 'small' })
    await expect(reopened.downloadMedium((await reopened.getObservedState()).observed)).resolves.toMatchObject({
      status: 'medium-installed', mediumSource: 'bundled', activeTier: 'medium', progress: null,
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(await readdir(bundledMediumRoot)).toHaveLength(3)
    expect(await readFile(path.join(bundledMediumRoot, 'manifest.json'), 'utf8')).toBe(manifest)
    expect(await readFile(path.join(bundledMediumRoot, 'medium-det.tar'))).toEqual(Buffer.from(detBytes))
    expect(await readFile(path.join(bundledMediumRoot, 'medium-rec.tar'))).toEqual(Buffer.from(recBytes))
    await expect(lstat(path.join(dataRoot, 'screenshot-ocr/medium/current'))).rejects.toMatchObject({ code: 'ENOENT' })
    const peer = await createActualScreenshotOcrModelManager(config)
    const lease = reopened.acquireTier()
    await expect(peer.removeMedium((await peer.getObservedState()).observed)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    lease.release()
    const stale = (await peer.getObservedState()).observed
    await authority.setTier('small'); await authority.setTier('medium')
    await expect(peer.removeMedium(stale)).rejects.toMatchObject({ name: 'OcrPreferenceConflictError' })
    expect(authority.snapshot().settings.screenshotOcr?.preferredTier).toBe('medium')
    await peer.removeMedium((await peer.getObservedState()).observed)
    const staleEnable = (await peer.getObservedState()).observed
    await authority.setTier('medium'); await authority.setTier('small')
    await expect(peer.downloadMedium(staleEnable)).rejects.toMatchObject({ name: 'OcrPreferenceConflictError' })
    expect(peer.getState()).toMatchObject({ status: 'medium-disabled', activeTier: 'small' })
    expect(fetch).not.toHaveBeenCalled()
    await peer.dispose(); await reopened.dispose()
  })

  it('does not delete a newly installed managed copy when the user confirmed only bundled disable', async () => {
    const authority = authoritativeSettings()
    const h = await manager({ settings: authority.settings })
    await h.value.downloadMedium((await h.value.getObservedState()).observed)
    const bundledMediumRoot = await root()
    await cp(path.join(h.dataRoot, 'screenshot-ocr/medium/current'), bundledMediumRoot, { recursive: true })
    const dataRoot = await root()
    const full = await createActualScreenshotOcrModelManager({ dataRoot, bundledMediumRoot, settings: authority.settings, artifacts: fixtureArtifacts })
    const observed = { ...(await full.getObservedState()).observed, mediumSource: 'bundled' as const }
    await cp(path.join(h.dataRoot, 'screenshot-ocr/medium/current'), path.join(dataRoot, 'screenshot-ocr/medium/current'), { recursive: true })
    await expect(full.removeMedium(observed)).rejects.toMatchObject({ name: 'OcrPreferenceConflictError' })
    expect(await readFile(path.join(dataRoot, 'screenshot-ocr/medium/current/medium-det.tar'))).toEqual(Buffer.from(detBytes))
    expect(authority.snapshot().settings.screenshotOcr?.preferredTier).toBe('medium')
    await full.dispose(); await h.value.dispose()
  })

  it('refreshes another process preference before and after a new lazy OCR lease', async () => {
    const authority = authoritativeSettings()
    const source = await manager({ settings: authority.settings })
    await source.value.downloadMedium((await source.value.getObservedState()).observed)
    await source.value.dispose()
    let cached = authority.snapshot()
    let disableAfterRead = false
    const settings = { ...authority.settings,
      getDisplaySnapshot: () => structuredClone(cached),
      readFresh: async () => {
        cached = authority.snapshot()
        if (disableAfterRead) { disableAfterRead = false; await authority.setTier('small') }
        return structuredClone(cached)
      },
    }
    const dataRoot = await root()
    const lazy = createLazyScreenshotOcrModelManager({ dataRoot,
      bundledMediumRoot: path.join(source.dataRoot, 'screenshot-ocr/medium/current'),
      settings, artifacts: fixtureArtifacts }, createActualScreenshotOcrModelManager)
    await lazy.initialize()
    await authority.setTier('small')
    const disabledLease = await lazy.acquireTier()
    expect(disabledLease.tier).toBe('small')
    disabledLease.release()
    await authority.setTier('medium')
    disableAfterRead = true
    const racedLease = await lazy.acquireTier()
    expect(racedLease.tier).toBe('small')
    racedLease.release()
    expect((await readdir(path.join(dataRoot, 'screenshot-ocr/medium/.leases'))).filter(name => name.endsWith('.lease'))).toEqual([])
    await lazy.dispose()
  })

  it('reports retained bundled resources as disabled after deleting a managed Medium generation', async () => {
    const authority = authoritativeSettings()
    const h = await manager({ settings: authority.settings })
    await h.value.downloadMedium((await h.value.getObservedState()).observed)
    await h.value.dispose()
    const bundledMediumRoot = await root()
    await cp(path.join(h.dataRoot, 'screenshot-ocr/medium/current'), bundledMediumRoot, { recursive: true })
    const full = await createActualScreenshotOcrModelManager({ dataRoot: h.dataRoot, bundledMediumRoot,
      settings: authority.settings, artifacts: fixtureArtifacts, fetch: successfulFetch() })
    expect(full.getState()).toMatchObject({ mediumSource: 'managed' })
    await expect(full.removeMedium((await full.getObservedState()).observed)).resolves.toMatchObject({
      status: 'medium-disabled', mediumSource: 'bundled', activeTier: 'small', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
    })
    await expect(lstat(path.join(h.dataRoot, 'screenshot-ocr/medium/current'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(bundledMediumRoot, 'medium-rec.tar'))).toEqual(Buffer.from(recBytes))
    await full.dispose()
  })

  it('activates an injected GitHub preparation only after verifying the pinned inner archives', async () => {
    const fetch = vi.fn(async () => { throw new Error('legacy source must stay unused') })
    const prepareMedium = vi.fn(async (stagingRoot: string) => {
      await writeFile(path.join(stagingRoot, 'medium-det.tar'), detBytes)
      await writeFile(path.join(stagingRoot, 'medium-rec.tar'), recBytes)
    })
    const h = await manager({ fetch, prepareMedium })
    expect(await h.value.downloadMedium()).toMatchObject({ status: 'medium-installed', activeTier: 'medium' })
    expect(prepareMedium).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    await h.value.dispose()
    const invalid = await manager({ fetch, prepareMedium: async (stagingRoot: string) => {
      await writeFile(path.join(stagingRoot, 'medium-det.tar'), new Uint8Array(detBytes.length))
      await writeFile(path.join(stagingRoot, 'medium-rec.tar'), recBytes)
    } })
    expect(await invalid.value.downloadMedium()).toMatchObject({ status: 'medium-failed', activeTier: 'small' })
    expect(await invalid.value.resolveActiveResource('medium-det.tar')).toBeUndefined()
    await invalid.value.dispose()
  })

  it('starts absent, downloads only the two fixed official HTTPS artifacts, verifies, and activates the exact pair', async () => {
    const fetch = successfulFetch()
    const states: unknown[] = []
    const { dataRoot, value } = await manager({ fetch, onState: (state: unknown) => states.push(state) })

    expect(value.getState()).toEqual({
      activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null, mediumSource: null,
      availableMediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
      status: 'medium-absent', progress: null, errorCode: null,
    })
    await expect(value.downloadMedium()).resolves.toMatchObject({
      activeTier: 'medium', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
      status: 'medium-installed', progress: null, errorCode: null,
    })
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.redirect])).toEqual(
      SCREENSHOT_OCR_MEDIUM_ARTIFACTS.map(({ url }) => [url, 'manual']),
    )
    const active = path.join(dataRoot, 'screenshot-ocr', 'medium', 'current')
    expect((await readdir(active)).sort()).toEqual(['manifest.json', 'medium-det.tar', 'medium-rec.tar'])
    expect(await readFile(path.join(active, 'medium-det.tar'))).toEqual(Buffer.from(detBytes))
    const progress = states
      .filter((state: any) => state.status === 'medium-downloading')
      .map((state: any) => state.progress)
    expect(progress.length).toBeGreaterThan(1)
    expect(progress.every((item: any) => item.totalBytes === detBytes.byteLength + recBytes.byteLength)).toBe(true)
    expect(progress.map((item: any) => item.receivedBytes)).toEqual(
      [...progress.map((item: any) => item.receivedBytes)].sort((a, b) => a - b),
    )
    expect(states.at(-1)).toMatchObject({ status: 'medium-installed', activeTier: 'medium' })
  })

  it('falls back to Small when Medium is absent or the persisted preference is Small', async () => {
    let preferred: 'small' | 'medium' = 'medium'
    const { value } = await manager({ getPreferredTier: () => preferred, setPreferredTier: async () => undefined })
    expect(value.resolveActiveTier()).toBe('small')
    await value.downloadMedium()
    expect(value.resolveActiveTier()).toBe('medium')
    preferred = 'small'
    expect(value.resolveActiveTier()).toBe('small')
    expect(value.getState().activeTier).toBe('small')
  })

  it('marks an installed Medium runtime unavailable with bounded state and keeps later sessions on Small', async () => {
    const states: unknown[] = []
    const { value } = await manager({ onState: (state: unknown) => states.push(state) })
    await value.downloadMedium()
    value.reportTierUnavailable('medium')
    expect(value.getState()).toMatchObject({
      activeTier: 'small', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
      status: 'medium-failed', errorCode: 'OPERATION_FAILED', progress: null,
    })
    expect(value.acquireTier().tier).toBe('small')
    expect(states.at(-1)).toEqual(value.getState())
  })

  it.each([
    ['insecure redirect', () => response(new Uint8Array(), { status: 302, location: 'http://paddle-model-ecology.bj.bcebos.com/model.tar' })],
    ['foreign redirect', () => response(new Uint8Array(), { status: 302, location: 'https://example.com/model.tar' })],
    ['credential redirect', () => response(new Uint8Array(), { status: 302, location: 'https://user@paddle-model-ecology.bj.bcebos.com/model.tar' })],
    ['query redirect', () => response(new Uint8Array(), { status: 302, location: `${fixtureArtifacts[0].url}?token=private` })],
    ['wrong content length', () => response(detBytes, { length: String(detBytes.byteLength + 1) })],
    ['hash mismatch', () => response(detBytes.map((byte, index) => index === 600 ? byte ^ 1 : byte))],
    ['interrupted response', () => new Response(new ReadableStream({ start(controller) { controller.enqueue(detBytes.slice(0, 512)); controller.error(new Error('private')) } }), { status: 200 })],
  ])('fails closed for %s without activating partial bytes or exposing private errors', async (_name, firstResponse) => {
    const fetch = vi.fn(async () => firstResponse())
    const { dataRoot, value } = await manager({ fetch })
    await expect(value.downloadMedium()).resolves.toMatchObject({
      activeTier: 'small', mediumVersion: null, status: 'medium-failed',
      progress: null, errorCode: 'OPERATION_FAILED',
    })
    await expect(readdir(path.join(dataRoot, 'screenshot-ocr', 'medium', 'current'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(value.getState())).not.toContain('private')
  })

  it('rejects an over-limit stream even when Content-Length is absent', async () => {
    const huge = new Uint8Array(detBytes.byteLength + 1)
    const fetch = vi.fn(async () => new Response(chunks(huge, 256), { status: 200 }))
    const { value } = await manager({ fetch })
    await expect(value.downloadMedium()).resolves.toMatchObject({ status: 'medium-failed', errorCode: 'OPERATION_FAILED' })
  })

  it('aborts a stalled official response at the bounded download deadline', async () => {
    let observedSignal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined
      observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const { value } = await manager({ fetch, downloadTimeoutMs: 5 })
    await expect(value.downloadMedium()).resolves.toMatchObject({
      activeTier: 'small', status: 'medium-failed', errorCode: 'OPERATION_FAILED', progress: null,
    })
    expect(observedSignal?.aborted).toBe(true)
  })

  it('cancels a user-started download without reporting a failure or retaining staging bytes', async () => {
    let observedSignal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined
      observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const { dataRoot, value } = await manager({ fetch, downloadTimeoutMs: 60_000 })
    const download = value.downloadMedium()
    await vi.waitFor(() => expect(observedSignal).toBeDefined())

    const cancelled = value.cancelMediumDownload()

    expect(observedSignal?.aborted).toBe(true)
    await expect(cancelled).resolves.toMatchObject({
      activeTier: 'small', mediumVersion: null, status: 'medium-absent',
      progress: null, errorCode: null,
    })
    await expect(download).resolves.toMatchObject({ status: 'medium-absent', errorCode: null })
    expect((await readdir(path.join(dataRoot, 'screenshot-ocr', 'medium')))
      .filter((name) => name.startsWith('.staging-'))).toEqual([])
  })

  it('preserves the installed Medium generation when a user cancels an update', async () => {
    let stall = false
    let observedSignal: AbortSignal | undefined
    const fetch = vi.fn((url: string, init?: RequestInit) => {
      if (!stall) return Promise.resolve(response(url.includes('_det_') ? detBytes : recBytes))
      return new Promise<Response>((_resolve, reject) => {
        observedSignal = init?.signal ?? undefined
        observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    })
    const { value } = await manager({ fetch, downloadTimeoutMs: 60_000 })
    await value.downloadMedium()
    stall = true
    const update = value.downloadMedium()
    await vi.waitFor(() => expect(observedSignal).toBeDefined())

    await expect(value.cancelMediumDownload()).resolves.toMatchObject({
      activeTier: 'medium', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
      status: 'medium-installed', progress: null, errorCode: null,
    })
    await expect(update).resolves.toMatchObject({ status: 'medium-installed' })
  })

  it('waits for a preference commit during cancellation and retains its acknowledged generation', async () => {
    const dataRoot = await root()
    let preferred: 'small' | 'medium' = 'small'
    let notifyPersistStarted!: () => void
    const persistStarted = new Promise<void>((resolve) => { notifyPersistStarted = resolve })
    let releasePersist!: () => void
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve })

    const value = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => {
        preferred = tier
        if (tier === 'medium') {
          notifyPersistStarted()
          await persistGate
        }
      },
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    const download = value.downloadMedium()
    await persistStarted

    const cancelled = value.cancelMediumDownload()
    releasePersist()

    await expect(cancelled).resolves.toMatchObject({
      activeTier: 'medium', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION, status: 'medium-installed', progress: null, errorCode: null,
    })
    await expect(download).resolves.toMatchObject({ status: 'medium-installed', errorCode: null })
    expect(preferred).toBe('medium')
    await expect(readdir(path.join(dataRoot, 'screenshot-ocr', 'medium', 'current')))
      .resolves.toEqual(expect.arrayContaining(['manifest.json', 'medium-det.tar', 'medium-rec.tar']))
    expect((await readdir(path.join(dataRoot, 'screenshot-ocr', 'medium'))).filter((name) => (
      name === 'transaction.json' || name.startsWith('.staging-') || name.startsWith('.previous-')
    ))).toEqual([])
  })

  it('never attempts preference compensation after a committed cancellation, even if compensation would fail', async () => {
    const dataRoot = await root()
    let preferred: 'small' | 'medium' = 'small'
    let notifyPersistStarted!: () => void
    const persistStarted = new Promise<void>((resolve) => { notifyPersistStarted = resolve })
    let releasePersist!: () => void
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve })

    const value = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => {
        if (tier === 'small') throw new Error('settings unavailable')
        preferred = tier
        notifyPersistStarted()
        await persistGate
      },
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    const download = value.downloadMedium()
    await persistStarted

    const cancelled = value.cancelMediumDownload()
    expect(cancelled).toBe(download)
    const settlement = expect(cancelled).resolves.toMatchObject({ status: 'medium-installed' })
    releasePersist()
    await settlement

    expect(preferred).toBe('medium')
    await expect(readFile(path.join(dataRoot, 'screenshot-ocr', 'medium', 'transaction.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reopens the new committed generation after cancellation without restoring an older user preference', async () => {
    const dataRoot = await root()
    let preferred: 'small' | 'medium' = 'small'
    const supportedManifests = [
      { version: '1.0.0', artifacts: priorFixtureArtifacts },
      { version: '2.0.0', artifacts: fixtureArtifacts },
    ] as const

    const prior = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => { preferred = tier },
      fetch: vi.fn(async (url: string) => response(url.includes('_det_') ? priorDetBytes : priorRecBytes)),
      artifacts: priorFixtureArtifacts,
      currentVersion: '1.0.0',
      supportedManifests,
    })
    await prior.downloadMedium()
    await prior.dispose()
    preferred = 'small'

    let notifyPersistStarted!: () => void
    const persistStarted = new Promise<void>((resolve) => { notifyPersistStarted = resolve })
    let releasePersist!: () => void
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve })
    const updater = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => {
        if (tier === 'small') throw new Error('unexpected preference compensation')
        preferred = tier
        if (tier === 'medium') {
          notifyPersistStarted()
          await persistGate
        }
      },
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      currentVersion: '2.0.0',
      supportedManifests,
    })
    const update = updater.downloadMedium()
    await persistStarted
    const cancelled = updater.cancelMediumDownload()
    const settlement = expect(cancelled).resolves.toMatchObject({ status: 'medium-installed' })
    releasePersist()
    await settlement
    expect(update).toBe(cancelled)
    expect(preferred).toBe('medium')

    await updater.dispose()
    const recovered = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => { preferred = tier },
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      currentVersion: '2.0.0',
      supportedManifests,
    })
    expect(preferred).toBe('medium')
    expect(recovered.getState()).toMatchObject({
      activeTier: 'medium', mediumVersion: '2.0.0', status: 'medium-installed', errorCode: null,
    })
    expect(await readFile(path.join(dataRoot, 'screenshot-ocr', 'medium', 'current', 'medium-det.tar')))
      .toEqual(Buffer.from(detBytes))
    await expect(readFile(path.join(dataRoot, 'screenshot-ocr', 'medium', 'transaction.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires the exact canonical model archive members and model names', async () => {
    const wrong = tar('PP-OCRv6_medium_det_onnx_infer', 'replacement')
    const artifacts = [{ ...fixtureArtifacts[0], bytes: wrong.byteLength, sha256: createHash('sha256').update(wrong).digest('hex') }, fixtureArtifacts[1]]
    const malformed = new Uint8Array(wrong)
    malformed[0] = '.'.charCodeAt(0); malformed[1] = '.'.charCodeAt(0); malformed[2] = '/'.charCodeAt(0)
    artifacts[0] = { ...artifacts[0], sha256: createHash('sha256').update(malformed).digest('hex') }
    const fetch = vi.fn(async (url: string) => response(url.includes('_det_') ? malformed : recBytes))
    const { value } = await manager({ fetch, artifacts })
    await expect(value.downloadMedium()).resolves.toMatchObject({ status: 'medium-failed' })
  })

  it('rejects a hash-valid archive whose inference.yml declares a different model', async () => {
    const wrong = tar('PP-OCRv6_medium_det_onnx_infer').map((byte) => byte)
    const needle = new TextEncoder().encode('PP-OCRv6_medium_det')
    const replacement = new TextEncoder().encode('PP-OCRv6_medium_bad')
    const start = wrong.findIndex((_byte, index) => needle.every((value, offset) => wrong[index + offset] === value))
    wrong.set(replacement, start)
    const artifacts = [{ ...fixtureArtifacts[0], sha256: createHash('sha256').update(wrong).digest('hex') }, fixtureArtifacts[1]]
    const fetch = vi.fn(async (url: string) => response(url.includes('_det_') ? wrong : recBytes))
    const { value } = await manager({ fetch, artifacts })
    await expect(value.downloadMedium()).resolves.toMatchObject({ status: 'medium-failed', errorCode: 'OPERATION_FAILED' })
  })

  it.each([
    ['bad ustar magic', (bytes: Uint8Array) => { bytes[257] = 'x'.charCodeAt(0); writeTarChecksum(bytes) }],
    ['bad header checksum', (bytes: Uint8Array) => { bytes[148] = bytes[148]! ^ 1 }],
  ])('rejects a hash-valid archive with %s', async (_name, corrupt) => {
    const invalid = new Uint8Array(detBytes)
    corrupt(invalid)
    const artifacts = [{
      ...fixtureArtifacts[0],
      sha256: createHash('sha256').update(invalid).digest('hex'),
    }, fixtureArtifacts[1]]
    const fetch = vi.fn(async (url: string) => response(url.includes('_det_') ? invalid : recBytes))
    const { value } = await manager({ fetch, artifacts })
    await expect(value.downloadMedium()).resolves.toMatchObject({
      activeTier: 'small', status: 'medium-failed', errorCode: 'OPERATION_FAILED',
    })
  })

  it('shares one concurrent flight and refuses removal until the flight becomes idle', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetch = vi.fn(async (url: string) => { await gate; return response(url.includes('_det_') ? detBytes : recBytes) })
    const { value } = await manager({ fetch })
    const first = value.downloadMedium()
    const second = value.downloadMedium()
    expect(second).toBe(first)
    await expect(value.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    release()
    await expect(first).resolves.toMatchObject({ status: 'medium-installed' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('atomically rolls back to the previously active verified pair when replacement activation fails', async () => {
    const first = await manager()
    await first.value.downloadMedium()
    const original = await readFile(path.join(first.dataRoot, 'screenshot-ocr', 'medium', 'current', 'medium-det.tar'))

    const { rename } = await import('node:fs/promises')
    let failed = false
    const replacement = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot, getPreferredTier: () => 'medium', setPreferredTier: async () => undefined,
      fetch: successfulFetch(), artifacts: fixtureArtifacts,
      rename: async (from: string, to: string) => {
        if (!failed && from.includes('.staging-') && to.endsWith(path.join('medium', 'current'))) {
          failed = true
          throw new Error('private activation failure')
        }
        await rename(from, to)
      },
    })
    await expect(replacement.downloadMedium()).resolves.toMatchObject({ status: 'medium-failed', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION })
    expect(await readFile(path.join(first.dataRoot, 'screenshot-ocr', 'medium', 'current', 'medium-det.tar'))).toEqual(original)
    expect(replacement.resolveActiveTier()).toBe('medium')
    await expect(readFile(path.join(first.dataRoot, 'screenshot-ocr', 'medium', 'transaction.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a catastrophic rollback failure and preserves the trusted backup evidence', async () => {
    const first = await manager()
    await first.value.downloadMedium()

    const { rename } = await import('node:fs/promises')
    let activeRenames = 0
    const replacement = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot, getPreferredTier: () => 'medium', setPreferredTier: async () => undefined,
      fetch: successfulFetch(), artifacts: fixtureArtifacts,
      rename: async (from: string, to: string) => {
        if (to.endsWith(path.join('medium', 'current')) && ++activeRenames >= 1) throw new Error('private fatal')
        await rename(from, to)
      },
    })
    await expect(replacement.downloadMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    const names = await readdir(path.join(first.dataRoot, 'screenshot-ocr', 'medium'))
    expect(names.some((name) => name.startsWith('.previous-'))).toBe(true)
    expect(JSON.stringify(replacement.getState())).not.toContain('private')
  })

  it('removes an idle installed pair, is idempotent, and leaves Small available', async () => {
    const { dataRoot, value } = await manager()
    await value.downloadMedium()
    await expect(value.removeMedium()).resolves.toMatchObject({ status: 'medium-absent', activeTier: 'small' })
    await expect(value.removeMedium()).resolves.toMatchObject({ status: 'medium-absent' })
    await expect(readdir(path.join(dataRoot, 'screenshot-ocr', 'medium', 'current'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(value.resolveActiveTier()).toBe('small')
  })

  it('preserves the installed pair when persisting the Small preference fails during removal', async () => {
    let preferred: 'small' | 'medium' = 'small'
    let failSmall = false
    const h = await manager({
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => {
        if (tier === 'small' && failSmall) throw new Error('private setting')
        preferred = tier
      },
    })
    await h.value.downloadMedium()
    failSmall = true
    await expect(h.value.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(h.value.resolveActiveTier()).toBe('medium')
    await expect(readFile(path.join(h.dataRoot, 'screenshot-ocr', 'medium', 'current', 'medium-det.tar'))).resolves.toEqual(Buffer.from(detBytes))
  })

  it('refuses removal while a Medium inference lease is active and releases idempotently', async () => {
    const { value } = await manager()
    await value.downloadMedium()
    const lease = value.acquireTier()
    expect(lease.tier).toBe('medium')
    await expect(value.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    lease.release()
    lease.release()
    await expect(value.removeMedium()).resolves.toMatchObject({ activeTier: 'small' })
  })

  it('retains ownership after lease-marker deletion fails and retries cleanup idempotently', async () => {
    let failRemoval = true
    const h = await manager({
      removeLeaseFile: (filePath: string) => {
        if (failRemoval) throw new Error('temporary filesystem failure')
        rmSync(filePath, { force: true })
      },
    })
    await h.value.downloadMedium()
    const lease = h.value.acquireTier()
    expect(lease.tier).toBe('medium')
    lease.release()
    await expect(h.value.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })

    failRemoval = false
    lease.release()
    await expect(h.value.removeMedium()).resolves.toMatchObject({ activeTier: 'small' })
  })

  it('pins the active tree while an audited protocol resource read is in flight', async () => {
    const { value } = await manager()
    await value.downloadMedium()
    const reading = value.resolveActiveResource('medium-det.tar')
    await expect(value.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(reading).resolves.toEqual(detBytes)
    await expect(value.removeMedium()).resolves.toMatchObject({ activeTier: 'small' })
  })

  it('does not replace the active Medium pair while an inference lease is active', async () => {
    const h = await manager()
    await h.value.downloadMedium()
    const lease = h.value.acquireTier()
    await expect(h.value.downloadMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    lease.release()
    await expect(h.value.downloadMedium()).resolves.toMatchObject({ status: 'medium-installed' })
  })

  it('refuses activation when a Medium inference lease begins after the update download starts', async () => {
    let updating = false
    let releaseRecognition!: () => void
    const recognitionGate = new Promise<void>((resolve) => { releaseRecognition = resolve })
    const fetch = vi.fn(async (url: string) => {
      if (updating && url.includes('_rec_')) await recognitionGate
      return response(url.includes('_det_') ? detBytes : recBytes)
    })
    const h = await manager({ fetch })
    await h.value.downloadMedium()
    updating = true
    const before = await readFile(path.join(h.dataRoot, 'screenshot-ocr', 'medium', 'current', 'manifest.json'))
    const update = h.value.downloadMedium()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
    const lease = h.value.acquireTier()
    expect(lease.tier).toBe('medium')
    releaseRecognition()
    await expect(update).resolves.toMatchObject({
      activeTier: 'medium', status: 'medium-failed', errorCode: 'OPERATION_FAILED',
    })
    expect(await readFile(path.join(h.dataRoot, 'screenshot-ocr', 'medium', 'current', 'manifest.json'))).toEqual(before)
    expect(h.preferredTier()).toBe('medium')
    lease.release()
  })

  it('rolls activation back when persisting the Medium preference fails', async () => {
    const h = await manager({ setPreferredTier: vi.fn(async () => { throw new Error('private settings') }) })
    await expect(h.value.downloadMedium()).resolves.toMatchObject({
      activeTier: 'small', mediumVersion: null, status: 'medium-failed', errorCode: 'OPERATION_FAILED',
    })
    await expect(readdir(path.join(h.dataRoot, 'screenshot-ocr', 'medium', 'current'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('honors a cross-manager generation lease for the same data root', async () => {
    const processAlive = (pid: number) => pid === 1001 || pid === 1002
    const first = await manager({ processId: 1001, processAlive })
    await first.value.downloadMedium()

    const second = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot,
      getPreferredTier: () => 'medium',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      processId: 1002,
      processAlive,
    })
    const lease = first.value.acquireTier()
    expect(lease.tier).toBe('medium')
    await expect(second.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    lease.release()
    await expect(second.removeMedium()).resolves.toMatchObject({ status: 'medium-absent' })
  })

  it('keeps an unknown-identity cross-process lease conservative until its owner releases it', async () => {
    const first = await manager({
      processId: 1001,
      processIdentity: 'created-1001',
      processIdentityMatches: async () => 'alive-match',
    })
    await first.value.downloadMedium()
    const lease = first.value.acquireTier()

    const second = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot,
      getPreferredTier: () => 'medium',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      processId: 1002,
      processIdentity: 'created-1002',
      processIdentityMatches: async () => 'unknown' as const,
    })

    await expect(second.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    lease.release()
    await expect(second.removeMedium()).resolves.toMatchObject({ status: 'medium-absent' })
  })

  it('treats live mutation contention as a bounded busy operation without degrading trusted storage', async () => {
    const processIdentityMatches = async (pid: number, expected: string) => (
      expected === `created-${pid}` ? 'alive-match' as const : 'dead-or-mismatch' as const
    )
    const first = await manager({
      processId: 1001,
      processIdentity: 'created-1001',
      processIdentityMatches,
    })
    await first.value.downloadMedium()
    const liveWriter = await acquireMediumMutationLock({
      root: path.join(first.dataRoot, 'screenshot-ocr', 'medium', '.mutation-lock'),
      owner: { pid: 1001, creationIdentity: 'created-1001' },
      processIdentityMatches,
    })

    const second = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot,
      getPreferredTier: () => 'medium',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      processId: 1002,
      processIdentity: 'created-1002',
      processIdentityMatches,
      mutationLockWaitTimeoutMs: 5,
    })

    expect(second.getState()).toMatchObject({
      activeTier: 'medium', status: 'medium-installed', errorCode: null,
    })
    await expect(second.removeMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(second.getState()).toMatchObject({
      activeTier: 'medium', status: 'medium-installed', errorCode: null,
    })
    await liveWriter.release()
  })

  it('fails closed without cleanup when initialization observes a live current-to-previous swap', async () => {
    const processIdentityMatches = async (pid: number, expected: string) => (
      expected === `created-${pid}` ? 'alive-match' as const : 'dead-or-mismatch' as const
    )
    const first = await manager({
      processId: 1001,
      processIdentity: 'created-1001',
      processIdentityMatches,
    })
    await first.value.downloadMedium()
    const mediumRoot = path.join(first.dataRoot, 'screenshot-ocr', 'medium')
    const previous = path.join(mediumRoot, '.previous-123e4567-e89b-42d3-a456-426614174000')
    const writer = await acquireMediumMutationLock({
      root: path.join(mediumRoot, '.mutation-lock'),
      owner: { pid: 1001, creationIdentity: 'created-1001' },
      processIdentityMatches,
    })
    await renameFileForTest(path.join(mediumRoot, 'current'), previous)


    const duringSwap = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot,
      getPreferredTier: () => 'medium',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      processId: 1002,
      processIdentity: 'created-1002',
      processIdentityMatches,
      mutationLockWaitTimeoutMs: 5,
    })
    expect(duringSwap.getState()).toMatchObject({
      activeTier: 'small', status: 'medium-failed', errorCode: 'OPERATION_FAILED',
    })
    await expect(lstat(previous)).resolves.toMatchObject({})

    await renameFileForTest(previous, path.join(mediumRoot, 'current'))
    await writer.release()
    await expect(duringSwap.downloadMedium()).resolves.toMatchObject({
      activeTier: 'medium', status: 'medium-installed', errorCode: null,
    })
  })

  it('keeps the shared lease namespace after dispose so another process cannot lose a concurrent lease', async () => {
    const h = await manager()
    await h.value.downloadMedium()
    await h.value.dispose()

    const leases = await lstat(path.join(h.dataRoot, 'screenshot-ocr', 'medium', '.leases'))
    expect(leases.isDirectory()).toBe(true)
  })

  it('recovers the unique audited previous generation after an interrupted replacement', async () => {
    const first = await manager()
    await first.value.downloadMedium()
    const mediumRoot = path.join(first.dataRoot, 'screenshot-ocr', 'medium')
    const { rename } = await import('node:fs/promises')
    await rename(path.join(mediumRoot, 'current'), path.join(mediumRoot, '.previous-123e4567-e89b-42d3-a456-426614174000'))
    await mkdir(path.join(mediumRoot, '.staging-223e4567-e89b-42d3-a456-426614174000'))
    await mkdir(path.join(mediumRoot, '.mutation-lock'), { recursive: true })
    await writeFile(
      path.join(mediumRoot, '.mutation-lock', '323e4567-e89b-42d3-a456-426614174000.waiting.json'),
      JSON.stringify({
        schemaVersion: 1,
        token: '323e4567-e89b-42d3-a456-426614174000',
        pid: 999,
        creationIdentity: 'dead-process',
        phase: 'waiting',
        ticket: 1,
      }),
    )

    const recovered = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot,
      getPreferredTier: () => 'medium',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
      processId: 1001,
      processAlive: () => false,
    })
    expect(recovered.getState()).toMatchObject({ status: 'medium-installed', activeTier: 'medium' })
    expect((await readdir(mediumRoot)).filter((name) => name.startsWith('.previous-') || name.startsWith('.staging-'))).toEqual([])
  })

  it.each([
    ['prepared', 'prepared'],
    ['after-current-rename', 'previous-moved'],
    ['after-generation-switch', 'current-switched'],
    ['after-preference-persist', 'preference-persisted'],
  ] as const)('recovers an interrupted replacement at the %s boundary without a stranded installed Small state', async (_boundary, phase) => {
    const dataRoot = await root()
    let preferred: 'small' | 'medium' = 'small'

    const options = {
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => { preferred = tier },
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    }
    const installed = await createScreenshotOcrModelManager(options)
    await expect(installed.downloadMedium()).resolves.toMatchObject({ status: 'medium-installed' })
    await installed.dispose()
    const mediumRoot = path.join(dataRoot, 'screenshot-ocr', 'medium')
    const current = path.join(mediumRoot, 'current')
    const stagingName = '.staging-123e4567-e89b-42d3-a456-426614174000'
    const previousName = '.previous-223e4567-e89b-42d3-a456-426614174000'
    const staging = path.join(mediumRoot, stagingName)
    const previous = path.join(mediumRoot, previousName)

    if (phase === 'prepared') {
      await cp(current, staging, { recursive: true })
    } else if (phase === 'previous-moved') {
      await cp(current, staging, { recursive: true })
      await renameFileForTest(current, previous)
    } else {
      await cp(current, previous, { recursive: true })
      preferred = phase === 'current-switched' ? 'small' : 'medium'
    }
    await writeFile(path.join(mediumRoot, 'transaction.json'), `${JSON.stringify({
      kind: 'replace',
      staging: stagingName,
      previous: previousName,
      phase,
      hadPrevious: true,
      observed: { revision: 0, preferredTier: 'small', tierRevision: 0 },
    })}\n`)

    const recovered = await createScreenshotOcrModelManager(options)
    expect(recovered.getState()).toMatchObject({
      activeTier: 'medium', status: 'medium-installed', errorCode: null,
    })
    expect(preferred).toBe('medium')
    expect((await readdir(mediumRoot)).filter((name) => (
      name.startsWith('.staging-') || name.startsWith('.previous-') || name === 'transaction.json'
    ))).toEqual([])
  })

  it.each(['missing', 'invalid'] as const)(
    'keeps the only trusted active generation for a prepared journal with %s staging without persisting Medium',
    async (stagingState) => {
      const dataRoot = await root()
      let preferred: 'small' | 'medium' = 'small'

      const baseOptions = {
        dataRoot,
        getPreferredTier: () => preferred,
        setPreferredTier: async (tier: 'small' | 'medium') => { preferred = tier },
        fetch: successfulFetch(),
        artifacts: fixtureArtifacts,
      }
      const installed = await createScreenshotOcrModelManager(baseOptions)
      await installed.downloadMedium()
      await installed.dispose()
      preferred = 'small'
      const mediumRoot = path.join(dataRoot, 'screenshot-ocr', 'medium')
      const stagingName = '.staging-123e4567-e89b-42d3-a456-426614174000'
      const previousName = '.previous-223e4567-e89b-42d3-a456-426614174000'
      if (stagingState === 'invalid') {
        await mkdir(path.join(mediumRoot, stagingName))
        await writeFile(path.join(mediumRoot, stagingName, 'partial'), 'partial')
      }
      await writeFile(path.join(mediumRoot, 'transaction.json'), `${JSON.stringify({
        kind: 'replace', staging: stagingName, previous: previousName, phase: 'prepared', hadPrevious: true,
      })}\n`)
      const persist = vi.fn(async () => { throw new Error('settings unavailable') })

      const recovered = await createScreenshotOcrModelManager({
        ...baseOptions,
        setPreferredTier: persist,
      })
      expect(recovered.getState()).toMatchObject({
        activeTier: 'small', status: 'medium-installed', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
      })
      expect(persist).not.toHaveBeenCalled()
      expect((await readdir(path.join(mediumRoot, 'current'))).sort()).toEqual([
        'manifest.json', 'medium-det.tar', 'medium-rec.tar',
      ])
      expect((await readdir(mediumRoot)).filter((name) => (
        name === 'transaction.json' || name.startsWith('.staging-') || name.startsWith('.previous-')
      ))).toEqual([])
    },
  )

  it.each([
    ['prepared', false],
    ['previous-moved', false],
    ['current-switched', true],
    ['preference-persisted', true],
  ] as const)('recovers a first install journal at phase %s', async (phase, switched) => {
    const seed = await manager()
    await seed.value.downloadMedium()
    await seed.value.dispose()
    const dataRoot = await root()
    const mediumRoot = path.join(dataRoot, 'screenshot-ocr', 'medium')
    await mkdir(mediumRoot, { recursive: true })
    const stagingName = '.staging-123e4567-e89b-42d3-a456-426614174000'
    const previousName = '.previous-223e4567-e89b-42d3-a456-426614174000'
    const generation = switched ? path.join(mediumRoot, 'current') : path.join(mediumRoot, stagingName)
    await cp(path.join(seed.dataRoot, 'screenshot-ocr', 'medium', 'current'), generation, { recursive: true })
    let preferred: 'small' | 'medium' = phase === 'preference-persisted' ? 'medium' : 'small'
    await writeFile(path.join(mediumRoot, 'transaction.json'), `${JSON.stringify({
      kind: 'replace', staging: stagingName, previous: previousName, phase, hadPrevious: false,
      observed: { revision: 0, preferredTier: 'small', tierRevision: 0 },
    })}\n`)

    const recovered = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => { preferred = tier },
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    expect(recovered.getState()).toMatchObject(switched
      ? { activeTier: 'medium', status: 'medium-installed' }
      : { activeTier: 'small', status: 'medium-absent' })
    expect(preferred).toBe(switched ? 'medium' : 'small')
  })

  it('preserves a sole switched first-install generation across a failed recovery preference commit', async () => {
    const seed = await manager()
    await seed.value.downloadMedium()
    await seed.value.dispose()
    const dataRoot = await root()
    const mediumRoot = path.join(dataRoot, 'screenshot-ocr', 'medium')
    const current = path.join(mediumRoot, 'current')
    const stagingName = '.staging-123e4567-e89b-42d3-a456-426614174000'
    const previousName = '.previous-223e4567-e89b-42d3-a456-426614174000'
    const transaction = {
      kind: 'replace',
      staging: stagingName,
      previous: previousName,
      phase: 'current-switched',
      hadPrevious: false,
      observed: { revision: 0, preferredTier: 'small', tierRevision: 0 },
    } as const
    await mkdir(mediumRoot, { recursive: true })
    await cp(path.join(seed.dataRoot, 'screenshot-ocr', 'medium', 'current'), current, { recursive: true })
    await writeFile(path.join(mediumRoot, 'transaction.json'), `${JSON.stringify(transaction)}\n`)
    let preferred: 'small' | 'medium' = 'small'

    const failedPersist = vi.fn(async (_tier: 'small' | 'medium') => {
      throw new Error('settings unavailable')
    })

    const degraded = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: failedPersist,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    expect(failedPersist).toHaveBeenCalledOnce()
    expect(failedPersist).toHaveBeenCalledWith('medium')
    expect(degraded.getState()).toEqual({
      activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null, mediumSource: null,
      availableMediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
      status: 'medium-failed', progress: null, errorCode: 'OPERATION_FAILED',
    })
    expect(preferred).toBe('small')
    expect((await readdir(mediumRoot)).filter((name) => (
      name === 'current' || name.startsWith('.staging-') || name.startsWith('.previous-')
    ))).toEqual(['current'])
    expect((await readdir(current)).sort()).toEqual([
      'manifest.json', 'medium-det.tar', 'medium-rec.tar',
    ])
    await expect(readFile(path.join(mediumRoot, 'transaction.json'), 'utf8'))
      .resolves.toBe(`${JSON.stringify(transaction)}\n`)
    await degraded.dispose()

    const committedPersist = vi.fn(async (tier: 'small' | 'medium') => { preferred = tier })
    const recovered = await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: committedPersist,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    expect(committedPersist).toHaveBeenCalledOnce()
    expect(committedPersist).toHaveBeenCalledWith('medium')
    expect(preferred).toBe('medium')
    expect(recovered.getState()).toEqual({
      activeTier: 'medium', bundledVersion: '6.0.0', mediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION, mediumSource: 'managed',
      availableMediumVersion: null,
      status: 'medium-installed', progress: null, errorCode: null,
    })
    expect((await readdir(mediumRoot)).filter((name) => (
      name === 'transaction.json' || name.startsWith('.staging-') || name.startsWith('.previous-')
    ))).toEqual([])
  })

  it('starts Small-only on storage initialization failure and repairs only on explicit retry', async () => {
    const parent = await root()
    const blockedRoot = path.join(parent, 'blocked-root')
    await writeFile(blockedRoot, 'not a directory')

    const degraded = await createScreenshotOcrModelManager({
      dataRoot: blockedRoot,
      getPreferredTier: () => 'medium',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    expect(degraded.getState()).toEqual({
      activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null, mediumSource: null,
      availableMediumVersion: SCREENSHOT_OCR_MEDIUM_VERSION,
      status: 'medium-failed', progress: null, errorCode: 'OPERATION_FAILED',
    })
    await rm(blockedRoot, { force: true })
    await expect(degraded.downloadMedium()).resolves.toMatchObject({ status: 'medium-installed', activeTier: 'medium' })
  })

  it('reports a pinned prior generation as update-available and preserves it when update verification fails', async () => {
    const dataRoot = await root()
    let preferred: 'small' | 'medium' = 'small'

    const common = {
      dataRoot,
      getPreferredTier: () => preferred,
      setPreferredTier: async (tier: 'small' | 'medium') => { preferred = tier },
      supportedManifests: [
        { version: '1.0.0', artifacts: priorFixtureArtifacts },
        { version: '2.0.0', artifacts: fixtureArtifacts },
      ],
    }
    const prior = await createScreenshotOcrModelManager({
      ...common,
      currentVersion: '1.0.0',
      artifacts: priorFixtureArtifacts,
      fetch: vi.fn(async (url: string) => response(url.includes('_det_') ? priorDetBytes : priorRecBytes)),
    })
    await prior.downloadMedium()
    const broken = await createScreenshotOcrModelManager({
      ...common,
      currentVersion: '2.0.0',
      artifacts: fixtureArtifacts,
      fetch: vi.fn(async () => response(new Uint8Array(detBytes.byteLength))),
    })
    expect(broken.getState()).toMatchObject({
      activeTier: 'medium', mediumVersion: '1.0.0', availableMediumVersion: '2.0.0', status: 'medium-update-available',
    })
    await expect(broken.downloadMedium()).resolves.toMatchObject({
      activeTier: 'medium', mediumVersion: '1.0.0', availableMediumVersion: '2.0.0', status: 'medium-failed',
    })
    const updated = await createScreenshotOcrModelManager({
      ...common, currentVersion: '2.0.0', artifacts: fixtureArtifacts, fetch: successfulFetch(),
    })
    await expect(updated.downloadMedium()).resolves.toMatchObject({
      activeTier: 'medium', mediumVersion: '2.0.0', availableMediumVersion: null, status: 'medium-installed',
    })
  })

  it('removes stale uncommitted staging on an absent Small-only startup', async () => {
    const dataRoot = await root()
    const mediumRoot = path.join(dataRoot, 'screenshot-ocr', 'medium')
    const staleName = '.staging-123e4567-e89b-42d3-a456-426614174000'
    await mkdir(path.join(mediumRoot, staleName), { recursive: true })
    await writeFile(path.join(mediumRoot, staleName, 'partial'), 'partial')

    await createScreenshotOcrModelManager({
      dataRoot,
      getPreferredTier: () => 'small',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    expect((await readdir(mediumRoot)).filter((name) => name.startsWith('.staging-'))).toEqual([])
  })

  it('rejects an oversized active manifest before parsing it', async () => {
    const first = await manager()
    await first.value.downloadMedium()
    await writeFile(path.join(first.dataRoot, 'screenshot-ocr', 'medium', 'current', 'manifest.json'), ' '.repeat(16 * 1024 + 1))

    const audited = await createScreenshotOcrModelManager({
      dataRoot: first.dataRoot,
      getPreferredTier: () => 'medium',
      setPreferredTier: async () => undefined,
      fetch: successfulFetch(),
      artifacts: fixtureArtifacts,
    })
    expect(audited.getState()).toMatchObject({ activeTier: 'small', mediumVersion: null, status: 'medium-absent' })
  })

  it('aborts and cleans an interrupted flight on dispose, suppresses late state, and disposes idempotently', async () => {
    let observedSignal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observedSignal = init?.signal ?? undefined
      observedSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const states: unknown[] = []
    const { dataRoot, value } = await manager({ fetch, onState: (state: unknown) => states.push(state) })
    const flight = value.downloadMedium()
    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    const count = states.length
    await value.dispose()
    await value.dispose()
    await flight
    expect(observedSignal!.aborted).toBe(true)
    expect(states).toHaveLength(count)
    expect((await readdir(path.join(dataRoot, 'screenshot-ocr', 'medium'))).sort()).toEqual(['.leases', '.mutation-lock'])
    await expect(value.downloadMedium()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  })

  it('drains an active generation lease on dispose and refuses new Medium acquisition afterward', async () => {
    const { value } = await manager()
    await value.downloadMedium()
    const lease = value.acquireTier()
    let disposed = false
    const firstDispose = value.dispose()
    expect(value.dispose()).toBe(firstDispose)
    const disposing = firstDispose.then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    lease.release()
    await disposing
    expect(value.acquireTier().tier).toBe('small')
  })
})
