import { spawn } from 'node:child_process'
import { constants as fsConstants, type Stats } from 'node:fs'
import type { Readable } from 'node:stream'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import {
  documentConversionTimeoutMs,
  MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES,
  type DocumentConversionFormat,
} from '../../shared/document-conversion'
import { appError, PublicError } from '../../shared/public-errors'
import type { DocumentConversionRuntime } from './component-manager'

const PROCESS_STREAM_LIMIT_BYTES = 64 * 1024
const STATUS_LIMIT_BYTES = 64 * 1024
const FILE_READ_CHUNK_BYTES = 64 * 1024
const OPERATION_PREFIX = 'arkdown-markitdown-'
const SAFE_FILE_OPEN_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NONBLOCK ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0)

export interface MarkItDownSpawnedChild {
  readonly stdout: Readable
  readonly stderr: Readable
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface MarkItDownSpawnOptions {
  cwd: string
  windowsHide: true
  shell: false
  env: {
    PYTHONIOENCODING: 'utf-8'
    PYTHONUTF8: '1'
    PYTHONDONTWRITEBYTECODE: '1'
  }
}

export type MarkItDownSpawn = (
  command: string,
  args: readonly string[],
  options: MarkItDownSpawnOptions,
) => MarkItDownSpawnedChild

export interface MarkItDownRunnerInput {
  canonicalPath: string
  format: DocumentConversionFormat
  runtime: DocumentConversionRuntime
  signal: AbortSignal
}

export interface MarkItDownRunnerResult {
  markdown: string
  warnings: readonly string[]
}

export interface MarkItDownRunner {
  convert(input: MarkItDownRunnerInput): Promise<MarkItDownRunnerResult>
}

export interface MarkItDownFileHandle {
  stat(): Promise<Stats>
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

export type MarkItDownOpenFile = (filePath: string, flags?: number) => Promise<MarkItDownFileHandle>
export type MarkItDownRemoveDirectory = (directory: string) => Promise<void>

export interface MarkItDownRunnerOptions {
  tempRoot: string
  spawn?: MarkItDownSpawn
  openFile?: MarkItDownOpenFile
  removeDirectory?: MarkItDownRemoveDirectory
}

type ForcedExit = 'abort' | 'timeout' | 'stream-limit' | undefined

function equalPath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight
}

function fileTooLarge(maximumBytes: number): PublicError {
  return appError(maximumBytes === MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES
    ? 'DOCUMENT_CONVERSION_OUTPUT_TOO_LARGE'
    : 'DOCUMENT_CONVERSION_FAILED')
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

async function assertOpenedRegularPath(filePath: string, opened: Stats): Promise<Stats> {
  const pathname = await lstat(filePath)
  if (!opened.isFile() || !pathname.isFile() || pathname.isSymbolicLink()
    || !sameFileSnapshot(opened, pathname)
    || !equalPath(await realpath(filePath), filePath)) {
    throw appError('DOCUMENT_CONVERSION_FAILED')
  }
  return pathname
}

async function readBoundedOwnedRegularFile(
  filePath: string,
  maximumBytes: number,
  openFile: MarkItDownOpenFile,
): Promise<Buffer> {
  let handle: MarkItDownFileHandle
  try {
    handle = await openFile(filePath, SAFE_FILE_OPEN_FLAGS)
  } catch {
    throw appError('DOCUMENT_CONVERSION_FAILED')
  }

  let outcome: { ok: true; value: Buffer } | { ok: false; error: unknown }
  try {
    const before = await handle.stat()
    await assertOpenedRegularPath(filePath, before)
    if (before.size > maximumBytes) throw fileTooLarge(maximumBytes)

    const chunks: Buffer[] = []
    let total = 0
    while (total <= maximumBytes) {
      const length = Math.min(FILE_READ_CHUNK_BYTES, maximumBytes + 1 - total)
      const chunk = Buffer.allocUnsafe(length)
      const result = await handle.read(chunk, 0, length, total)
      if (!Number.isSafeInteger(result.bytesRead)
        || result.bytesRead < 0
        || result.bytesRead > length) {
        throw appError('DOCUMENT_CONVERSION_FAILED')
      }
      if (result.bytesRead === 0) break
      chunks.push(chunk.subarray(0, result.bytesRead))
      total += result.bytesRead
    }
    if (total > maximumBytes) throw fileTooLarge(maximumBytes)

    const after = await handle.stat()
    await assertOpenedRegularPath(filePath, after)
    if (!sameFileSnapshot(before, after) || after.size !== total) {
      if (after.size > maximumBytes) throw fileTooLarge(maximumBytes)
      throw appError('DOCUMENT_CONVERSION_FAILED')
    }
    outcome = { ok: true, value: Buffer.concat(chunks, total) }
  } catch (error) {
    outcome = {
      ok: false,
      error: error instanceof PublicError ? error : appError('DOCUMENT_CONVERSION_FAILED'),
    }
  }

  try {
    await handle.close()
  } catch {
    if (outcome.ok) throw appError('DOCUMENT_CONVERSION_FAILED')
  }
  if (!outcome.ok) throw outcome.error
  return outcome.value
}

function parseExactStatus(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const record = value as Record<string, unknown>
  const keys = Reflect.ownKeys(record)
  const valid = keys.length === 2
    && keys.includes('ok')
    && keys.includes('chars')
    && record.ok === true
    && Number.isSafeInteger(record.chars)
    && (record.chars as number) >= 0
  return valid ? record.chars as number : undefined
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

export function createMarkItDownRunner(options: MarkItDownRunnerOptions): MarkItDownRunner {
  const tempRoot = path.resolve(options.tempRoot)
  const spawnProcess: MarkItDownSpawn = options.spawn ?? ((command, args, spawnOptions) => (
    spawn(command, [...args], { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] }) as MarkItDownSpawnedChild
  ))
  const openFile: MarkItDownOpenFile = options.openFile
    ?? (async (filePath, flags = SAFE_FILE_OPEN_FLAGS) => open(filePath, flags))
  const removeDirectory: MarkItDownRemoveDirectory = options.removeDirectory
    ?? (async (directory) => rm(directory, { recursive: true, force: true }))

  const removeOperationDirectory = async (operationDirectory: string): Promise<void> => {
    const resolved = path.resolve(operationDirectory)
    const relative = path.relative(tempRoot, resolved)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative) || path.dirname(relative) !== '.'
      || !path.basename(relative).startsWith(OPERATION_PREFIX)) {
      throw new Error('Refusing to remove a directory outside the MarkItDown temp root')
    }
    await removeDirectory(resolved)
  }

  return {
    async convert(input) {
      input.signal.throwIfAborted()
      await mkdir(tempRoot, { recursive: true })
      const rootMetadata = await lstat(tempRoot)
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()
        || !equalPath(await realpath(tempRoot), tempRoot)) {
        throw appError('DOCUMENT_CONVERSION_FAILED')
      }
      const operationDirectory = await mkdtemp(path.join(tempRoot, OPERATION_PREFIX))
      const markdownPath = path.join(operationDirectory, 'output.md')
      const statusPath = path.join(operationDirectory, 'status.json')
      let outcome: { ok: true; value: MarkItDownRunnerResult } | { ok: false; error: unknown }
      try {
        let child: MarkItDownSpawnedChild
        try {
          child = spawnProcess(input.runtime.pythonExecutable, [
            input.runtime.entryScript,
            '--input', input.canonicalPath,
            '--output', markdownPath,
            '--status', statusPath,
          ], {
            cwd: operationDirectory,
            windowsHide: true,
            shell: false,
            env: {
              PYTHONIOENCODING: 'utf-8',
              PYTHONUTF8: '1',
              PYTHONDONTWRITEBYTECODE: '1',
            },
          })
        } catch {
          throw appError('DOCUMENT_CONVERSION_FAILED')
        }

        let forcedExit: ForcedExit
        let finished = false
        let stdoutBytes = 0
        let stderrBytes = 0
        const force = (reason: Exclude<ForcedExit, undefined>): void => {
          if (finished || forcedExit) return
          forcedExit = reason
          child.kill('SIGTERM')
        }
        const countStream = (stream: Readable, kind: 'stdout' | 'stderr'): void => {
          stream.on('data', (chunk: Buffer | string) => {
            const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
            if (kind === 'stdout') stdoutBytes += bytes
            else stderrBytes += bytes
            if (stdoutBytes > PROCESS_STREAM_LIMIT_BYTES || stderrBytes > PROCESS_STREAM_LIMIT_BYTES) {
              force('stream-limit')
            }
          })
        }
        countStream(child.stdout, 'stdout')
        countStream(child.stderr, 'stderr')

        const exit = await new Promise<{ code: number | null; spawnFailed: boolean }>((resolve) => {
          const timeout = setTimeout(() => force('timeout'), documentConversionTimeoutMs(input.format))
          const cancel = (): void => force('abort')
          const settle = (result: { code: number | null; spawnFailed: boolean }): void => {
            if (finished) return
            finished = true
            clearTimeout(timeout)
            input.signal.removeEventListener('abort', cancel)
            resolve(result)
          }
          child.once('error', () => settle({ code: null, spawnFailed: true }))
          child.once('close', (code) => settle({ code, spawnFailed: false }))
          if (input.signal.aborted) cancel()
          else input.signal.addEventListener('abort', cancel, { once: true })
        })

        if (forcedExit === 'abort') throw abortReason(input.signal)
        if (forcedExit === 'timeout') throw appError('DOCUMENT_CONVERSION_TIMEOUT')
        if (forcedExit === 'stream-limit' || exit.spawnFailed || exit.code !== 0) {
          throw appError('DOCUMENT_CONVERSION_FAILED')
        }

        let statusCharacterCount: number | undefined
        try {
          const statusBytes = await readBoundedOwnedRegularFile(statusPath, STATUS_LIMIT_BYTES, openFile)
          statusCharacterCount = parseExactStatus(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(statusBytes)) as unknown,
          )
        } catch {
          throw appError('DOCUMENT_CONVERSION_FAILED')
        }
        if (statusCharacterCount === undefined) throw appError('DOCUMENT_CONVERSION_FAILED')
        const outputBytes = await readBoundedOwnedRegularFile(
          markdownPath,
          MAX_DOCUMENT_CONVERSION_OUTPUT_BYTES,
          openFile,
        )
        let markdown: string
        try {
          markdown = new TextDecoder('utf-8', { fatal: true }).decode(outputBytes)
        } catch {
          throw appError('DOCUMENT_CONVERSION_FAILED')
        }
        if (statusCharacterCount !== [...markdown].length) throw appError('DOCUMENT_CONVERSION_FAILED')
        outcome = {
          ok: true,
          value: Object.freeze({ markdown, warnings: Object.freeze([] as string[]) }),
        }
      } catch (error) {
        outcome = { ok: false, error }
      }

      try {
        await removeOperationDirectory(operationDirectory)
      } catch {
        if (outcome.ok) throw appError('DOCUMENT_CONVERSION_FAILED')
      }
      if (!outcome.ok) throw outcome.error
      return outcome.value
    },
  }
}
