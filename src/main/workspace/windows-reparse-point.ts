import { execFile } from 'node:child_process'
import path from 'node:path'

const FSUTIL_TIMEOUT_MS = 2_000
const FSUTIL_MAX_BUFFER_BYTES = 4 * 1024

export interface WindowsReparsePointCommandOptions {
  readonly encoding: 'buffer'
  readonly maxBuffer: number
  readonly shell: false
  readonly timeout: number
  readonly windowsHide: true
}

export interface WindowsReparsePointCommandResult {
  readonly error: (Error & {
    readonly code?: string | number | null
    readonly killed?: boolean
  }) | null
  readonly stdout: Buffer
  readonly stderr: Buffer
}

export type WindowsReparsePointCommandRunner = (
  file: string,
  args: readonly string[],
  options: WindowsReparsePointCommandOptions,
) => Promise<WindowsReparsePointCommandResult>

const runWindowsReparsePointCommand: WindowsReparsePointCommandRunner = (
  file,
  args,
  options,
) => new Promise((resolve) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    resolve({
      error,
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
    })
  })
})

function containsNotAReparsePointError(output: Buffer): boolean {
  return /(?:^|\r?\n)[^0-9\r\n]{0,32}4390\s*:/u.test(output.toString('latin1'))
}

function inspectionFailure(): Error {
  return new Error('Windows reparse-point inspection failed')
}

export async function queryWindowsReparsePoint(
  target: string,
  run: WindowsReparsePointCommandRunner = runWindowsReparsePointCommand,
): Promise<boolean> {
  if (process.platform !== 'win32') return false
  if (!path.win32.isAbsolute(target) || target.includes('\0')) throw inspectionFailure()
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || systemRoot.includes('\0')) {
    throw inspectionFailure()
  }

  let result: WindowsReparsePointCommandResult
  try {
    result = await run(
      path.win32.join(systemRoot, 'System32', 'fsutil.exe'),
      ['reparsepoint', 'query', target],
      {
        encoding: 'buffer',
        maxBuffer: FSUTIL_MAX_BUFFER_BYTES,
        shell: false,
        timeout: FSUTIL_TIMEOUT_MS,
        windowsHide: true,
      },
    )
  } catch {
    throw inspectionFailure()
  }

  if (!result.error) return true
  if (
    result.error.code === 1
    && result.error.killed !== true
    && (
      containsNotAReparsePointError(result.stdout)
      || containsNotAReparsePointError(result.stderr)
    )
  ) return false
  throw inspectionFailure()
}
