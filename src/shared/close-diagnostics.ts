/** Close diagnostics are data only: none of these fields grants close or retry authority. */
export const CLOSE_DIAGNOSTIC_EVENT_MAX_BYTES = 2 * 1024
export const CLOSE_DIAGNOSTIC_SUMMARY_MAX_BYTES = 4 * 1024

const STAGES = ['prepare-editor', 'await-user', 'await-preferences', 'settle-document', 'settle-preferences',
  'quiesce-owner', 'drain-ipc', 'persist-window', 'finalize', 'native-close', 'restore-editor'] as const
const OPERATIONS = ['editor', 'document', 'draft', 'preferences', 'owner', 'ai', 'ipc', 'window-settings', 'cleanup', 'restore'] as const
const ERROR_CODES = ['editor-unavailable', 'document-save-failed', 'draft-end-failed',
  'document-result-unknown', 'preferences-save-failed', 'ai-drain-failed', 'owner-close-failed', 'ipc-drain-failed',
  'window-settings-failed', 'cleanup-failed', 'native-close-failed', 'restore-failed', 'renderer-process-gone'] as const

export interface CloseDiagnosticEvent {
  version: string
  platform: 'win32' | 'darwin' | 'linux'
  /** Main-issued UUIDs, never titles, native paths or renderer-supplied display names. */
  windowId: string
  attemptId: string
  stage: typeof STAGES[number]
  event: 'enter' | 'exit' | 'error' | 'timeout'
  stageElapsedMs: number
  /** Omit when the owning document's state is unknown. */
  dirty?: boolean
  pending: Readonly<Partial<Record<typeof OPERATIONS[number], number>>>
  errorCode: typeof ERROR_CODES[number] | null
}

const REQUIRED_KEYS = ['version', 'platform', 'windowId', 'attemptId', 'stage', 'event', 'stageElapsedMs', 'pending', 'errorCode']
const EVENT_KEYS = [...REQUIRED_KEYS, 'dirty']
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)

/** Reads descriptor values, not properties: accessors and toJSON never execute. */
function ownData(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return undefined
  const keys = Reflect.ownKeys(value)
  if (keys.length > allowed.length || !required.every(key => keys.includes(key))) return undefined
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined
    result[key] = descriptor.value
  }
  return result
}

export function parseCloseDiagnosticEvent(input: unknown): Readonly<CloseDiagnosticEvent> | undefined {
  try {
    const value = ownData(input, EVENT_KEYS, REQUIRED_KEYS)
    if (!value || typeof value.version !== 'string' || value.version.length > 64
      || /[^0-9A-Za-z.+-]/.test(value.version)
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(value.version)
      || !['win32', 'darwin', 'linux'].includes(value.platform as string)
      || !uuid(value.windowId) || !uuid(value.attemptId)
      || !STAGES.includes(value.stage as CloseDiagnosticEvent['stage'])
      || !['enter', 'exit', 'error', 'timeout'].includes(value.event as string)
      || typeof value.stageElapsedMs !== 'number' || !Number.isFinite(value.stageElapsedMs)
      || value.stageElapsedMs < 0 || value.stageElapsedMs > Number.MAX_SAFE_INTEGER
      || (Object.hasOwn(value, 'dirty') && typeof value.dirty !== 'boolean')
      || !(value.errorCode === null || ERROR_CODES.includes(value.errorCode as typeof ERROR_CODES[number]))) return undefined
    const pending = ownData(value.pending, OPERATIONS)
    if (!pending) return undefined
    for (const count of Object.values(pending)) {
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined
    }
    return Object.freeze({ version: value.version, platform: value.platform as CloseDiagnosticEvent['platform'],
      windowId: value.windowId, attemptId: value.attemptId, stage: value.stage as CloseDiagnosticEvent['stage'],
      event: value.event as CloseDiagnosticEvent['event'], stageElapsedMs: value.stageElapsedMs,
      ...(Object.hasOwn(value, 'dirty') ? { dirty: value.dirty as boolean } : {}),
      pending: Object.freeze({ ...pending }) as CloseDiagnosticEvent['pending'],
      errorCode: value.errorCode as CloseDiagnosticEvent['errorCode'] })
  } catch { return undefined }
}

export function serializeCloseDiagnosticEvent(input: unknown): string | undefined {
  const event = parseCloseDiagnosticEvent(input)
  if (!event) return undefined
  const text = JSON.stringify(event)
  return new TextEncoder().encode(text).byteLength <= CLOSE_DIAGNOSTIC_EVENT_MAX_BYTES ? text : undefined
}

/** Caller supplies only the main-owned current attempt's facts. No clipboard or upload side effects. */
export function formatCloseDiagnosticSummary(input: unknown): string | undefined {
  const event = parseCloseDiagnosticEvent(input)
  if (!event) return undefined
  const text = `Arkdown close diagnostic\n${JSON.stringify(event, null, 2)}`
  return new TextEncoder().encode(text).byteLength <= CLOSE_DIAGNOSTIC_SUMMARY_MAX_BYTES ? text : undefined
}
