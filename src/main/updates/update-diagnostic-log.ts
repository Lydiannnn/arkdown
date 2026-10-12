import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { sanitizeUpdateDiagnostic } from './update-diagnostic'

const MAX_RECORDS = 8
const MAX_RECORD_BYTES = 36 * 1024
export interface UpdateDiagnosticContext {
  version: string
  edition: 'Full' | 'Lite' | null
  kind: 'installer' | 'portable' | null
  helperSha256: string
  helperStarted: boolean
  helperPid: number | null
}
export interface UpdateDiagnosticFile { write(bytes: Uint8Array, position: number): Promise<number>; close(): Promise<void> }
export interface UpdateDiagnosticLogOptions {
  /** Trusted main-process profile path, never a helper/renderer/environment log path. */
  directory: string
  instanceId?: string
  /** Fault injection only; implementations must preserve exclusive owned-handle semantics. */
  openFile?(file: string): Promise<UpdateDiagnosticFile>
}
export interface UpdateDiagnosticLog {
  /** Failure-only, best effort. Never awaited by update, revoke, close or exit. */
  record(diagnostic: unknown, context: UpdateDiagnosticContext): void
  /** Test observer only. OS I/O may remain pending indefinitely; this is never an exit gate. */
  settled(): Promise<void>
}
async function openExclusive(file: string): Promise<UpdateDiagnosticFile> {
  const handle = await open(file, 'wx', 0o600)
  return { write: async (bytes, position) => (await handle.write(bytes, 0, bytes.byteLength, position)).bytesWritten, close: () => handle.close() }
}

/** One instance per main process. A bounded set of fresh files preserves the first failure without scanning or deletion. */
export function createUpdateDiagnosticLog(options: UpdateDiagnosticLogOptions): UpdateDiagnosticLog {
  let directory = '', instanceId = '', admitted = 0, disabled = false
  const pending = new Set<Promise<void>>()
  try {
    directory = path.resolve(options.directory); instanceId = options.instanceId ?? randomUUID()
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(instanceId)) disabled = true
  } catch { disabled = true }
  const write = async (file: string, bytes: Buffer): Promise<void> => {
    let owned: UpdateDiagnosticFile | undefined
    try {
      await mkdir(directory, { recursive: true })
      owned = await (options.openFile ?? openExclusive)(file)
      let position = 0
      while (position < bytes.byteLength) {
        const count = await owned.write(bytes.subarray(position), position)
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - position) return
        position += count
      }
    } catch { /* Diagnostic storage failure never changes update behavior. No retry or fallback path. */ }
    finally { try { await owned?.close() } catch { /* Owned diagnostic handles have no lifecycle authority. */ } }
  }
  return Object.freeze({
    record(value: unknown, context: UpdateDiagnosticContext): void {
      if (disabled || admitted >= MAX_RECORDS) return
      try {
        const { version, edition, kind, helperSha256, helperStarted, helperPid } = context
        if (typeof version !== 'string' || version.length > 100 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
          || ![null, 'Full', 'Lite'].includes(edition) || ![null, 'installer', 'portable'].includes(kind)
          || typeof helperSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(helperSha256) || typeof helperStarted !== 'boolean'
          || !(helperPid === null || Number.isSafeInteger(helperPid) && helperPid > 0 && helperPid <= 0xffffffff)
          || !helperStarted && helperPid !== null) return
        const diagnostic = sanitizeUpdateDiagnostic(value, helperStarted ? 'helper' : 'parent')
        if (!diagnostic) return
        const bytes = Buffer.from(JSON.stringify({ timestamp: new Date().toISOString(), parentPid: process.pid,
          helperPid, helperStarted, helperSha256, version, edition, kind, diagnostic }) + '\n', 'utf8')
        if (bytes.byteLength > MAX_RECORD_BYTES) return
        const file = path.join(directory, `arkdown-update-${instanceId}-${admitted++}.json`)
        const operation = write(file, bytes).finally(() => { pending.delete(operation) })
        pending.add(operation)
      } catch { /* Snapshot/getter/serialization failures cannot replace the original error. */ }
    },
    async settled(): Promise<void> { while (pending.size) await Promise.all(pending) },
  })
}
