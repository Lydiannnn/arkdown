import { access, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import writeFileAtomic from 'write-file-atomic'
import type { ImportedDocx } from '../../shared/contracts'
import { isPandocImportPath } from '../../shared/document-types'
import { appError, PublicError } from '../../shared/public-errors'
import {
  normalizeImportedDocxMarkdown,
  normalizeMarkdownForDocxExport,
} from './docx-markdown'
import { resolvePandocExecutable, type PandocLocatorOptions } from './pandoc-locator'
import {
  PandocTerminationUnconfirmedError,
  runPandoc,
  runPandocText,
  type PandocTerminationStatus,
} from './pandoc-runner'

const MAX_CONVERTED_MARKDOWN_BYTES = 16 * 1024 * 1024

export interface DocxServiceOptions extends PandocLocatorOptions {
  tempRoot: string
  ensurePandoc?(signal: AbortSignal): Promise<string>
}

export interface DocxImportOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

interface DocxServiceDependencies {
  readonly readFile: typeof readFile
}

const DEFAULT_DEPENDENCIES: DocxServiceDependencies = { readFile }

export interface ImportedDocxText {
  readonly text: string
}

interface PendingTermination {
  readonly termination: PandocTerminationStatus
  readonly operationDirectory?: string
}

interface CombinedAbortSignal {
  readonly signal: AbortSignal
  dispose(): void
}

function combineAbortSignals(signals: readonly (AbortSignal | undefined)[]): CombinedAbortSignal {
  const controller = new AbortController()
  const removers: Array<() => void> = []
  for (const signal of signals) {
    if (signal === undefined) continue
    if (signal.aborted) {
      if (!controller.signal.aborted) controller.abort(signal.reason)
      continue
    }
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
    removers.push(() => signal.removeEventListener('abort', abort))
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of removers) remove()
    },
  }
}

async function requireConvertedFile(outputPath: string, signal: AbortSignal): Promise<void> {
  let metadata
  try {
    metadata = await stat(outputPath)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof PublicError) throw error
    throw appError('DOCX_CONVERSION_FAILED')
  }
  signal.throwIfAborted()
  if (!metadata.isFile() || metadata.size <= 0) throw appError('DOCX_CONVERSION_FAILED')
}

async function readConvertedMarkdown(
  outputPath: string,
  signal: AbortSignal,
  read: typeof readFile,
): Promise<string> {
  let metadata
  try {
    metadata = await stat(outputPath)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof PublicError) throw error
    throw appError('DOCX_CONVERSION_FAILED')
  }
  signal.throwIfAborted()
  if (!metadata.isFile() || metadata.size > MAX_CONVERTED_MARKDOWN_BYTES) {
    throw appError('DOCX_CONVERSION_FAILED')
  }
  let markdown
  try {
    markdown = await read(outputPath, 'utf8')
  } catch {
    signal.throwIfAborted()
    throw appError('DOCX_CONVERSION_FAILED')
  }
  signal.throwIfAborted()
  return markdown
}

function sanitizePlainText(plainText: string): string {
  let normalized = ''
  for (let index = 0; index < plainText.length; index += 1) {
    const character = plainText[index]!
    const code = character.charCodeAt(0)
    if (character === '\r') {
      if (plainText[index + 1] === '\n') index += 1
      normalized += '\n'
    } else if (character === '\n' || character === '\t') {
      normalized += character
    } else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      continue
    } else {
      normalized += character
    }
  }

  return normalized
}

export class DocxService {
  private readonly instanceRoot: string
  private readonly pendingTerminations = new Set<PendingTermination>()
  private readonly shutdownController = new AbortController()
  private readonly activeDrainWaiters = new Set<() => void>()
  private activeOperations = 0
  private disposed = false
  private disposePromise: Promise<void> | undefined

  constructor(
    private readonly options: DocxServiceOptions,
    private readonly dependencies: DocxServiceDependencies = DEFAULT_DEPENDENCIES,
  ) {
    this.instanceRoot = path.join(options.tempRoot, 'docx', randomUUID())
  }

  private async pandoc(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const executable = this.options.ensurePandoc
      ? await this.options.ensurePandoc(signal)
      : await resolvePandocExecutable(this.options)
    signal.throwIfAborted()
    return executable
  }

  private async removeOwnedDirectory(directory: string): Promise<void> {
    const relative = path.relative(this.instanceRoot, directory)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw appError('DOCX_CONVERSION_FAILED')
    }
    try {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      })
    } catch {
      throw appError('DOCX_CONVERSION_FAILED')
    }
  }

  private rememberUnconfirmedTermination(
    termination: PandocTerminationStatus,
    operationDirectory?: string,
  ): void {
    this.pendingTerminations.add({ termination, operationDirectory })
  }

  private acquireOperation(callerSignal?: AbortSignal): {
    readonly signal: AbortSignal
    release(): void
  } {
    if (this.disposed) throw appError('DOCX_CONVERSION_FAILED')
    this.activeOperations += 1
    const combined = combineAbortSignals([callerSignal, this.shutdownController.signal])
    let released = false
    return {
      signal: combined.signal,
      release: () => {
        if (released) return
        released = true
        combined.dispose()
        this.activeOperations -= 1
        if (this.activeOperations === 0) {
          for (const resolve of this.activeDrainWaiters) resolve()
          this.activeDrainWaiters.clear()
        }
      },
    }
  }

  private async withOperation<T>(
    callerSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease = this.acquireOperation(callerSignal)
    try {
      lease.signal.throwIfAborted()
      const result = await operation(lease.signal)
      lease.signal.throwIfAborted()
      return result
    } finally {
      lease.release()
    }
  }

  private async waitForActiveOperations(): Promise<void> {
    if (this.activeOperations === 0) return
    await new Promise<void>((resolve) => this.activeDrainWaiters.add(resolve))
  }

  private async prepareForOperation(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    for (const pending of this.pendingTerminations) {
      if (!pending.termination.isConfirmed()) throw appError('DOCX_CONVERSION_FAILED')
      if (pending.operationDirectory !== undefined) {
        await this.removeOwnedDirectory(pending.operationDirectory)
      }
      this.pendingTerminations.delete(pending)
    }
    signal.throwIfAborted()
    await mkdir(this.instanceRoot, { recursive: true })
    signal.throwIfAborted()
  }

  private async createOperationDirectory(
    kind: 'imports' | 'exports',
    signal: AbortSignal,
  ): Promise<string> {
    await this.prepareForOperation(signal)
    const directory = path.join(this.instanceRoot, kind, randomUUID())
    try {
      await mkdir(directory, { recursive: true })
      signal.throwIfAborted()
      return directory
    } catch (error) {
      await this.removeOwnedDirectory(directory)
      throw error
    }
  }

  private async canonicalImportSource(
    sourcePath: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted()
    if (!path.isAbsolute(sourcePath) || !isPandocImportPath(sourcePath)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const sourceMetadata = await lstat(sourcePath)
    signal.throwIfAborted()
    if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const canonicalSource = await realpath(sourcePath)
    signal.throwIfAborted()
    const canonicalMetadata = await lstat(canonicalSource)
    signal.throwIfAborted()
    if (canonicalMetadata.isSymbolicLink() || !canonicalMetadata.isFile()) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    return canonicalSource
  }

  async import(sourcePath: string, options: DocxImportOptions = {}): Promise<ImportedDocx> {
    return await this.withOperation(options.signal, async (signal) => {
      const canonicalSource = await this.canonicalImportSource(sourcePath, signal)
      const operationDirectory = await this.createOperationDirectory('imports', signal)
      const markdownPath = path.join(operationDirectory, 'document.md')
      let retainOperationDirectory = false
      try {
        await runPandoc(
          await this.pandoc(signal),
          [
            canonicalSource,
            '--from=docx',
            '--to=gfm+raw_html',
            '--wrap=none',
            '--extract-media=media',
            '--output=document.md',
          ],
          operationDirectory,
          { ...options, signal },
        )
        signal.throwIfAborted()
        const convertedMarkdown = await readConvertedMarkdown(
          markdownPath,
          signal,
          this.dependencies.readFile,
        )
        signal.throwIfAborted()
        const markdown = normalizeImportedDocxMarkdown(convertedMarkdown, operationDirectory)
        signal.throwIfAborted()
        await rm(markdownPath, { force: true })
        signal.throwIfAborted()
        retainOperationDirectory = true
        return {
          sourceAbsolutePath: canonicalSource,
          sourceFileName: path.basename(canonicalSource),
          markdown,
        }
      } catch (error) {
        const termination = PandocTerminationUnconfirmedError.getTerminationStatus(error)
        if (termination !== undefined) {
          retainOperationDirectory = true
          this.rememberUnconfirmedTermination(termination, operationDirectory)
        }
        throw error
      } finally {
        if (!retainOperationDirectory) await this.removeOwnedDirectory(operationDirectory)
      }
    })
  }

  async importText(
    sourcePath: string,
    options: DocxImportOptions = {},
  ): Promise<ImportedDocxText> {
    return await this.withOperation(options.signal, async (signal) => {
      const canonicalSource = await this.canonicalImportSource(sourcePath, signal)
      await this.prepareForOperation(signal)
      try {
        const plainText = await runPandocText(
          await this.pandoc(signal),
          [
            canonicalSource,
            '--from=docx',
            '--to=plain',
            '--wrap=none',
          ],
          this.instanceRoot,
          { ...options, signal },
        )
        signal.throwIfAborted()
        const text = sanitizePlainText(plainText)
        signal.throwIfAborted()
        return { text }
      } catch (error) {
        const termination = PandocTerminationUnconfirmedError.getTerminationStatus(error)
        if (termination !== undefined) {
          this.rememberUnconfirmedTermination(termination)
        }
        throw error
      }
    })
  }

  dispose(): Promise<void> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort(new DOMException('DocxService is shutting down', 'AbortError'))
    }
    const disposal = (async () => {
      await this.waitForActiveOperations()
      for (const pending of this.pendingTerminations) {
        await pending.termination.whenConfirmed
      }
      await this.removeOwnedDirectory(this.instanceRoot)
      this.pendingTerminations.clear()
    })()
    this.disposePromise = disposal
    void disposal.catch(() => {
      if (this.disposePromise === disposal) this.disposePromise = undefined
    })
    return disposal
  }

  async canReuseTarget(targetPath: string): Promise<boolean> {
    if (this.disposed) return false
    if (!path.isAbsolute(targetPath) || !/\.docx$/iu.test(targetPath)) return false
    try {
      const metadata = await lstat(targetPath)
      if (metadata.isSymbolicLink() || !metadata.isFile()) return false
      await Promise.all([
        access(targetPath, constants.W_OK),
        access(path.dirname(targetPath), constants.W_OK),
      ])
      return true
    } catch {
      return false
    }
  }

  async exportDocx(
    markdown: string,
    targetPath: string,
    options: Pick<DocxImportOptions, 'signal'> = {},
  ): Promise<void> {
    return await this.withOperation(options.signal, async (signal) => {
      if (
        !path.isAbsolute(targetPath)
        || path.extname(targetPath).toLocaleLowerCase('en-US') !== '.docx'
      ) {
        throw appError('UNSUPPORTED_FILE_TYPE')
      }

      const operationDirectory = await this.createOperationDirectory('exports', signal)
      const markdownPath = path.join(operationDirectory, 'document.md')
      const convertedName = 'document.docx'
      const convertedPath = path.join(operationDirectory, convertedName)
      let retainOperationDirectory = false
      try {
        await writeFile(markdownPath, normalizeMarkdownForDocxExport(markdown), 'utf8')
        signal.throwIfAborted()
        await runPandoc(
          await this.pandoc(signal),
          [
            'document.md',
            '--from=gfm+raw_html',
            '--to=docx',
            `--output=${convertedName}`,
          ],
          operationDirectory,
          { signal },
        )
        signal.throwIfAborted()
        await requireConvertedFile(convertedPath, signal)
        signal.throwIfAborted()
        const converted = await this.dependencies.readFile(convertedPath)
        signal.throwIfAborted()
        await writeFileAtomic(targetPath, converted, { fsync: true })
        signal.throwIfAborted()
      } catch (error) {
        const termination = PandocTerminationUnconfirmedError.getTerminationStatus(error)
        if (termination !== undefined) {
          retainOperationDirectory = true
          this.rememberUnconfirmedTermination(termination, operationDirectory)
        }
        throw error
      } finally {
        if (!retainOperationDirectory) await this.removeOwnedDirectory(operationDirectory)
      }
    })
  }
}
