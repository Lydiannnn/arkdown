import { spawn } from 'node:child_process'
import { TextDecoder } from 'node:util'
import { appError } from '../../shared/public-errors'

const MAX_STDERR_BYTES = 16 * 1024
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDOUT_CHARACTERS = 16 * 1024 * 1024
const TERMINATION_GRACE_MS = 1_000
const FORCE_TERMINATION_GRACE_MS = 1_000

export interface PandocTerminationStatus {
  readonly whenConfirmed: Promise<void>
  isConfirmed(): boolean
}

const PANDOC_TERMINATION_ERROR_TOKEN = Symbol('pandoc-termination-error')

export class PandocTerminationUnconfirmedError extends Error {
  readonly code = 'DOCX_CONVERSION_FAILED'
  readonly name = 'PandocTerminationUnconfirmedError'
  readonly terminationReason: Error
  readonly #status: PandocTerminationStatus

  constructor(
    token: symbol,
    status: PandocTerminationStatus,
    terminationReason: Error,
  ) {
    super('Pandoc did not confirm process termination within the allowed grace period')
    if (token !== PANDOC_TERMINATION_ERROR_TOKEN) {
      throw new TypeError('Pandoc termination errors are runner-owned')
    }
    this.#status = status
    this.terminationReason = terminationReason
    Object.freeze(this)
  }

  get termination(): PandocTerminationStatus {
    return this.#status
  }

  static isAuthentic(error: unknown): error is PandocTerminationUnconfirmedError {
    return typeof error === 'object' && error !== null && #status in error
  }

  static getTerminationStatus(error: unknown): PandocTerminationStatus | undefined {
    return this.isAuthentic(error) ? error.#status : undefined
  }
}

Object.freeze(PandocTerminationUnconfirmedError.prototype)
Object.freeze(PandocTerminationUnconfirmedError)

function unconfirmedTerminationError(
  status: PandocTerminationStatus,
  reason: Error,
): PandocTerminationUnconfirmedError {
  return new PandocTerminationUnconfirmedError(
    PANDOC_TERMINATION_ERROR_TOKEN,
    status,
    reason,
  )
}

interface RunPandocOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export async function runPandoc(
  executable: string,
  args: readonly string[],
  cwd: string,
  options: RunPandocOptions = {},
): Promise<void> {
  await runPandocProcess(executable, args, cwd, false, options)
}

export async function runPandocText(
  executable: string,
  args: readonly string[],
  cwd: string,
  options: RunPandocOptions = {},
): Promise<string> {
  return runPandocProcess(executable, args, cwd, true, options)
}

async function runPandocProcess(
  executable: string,
  args: readonly string[],
  cwd: string,
  captureStdout: boolean,
  options: RunPandocOptions,
): Promise<string> {
  options.signal?.throwIfAborted()
  if (options.timeoutMs !== undefined
    && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw appError('DOCX_CONVERSION_FAILED')
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const stderrChunks: Buffer[] = []
    const stdoutDecoder = captureStdout
      ? new TextDecoder('utf-8', { fatal: true })
      : undefined
    let stdout = ''
    let stderrBytes = 0
    let stdoutBytes = 0
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    let removeAbortListener = () => {}
    let terminationError: Error | undefined
    let terminationStatus: PandocTerminationStatus | undefined
    let confirmTermination: (() => void) | undefined

    const finish = (error?: Error, stdout = '') => {
      if (settled) return
      settled = true
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
      if (terminationTimer !== undefined) clearTimeout(terminationTimer)
      removeAbortListener()
      if (error) reject(error)
      else resolve(stdout)
    }

    let child
    try {
      child = spawn(executable, [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      })
    } catch {
      finish(appError('DOCX_CONVERSION_FAILED'))
      return
    }

    const createTerminationStatus = (): PandocTerminationStatus => {
      if (terminationStatus !== undefined) return terminationStatus
      let resolveConfirmation = () => {}
      let confirmed = false
      const whenConfirmed = new Promise<void>((resolveConfirmationPromise) => {
        resolveConfirmation = resolveConfirmationPromise
      })
      const status: PandocTerminationStatus = Object.freeze({
        whenConfirmed,
        isConfirmed: () => confirmed,
      })
      terminationStatus = status
      confirmTermination = () => {
        if (confirmed) return
        confirmed = true
        resolveConfirmation()
      }
      return status
    }

    const terminate = (error: Error) => {
      if (settled || terminationError !== undefined) return
      terminationError = error
      const status = createTerminationStatus()

      try {
        child.kill()
      } catch {
        // A thrown/false kill does not prove that the child exited. The force phase
        // below still runs and only exit/close can confirm termination.
      }

      terminationTimer = setTimeout(() => {
        try {
          // On Windows Node maps SIGKILL to TerminateProcess; on POSIX it is the
          // non-catchable force-termination signal.
          child.kill('SIGKILL')
        } catch {
          // Confirmation remains event-driven; force-kill failure is handled by
          // the bounded unconfirmed-termination result below.
        }
        terminationTimer = setTimeout(() => {
          finish(unconfirmedTerminationError(status, error))
        }, FORCE_TERMINATION_GRACE_MS)
      }, TERMINATION_GRACE_MS)
    }

    if (captureStdout) {
      child.stdout?.on('data', (chunk: Buffer | string) => {
        if (settled || terminationError !== undefined) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
        if (bytes.length > MAX_STDOUT_BYTES - stdoutBytes) {
          terminate(appError('DOCX_CONVERSION_FAILED'))
          return
        }
        stdoutBytes += bytes.length
        try {
          const decoded = stdoutDecoder!.decode(bytes, { stream: true })
          if (decoded.length > MAX_STDOUT_CHARACTERS - stdout.length) {
            terminate(appError('DOCX_CONVERSION_FAILED'))
            return
          }
          stdout += decoded
        } catch {
          terminate(appError('DOCX_CONVERSION_FAILED'))
        }
      })
    }

    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
      const retained = Buffer.from(bytes.subarray(0, MAX_STDERR_BYTES - stderrBytes))
      stderrChunks.push(retained)
      stderrBytes += retained.length
    })
    const handlePipeError = () => terminate(appError('DOCX_CONVERSION_FAILED'))
    child.stdout?.on('error', handlePipeError)
    child.stderr?.on('error', handlePipeError)

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (terminationError !== undefined) return
      finish(error.code === 'ENOENT'
        ? appError('PANDOC_NOT_FOUND')
        : appError('DOCX_CONVERSION_FAILED'))
    })
    child.once('exit', () => {
      confirmTermination?.()
      if (terminationError !== undefined) finish(terminationError)
    })
    child.once('close', (code) => {
      confirmTermination?.()
      if (terminationError !== undefined) finish(terminationError)
      else if (code === 0) {
        if (!captureStdout) {
          finish()
          return
        }
        try {
          const tail = stdoutDecoder!.decode()
          if (tail.length > MAX_STDOUT_CHARACTERS - stdout.length) {
            finish(appError('DOCX_CONVERSION_FAILED'))
          } else {
            finish(undefined, stdout + tail)
          }
        } catch {
          finish(appError('DOCX_CONVERSION_FAILED'))
        }
      }
      else {
        void stderrChunks
        finish(appError('DOCX_CONVERSION_FAILED'))
      }
    })

    const abort = () => {
      const reason = options.signal?.reason
      terminate(reason instanceof Error
        ? reason
        : new DOMException('The Pandoc conversion was canceled', 'AbortError'))
    }
    if (options.signal !== undefined) {
      options.signal.addEventListener('abort', abort, { once: true })
      removeAbortListener = () => options.signal?.removeEventListener('abort', abort)
      if (options.signal.aborted) {
        abort()
        return
      }
    }
    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        terminate(appError('DOCX_CONVERSION_FAILED'))
      }, options.timeoutMs)
    }
  })
}
