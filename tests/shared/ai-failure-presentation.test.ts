import { describe, expect, it } from 'vitest'
import { parseAiConversationEvent } from '../../src/shared/ai-conversation'
import { MODEL_ERROR_REASONS, type ModelErrorDetail } from '../../src/shared/model-error-detail'
import { PUBLIC_ERROR_MESSAGES } from '../../src/shared/public-errors'
import { describeAiConversationFailure } from '../../src/shared/ai-failure-presentation'

const detail = (reason: ModelErrorDetail['reason']): ModelErrorDetail => ({ version: 1, reason, stage: 'receive', source: 'http' })
describe('AI semantic failure transport and presentation', () => {
  it('retains bounded machine-readable evidence without accepting provider prose or accessors', () => {
    const event = { requestId: '550e8400-e29b-41d4-a716-446655440000', type: 'failed', code: 'MODEL_INCOMPATIBLE_RESPONSE',
      message: PUBLIC_ERROR_MESSAGES.MODEL_INCOMPATIBLE_RESPONSE, detail: { ...detail('service-unavailable'), httpStatus: 503 } }
    expect(parseAiConversationEvent(event)).toEqual(event)
    expect(parseAiConversationEvent({ ...event, detail: { ...event.detail, providerMessage: 'private content' } })).toBeUndefined()
    const getter = Object.defineProperty({}, 'reason', { get() { throw new Error('must not read') } })
    expect(parseAiConversationEvent({ ...event, detail: getter })).toBeUndefined()
    expect(parseAiConversationEvent({ ...event, detail: undefined })).toBeUndefined()
    expect(parseAiConversationEvent({ ...event, message: 'private provider error' })).toBeUndefined()
    const { detail: _detail, ...legacy } = event
    expect(parseAiConversationEvent(legacy)).toEqual(legacy)
  })

  it.each(MODEL_ERROR_REASONS)('uses controlled precise text for %s instead of the compatibility code', reason => {
    const message = describeAiConversationFailure({ code: 'MODEL_INCOMPATIBLE_RESPONSE', detail: detail(reason) })
    expect(message.length).toBeGreaterThan(8)
    expect(message).not.toMatch(/文件未修改|已修改|拉大窗口|自动重试/)
    if (reason !== 'protocol-malformed') expect(message).not.toContain('格式不兼容')
  })

  it('separates provider outages, network failures, output limits and malformed responses', () => {
    for (const [reason, content] of [
      ['service-unavailable', '暂时不可用'], ['dns', '域名'], ['tls', '安全连接'],
      ['output-limit', '长度上限'], ['stream-interrupted', '中断'], ['tool-invalid-arguments', '工具参数'],
      ['protocol-malformed', '格式不兼容'], ['cli-authentication', '登录'],
    ] as const) expect(describeAiConversationFailure({ code: 'MODEL_INCOMPATIBLE_RESPONSE', detail: detail(reason) })).toContain(content)
  })

  it('explains reasoning consumption and actionable recovery for output limits', () => {
    const message = describeAiConversationFailure({ code: 'MODEL_INCOMPATIBLE_RESPONSE', detail: detail('output-limit') })
    expect(message).toContain('思考内容也计入')
    expect(message).toContain('降低思考强度')
    expect(message).toContain('缩小单次处理范围')
    expect(message).not.toMatch(/文件未修改|文件已修改|自动重试/)
  })

  it.each([
    ['response-size-limit', '响应大小'], ['provider-interrupted', '服务商'], ['tool-stream-incomplete', '工具调用'],
  ] as const)('explains %s without claiming whole-task write outcomes', (reason, content) => {
    const event = { requestId: '550e8400-e29b-41d4-a716-446655440000', type: 'failed', code: 'MODEL_INCOMPATIBLE_RESPONSE',
      message: PUBLIC_ERROR_MESSAGES.MODEL_INCOMPATIBLE_RESPONSE, detail: detail(reason) }
    expect(parseAiConversationEvent(event)).toEqual(event)
    const message = describeAiConversationFailure({ code: 'MODEL_INCOMPATIBLE_RESPONSE', detail: detail(reason) })
    expect(message).toContain(content)
    expect(message).not.toMatch(/文件未修改|文件已修改|格式不兼容/)
  })

  it.each(['AI_CONTEXT_LIMIT_REACHED', 'TOOL_RESULT_TOO_LARGE'] as const)('gives capacity guidance for %s without promising a larger context on continue', code => {
    const message = describeAiConversationFailure({ code })
    expect(message).toMatch(/保留.*结论/)
    expect(message).toContain('按章节')
    expect(message).toMatch(/复制.*主动清空/)
    expect(message).toContain('更大上下文')
    expect(message).not.toMatch(/点击.*继续|原样.*重试/)
  })
  it('keeps provider quota and rate guidance distinct from local tool counts', () => {
    const quota = describeAiConversationFailure({ code: 'MODEL_QUOTA_EXCEEDED', detail: detail('quota-exceeded') })
    expect(quota).toMatch(/服务商账户.*可用配额/)
    expect(quota).toContain('工具次数不能恢复')
    expect(describeAiConversationFailure({ code: 'MODEL_QUOTA_EXCEEDED' })).toContain('工具次数不能恢复')
    const rate = describeAiConversationFailure({ code: 'MODEL_RATE_LIMITED', detail: { ...detail('rate-limited'), retryAfterSeconds: 12 } })
    expect(rate).toMatch(/等待 12 秒.*再重试/)
    expect(rate).not.toContain('继续分析')
    expect(describeAiConversationFailure({ code: 'MODEL_RATE_LIMITED' })).toContain('等待后再重试')
    const output = describeAiConversationFailure({ code: 'MODEL_INCOMPATIBLE_RESPONSE', detail: detail('output-limit') })
    expect(output).toMatch(/保留.*部分结果/)
    expect(output).toContain('核对已执行的修改')
  })
  it('uses retry delay only as guidance, and preserves legacy local error text', () => {
    expect(describeAiConversationFailure({ code: 'MODEL_RATE_LIMITED', detail: { ...detail('rate-limited'), retryAfterSeconds: 12 } })).toContain('12 秒')
    expect(describeAiConversationFailure({ code: 'MODEL_QUOTA_EXCEEDED', detail: { ...detail('quota-exceeded'), retryAfterSeconds: 12 } })).not.toContain('12 秒')
    expect(describeAiConversationFailure({ code: 'AI_MODEL_NOT_CONFIGURED' })).toBe(PUBLIC_ERROR_MESSAGES.AI_MODEL_NOT_CONFIGURED)
  })
})
