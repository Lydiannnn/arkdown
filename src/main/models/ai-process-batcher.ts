import { AI_PROCESS_TEXT_MAX_BYTES } from '../../shared/ai-process-events'
import type { ModelProcessDelta } from './model-process-delta'

const FLUSH_INTERVAL_MS = 50
const PENDING_BYTES_LIMIT = 256 * 1024
const PENDING_ENTRY_LIMIT = 256
interface PendingDelta { value: ModelProcessDelta; bytes: number }

function* chunks(text: string): Generator<{ delta: string; bytes: number }> {
  let delta = ''
  let bytes = 0
  for (const character of text) {
    // Only the display copy normalizes malformed surrogate halves. Provider
    // replay is never passed back from this buffer or modified by it.
    const code = character.codePointAt(0)!
    const safe = code >= 0xd800 && code <= 0xdfff ? '\ufffd' : character
    const size = Buffer.byteLength(safe, 'utf8')
    if (bytes + size > AI_PROCESS_TEXT_MAX_BYTES) {
      yield { delta, bytes }
      delta = ''; bytes = 0
    }
    delta += safe
    bytes += size
  }
  if (delta) yield { delta, bytes }
}

/** One model round's optional display-only channel. No final answer or provider
 * replay belongs here. The owner flushes before a phase/terminal event, closes
 * at normal round end and disposes on ownership invalidation. The producer is
 * serial: append returns false for consumer-reentrant input without accepting
 * or buffering it. The display consumer must not act as a provider producer.
 * A consumer-reentrant close drains already accepted entries. Not yet wired. */
export class AiProcessBatcher {
  private pending: PendingDelta[] = []
  private pendingBytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closed = false
  private closing = false
  private flushing = false

  constructor(private readonly options: {
    isCurrent(): boolean
    emit(delta: ModelProcessDelta): void
  }) {}

  append(event: ModelProcessDelta): boolean {
    if (this.flushing || this.closing || !this.owned() || !event.delta) return false
    for (const part of chunks(event.delta)) {
      if (!this.owned()) return false
      const previous = this.pending.at(-1)
      if (previous && previous.bytes + part.bytes <= AI_PROCESS_TEXT_MAX_BYTES
        && previous.value.kind === event.kind && previous.value.itemId === event.itemId
        && previous.value.segmentIndex === event.segmentIndex && previous.value.delivery === event.delivery) {
        previous.value.delta += part.delta
        previous.bytes += part.bytes
      } else this.pending.push({ value: { ...event, delta: part.delta }, bytes: part.bytes })
      this.pendingBytes += part.bytes
      if (this.pendingBytes >= PENDING_BYTES_LIMIT || this.pending.length >= PENDING_ENTRY_LIMIT) this.flush()
    }
    if (this.pending.length && this.timer === undefined && this.owned()) {
      this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, FLUSH_INTERVAL_MS)
      this.timer.unref?.()
    }
    return !this.closed
  }

  flush(): void {
    if (this.flushing || !this.owned()) return
    this.cancelTimer()
    const entries = this.pending
    this.pending = []
    this.pendingBytes = 0
    this.flushing = true
    try {
      for (const entry of entries) {
        if (!this.owned()) break
        try { this.options.emit(Object.freeze({ ...entry.value })) }
        catch { this.dispose(); break }
      }
    } finally {
      this.flushing = false
      if (this.closing) this.dispose()
    }
  }

  close(): void {
    if (this.closed || this.closing) return
    this.closing = true
    if (this.flushing) return
    this.flush()
    this.dispose()
  }

  dispose(): void {
    this.closed = true
    this.pending = []
    this.pendingBytes = 0
    this.cancelTimer()
  }

  private owned(): boolean {
    if (this.closed) return false
    try { if (this.options.isCurrent()) return true } catch { /* A display gate cannot break model work. */ }
    this.dispose()
    return false
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
