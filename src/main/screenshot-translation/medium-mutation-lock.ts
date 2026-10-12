import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import type { ProcessCreationIdentityMatch } from './process-creation-identity'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_RECORD_BYTES = 4 * 1024
const MAX_TICKET = 1_000_000_000

interface MutationOwner {
  pid: number
  creationIdentity: string
}

interface MutationCandidate extends MutationOwner {
  schemaVersion: 1
  token: string
  phase: 'choosing' | 'waiting'
  ticket: number
}

export interface MediumMutationLockLease {
  readonly token: string
  release(): Promise<void>
}

export interface AcquireMediumMutationLockOptions {
  root: string
  owner: MutationOwner
  processIdentityMatches(pid: number, expectedIdentity: string): Promise<ProcessCreationIdentityMatch>
  token?: string
  pollIntervalMs?: number
  waitTimeoutMs?: number
  invalidRecordGraceMs?: number
}

export class MediumMutationLockBusyError extends Error {
  constructor() {
    super('Medium mutation lock is busy')
    this.name = 'MediumMutationLockBusyError'
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function parseCandidate(value: unknown, expectedToken: string): MutationCandidate | undefined {
  if (!exactRecord(value, ['schemaVersion', 'token', 'pid', 'creationIdentity', 'phase', 'ticket'])
    || value.schemaVersion !== 1 || value.token !== expectedToken
    || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.creationIdentity !== 'string' || value.creationIdentity.length < 1
    || value.creationIdentity.length > 128
    || (value.phase !== 'choosing' && value.phase !== 'waiting')
    || typeof value.ticket !== 'number' || !Number.isSafeInteger(value.ticket)
    || value.ticket < 0 || value.ticket > MAX_TICKET
    || (value.phase === 'choosing' ? value.ticket !== 0 : value.ticket < 1)) return undefined
  return value as unknown as MutationCandidate
}

function candidateName(name: string): { token: string; phase: MutationCandidate['phase'] } | undefined {
  const match = /^([0-9a-f-]+)\.(choosing|waiting)\.json$/u.exec(name)
  if (!match || !UUID_PATTERN.test(match[1]!)) return undefined
  return { token: match[1]!, phase: match[2] as MutationCandidate['phase'] }
}

async function publishCandidate(filePath: string, candidate: MutationCandidate): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFileAtomic(filePath, `${JSON.stringify(candidate)}\n`, { encoding: 'utf8', fsync: true })
      return
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EACCES')) throw error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

async function liveCandidates(options: {
  root: string
  owner: MutationOwner
  invalidRecordGraceMs: number
  processIdentityMatches(pid: number, expectedIdentity: string): Promise<ProcessCreationIdentityMatch>
}): Promise<MutationCandidate[]> {
  const byToken = new Map<string, MutationCandidate>()
  const now = Date.now()
  const entries = await readdir(options.root, { withFileTypes: true })
  for (const entry of entries) {
    const identity = candidateName(entry.name)
    if (!identity || !entry.isFile()) continue
    const filePath = path.join(options.root, entry.name)
    let candidate: MutationCandidate | undefined
    let modifiedMs = 0
    try {
      const info = await lstat(filePath)
      modifiedMs = info.mtimeMs
      if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_RECORD_BYTES) {
        candidate = parseCandidate(JSON.parse(await readFile(filePath, 'utf8')) as unknown, identity.token)
        if (candidate?.phase !== identity.phase) candidate = undefined
      }
    } catch { /* an invalid or concurrently removed candidate is handled below */ }
    if (!candidate) {
      if (now - modifiedMs >= options.invalidRecordGraceMs) await rm(filePath, { force: true }).catch(() => undefined)
      continue
    }
    if (candidate.pid === options.owner.pid && candidate.creationIdentity === options.owner.creationIdentity) {
      const existing = byToken.get(candidate.token)
      if (!existing || candidate.phase === 'waiting') byToken.set(candidate.token, candidate)
      continue
    }
    let identityStatus: ProcessCreationIdentityMatch
    try {
      identityStatus = await options.processIdentityMatches(candidate.pid, candidate.creationIdentity)
    } catch {
      const existing = byToken.get(candidate.token)
      if (!existing || candidate.phase === 'waiting') byToken.set(candidate.token, candidate)
      continue
    }
    if (identityStatus === 'dead-or-mismatch') {
      await rm(filePath, { force: true }).catch(() => undefined)
      continue
    }
    const existing = byToken.get(candidate.token)
    if (!existing || candidate.phase === 'waiting') byToken.set(candidate.token, candidate)
  }
  return [...byToken.values()]
}

function precedes(first: MutationCandidate, second: MutationCandidate): boolean {
  return first.ticket < second.ticket || (first.ticket === second.ticket && first.token < second.token)
}

export function mediumMutationWriterPresentSync(root: string): boolean {
  try {
    return readdirSync(root, { withFileTypes: true }).some((entry) => entry.isFile() && candidateName(entry.name) !== undefined)
  } catch { return false }
}

export async function acquireMediumMutationLock(
  options: AcquireMediumMutationLockOptions,
): Promise<MediumMutationLockLease> {
  const token = options.token ?? randomUUID()
  if (!UUID_PATTERN.test(token) || !Number.isSafeInteger(options.owner.pid) || options.owner.pid <= 0
    || !options.owner.creationIdentity || options.owner.creationIdentity.length > 128) {
    throw new Error('Invalid Medium mutation lock owner')
  }
  const pollIntervalMs = options.pollIntervalMs ?? 25
  const waitTimeoutMs = options.waitTimeoutMs ?? 1_000
  const invalidRecordGraceMs = options.invalidRecordGraceMs ?? 250
  const choosingPath = path.join(options.root, `${token}.choosing.json`)
  const waitingPath = path.join(options.root, `${token}.waiting.json`)
  await mkdir(options.root, { recursive: true })
  let published = false
  try {
    await publishCandidate(choosingPath, {
      schemaVersion: 1,
      token,
      pid: options.owner.pid,
      creationIdentity: options.owner.creationIdentity,
      phase: 'choosing',
      ticket: 0,
    })
    published = true
    const initial = await liveCandidates({ ...options, invalidRecordGraceMs })
    const maximumTicket = initial.reduce((maximum, candidate) => Math.max(maximum, candidate.ticket), 0)
    if (maximumTicket >= MAX_TICKET) throw new MediumMutationLockBusyError()
    const own: MutationCandidate = {
      schemaVersion: 1,
      token,
      pid: options.owner.pid,
      creationIdentity: options.owner.creationIdentity,
      phase: 'waiting',
      ticket: maximumTicket + 1,
    }
    await publishCandidate(waitingPath, own)
    await rm(choosingPath, { force: true }).catch(() => undefined)
    const deadline = Date.now() + waitTimeoutMs
    while (true) {
      const candidates = await liveCandidates({ ...options, invalidRecordGraceMs })
      const blocked = candidates.some((candidate) => candidate.token !== token
        && (candidate.phase === 'choosing' || precedes(candidate, own)))
      if (!blocked) break
      if (Date.now() >= deadline) throw new MediumMutationLockBusyError()
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
    let releasePromise: Promise<void> | undefined
    return {
      token,
      release() {
        releasePromise ??= (async () => {
          try {
            const info = await lstat(waitingPath)
            if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) return
            const record = parseCandidate(JSON.parse(await readFile(waitingPath, 'utf8')) as unknown, token)
            if (record?.token === token && record.pid === options.owner.pid
              && record.creationIdentity === options.owner.creationIdentity) await rm(waitingPath, { force: true })
          } catch { /* an already removed candidate is released */ }
          await rm(choosingPath, { force: true }).catch(() => undefined)
        })()
        return releasePromise
      },
    }
  } catch (error) {
    if (published) {
      await rm(choosingPath, { force: true }).catch(() => undefined)
      await rm(waitingPath, { force: true }).catch(() => undefined)
    }
    throw error
  }
}
