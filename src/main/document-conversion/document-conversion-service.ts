import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  validateResolvedConvertibleDocument,
  type ResolvedConvertibleDocument,
} from '../workspace/workspace-service'
import {
  MAX_DOCUMENT_CONVERSION_INPUT_BYTES,
  MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES,
  type ConvertedDocument,
  type DocumentConversionComponentState,
  type DocumentConversionFormat,
} from '../../shared/document-conversion'
import { appError, PublicError } from '../../shared/public-errors'
import type {
  DocumentConversionComponentLease,
  DocumentConversionComponentManager,
} from './component-manager'
import type { MarkItDownRunner, MarkItDownRunnerInput, MarkItDownRunnerResult } from './markitdown-runner'
import { normalizePptxMarkdown } from './pptx-markdown-normalization'

const SUPPORTED_EXTENSIONS = new Set<DocumentConversionFormat>(['pdf', 'pptx', 'xlsx', 'epub'])

export type DocumentConversionRunner = Pick<MarkItDownRunner, 'convert'>

export interface DocumentConversionServiceOptions {
  manager: Pick<DocumentConversionComponentManager, 'acquireLease' | 'ensureVerified' | 'getState' | 'subscribe'>
  runner: DocumentConversionRunner
  onCacheInvalidated?(converterVersion: string | null): void
  /** @internal Narrow injection seam for deterministic lifecycle validation tests. */
  validateInput?(absolutePath: string): Promise<ValidatedInput>
}

interface ValidatedInput {
  canonicalPath: string
  fileName: string
  format: DocumentConversionFormat
  bytes: number
  modifiedAtMs: number
  rawModifiedAtMs: number
  device: number | bigint
  inode: number | bigint
}

interface Subscriber {
  signal: AbortSignal
  resolve(value: ConvertedDocument): void
  reject(reason: unknown): void
  cancel(): void
}

interface ConversionFlight {
  key: string
  generation: number
  input: ValidatedInput
  lease: DocumentConversionComponentLease
  controller: AbortController
  subscribers: Map<symbol, Subscriber>
}

function fingerprint(input: ValidatedInput, converterVersion: string): string {
  return createHash('sha256')
    .update(input.canonicalPath).update('\0')
    .update(String(input.bytes)).update('\0')
    .update(String(input.modifiedAtMs)).update('\0')
    .update(converterVersion)
    .digest('hex')
}

function immutableDocument(value: ConvertedDocument): ConvertedDocument {
  return Object.freeze({
    source: Object.freeze({ ...value.source }),
    markdown: value.markdown,
    converterVersion: value.converterVersion,
    fingerprint: value.fingerprint,
    warnings: Object.freeze([...value.warnings]),
  })
}

function callerCopy(value: ConvertedDocument): ConvertedDocument {
  return immutableDocument(value)
}

function componentCacheIdentity(state: DocumentConversionComponentState): string {
  return JSON.stringify({
    source: state.source,
    status: state.status,
    installedVersion: state.installedVersion,
    availableVersion: state.availableVersion,
    progress: state.progress,
    errorCode: state.errorCode,
  })
}

function pathError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT') throw appError('FILE_NOT_FOUND')
  if (code === 'EACCES' || code === 'EPERM') throw appError('PERMISSION_DENIED')
  if (error instanceof PublicError) throw error
  throw appError('INVALID_INPUT')
}

function equalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

async function validateInput(absolutePath: string): Promise<ValidatedInput> {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)
    || /^[a-z][a-z0-9+.-]*:\/\//iu.test(absolutePath)) {
    throw appError('INVALID_INPUT')
  }
  try {
    const original = await lstat(absolutePath)
    if (!original.isFile() || original.isSymbolicLink()) throw appError('INVALID_INPUT')
    const extension = path.extname(absolutePath).slice(1).toLocaleLowerCase('en-US')
    if (!SUPPORTED_EXTENSIONS.has(extension as DocumentConversionFormat)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    if (original.size > MAX_DOCUMENT_CONVERSION_INPUT_BYTES) {
      throw appError('DOCUMENT_CONVERSION_INPUT_TOO_LARGE')
    }
    const canonicalPath = await realpath(absolutePath)
    if (!equalPath(path.resolve(absolutePath), canonicalPath)) throw appError('INVALID_INPUT')
    const canonical = await lstat(canonicalPath)
    if (!canonical.isFile() || canonical.isSymbolicLink()
      || canonical.size !== original.size
      || canonical.mtimeMs !== original.mtimeMs
      || canonical.dev !== original.dev
      || canonical.ino !== original.ino) {
      throw appError('INVALID_INPUT')
    }
    return {
      canonicalPath,
      fileName: path.basename(canonicalPath),
      format: extension as DocumentConversionFormat,
      bytes: canonical.size,
      modifiedAtMs: Math.trunc(canonical.mtimeMs),
      rawModifiedAtMs: canonical.mtimeMs,
      device: canonical.dev,
      inode: canonical.ino,
    }
  } catch (error) {
    pathError(error)
  }
}

async function assertInputUnchanged(input: ValidatedInput): Promise<void> {
  try {
    const metadata = await lstat(input.canonicalPath)
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size !== input.bytes
      || metadata.mtimeMs !== input.rawModifiedAtMs
      || metadata.dev !== input.device
      || metadata.ino !== input.inode
      || !equalPath(await realpath(input.canonicalPath), input.canonicalPath)) {
      throw appError('DOCUMENT_CONVERSION_FAILED')
    }
  } catch (error) {
    if (error instanceof PublicError) throw error
    throw appError('DOCUMENT_CONVERSION_FAILED')
  }
}

export class DocumentConversionService {
  private readonly cache = new Map<string, ConvertedDocument>()
  private readonly active = new Map<string, ConversionFlight>()
  private readonly executions = new Set<Promise<void>>()
  private readonly unsubscribe: () => void
  private componentIdentity: string
  private disposed = false
  private generation = 0

  constructor(private readonly options: DocumentConversionServiceOptions) {
    this.componentIdentity = componentCacheIdentity(options.manager.getState())
    this.unsubscribe = options.manager.subscribe((state) => this.componentChanged(state))
  }

  async convertLocal(absolutePath: string, signal: AbortSignal): Promise<ConvertedDocument> {
    if (this.disposed) throw appError('OPERATION_FAILED')
    signal.throwIfAborted()
    const input = await (this.options.validateInput ?? validateInput)(absolutePath)
    return await this.convertValidatedInput(input, signal)
  }

  async convertResolved(
    resolved: ResolvedConvertibleDocument,
    signal: AbortSignal,
  ): Promise<ConvertedDocument> {
    if (this.disposed) throw appError('OPERATION_FAILED')
    signal.throwIfAborted()
    const input = await validateResolvedConvertibleDocument(resolved)
    return await this.convertValidatedInput(input, signal)
  }

  private async convertValidatedInput(
    input: ValidatedInput,
    signal: AbortSignal,
  ): Promise<ConvertedDocument> {
    if (this.disposed) throw appError('OPERATION_FAILED')
    signal.throwIfAborted()

    let lease: DocumentConversionComponentLease
    try {
      const verification = this.options.manager.ensureVerified()
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(
          signal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
        )
        signal.addEventListener('abort', abort, { once: true })
        void verification.then(
          () => {
            signal.removeEventListener('abort', abort)
            resolve()
          },
          (error) => {
            signal.removeEventListener('abort', abort)
            reject(error)
          },
        )
      })
    } catch (error) {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
      }
      if (error instanceof DOMException && error.name === 'AbortError') throw error
      throw appError('DOCUMENT_CONVERSION_COMPONENT_MISSING')
    }
    if (this.disposed) throw appError('OPERATION_FAILED')
    signal.throwIfAborted()
    try {
      lease = this.options.manager.acquireLease()
    } catch {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_MISSING')
    }
    const key = fingerprint(input, lease.runtime.version)
    const cached = this.cache.get(key)
    if (cached) {
      lease.release()
      return callerCopy(cached)
    }
    const existing = this.active.get(key)
    if (existing) {
      lease.release()
      return this.subscribe(existing, signal)
    }

    const flight: ConversionFlight = {
      key,
      generation: this.generation,
      input,
      lease,
      controller: new AbortController(),
      subscribers: new Map(),
    }
    this.active.set(key, flight)
    const result = this.subscribe(flight, signal)
    const execution = this.execute(flight)
    this.executions.add(execution)
    void execution.finally(() => this.executions.delete(execution)).catch(() => undefined)
    return result
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    try { this.unsubscribe() } catch { /* disposal must still terminate owned flights */ }
    this.cache.clear()
    const failure = appError('OPERATION_FAILED')
    for (const flight of this.active.values()) {
      for (const subscriber of [...flight.subscribers.values()]) {
        subscriber.cancel()
        subscriber.reject(failure)
      }
      flight.subscribers.clear()
      flight.controller.abort(failure)
    }
    this.notifyCacheInvalidated(null)
  }

  async disposeAndDrain(): Promise<void> {
    this.dispose()
    await Promise.allSettled([...this.executions])
  }

  private componentChanged(state: DocumentConversionComponentState): void {
    if (this.disposed) return
    const nextIdentity = componentCacheIdentity(state)
    if (nextIdentity === this.componentIdentity) return
    this.componentIdentity = nextIdentity
    this.generation += 1
    this.cache.clear()
    this.notifyCacheInvalidated(state.installedVersion)
  }

  private notifyCacheInvalidated(converterVersion: string | null): void {
    try { this.options.onCacheInvalidated?.(converterVersion) } catch {
      // Cache observers cannot own conversion or disposal control flow.
    }
  }

  private subscribe(flight: ConversionFlight, signal: AbortSignal): Promise<ConvertedDocument> {
    signal.throwIfAborted()
    const token = Symbol('document-conversion-subscriber')
    return new Promise<ConvertedDocument>((resolve, reject) => {
      let settled = false
      const cancel = (): void => {
        signal.removeEventListener('abort', abort)
      }
      const settleResolve = (value: ConvertedDocument): void => {
        if (settled) return
        settled = true
        cancel()
        flight.subscribers.delete(token)
        resolve(callerCopy(value))
      }
      const settleReject = (reason: unknown): void => {
        if (settled) return
        settled = true
        cancel()
        flight.subscribers.delete(token)
        reject(reason)
      }
      const abort = (): void => {
        settleReject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
        if (flight.subscribers.size === 0 && !flight.controller.signal.aborted) {
          flight.controller.abort(signal.reason)
        }
      }
      flight.subscribers.set(token, { signal, resolve: settleResolve, reject: settleReject, cancel })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  private async execute(flight: ConversionFlight): Promise<void> {
    try {
      await assertInputUnchanged(flight.input)
      const runnerInput: MarkItDownRunnerInput = {
        canonicalPath: flight.input.canonicalPath,
        format: flight.input.format,
        runtime: flight.lease.runtime,
        signal: flight.controller.signal,
      }
      const converted: MarkItDownRunnerResult = await this.options.runner.convert(runnerInput)
      await assertInputUnchanged(flight.input)
      const markdown = flight.input.format === 'pptx'
        ? normalizePptxMarkdown(converted.markdown)
        : converted.markdown
      if (!/\S/u.test(markdown)) throw appError('DOCUMENT_CONVERSION_EMPTY')
      if (Buffer.byteLength(markdown, 'utf8') > MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES) {
        throw appError('DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE')
      }
      const value = immutableDocument({
        source: {
          absolutePath: flight.input.canonicalPath,
          fileName: flight.input.fileName,
          format: flight.input.format,
          bytes: flight.input.bytes,
          modifiedAtMs: flight.input.modifiedAtMs,
        },
        markdown,
        converterVersion: flight.lease.runtime.version,
        fingerprint: flight.key,
        warnings: converted.warnings,
      })
      if (!this.disposed && flight.generation === this.generation) this.cache.set(flight.key, value)
      for (const subscriber of [...flight.subscribers.values()]) subscriber.resolve(value)
    } catch (error) {
      for (const subscriber of [...flight.subscribers.values()]) subscriber.reject(error)
    } finally {
      this.active.delete(flight.key)
      flight.lease.release()
    }
  }
}
