import { randomUUID } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import { serializeCloseDiagnosticEvent } from '../../shared/close-diagnostics'

export const CLOSE_DIAGNOSTIC_SEGMENT_MAX_BYTES = 256 * 1024
export const CLOSE_DIAGNOSTIC_QUEUE_MAX_BYTES = 64 * 1024
export const CLOSE_DIAGNOSTIC_QUEUE_MAX_EVENTS = 128
const SEGMENTS = 3

/** A handle exclusively created by this log instance; rotation never reopens a pathname. */
export interface CloseDiagnosticFile {
  write(bytes: Uint8Array, position: number): Promise<number>
  truncate(): Promise<void>
  close(): Promise<void>
}
export interface CloseDiagnosticLogOptions {
  directory: string
  /** A fresh main-issued UUID for this process instance; production normally uses randomUUID. */
  instanceId?: string
  /** Fault-injection seam; must preserve exclusive creation and owned-handle semantics. */
  openFile?(file: string): Promise<CloseDiagnosticFile>
}
export interface CloseDiagnosticLog {
  /** Best effort only. Never await diagnostics as a prerequisite for saving or closing. */
  record(event: unknown): void
  /** Observer for tests/diagnostic cleanup only; pending OS I/O may never settle. Never a close gate. */
  settled(): Promise<void>
  /** Synchronous admission stop; handles close after any already-started I/O settles. */
  dispose(): void
}
interface Segment { file: CloseDiagnosticFile; bytes: number }

async function openExclusive(file: string): Promise<CloseDiagnosticFile> {
  const handle = await open(file, 'wx', 0o600)
  return {
    write: async (bytes, position) => (await handle.write(bytes, 0, bytes.byteLength, position)).bytesWritten,
    truncate: () => handle.truncate(0), close: () => handle.close(),
  }
}

/** Independent diagnostic I/O only. No access to document writes, close authority, or error payloads. */
export function createCloseDiagnosticLog(options: CloseDiagnosticLogOptions): CloseDiagnosticLog {
  const queue: Buffer[] = []
  const segments: Array<Segment | undefined> = []
  let retainedBytes = 0
  let retainedEvents = 0
  let current = 0
  let prepared = false
  let stopped = false
  let running: Promise<void> | undefined
  let directory = ''
  let instanceId = ''
  try {
    directory = path.resolve(options.directory)
    instanceId = options.instanceId ?? randomUUID()
    if (typeof instanceId !== 'string' || instanceId.length !== 36
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(instanceId)) stopped = true
  } catch { stopped = true }

  const dropQueued = () => {
    for (const bytes of queue.splice(0)) { retainedBytes -= bytes.byteLength; retainedEvents-- }
  }
  const closeHandles = async () => {
    const owned = segments.splice(0)
    await Promise.all(owned.map(async segment => {
      try { await segment?.file.close() } catch { /* A diagnostic handle never controls close success. */ }
    }))
  }
  const write = async (bytes: Buffer) => {
    if (!prepared) { await mkdir(directory, { recursive: true }); prepared = true }
    if (stopped) return
    let segment = segments[current]
    if (segment && segment.bytes + bytes.byteLength > CLOSE_DIAGNOSTIC_SEGMENT_MAX_BYTES) {
      current = (current + 1) % SEGMENTS
      segment = segments[current]
      if (segment) { await segment.file.truncate(); segment.bytes = 0 }
    }
    if (!segment) {
      const file = path.join(directory, `arkdown-close-${instanceId}.${current}.jsonl`)
      segment = { file: await (options.openFile ?? openExclusive)(file), bytes: 0 }
      segments[current] = segment
    }
    if (stopped) return
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = await segment.file.write(bytes.subarray(offset), segment.bytes + offset)
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) throw new Error('Diagnostic write failed')
      offset += written
    }
    segment.bytes += bytes.byteLength
  }
  const drain = async () => {
    try {
      while (!stopped && queue.length > 0) {
        const bytes = queue.shift()!
        try { await write(bytes) }
        finally { retainedBytes -= bytes.byteLength; retainedEvents-- }
      }
    } catch {
      // Unknown partial writes/rotation results must not be replayed or spliced into later records.
      stopped = true
    } finally { if (stopped) dropQueued() }
  }
  const start = (): void => {
    if (running) return
    running = drain().finally(async () => {
      // Admission/disposal may occur between drain's final await and this handoff.
      if (stopped) await closeHandles()
      running = undefined
      if (!stopped && queue.length > 0) start()
    })
  }
  return Object.freeze({
    record(event: unknown): void {
      if (stopped || retainedEvents >= CLOSE_DIAGNOSTIC_QUEUE_MAX_EVENTS) return
      try {
        const text = serializeCloseDiagnosticEvent(event)
        if (text === undefined) return
        const bytes = Buffer.from(`${text}\n`, 'utf8')
        if (bytes.byteLength > CLOSE_DIAGNOSTIC_SEGMENT_MAX_BYTES
          || retainedBytes + bytes.byteLength > CLOSE_DIAGNOSTIC_QUEUE_MAX_BYTES) return
        queue.push(bytes); retainedBytes += bytes.byteLength; retainedEvents++
        start()
      } catch { /* Invalid diagnostic input cannot affect the caller's operation. */ }
    },
    settled: async () => { while (running) await running },
    dispose(): void {
      stopped = true
      dropQueued()
      if (!running) start()
    },
  })
}
