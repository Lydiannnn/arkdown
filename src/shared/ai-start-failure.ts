import { parseModelErrorDetail, type ModelErrorDetail } from './model-error-detail'
import { isPublicErrorCode, PUBLIC_ERROR_MESSAGES, type PublicErrorCode } from './public-errors'

/** AI admission alone carries semantic model details; other API error contracts stay unchanged. */
export type AiConversationStartResult =
  | { ok: true; value: { requestId: string; modelId: string; transcriptRevision: number } }
  | { ok: false; error: { code: string; message: string; detail?: ModelErrorDetail } }

function dataRecord(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(value)
  return required.every(key => Object.hasOwn(descriptors, key))
    && keys.every(key => typeof key === 'string' && (required.includes(key) || optional.includes(key))
      && descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, 'value'))
}

/** Accept only finite evidence. Never trust the incoming human-readable message. */
export function parseAiStartFailure(value: unknown): {
  ok: false; error: { code: PublicErrorCode; message: string; detail?: ModelErrorDetail }
} | null {
  try {
    if (!dataRecord(value, ['ok', 'error']) || value.ok !== false
      || !dataRecord(value.error, ['code', 'message'], ['detail'])
      || !isPublicErrorCode(value.error.code) || typeof value.error.message !== 'string') return null
    const detail = Object.hasOwn(value.error, 'detail') ? parseModelErrorDetail(value.error.detail) : undefined
    if (detail === null) return null
    return { ok: false, error: Object.freeze({ code: value.error.code, message: PUBLIC_ERROR_MESSAGES[value.error.code],
      ...(detail ? { detail } : {}),
    }) }
  } catch { return null }
}
