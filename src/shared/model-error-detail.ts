/** Finite semantic metadata only. Never attach provider prose, arguments, credentials or file identities. */
export const MODEL_ERROR_REASONS = [
  'authentication', 'access-denied', 'model-not-found', 'not-found', 'invalid-endpoint',
  'rate-limited', 'quota-exceeded', 'service-unavailable', 'request-rejected',
  'context-limit', 'output-limit', 'content-filtered', 'tools-unsupported',
  'network', 'dns', 'connection-refused', 'tls', 'timeout', 'stream-interrupted',
  'protocol-malformed', 'response-size-limit', 'provider-interrupted', 'tool-stream-incomplete',
  'tool-invalid-arguments', 'tool-invalid-name', 'tool-invalid-identity',
  'cli-authentication', 'cli-unavailable', 'cli-sandbox', 'cli-budget-exceeded', 'unknown',
] as const
export type ModelErrorReason = typeof MODEL_ERROR_REASONS[number]
export const MODEL_ERROR_STAGES = ['configuration', 'connect', 'receive', 'decode', 'provider', 'tool-validation', 'cli'] as const
export const MODEL_ERROR_SOURCES = ['local', 'http', 'sse', 'responses', 'codex'] as const
export interface ModelErrorDetail {
  readonly version: 1
  readonly reason: ModelErrorReason
  readonly stage: typeof MODEL_ERROR_STAGES[number]
  readonly source: typeof MODEL_ERROR_SOURCES[number]
  readonly httpStatus?: number
  /** A provider-supplied, bounded delta; informational, never permission to retry a write. */
  readonly retryAfterSeconds?: number
}

export function parseModelErrorDetail(value: unknown): ModelErrorDetail | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (![null, Object.prototype].includes(Object.getPrototypeOf(value))) return null
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(value)
    const allowed = ['version', 'reason', 'stage', 'source', 'httpStatus', 'retryAfterSeconds']
    if (keys.some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]!))) return null
    const field = (key: string): unknown => descriptors[key]?.value
    if (field('version') !== 1 || !MODEL_ERROR_REASONS.includes(field('reason') as ModelErrorReason)
      || !MODEL_ERROR_STAGES.includes(field('stage') as ModelErrorDetail['stage'])
      || !MODEL_ERROR_SOURCES.includes(field('source') as ModelErrorDetail['source'])) return null
    const httpStatus = field('httpStatus')
    const retryAfterSeconds = field('retryAfterSeconds')
    if (keys.includes('httpStatus') && !(typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599)) return null
    if (keys.includes('retryAfterSeconds') && !(typeof retryAfterSeconds === 'number' && Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 0 && retryAfterSeconds <= 86_400)) return null
    return Object.freeze({ version: 1, reason: field('reason') as ModelErrorReason,
      stage: field('stage') as ModelErrorDetail['stage'], source: field('source') as ModelErrorDetail['source'],
      ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
      ...(typeof retryAfterSeconds === 'number' ? { retryAfterSeconds } : {}),
    })
  } catch { return null }
}
