import { PUBLIC_ERROR_MESSAGES, type PublicErrorCode } from './public-errors'
import type { ModelErrorDetail, ModelErrorReason } from './model-error-detail'

export interface AiConversationFailure {
  readonly code: PublicErrorCode
  readonly detail?: ModelErrorDetail
}

/** Fixed product copy keyed only by validated semantic evidence. Provider prose
 * and write outcomes must never be inferred from a model request failure. */
const REASON_MESSAGES: Record<ModelErrorReason, string> = {
  authentication: '大模型认证失败，请检查 API Key 或登录状态。',
  'access-denied': '服务商拒绝了本次访问，请检查账户是否有权限使用该模型。',
  'model-not-found': '服务商未找到配置的模型，请核对模型名称。',
  'not-found': '服务商未找到请求的资源，请核对接口地址和模型配置。',
  'invalid-endpoint': '大模型接口地址无效，请检查接口配置。',
  'rate-limited': '服务商限制了请求频率，请等待后再重试。',
  'quota-exceeded': '大模型账户余额或配额不足，请检查服务商账户和可用配额。修改本地工具次数不能恢复账户额度。',
  'service-unavailable': '大模型服务暂时不可用，请稍后重试。',
  'request-rejected': '服务商拒绝了本次请求，请检查模型及请求配置。',
  'context-limit': PUBLIC_ERROR_MESSAGES.AI_CONTEXT_LIMIT_REACHED,
  'output-limit': '本次生成达到输出长度上限（思考内容也计入），回复未完整返回。请保留已有部分结果，核对已执行的修改；可降低思考强度或缩小单次处理范围，再只提交剩余任务。',
  'content-filtered': '服务商因内容策略未完成本次请求。',
  'tools-unsupported': '当前模型或接口不支持本次所需的工具调用，请选择支持工具调用的模型。',
  network: '连接大模型服务失败，请检查网络连接。',
  dns: '无法解析大模型接口的域名，请检查接口地址和网络连接。',
  'connection-refused': '大模型服务拒绝连接，请检查接口服务是否可用。',
  tls: '无法与大模型服务建立安全连接，请检查网络环境及服务证书。',
  timeout: '等待大模型响应超时，本次请求未完成。',
  'stream-interrupted': '大模型响应传输中断，回复未完整返回。',
  'protocol-malformed': '大模型返回的数据格式不兼容，无法继续处理本次响应。',
  'response-size-limit': '大模型返回的数据超过本地响应大小上限，回复未完整处理。请缩小单次处理范围后重试。',
  'provider-interrupted': '服务商提前中止了本次生成，回复未完整返回。请稍后重试或缩小单次处理范围。',
  'tool-stream-incomplete': '模型的工具调用未完整返回，本批工具未执行。请重试或缩小单次处理范围。',
  'tool-invalid-arguments': '模型返回的工具参数无效，本批工具未执行。',
  'tool-invalid-name': '模型请求了不支持的工具，本批工具未执行。',
  'tool-invalid-identity': '模型返回的工具调用标识无效或冲突，本批工具未执行。',
  'cli-authentication': 'Codex CLI 登录无效或已过期，请重新登录。',
  'cli-unavailable': 'Codex CLI 暂不可用，请检查组件安装和运行状态。',
  'cli-sandbox': 'Codex CLI 的执行环境限制了本次请求。',
  'cli-budget-exceeded': 'Codex CLI 已达到本次运行额度上限。',
  unknown: '大模型请求未能完成，暂未确定具体原因。',
}

export function describeAiConversationFailure(failure: AiConversationFailure): string {
  if (!failure.detail) {
    if (failure.code === 'MODEL_RATE_LIMITED') return REASON_MESSAGES['rate-limited']
    if (failure.code === 'MODEL_QUOTA_EXCEEDED') return REASON_MESSAGES['quota-exceeded']
    return PUBLIC_ERROR_MESSAGES[failure.code]
  }
  const message = REASON_MESSAGES[failure.detail.reason]
  const delay = failure.detail.retryAfterSeconds
  return failure.detail.reason === 'rate-limited' && delay !== undefined && delay > 0
    ? `服务商限制了请求频率，请按服务商建议等待 ${delay} 秒后再重试。` : message
}
