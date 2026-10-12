import { createHash } from 'node:crypto'
import { lstat, mkdtemp, realpath, rename, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentConversionComponentManager, DocumentConversionRuntime } from '../../src/main/document-conversion/component-manager'
import {
  DocumentConversionService,
  type DocumentConversionRunner,
} from '../../src/main/document-conversion/document-conversion-service'
import type { MarkItDownRunnerResult } from '../../src/main/document-conversion/markitdown-runner'
import type { DocumentConversionComponentState } from '../../src/shared/document-conversion'
import { appError } from '../../src/shared/public-errors'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-service-test-'))
  roots.push(root)
  return root
}

class FakeManager {
  version = '1.0.0'
  available = true
  revision = 0
  status: DocumentConversionComponentState['status'] = 'installed'
  busy = false
  leases = 0
  releases = 0
  listeners = new Set<(state: DocumentConversionComponentState) => void>()
  verificationCalls = 0
  async ensureVerified(): Promise<void> {
    this.verificationCalls += 1
    if (!this.available) throw appError('OPERATION_FAILED')
  }
  acquireLease(): ReturnType<DocumentConversionComponentManager['acquireLease']> {
    if (!this.available) throw appError('OPERATION_FAILED')
    this.leases += 1
    const runtime: DocumentConversionRuntime = Object.freeze({
      version: this.version,
      root: 'C:\\component',
      pythonExecutable: 'C:\\component\\python.exe',
      entryScript: 'C:\\component\\arkdown_markitdown.py',
    })
    let released = false
    return Object.freeze({ runtime, release: () => { if (!released) { released = true; this.releases += 1 } } })
  }
  subscribe(listener: (state: DocumentConversionComponentState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  getState(): DocumentConversionComponentState {
    return {
      revision: this.revision,
      source: 'packaged',
      status: this.status,
      installedVersion: this.status === 'absent' ? null : this.version,
      availableVersion: this.version,
      progress: null,
      errorCode: this.status === 'failed' ? 'OPERATION_FAILED' : null,
      busy: this.busy,
    }
  }
  emit(
    status: DocumentConversionComponentState['status'] = this.status,
    overrides: Partial<DocumentConversionComponentState> = {},
  ): void {
    this.revision += 1
    this.status = status
    this.busy = overrides.busy ?? false
    const state = { ...this.getState(), ...overrides, revision: this.revision }
    for (const listener of this.listeners) listener(state)
  }
}

function immediateRunner(markdown = '# converted'): DocumentConversionRunner & { calls: number; paths: string[] } {
  return {
    calls: 0,
    paths: [],
    async convert(input) {
      this.calls += 1
      this.paths.push(input.canonicalPath)
      input.signal.throwIfAborted()
      return { markdown, warnings: ['layout warning'] }
    },
  }
}

function expectedFingerprint(canonicalPath: string, bytes: number, modifiedAtMs: number, version: string): string {
  return createHash('sha256')
    .update(canonicalPath).update('\0').update(String(bytes)).update('\0')
    .update(String(modifiedAtMs)).update('\0').update(version)
    .digest('hex')
}

describe('DocumentConversionService', () => {
  it('verifies the component before acquiring the first conversion lease', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'slides.pptx')
    await writeFile(source, 'source')
    const order: string[] = []
    const manager = new FakeManager()
    manager.ensureVerified = vi.fn(async () => { order.push('verify') })
    const acquireLease = manager.acquireLease.bind(manager)
    manager.acquireLease = vi.fn(() => {
      order.push('lease')
      return acquireLease()
    })
    const service = new DocumentConversionService({ manager, runner: immediateRunner() })

    await service.convertLocal(source, new AbortController().signal)

    expect(order.slice(0, 2)).toEqual(['verify', 'lease'])
    service.dispose()
  })

  it('preserves caller cancellation while component verification is pending', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'slides.pptx')
    await writeFile(source, 'source')
    const manager = new FakeManager()
    let releaseVerification!: () => void
    manager.ensureVerified = vi.fn(() => new Promise<void>((resolve) => {
      releaseVerification = resolve
    }))
    const service = new DocumentConversionService({ manager, runner: immediateRunner() })
    const controller = new AbortController()
    const cancellation = new DOMException('cancelled while verifying', 'AbortError')

    const conversion = service.convertLocal(source, controller.signal)
    await vi.waitFor(() => expect(manager.ensureVerified).toHaveBeenCalledOnce())
    controller.abort(cancellation)
    releaseVerification()

    await expect(conversion).rejects.toBe(cancellation)
    service.dispose()
  })

  it('collapses PPTX soft line breaks before publishing the converted Markdown', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'slides.pptx')
    await writeFile(source, 'source')
    const service = new DocumentConversionService({
      manager: new FakeManager(),
      runner: immediateRunner('<!-- Slide number: 1 -->\n1\n标题\n\n第一行\n第二行'),
    })

    const converted = await service.convertLocal(source, new AbortController().signal)

    expect(converted.markdown).toBe('<!-- Slide number: 1 -->\n1 标题\n\n第一行 第二行')
    service.dispose()
  })

  it('canonicalizes absolute regular files and returns deeply immutable caller copies', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.PDF')
    await writeFile(source, 'source')
    const canonical = await realpath(source)
    const metadata = await lstat(canonical)
    const manager = new FakeManager()
    const runner = immediateRunner()
    const service = new DocumentConversionService({ manager, runner })

    const first = await service.convertLocal(path.join(root, '.', 'sample.PDF'), new AbortController().signal)
    const second = await service.convertLocal(source, new AbortController().signal)
    const third = await service.convertLocal(source.toLocaleUpperCase('en-US'), new AbortController().signal)

    expect(runner.paths).toEqual([canonical])
    expect(first).toEqual({
      source: {
        absolutePath: canonical,
        fileName: 'sample.PDF',
        format: 'pdf',
        bytes: metadata.size,
        modifiedAtMs: Math.trunc(metadata.mtimeMs),
      },
      markdown: '# converted',
      converterVersion: '1.0.0',
      fingerprint: expectedFingerprint(canonical, metadata.size, Math.trunc(metadata.mtimeMs), '1.0.0'),
      warnings: ['layout warning'],
    })
    expect(second).not.toBe(first)
    expect(second.source).not.toBe(first.source)
    expect(second.warnings).not.toBe(first.warnings)
    expect(third.source.absolutePath).toBe(canonical)
    for (const value of [first, first.source, first.warnings, second, second.source, second.warnings]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(manager.leases).toBe(3)
    expect(manager.releases).toBe(3)
    service.dispose()
  })

  it('rejects non-local, non-regular, reparse, unsupported, oversized, and missing inputs', async () => {
    const root = await temporaryRoot()
    const regular = path.join(root, 'sample.pdf')
    const unsupported = path.join(root, 'sample.docx')
    const junction = path.join(root, 'junction')
    const link = path.join(junction, 'sample.pdf')
    const oversized = path.join(root, 'large.xlsx')
    await writeFile(regular, 'source')
    await writeFile(unsupported, 'source')
    await symlink(root, junction, 'junction')
    await writeFile(oversized, '')
    await truncate(oversized, 256 * 1024 * 1024 + 1)
    const service = new DocumentConversionService({ manager: new FakeManager(), runner: immediateRunner() })
    const cases: Array<[string, string]> = [
      ['relative.pdf', 'INVALID_INPUT'],
      ['https://example.test/file.pdf', 'INVALID_INPUT'],
      [root, 'INVALID_INPUT'],
      [link, 'INVALID_INPUT'],
      [unsupported, 'UNSUPPORTED_FILE_TYPE'],
      [oversized, 'DOCUMENT_CONVERSION_INPUT_TOO_LARGE'],
      [path.join(root, 'missing.epub'), 'FILE_NOT_FOUND'],
    ]
    for (const [input, code] of cases) {
      await expect(service.convertLocal(input, new AbortController().signal)).rejects.toMatchObject({ code })
    }
    service.dispose()
  })

  it('rejects empty visible output, missing components, and files changed during conversion', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    const manager = new FakeManager()
    const empty = new DocumentConversionService({ manager, runner: immediateRunner(' \n\t') })
    await expect(empty.convertLocal(source, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_EMPTY' })
    empty.dispose()

    manager.available = false
    const unavailable = new DocumentConversionService({ manager, runner: immediateRunner() })
    await expect(unavailable.convertLocal(source, new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCUMENT_CONVERSION_COMPONENT_MISSING',
    })
    unavailable.dispose()

    manager.available = true
    const replacingRunner = immediateRunner()
    replacingRunner.convert = async () => {
      await writeFile(source, 'replacement with a different size')
      return { markdown: '# converted', warnings: [] }
    }
    const replaced = new DocumentConversionService({ manager, runner: replacingRunner })
    await expect(replaced.convertLocal(source, new AbortController().signal)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_FAILED' })
    replaced.dispose()
  })

  it('rejects a same-size same-mtime input replaced with a different file during conversion', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    const replacement = path.join(root, 'replacement.pdf')
    const original = path.join(root, 'original.pdf')
    await writeFile(source, 'source')
    await writeFile(replacement, 'other!')
    const stableTime = new Date(Math.trunc(Date.now() / 1_000) * 1_000)
    await Promise.all([
      utimes(source, stableTime, stableTime),
      utimes(replacement, stableTime, stableTime),
    ])
    const sourceMetadata = await lstat(source)
    const replacementMetadata = await lstat(replacement)
    expect(replacementMetadata.size).toBe(sourceMetadata.size)
    expect(replacementMetadata.mtimeMs).toBe(sourceMetadata.mtimeMs)

    const runner = immediateRunner()
    runner.convert = async () => {
      await rename(source, original)
      await rename(replacement, source)
      return { markdown: '# converted', warnings: [] }
    }
    const service = new DocumentConversionService({ manager: new FakeManager(), runner })

    await expect(service.convertLocal(source, new AbortController().signal)).rejects.toMatchObject({
      code: 'DOCUMENT_CONVERSION_FAILED',
    })
    const currentMetadata = await lstat(source)
    expect(currentMetadata.size).toBe(sourceMetadata.size)
    expect(currentMetadata.mtimeMs).toBe(sourceMetadata.mtimeMs)
    service.dispose()
  })

  it('rejects a trusted workspace token replaced before service use without leasing or spawning', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    const replacement = path.join(root, 'replacement.pdf')
    const original = path.join(root, 'original.pdf')
    await writeFile(source, 'source')
    await writeFile(replacement, 'other!')
    const stableTime = new Date(Math.trunc(Date.now() / 1_000) * 1_000)
    await Promise.all([
      utimes(source, stableTime, stableTime),
      utimes(replacement, stableTime, stableTime),
    ])
    const workspace = new WorkspaceService()
    await workspace.setRoot(root)
    const trusted = await workspace.resolveExistingConvertibleDocument('sample.pdf')
    await rename(source, original)
    await rename(replacement, source)
    const current = await lstat(source)
    expect(current.size).toBe(trusted.bytes)
    expect(Math.trunc(current.mtimeMs)).toBe(trusted.modifiedAtMs)

    const manager = new FakeManager()
    const runner = immediateRunner()
    const service = new DocumentConversionService({ manager, runner })
    try {
      await expect(service.convertResolved(trusted, new AbortController().signal))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(manager.leases).toBe(0)
      expect(manager.releases).toBe(0)
      expect(runner.calls).toBe(0)
    } finally {
      service.dispose()
    }
  })

  it('coalesces same-fingerprint work and cancels the child only after every subscriber aborts', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    let sharedSignal!: AbortSignal
    let calls = 0
    const runner: DocumentConversionRunner = {
      convert(input) {
        calls += 1
        sharedSignal = input.signal
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
        })
      },
    }
    const manager = new FakeManager()
    const service = new DocumentConversionService({ manager, runner })
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = service.convertLocal(source, firstController.signal)
    const second = service.convertLocal(source, secondController.signal)
    await vi.waitFor(() => expect(calls).toBe(1))

    firstController.abort(new DOMException('first cancelled', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal.aborted).toBe(false)
    secondController.abort(new DOMException('second cancelled', 'AbortError'))
    await expect(second).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(sharedSignal.aborted).toBe(true))
    expect(manager.releases).toBe(manager.leases)
    service.dispose()
  })

  it('lets a surviving coalesced subscriber receive a successful immutable result', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    let sharedSignal!: AbortSignal
    let complete!: (value: MarkItDownRunnerResult) => void
    let calls = 0
    const runner: DocumentConversionRunner = {
      convert(input) {
        calls += 1
        sharedSignal = input.signal
        return new Promise((resolve) => { complete = resolve })
      },
    }
    const manager = new FakeManager()
    const service = new DocumentConversionService({ manager, runner })
    const firstController = new AbortController()
    const first = service.convertLocal(source, firstController.signal)
    const second = service.convertLocal(source, new AbortController().signal)
    await vi.waitFor(() => expect(calls).toBe(1))

    firstController.abort(new DOMException('first cancelled', 'AbortError'))
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal.aborted).toBe(false)
    complete({ markdown: '# shared result', warnings: ['layout warning'] })

    const result = await second
    expect(result.markdown).toBe('# shared result')
    expect(result.warnings).toEqual(['layout warning'])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.source)).toBe(true)
    expect(Object.isFrozen(result.warnings)).toBe(true)
    expect(calls).toBe(1)
    expect(manager.releases).toBe(manager.leases)
    service.dispose()
  })

  it('disposes active flights even when the cache invalidation observer throws', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    let sharedSignal!: AbortSignal
    let rejectRunner!: (reason: unknown) => void
    let calls = 0
    const runner: DocumentConversionRunner = {
      convert(input) {
        calls += 1
        sharedSignal = input.signal
        return new Promise((_resolve, reject) => {
          rejectRunner = reject
          input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true })
        })
      },
    }
    const manager = new FakeManager()
    const observerFailure = new Error('observer failed')
    const onCacheInvalidated = vi.fn(() => { throw observerFailure })
    const service = new DocumentConversionService({ manager, runner, onCacheInvalidated })
    const conversion = service.convertLocal(source, new AbortController().signal)
    const rejection = expect(conversion).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await vi.waitFor(() => expect(calls).toBe(1))

    let disposeFailure: unknown
    try {
      service.dispose()
    } catch (error) {
      disposeFailure = error
    }
    if (!sharedSignal.aborted) rejectRunner(appError('OPERATION_FAILED'))

    await rejection
    expect(disposeFailure).toBeUndefined()
    expect(sharedSignal.aborted).toBe(true)
    expect(onCacheInvalidated).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(manager.releases).toBe(manager.leases))
    expect(manager.listeners.size).toBe(0)
  })

  it('aborts subscribers synchronously but drains runner cleanup before releasing the lease', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    let sharedSignal!: AbortSignal
    let notifyRunnerStarted!: () => void
    const runnerStarted = new Promise<void>((resolve) => { notifyRunnerStarted = resolve })
    let finishRunnerCleanup!: () => void
    const runnerCleanup = new Promise<void>((resolve) => { finishRunnerCleanup = resolve })
    let cleanupFinished = false
    const runner: DocumentConversionRunner = {
      convert(input) {
        sharedSignal = input.signal
        notifyRunnerStarted()
        return new Promise((_resolve, reject) => {
          input.signal.addEventListener('abort', () => {
            void runnerCleanup.then(() => {
              cleanupFinished = true
              reject(input.signal.reason)
            })
          }, { once: true })
        })
      },
    }
    const manager = new FakeManager()
    const service = new DocumentConversionService({ manager, runner })
    const conversion = service.convertLocal(source, new AbortController().signal)
    const conversionOutcome = conversion.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    )
    await runnerStarted

    let drainSettled = false
    try {
      const draining = service.disposeAndDrain().then(() => { drainSettled = true })

      expect(sharedSignal.aborted).toBe(true)
      await expect(conversionOutcome).resolves.toMatchObject({
        resolved: false,
        error: { code: 'OPERATION_FAILED' },
      })
      await Promise.resolve()
      expect(cleanupFinished).toBe(false)
      expect(drainSettled).toBe(false)
      expect(manager.releases).toBe(0)

      finishRunnerCleanup()
      await draining
      expect(cleanupFinished).toBe(true)
      expect(manager.releases).toBe(manager.leases)
    } finally {
      service.dispose()
      finishRunnerCleanup()
      await conversionOutcome
    }
  })

  it('rejects disposal during validation before acquiring a lease or starting a flight', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    const canonicalPath = await realpath(source)
    const metadata = await lstat(canonicalPath)
    let releaseValidation!: () => void
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve })
    const validateInput = vi.fn(async () => {
      await validationGate
      return {
        canonicalPath,
        fileName: 'sample.pdf',
        format: 'pdf' as const,
        bytes: metadata.size,
        modifiedAtMs: Math.trunc(metadata.mtimeMs),
        rawModifiedAtMs: metadata.mtimeMs,
        device: metadata.dev,
        inode: metadata.ino,
      }
    })
    const manager = new FakeManager()
    const runner = immediateRunner()
    const service = new DocumentConversionService({
      manager,
      runner,
      validateInput,
    })

    const conversion = service.convertLocal(source, new AbortController().signal)
    service.dispose()
    releaseValidation()

    await expect(conversion).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(validateInput).toHaveBeenCalledOnce()
    expect(manager.leases).toBe(0)
    expect(manager.releases).toBe(0)
    expect(runner.calls).toBe(0)
  })

  it('does not let a pre-invalidation flight repopulate the cache for the same installed version', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    const completions: Array<(value: MarkItDownRunnerResult) => void> = []
    let calls = 0
    const runner: DocumentConversionRunner = {
      convert() {
        calls += 1
        if (calls > 1) return Promise.resolve({ markdown: '# fresh', warnings: [] })
        return new Promise((resolve) => { completions.push(resolve) })
      },
    }
    const manager = new FakeManager()
    const service = new DocumentConversionService({ manager, runner })

    try {
      const beforeInvalidation = service.convertLocal(source, new AbortController().signal)
      await vi.waitFor(() => expect(calls).toBe(1))
      manager.emit('update-available', { availableVersion: '2.0.0' })
      completions[0]!({ markdown: '# stale flight', warnings: [] })
      await expect(beforeInvalidation).resolves.toMatchObject({ markdown: '# stale flight' })

      const afterInvalidation = service.convertLocal(source, new AbortController().signal)
      await vi.waitFor(() => expect(calls).toBe(2))
      await expect(afterInvalidation).resolves.toMatchObject({ markdown: '# fresh' })
    } finally {
      service.dispose()
    }
  })

  it('preserves cached work across busy and revision-only component publications', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.pdf')
    await writeFile(source, 'source')
    const manager = new FakeManager()
    const runner = immediateRunner()
    const invalidations: Array<string | null> = []
    const service = new DocumentConversionService({
      manager,
      runner,
      onCacheInvalidated: (version) => invalidations.push(version),
    })

    await service.convertLocal(source, new AbortController().signal)
    await service.convertLocal(source, new AbortController().signal)
    manager.emit('installed', { busy: true })
    await service.convertLocal(source, new AbortController().signal)
    manager.emit('installed', { busy: true })
    await service.convertLocal(source, new AbortController().signal)
    manager.emit('installed', { busy: false })
    await service.convertLocal(source, new AbortController().signal)

    expect(runner.calls).toBe(1)
    expect(invalidations).toEqual([])
    service.dispose()
    expect(invalidations).toEqual([null])
  })

  it('invalidates cached work for file size, mtime, converter version, component events, and disposal', async () => {
    const root = await temporaryRoot()
    const source = path.join(root, 'sample.epub')
    await writeFile(source, 'one')
    const manager = new FakeManager()
    const runner = immediateRunner()
    const invalidations: Array<string | null> = []
    const service = new DocumentConversionService({
      manager,
      runner,
      onCacheInvalidated: (version) => invalidations.push(version),
    })
    await service.convertLocal(source, new AbortController().signal)
    await service.convertLocal(source, new AbortController().signal)
    expect(runner.calls).toBe(1)

    await writeFile(source, 'different-size')
    await service.convertLocal(source, new AbortController().signal)
    const changedTime = new Date(Date.now() + 10_000)
    await utimes(source, changedTime, changedTime)
    await service.convertLocal(source, new AbortController().signal)
    manager.version = '2.0.0'
    await service.convertLocal(source, new AbortController().signal)
    expect(runner.calls).toBe(4)

    manager.emit('update-available')
    await service.convertLocal(source, new AbortController().signal)
    expect(runner.calls).toBe(5)
    expect(invalidations).toEqual(['2.0.0'])
    service.dispose()
    expect(invalidations).toEqual(['2.0.0', null])
    expect(manager.listeners.size).toBe(0)
    await expect(service.convertLocal(source, new AbortController().signal)).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
  })
})
