import type { ModelErrorDetail, ModelErrorReason } from '../../shared/model-error-detail'
import { modelProtocolError, type ModelProtocolFailureStatus } from './model-errors'

/** Read data properties only; untrusted error getters and raw messages are never consulted. */
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try { return Object.getOwnPropertyDescriptor(value, key)?.value } catch { return undefined }
}

export function semanticModelError(
  status: ModelProtocolFailureStatus, reason: ModelErrorReason,
  stage: ModelErrorDetail['stage'], source: ModelErrorDetail['source'],
  metadata: Pick<ModelErrorDetail, 'httpStatus' | 'retryAfterSeconds'> = {},
) {
  return modelProtocolError(status, reason === 'tools-unsupported' ? 'tools' : undefined,
    { version: 1, reason, stage, source, ...metadata })
}

export function providerModelError(error: unknown, evidence: {
  source: 'http' | 'sse' | 'responses' | 'codex'; httpStatus?: number; retryAfterSeconds?: number
}) {
  const status = evidence.httpStatus
  const tokens = [field(error, 'code'), field(error, 'type')]
  const param = field(error, 'param')
  const has = (...values: string[]) => tokens.some(token => typeof token === 'string' && values.includes(token))
  const metadata = { ...(status === undefined ? {} : { httpStatus: status }),
    ...(evidence.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: evidence.retryAfterSeconds }) }
  const result = (legacy: ModelProtocolFailureStatus, reason: ModelErrorReason) => semanticModelError(legacy, reason, 'provider', evidence.source, metadata)
  // Explicit HTTP timeout/authentication and redirect evidence cannot be overridden by a contradictory body.
  if (status === 408 || status === 504) return result('timeout', 'timeout')
  if (status === 401) return result('authentication-failed', 'authentication')
  if (status !== undefined && status >= 300 && status < 400) return result('invalid-endpoint', 'invalid-endpoint')
  if (has('invalid_api_key', 'authentication_error', 'unauthorized')) return result('authentication-failed', 'authentication')
  if (status === 403 || has('permission_error', 'permission_denied', 'access_denied')) return result('authentication-failed', 'access-denied')
  if (has('model_not_found')) return result('model-not-found', 'model-not-found')
  if (status === 404 || has('not_found_error')) return result('model-not-found', 'not-found')
  if (has('insufficient_quota', 'quota_exceeded', 'insufficient_balance', 'billing_hard_limit_reached')) return result('quota-exceeded', 'quota-exceeded')
  if (status === 429 || has('rate_limit_error', 'rate_limit_exceeded')) return result('rate-limited', 'rate-limited')
  if (status !== undefined && status >= 500 || has('server_error', 'api_error', 'overloaded_error')) {
    return result(has('overloaded_error') ? 'rate-limited' : 'incompatible-response', 'service-unavailable')
  }
  if (has('context_length_exceeded', 'context_window_exceeded', 'prompt_too_long')) return result('incompatible-response', 'context-limit')
  if (has('content_filter', 'content_policy_violation')) return result('incompatible-response', 'content-filtered')
  if (has('tools_not_supported', 'tool_use_not_supported')
    || has('unsupported_parameter') && typeof param === 'string' && ['tools', 'tool_choice', 'functions', 'function_call'].includes(param)) {
    return result('incompatible-response', 'tools-unsupported')
  }
  if (status === 400 || status === 422 || has('invalid_request_error', 'invalid_request')) return result('incompatible-response', 'request-rejected')
  return result('incompatible-response', 'unknown')
}

export function transportModelError(error: unknown, stage: 'connect' | 'receive') {
  const code = field(error, 'code') ?? field(field(error, 'cause'), 'code')
  const tls = ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID']
  const reason: ModelErrorReason = typeof code === 'string' && tls.includes(code) ? 'tls'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns'
      : code === 'ECONNREFUSED' ? 'connection-refused'
        : code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT' ? 'timeout'
          : typeof code === 'string' && ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code) ? stage === 'receive' ? 'stream-interrupted' : 'network'
            : stage === 'connect' ? 'network' : 'unknown'
  return semanticModelError(reason === 'timeout' ? 'timeout' : 'invalid-endpoint', reason, stage, 'local')
}
