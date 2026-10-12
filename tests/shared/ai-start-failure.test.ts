import { expect, it, vi } from 'vitest'
import { parseAiStartFailure } from '../../src/shared/ai-start-failure'

const failure = () => ({ ok: false, error: { code: 'MODEL_TIMEOUT', message: 'untrusted',
  detail: { version: 1, reason: 'timeout', stage: 'receive', source: 'local' } } })

it('copies and freezes only finite detail and replaces arbitrary text with the approved fixed message', () => {
  const value = failure()
  const result = parseAiStartFailure(value)!
  value.error.detail.reason = 'network'
  expect(result).toEqual({ ok: false, error: { code: 'MODEL_TIMEOUT', message: '大模型请求超时',
    detail: { version: 1, reason: 'timeout', stage: 'receive', source: 'local' } } })
  expect(Object.isFrozen(result.error)).toBe(true)
  expect(Object.isFrozen(result.error.detail)).toBe(true)
})

it('retains legacy finite errors without requiring semantic model evidence', () => {
  expect(parseAiStartFailure({ ok: false, error: { code: 'AI_MODEL_NOT_CONFIGURED', message: 'SECRET' } })).toEqual({
    ok: false, error: { code: 'AI_MODEL_NOT_CONFIGURED', message: '尚未配置 AI 对话使用的大模型' },
  })
})

it('rejects accessors, inherited values, unknown keys and malformed finite details without reading getters', () => {
  const getter = vi.fn(() => 'MODEL_TIMEOUT')
  const hostile = failure()
  Object.defineProperty(hostile.error, 'code', { enumerable: true, get: getter })
  const unknowns = [hostile, Object.create(failure()), { ...failure(), path: 'SECRET' },
    { ok: false, error: { ...failure().error, code: 'NOT_PUBLIC' } },
    { ok: false, error: { ...failure().error, detail: undefined } },
    { ok: false, error: { ...failure().error, detail: { ...failure().error.detail, version: 2 } } },
    { ok: false, error: { ...failure().error, detail: { ...failure().error.detail, providerBody: 'SECRET' } } },
    { ok: false, error: { ...failure().error, detail: { ...failure().error.detail, retryAfterSeconds: 86401 } } },
  ]
  for (const value of unknowns) expect(parseAiStartFailure(value)).toBeNull()
  expect(getter).not.toHaveBeenCalled()
})
