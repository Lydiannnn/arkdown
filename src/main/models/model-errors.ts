import type { ModelConnectionStatus } from '../../shared/large-model-settings'
import { parseModelErrorDetail, type ModelErrorDetail, type ModelErrorReason } from '../../shared/model-error-detail'

export type ModelProtocolFailureStatus = Exclude<
  ModelConnectionStatus,
  'untested' | 'connected' | 'encryption-unavailable'
>

const PUBLIC_MESSAGES: Record<ModelProtocolFailureStatus, string> = {
  'authentication-failed': 'Model authentication failed',
  'model-not-found': 'The configured model was not found',
  'invalid-endpoint': 'The model endpoint is invalid or unavailable',
  timeout: 'The model request timed out',
  'rate-limited': 'The model provider rate limited the request',
  'quota-exceeded': 'The model account quota is exhausted',
  'incompatible-response': 'The model provider returned an incompatible response',
}

export class ModelProtocolError extends Error {
  readonly status: ModelProtocolFailureStatus
  readonly capability?: 'tools'
  readonly detail: ModelErrorDetail

  constructor(status: ModelProtocolFailureStatus, capability?: 'tools', detail?: ModelErrorDetail) {
    super(PUBLIC_MESSAGES[status])
    this.name = 'ModelProtocolError'
    this.status = status
    this.capability = capability
    const reason: ModelErrorReason = capability === 'tools' ? 'tools-unsupported'
      : status === 'authentication-failed' ? 'authentication'
        : status === 'incompatible-response' ? 'protocol-malformed' : status
    this.detail = parseModelErrorDetail(detail) ?? Object.freeze({ version: 1, reason,
      stage: reason === 'protocol-malformed' ? 'decode' : reason === 'timeout' ? 'receive' : 'provider', source: 'local' })
  }
}

export function modelProtocolError(
  status: ModelProtocolFailureStatus,
  capability?: 'tools',
  detail?: ModelErrorDetail,
): ModelProtocolError {
  return new ModelProtocolError(status, capability, detail)
}
