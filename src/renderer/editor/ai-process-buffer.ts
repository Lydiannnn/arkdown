import type { AiProcessEvent, AiProcessKind, AiProcessStage, AiProcessToolEvent } from '../../shared/ai-process-events'

export const AI_PROCESS_REQUEST_BYTES = 256 * 1024
export const AI_PROCESS_SESSION_BYTES = 2 * 1024 * 1024
const HEAD_BYTES = 32 * 1024
const TAIL_BYTES = AI_PROCESS_REQUEST_BYTES - HEAD_BYTES
// Text-byte budgets alone do not bound metadata for many tiny alternating items.
const MAX_TEXT_ENTRIES = 2048
const MAX_TOOL_ENTRIES = 256
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface AiProcessTextRecord {
  type: 'text'
  id: string
  round: number
  itemId: string
  segmentIndex: number
  channel: AiProcessKind
  delivery: 'stream' | 'complete'
  text: string
  bytes: number
  omittedBefore: boolean
}
export interface AiProcessToolRecord extends Omit<AiProcessToolEvent, 'type' | 'sequence'> { type: 'tool'; id: string }
export type AiProcessEntry = AiProcessTextRecord | AiProcessToolRecord
export interface AiProcessRecord {
  requestId: string
  messageId: string | null
  round: number
  sequence: number
  stage: AiProcessStage
  outcome: 'active' | 'completed' | 'failed' | 'stopped' | 'paused'
  startedAt: number
  endedAt: number | null
  lastSemanticProgressAt: number
  userExpanded: boolean | null
  entries: AiProcessEntry[]
  textBytes: number
  omitted: boolean
  revision: number
}

export function createAiProcessRecord(requestId: string, now: number): AiProcessRecord {
  return { requestId, messageId: null, round: 0, sequence: 0, stage: 'waiting-model', outcome: 'active',
    startedAt: now, endedAt: null, lastSemanticProgressAt: now, userExpanded: null,
    entries: [], textBytes: 0, omitted: false, revision: 0 }
}

/** Called only for a newly accepted main message-start, never for a process packet. */
export function beginAiProcessRound(record: AiProcessRecord, messageId: string, now: number): void {
  if (record.outcome !== 'active' || record.messageId === messageId) return
  record.round += 1
  record.messageId = messageId
  record.stage = 'waiting-model'
  record.lastSemanticProgressAt = now
  record.revision += 1
}

function utf8Slice(text: string, from: number, to: number): string {
  const bytes = encoder.encode(text)
  let start = Math.max(0, from), end = Math.min(bytes.length, to)
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--
  return start < end ? decoder.decode(bytes.subarray(start, end)) : ''
}

function trimText(record: AiProcessRecord): void {
  if (record.textBytes > AI_PROCESS_REQUEST_BYTES) {
    const tailStart = record.textBytes - TAIL_BYTES
    let offset = 0
    const kept: AiProcessEntry[] = []
    for (const entry of record.entries) {
      if (entry.type === 'tool') { kept.push(entry); continue }
      const start = offset, end = offset + entry.bytes
      offset = end
      const head = start < HEAD_BYTES ? utf8Slice(entry.text, 0, HEAD_BYTES - start) : ''
      const tail = end > tailStart ? utf8Slice(entry.text, Math.max(0, tailStart - start), entry.bytes) : ''
      if (head) kept.push({ ...entry, text: head, bytes: encoder.encode(head).length })
      if (tail) kept.push({ ...entry, id: head ? `${entry.id}-tail` : entry.id, text: tail,
        bytes: encoder.encode(tail).length, omittedBefore: entry.omittedBefore || start <= tailStart })
    }
    record.entries = kept
    record.omitted = true
  }
  const textEntries = record.entries.filter(entry => entry.type === 'text')
  if (textEntries.length > MAX_TEXT_ENTRIES) {
    // A separate structural safety cap, explicitly marked as omitted. Normal
    // byte-budget truncation above retains the configured first/tail text.
    const keep = new Set([...textEntries.slice(0, 256), ...textEntries.slice(-(MAX_TEXT_ENTRIES - 256))])
    record.entries = record.entries.filter(entry => entry.type === 'tool' || keep.has(entry))
    const firstTail = textEntries.at(-(MAX_TEXT_ENTRIES - 256))
    if (firstTail) firstTail.omittedBefore = true
    record.omitted = true
  }
  record.textBytes = record.entries.reduce((sum, entry) => sum + (entry.type === 'text' ? entry.bytes : 0), 0)
}

function sameTool(left: AiProcessToolRecord, right: AiProcessToolEvent): boolean {
  return left.toolName === right.toolName && left.operationId === right.operationId
    && left.displayName === right.displayName && left.cached === right.cached
    && left.paths.length === right.paths.length && left.paths.every((value, index) => value === right.paths[index])
}

/** Input has passed the strict wire codec. Request, round, message and sequence
 * still must match the already accepted conversation lifecycle. */
export function applyAiProcessEvent(record: AiProcessRecord, event: AiProcessEvent, now: number): boolean {
  if (record.outcome !== 'active' || record.requestId !== event.requestId || record.messageId !== event.messageId
    || record.round !== event.round || event.sequence <= record.sequence) return false
  let progressed = false
  if (event.type === 'process-text') {
    if (!event.delta) return false
    const bytes = encoder.encode(event.delta).length
    const previous = record.entries.at(-1)
    if (previous?.type === 'text' && previous.round === event.round && previous.itemId === event.itemId
      && previous.channel === event.kind && previous.segmentIndex === event.segmentIndex && previous.delivery === event.delivery) {
      previous.text += event.delta
      previous.bytes += bytes
    } else record.entries.push({ type: 'text', id: `text-${event.round}-${event.sequence}`, round: event.round,
      itemId: event.itemId, channel: event.kind, segmentIndex: event.segmentIndex, delivery: event.delivery,
      text: event.delta, bytes, omittedBefore: false })
    record.textBytes += bytes
    trimText(record)
    progressed = true
  } else if (event.type === 'process-stage') {
    progressed = record.stage !== event.stage
    record.stage = event.stage
  } else {
    const previous = record.entries.find((entry): entry is AiProcessToolRecord => entry.type === 'tool'
      && entry.round === event.round && entry.toolCallId === event.toolCallId)
    if (previous) {
      if (!sameTool(previous, event) || !['running', 'awaiting-approval'].includes(previous.status)
        || previous.status === 'running' && event.status === 'awaiting-approval') return false
      progressed = previous.status !== event.status
      previous.status = event.status
      if (event.reason) previous.reason = event.reason
    } else {
      if (record.entries.filter(entry => entry.type === 'tool').length >= MAX_TOOL_ENTRIES) {
        record.omitted = true
      } else record.entries.push({ ...event, type: 'tool', id: `tool-${event.round}-${event.toolCallId}`, paths: [...event.paths] })
      progressed = true
    }
  }
  record.sequence = event.sequence
  if (progressed) record.lastSemanticProgressAt = now
  record.revision += 1
  return true
}

export function finishAiProcess(record: AiProcessRecord, outcome: Exclude<AiProcessRecord['outcome'], 'active'>, now: number): void {
  if (record.outcome !== 'active') return
  record.outcome = outcome
  record.endedAt = now
  record.revision += 1
}

/** Oldest-first input. Only completed visible process text is evicted: answers,
 * authorization and write-audit records are not part of this buffer. */
export function enforceAiProcessSessionBudget(records: readonly AiProcessRecord[]): void {
  let total = records.reduce((sum, record) => sum + record.textBytes, 0)
  for (const record of records) {
    if (total <= AI_PROCESS_SESSION_BYTES) break
    if (record.outcome === 'active' || record.textBytes === 0) continue
    total -= record.textBytes
    record.textBytes = 0
    record.entries = record.entries.filter(entry => entry.type === 'tool')
    record.omitted = true
    record.revision += 1
  }
}
