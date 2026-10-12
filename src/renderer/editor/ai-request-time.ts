export interface AiRequestTime {
  kind: 'elapsed'
  requestId: string
  messageIds: readonly string[]
  elapsedMs: number
  active: boolean
  observedAt: number
}

export function requestElapsed(record: AiRequestTime, now = performance.now()): number {
  return record.elapsedMs + (record.active ? Math.max(0, now - record.observedAt) : 0)
}

export function freezeRequestTime(record: AiRequestTime, now = performance.now()): AiRequestTime {
  return record.active
    ? { ...record, active: false, elapsedMs: Math.floor(requestElapsed(record, now)), observedAt: now }
    : record
}
