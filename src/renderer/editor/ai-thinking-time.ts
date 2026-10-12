export interface AiThinkingTime {
  kind: 'thinking'
  messageId: string
  elapsedMs: number
  active: boolean
  observedAt: number
}

export function observedThinkingElapsed(record: AiThinkingTime, now = performance.now()): number {
  return record.elapsedMs + (record.active ? Math.max(0, now - record.observedAt) : 0)
}

export function freezeThinkingTime(record: AiThinkingTime, now = performance.now()): AiThinkingTime {
  return record.active
    ? { ...record, active: false, elapsedMs: Math.floor(observedThinkingElapsed(record, now)), observedAt: now }
    : record
}
