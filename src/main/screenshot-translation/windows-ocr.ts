import { spawn as nodeSpawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { mkdir as nodeMkdir, mkdtemp as nodeMkdtemp, rm, writeFile as nodeWriteFile } from 'node:fs/promises'
import path from 'node:path'
import {
  SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES,
  SCREENSHOT_IMAGE_MAX_DIMENSION_PX,
  SCREENSHOT_IMAGE_MAX_PIXELS,
  parseScreenshotOcrBlocks,
  parseScreenshotSessionId,
  type ScreenshotOcrResult,
  type ScreenshotRect,
} from '../../shared/screenshot-translation'

export type WindowsOcrErrorCode =
  | 'OCR_UNAVAILABLE'
  | 'OCR_LANGUAGE_UNAVAILABLE'
  | 'OCR_TIMEOUT'
  | 'OCR_CANCELLED'
  | 'OCR_FAILED'

export class WindowsOcrError extends Error {
  readonly code: WindowsOcrErrorCode
  constructor(code: WindowsOcrErrorCode) {
    super(code)
    this.name = 'WindowsOcrError'
    this.code = code
  }
}

export interface WindowsOcrDiagnostic {
  phase: 'cleanup'
  code: 'cleanup-failed'
}

export interface OcrBridgeChild {
  stdout: Readable
  stderr: Readable
  killed: boolean
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  removeAllListeners(): this
}

type SpawnOcrBridge = (command: string, args: readonly string[], options: {
  shell: false
  windowsHide: true
  stdio: ['ignore', 'pipe', 'pipe']
  env: NodeJS.ProcessEnv
}) => OcrBridgeChild

export interface WindowsOcrService {
  recognize(input: { sessionId: string; png: Uint8Array; signal: AbortSignal }): Promise<ScreenshotOcrResult>
  dispose(): Promise<void>
}

export interface WindowsOcrOptions {
  tempRoot: string
  resolveScriptPath: () => string
  spawn?: SpawnOcrBridge
  timeoutMs?: number
  stdoutLimit?: number
  stderrLimit?: number
  diagnostic?: (event: WindowsOcrDiagnostic) => void
  removeDirectory?: (directory: string) => Promise<void>
  makeRoot?: (directory: string) => Promise<void>
  makeTemporaryDirectory?: (prefix: string) => Promise<string>
  writeInputFile?: (filePath: string, bytes: Uint8Array) => Promise<void>
}

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_STDOUT_LIMIT = 8 * 1024 * 1024
const DEFAULT_STDERR_LIMIT = 64 * 1024

interface PngDimensions { width: number; height: number }
interface ActiveOperation { cancel(code: WindowsOcrErrorCode): void; settled: Promise<void> }

function parsePngDimensions(value: Uint8Array): PngDimensions | undefined {
  if (!(value instanceof Uint8Array)
    || value.byteLength < 33
    || value.byteLength > SCREENSHOT_IMAGE_DATA_URL_MAX_BYTES) return undefined
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (value[index] !== PNG_SIGNATURE[index]) return undefined
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  if (view.getUint32(8) !== 13
    || value[12] !== 0x49 || value[13] !== 0x48 || value[14] !== 0x44 || value[15] !== 0x52) return undefined
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width < 1 || height < 1
    || width > SCREENSHOT_IMAGE_MAX_DIMENSION_PX
    || height > SCREENSHOT_IMAGE_MAX_DIMENSION_PX
    || width * height > SCREENSHOT_IMAGE_MAX_PIXELS) return undefined
  return { width, height }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function canonicalProtocolString(value: string): boolean {
  if (value.normalize('NFC') !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

export function parseBoundedOcrJsonDocument(text: string): unknown {
  const maxDepth = 6
  let index = 0
  const whitespace = () => { while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index]!)) index += 1 }
  const string = (): string => {
    if (text[index] !== '"') throw new Error('json')
    const start = index++
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code < 0x20) throw new Error('json')
      if (text[index] === '"') {
        index += 1
        const value = JSON.parse(text.slice(start, index)) as unknown
        if (typeof value !== 'string' || !canonicalProtocolString(value)) throw new Error('json')
        return value
      }
      if (text[index] === '\\') {
        index += 2
        continue
      }
      index += 1
    }
    throw new Error('json')
  }
  const value = (depth: number): void => {
    whitespace()
    if (text[index] === '{') {
      if (depth >= maxDepth) throw new Error('json')
      index += 1; whitespace()
      const keys = new Set<string>()
      if (text[index] === '}') { index += 1; return }
      while (true) {
        const key = string()
        if (keys.has(key)) throw new Error('json')
        keys.add(key); whitespace()
        if (text[index++] !== ':') throw new Error('json')
        value(depth + 1); whitespace()
        const delimiter = text[index++]
        if (delimiter === '}') return
        if (delimiter !== ',') throw new Error('json')
        whitespace()
      }
    }
    if (text[index] === '[') {
      if (depth >= maxDepth) throw new Error('json')
      index += 1; whitespace()
      if (text[index] === ']') { index += 1; return }
      while (true) {
        value(depth + 1); whitespace()
        const delimiter = text[index++]
        if (delimiter === ']') return
        if (delimiter !== ',') throw new Error('json')
        whitespace()
      }
    }
    if (text[index] === '"') { string(); return }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, index)) { index += literal.length; return }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(index))?.[0]
    if (!number) throw new Error('json')
    index += number.length
  }
  value(0); whitespace()
  if (index !== text.length) throw new Error('json')
  return JSON.parse(text) as unknown
}

function rectContained(rect: ScreenshotRect, width: number, height: number): boolean {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= width && rect.y + rect.height <= height
}

function sameRect(left: ScreenshotRect, right: ScreenshotRect): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function unionRects(rectangles: readonly ScreenshotRect[]): ScreenshotRect | undefined {
  if (rectangles.length === 0) return undefined
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = 0
  let bottom = 0
  for (const rect of rectangles) {
    left = Math.min(left, rect.x)
    top = Math.min(top, rect.y)
    right = Math.max(right, rect.x + rect.width)
    bottom = Math.max(bottom, rect.y + rect.height)
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function parseBridgeOutput(bytes: Buffer, expected: PngDimensions): ScreenshotOcrResult {
  if (bytes.length === 0 || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) throw new WindowsOcrError('OCR_FAILED')
  let text: string
  let value: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    value = parseBoundedOcrJsonDocument(text)
  } catch { throw new WindowsOcrError('OCR_FAILED') }
  if (!exactRecord(value, value && typeof value === 'object' && (value as { status?: unknown }).status === 'ok'
    ? ['status', 'width', 'height', 'language', 'blocks']
    : ['status', 'code'])) throw new WindowsOcrError('OCR_FAILED')
  if (value.status === 'error') {
    if (value.code === 'language-unavailable') throw new WindowsOcrError('OCR_LANGUAGE_UNAVAILABLE')
    if (value.code === 'decode-failed' || value.code === 'ocr-failed' || value.code === 'output-limit') throw new WindowsOcrError('OCR_FAILED')
    throw new WindowsOcrError('OCR_FAILED')
  }
  if (value.status !== 'ok'
    || value.width !== expected.width
    || value.height !== expected.height
    || typeof value.language !== 'string'
    || value.language.length < 1 || value.language.length > 64
    || value.language.normalize('NFC') !== value.language
    || !/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(value.language)) throw new WindowsOcrError('OCR_FAILED')
  const blocks = parseScreenshotOcrBlocks(value.blocks)
  if (!blocks) throw new WindowsOcrError('OCR_FAILED')
  const ids = new Set<string>()
  for (const block of blocks) {
    if (ids.has(block.id) || !rectContained(block.rectPx, expected.width, expected.height)) throw new WindowsOcrError('OCR_FAILED')
    ids.add(block.id)
    if (block.words.length > 0) {
      const union = unionRects(block.words.map((word) => word.rectPx))
      if (!union || !sameRect(union, block.rectPx)) throw new WindowsOcrError('OCR_FAILED')
    }
  }
  return { width: expected.width, height: expected.height, language: value.language, blocks }
}

function safeOwnedChild(root: string, directory: string): boolean {
  const resolvedRoot = path.resolve(root)
  const resolvedDirectory = path.resolve(directory)
  return path.dirname(resolvedDirectory).toLocaleLowerCase('en-US') === resolvedRoot.toLocaleLowerCase('en-US')
    && resolvedDirectory !== resolvedRoot
}

function processEnvironment(): NodeJS.ProcessEnv {
  const keys = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PSModulePath'] as const
  const environment: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  for (const key of keys) if (process.env[key] !== undefined) environment[key] = process.env[key]
  return environment
}

export function createWindowsOcrScriptResolver(options: {
  isPackaged: boolean
  resourcesPath: string
  developmentRoot?: string
}): () => string {
  const scriptPath = options.isPackaged
    ? path.join(options.resourcesPath, 'screenshot-translation', 'windows-ocr.ps1')
    : path.join(options.developmentRoot ?? process.cwd(), 'scripts', 'windows-ocr.ps1')
  return () => scriptPath
}

export function createWindowsOcrService(options: WindowsOcrOptions): WindowsOcrService {
  const spawn = options.spawn ?? nodeSpawn as unknown as SpawnOcrBridge
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stdoutLimit = options.stdoutLimit ?? DEFAULT_STDOUT_LIMIT
  const stderrLimit = options.stderrLimit ?? DEFAULT_STDERR_LIMIT
  const removeDirectory = options.removeDirectory ?? ((directory: string) => rm(directory, { recursive: true, force: true }))
  const makeRoot = options.makeRoot ?? (async (directory: string) => { await nodeMkdir(directory, { recursive: true }) })
  const makeTemporaryDirectory = options.makeTemporaryDirectory ?? nodeMkdtemp
  const writeInputFile = options.writeInputFile ?? (async (filePath: string, bytes: Uint8Array) => {
    await nodeWriteFile(filePath, bytes, { flag: 'wx' })
  })
  const active = new Set<ActiveOperation>()
  let disposed = false

  const emitDiagnostic = (event: WindowsOcrDiagnostic) => {
    try { options.diagnostic?.(event) } catch { /* diagnostics never own lifecycle */ }
  }

  return {
    recognize(input) {
      if (disposed) return Promise.reject(new WindowsOcrError('OCR_UNAVAILABLE'))
      if (!exactRecord(input, ['sessionId', 'png', 'signal'])
        || !parseScreenshotSessionId(input.sessionId)
        || !(input.signal instanceof AbortSignal)) {
        return Promise.reject(new WindowsOcrError('OCR_FAILED'))
      }
      if (input.signal.aborted) {
        return Promise.reject(new WindowsOcrError('OCR_CANCELLED'))
      }
      const dimensions = parsePngDimensions(input.png)
      if (!dimensions) return Promise.reject(new WindowsOcrError('OCR_FAILED'))
      let scriptPath: string
      try {
        const resolved = options.resolveScriptPath()
        if (typeof resolved !== 'string' || resolved.length === 0 || resolved.includes('\0')) throw new Error('invalid')
        scriptPath = path.resolve(resolved)
      } catch { return Promise.reject(new WindowsOcrError('OCR_FAILED')) }

      let child: OcrBridgeChild | undefined
      let directory: string | undefined
      let timer: NodeJS.Timeout | undefined
      let done = false
      let cancelled: WindowsOcrErrorCode | undefined
      let stdoutBytes = 0
      let stderrBytes = 0
      const stdout: Buffer[] = []
      let settleFinalizer!: () => void
      const settled = new Promise<void>((resolve) => { settleFinalizer = resolve })
      let rejectPromise!: (error: WindowsOcrError) => void
      let resolvePromise!: (result: ScreenshotOcrResult) => void
      const resultPromise = new Promise<ScreenshotOcrResult>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })

      const cleanup = async () => {
        try {
          if (timer) clearTimeout(timer)
          input.signal.removeEventListener('abort', onAbort)
          child?.removeAllListeners()
          child?.stdout.removeAllListeners()
          child?.stderr.removeAllListeners()
          if (directory && safeOwnedChild(options.tempRoot, directory)) {
            try { await removeDirectory(directory) } catch { emitDiagnostic({ phase: 'cleanup', code: 'cleanup-failed' }) }
          }
        } catch {
          emitDiagnostic({ phase: 'cleanup', code: 'cleanup-failed' })
        }
      }
      const finish = (outcome: { result: ScreenshotOcrResult } | { error: WindowsOcrError }, kill: boolean) => {
        if (done) return
        done = true
        const terminate = !kill || !child ? Promise.resolve() : new Promise<void>((resolve) => {
          let terminationTimer: NodeJS.Timeout | undefined
          const complete = () => {
            if (terminationTimer) clearTimeout(terminationTimer)
            resolve()
          }
          child!.once('close', complete)
          child!.once('error', complete)
          terminationTimer = setTimeout(complete, 2_000)
          if (!child!.killed) { try { child!.kill() } catch { complete() } }
        })
        void terminate.then(cleanup).then(() => {
          if ('result' in outcome) resolvePromise(outcome.result)
          else rejectPromise(outcome.error)
          active.delete(operation)
          settleFinalizer()
        })
      }
      const operation: ActiveOperation = {
        cancel: (code) => {
          cancelled ??= code
          if (child) finish({ error: new WindowsOcrError(cancelled) }, true)
        },
        settled,
      }
      const onAbort = () => operation.cancel('OCR_CANCELLED')
      active.add(operation)
      input.signal.addEventListener('abort', onAbort, { once: true })
      if (disposed || input.signal.aborted) operation.cancel('OCR_CANCELLED')

      void (async () => {
        try {
          await makeRoot(options.tempRoot)
          if (cancelled) return finish({ error: new WindowsOcrError(cancelled) }, false)
          directory = await makeTemporaryDirectory(path.join(path.resolve(options.tempRoot), 'ocr-'))
          if (!safeOwnedChild(options.tempRoot, directory)) return finish({ error: new WindowsOcrError('OCR_FAILED') }, false)
          if (cancelled) return finish({ error: new WindowsOcrError(cancelled) }, false)
          const inputPath = path.join(directory, 'capture.png')
          await writeInputFile(inputPath, input.png)
          if (cancelled) return finish({ error: new WindowsOcrError(cancelled) }, false)
          child = spawn('powershell.exe', [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath, '-InputPath', inputPath,
          ], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: processEnvironment() })
          child.stdout.on('data', (chunk: Buffer | string) => {
            if (done) return
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            stdoutBytes += bytes.length
            if (stdoutBytes > stdoutLimit) return finish({ error: new WindowsOcrError('OCR_FAILED') }, true)
            stdout.push(bytes)
          })
          child.stderr.on('data', (chunk: Buffer | string) => {
            if (done) return
            stderrBytes += Buffer.byteLength(chunk)
            if (stderrBytes > stderrLimit) finish({ error: new WindowsOcrError('OCR_FAILED') }, true)
          })
          child.once('error', () => finish({ error: new WindowsOcrError('OCR_FAILED') }, true))
          child.once('close', (code, signal) => {
            if (done) return
            if (code !== 0 || signal !== null) return finish({ error: new WindowsOcrError('OCR_FAILED') }, false)
            try { finish({ result: parseBridgeOutput(Buffer.concat(stdout, stdoutBytes), dimensions) }, false) }
            catch (error) {
              finish({ error: error instanceof WindowsOcrError ? error : new WindowsOcrError('OCR_FAILED') }, false)
            }
          })
          if (cancelled) return finish({ error: new WindowsOcrError(cancelled) }, true)
          timer = setTimeout(() => operation.cancel('OCR_TIMEOUT'), timeoutMs)
        } catch { finish({ error: new WindowsOcrError(cancelled ?? 'OCR_FAILED') }, Boolean(child)) }
      })()
      return resultPromise
    },
    async dispose() {
      if (!disposed) {
        disposed = true
        for (const operation of [...active]) operation.cancel('OCR_CANCELLED')
      }
      await Promise.all([...active].map((operation) => operation.settled))
    },
  }
}
