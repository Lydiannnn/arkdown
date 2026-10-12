import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const MAX_OUTPUT_BYTES = 512
export type ProcessCreationIdentityMatch = 'alive-match' | 'dead-or-mismatch' | 'unknown'

type ProcessCreationIdentityLookup =
  | { status: 'alive'; identity: string }
  | { status: 'dead' }
  | { status: 'unknown' }

let currentProcessIdentity: Promise<ProcessCreationIdentityLookup> | undefined

function windowsCreationIdentity(pid: number, timeoutMs = 2_000): Promise<ProcessCreationIdentityLookup> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `try{$p=Get-Process -Id ${pid} -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*'){'dead';exit 0};exit 2};try{$p.StartTime.ToUniversalTime().Ticks}catch{exit 2}`],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
      (error, stdout) => {
        const value = stdout.trim()
        if (error) resolve({ status: 'unknown' })
        else if (value === 'dead') resolve({ status: 'dead' })
        else if (/^[0-9]{10,20}$/u.test(value)) resolve({ status: 'alive', identity: `win:${value}` })
        else resolve({ status: 'unknown' })
      },
    )
  })
}

async function unixCreationIdentity(pid: number): Promise<ProcessCreationIdentityLookup> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    if (Buffer.byteLength(stat) > 4 * 1024) return { status: 'unknown' }
    const close = stat.lastIndexOf(')')
    if (close < 1) return { status: 'unknown' }
    const fields = stat.slice(close + 2).split(' ')
    const startTime = fields[19]
    return startTime && /^[0-9]+$/u.test(startTime)
      ? { status: 'alive', identity: `proc:${startTime}` }
      : { status: 'unknown' }
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? { status: 'dead' }
      : { status: 'unknown' }
  }
}

async function processCreationIdentityFor(pid: number): Promise<ProcessCreationIdentityLookup> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'dead' }
  if (pid === process.pid) {
    const attempt = currentProcessIdentity ??= process.platform === 'win32'
      ? windowsCreationIdentity(pid)
      : unixCreationIdentity(pid)
    const result = await attempt
    if (result.status !== 'alive' && currentProcessIdentity === attempt) currentProcessIdentity = undefined
    return result
  }
  return process.platform === 'win32'
    ? windowsCreationIdentity(pid)
    : unixCreationIdentity(pid)
}

export async function currentProcessCreationIdentity(): Promise<string | undefined> {
  const result = await processCreationIdentityFor(process.pid)
  return result.status === 'alive' ? result.identity : undefined
}

export async function processCreationIdentityMatches(
  pid: number,
  expectedIdentity: string,
): Promise<ProcessCreationIdentityMatch> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead-or-mismatch'
  if (process.platform === 'win32') return windowsProcessCreationIdentityMatches(pid, expectedIdentity)
  const result = await unixCreationIdentity(pid)
  if (result.status === 'unknown') return 'unknown'
  if (result.status === 'dead') return 'dead-or-mismatch'
  return result.identity === expectedIdentity ? 'alive-match' : 'dead-or-mismatch'
}

export async function windowsProcessCreationIdentityMatches(
  pid: number,
  expectedIdentity: string,
  timeoutMs = 2_000,
): Promise<ProcessCreationIdentityMatch> {
  const result = await windowsCreationIdentity(pid, timeoutMs)
  if (result.status === 'unknown') return 'unknown'
  if (result.status === 'dead') return 'dead-or-mismatch'
  return result.identity === expectedIdentity ? 'alive-match' : 'dead-or-mismatch'
}
