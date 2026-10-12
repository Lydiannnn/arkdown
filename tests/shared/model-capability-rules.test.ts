import { afterEach, describe, expect, it, vi } from 'vitest'
import bundled from '../../src/shared/model-capability-rules.json'
import { effectiveModelThinking, normalizeReasoningPreference } from '../../src/shared/model-thinking'
import {
  getModelCapabilityRules, getModelCapabilityRulesRevision, parseModelCapabilityRules,
  parseModelThinkingCapability, recommendedModelIds, resolveModelCapabilityRule,
  setModelCapabilityRules, subscribeModelCapabilityRules,
} from '../../src/shared/model-capability-rules'

const connection = { provider: 'minimax' as const, protocol: 'openai' as const, baseUrl: 'https://api.minimax.cn/v1', modelId: 'MiniMax-M3' }
const cap = { thinking: 'toggle', encoding: 'thinking', efforts: [], disabledEfforts: [], defaultThinking: 'enabled', defaultEffort: 'default' }
function rule(id = 'custom') {
  return { id, protocol: 'openai', baseUrls: ['https://example.com/v1'], modelIds: ['test-model'], capability: { ...cap }, recommendation: 1 }
}
function file(rules: unknown[]) { return { schemaVersion: 1, revision: '2026-09-12', rules } }
afterEach(() => setModelCapabilityRules(null))

describe('model capability rules', () => {
  it('validates bundled data and preserves exact endpoint identity', () => {
    expect(parseModelCapabilityRules(bundled)).toBeDefined()
    expect(resolveModelCapabilityRule(connection)?.capability.encoding).toBe('adaptive')
    expect(resolveModelCapabilityRule({ ...connection, baseUrl: 'https://proxy.example/v1' })).toBeUndefined()
    expect(resolveModelCapabilityRule({ ...connection, modelId: 'minimax-m3' })).toBeUndefined()
    expect(resolveModelCapabilityRule({ ...connection, baseUrl: 'https://api.minimax.cn/v1/' })).toBeDefined()
  })
  it('retains Astra transport and Qwen output encoding', () => {
    expect(resolveModelCapabilityRule({ provider: 'other', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-6-astra' })?.transport).toBe('responses')
    expect(resolveModelCapabilityRule({ provider: 'qwen', protocol: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.8-max' })?.outputTokenField).toBe('max_completion_tokens')
    expect(resolveModelCapabilityRule({ provider: 'qwen', protocol: 'openai', baseUrl: 'https://fake.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.8-max' })).toBeUndefined()
  })
  it('uses protocol-specific MiniMax defaults and native Hy efforts', () => {
    expect(resolveModelCapabilityRule({ ...connection, protocol: 'anthropic', baseUrl: 'https://api.minimax.cn/anthropic/v1' })?.capability.defaultThinking).toBe('disabled')
    expect(resolveModelCapabilityRule({ provider: 'hy', protocol: 'openai', baseUrl: 'https://tokenhub.tencentmaas.com/v1', modelId: 'hy3' })?.capability.efforts).toEqual(['low', 'high'])
    expect(resolveModelCapabilityRule({ provider: 'hy', protocol: 'openai', baseUrl: 'https://tokenhub.tencentmaas.com/v1', modelId: 'hy4-preview' })?.capability.efforts).toEqual(['high'])
  })

  it('matches Qwen workspace and Coding endpoints in both protocols', () => {
    for (const protocol of ['openai', 'anthropic'] as const) {
      for (const baseUrl of [
        'https://workspace-fixture.cn-beijing.maas.aliyuncs.com' + (protocol === 'openai' ? '/compatible-mode/v1' : '/apps/anthropic/v1'),
        'https://coding.dashscope.aliyuncs.com' + (protocol === 'openai' ? '/v1' : '/apps/anthropic/v1'),
      ]) {
        const native = { provider: 'qwen' as const, protocol, baseUrl, modelId: 'qwen3.8-max' }
        expect(resolveModelCapabilityRule(native)?.capability.efforts).toEqual(['low','medium','xhigh'])
        expect(normalizeReasoningPreference(native, 'high')).toBe('xhigh')
        expect(normalizeReasoningPreference(native, 'max')).toBe('xhigh')
      }
    }
  })

  it('normalizes legacy preferences only into effective legal grades', () => {
    const glm = { provider: 'zhipu' as const, protocol: 'openai' as const, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', modelId: 'glm-5.2' }
    expect(normalizeReasoningPreference(glm, 'low')).toBe('high')
    expect(normalizeReasoningPreference(glm, 'xhigh')).toBe('max')
    const manual = {...connection, capabilityOverride: {thinking: {thinking:'toggle' as const,encoding:'thinking-effort' as const,efforts:['low','max'] as const,defaultThinking:'enabled' as const,defaultEffort:'max' as const,disabledEfforts:[]}}}
    expect(effectiveModelThinking(manual, {thinkingMode:'enabled',reasoningEffort:'medium'})).toEqual({thinkingMode:'enabled',reasoningEffort:'max'})
    expect(effectiveModelThinking(manual, {thinkingMode:'enabled',reasoningEffort:'xhigh'})).toEqual({thinkingMode:'enabled',reasoningEffort:'max'})
  })
  it('adds and overrides by id while preserving other bundled rules', () => {
    const original = resolveModelCapabilityRule(connection)!
    const replacement = { ...original, capability: { ...original.capability, defaultThinking: 'disabled' as const } }
    setModelCapabilityRules(parseModelCapabilityRules(file([replacement, rule()]))!)
    expect(resolveModelCapabilityRule(connection)?.capability.defaultThinking).toBe('disabled')
    expect(recommendedModelIds({ provider: 'other', protocol: 'openai', baseUrl: 'https://example.com/v1' })).toEqual(['test-model'])
    expect(resolveModelCapabilityRule({ ...connection, modelId: 'MiniMax-M2.7' })).toBeDefined()
    setModelCapabilityRules(null)
    expect(resolveModelCapabilityRule(connection)?.capability.defaultThinking).toBe('enabled')
    expect(getModelCapabilityRules()).toBeNull()
  })
  it('rejects ambiguity within a file and against retained bundled rules', () => {
    expect(parseModelCapabilityRules(file([rule('a'), rule('b')]))).toBeUndefined()
    const existing = resolveModelCapabilityRule(connection)!
    expect(parseModelCapabilityRules(file([{ ...existing, id: 'duplicate-bundled' }]))).toBeUndefined()
  })
  it('permits more-specific provider and endpoint overrides deterministically', () => {
    const broad = rule('broad')
    const narrow = { ...rule('narrow'), provider: 'minimax', capability: { ...cap, defaultThinking: 'disabled' } }
    setModelCapabilityRules(parseModelCapabilityRules(file([broad, narrow]))!)
    expect(resolveModelCapabilityRule({ ...connection, baseUrl: 'https://example.com/v1', modelId: 'test-model' })?.id).toBe('narrow')
  })
  it('clones state and emits revision notifications only after valid changes', () => {
    const listener = vi.fn()
    const stop = subscribeModelCapabilityRules(listener)
    const before = getModelCapabilityRulesRevision()
    const parsed = parseModelCapabilityRules(file([rule()]))!
    setModelCapabilityRules(parsed)
    parsed.rules[0].modelIds[0] = 'mutated'
    const read = getModelCapabilityRules()!
    read.rules[0].modelIds[0] = 'also-mutated'
    expect(getModelCapabilityRules()!.rules[0].modelIds).toEqual(['test-model'])
    expect(getModelCapabilityRulesRevision()).toBe(before + 1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(() => setModelCapabilityRules(file([rule(), rule()]) as never)).toThrow(TypeError)
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })
  it.each([
    { extra: true }, { schemaVersion: 2 }, { revision: 'invalid' }, { rules: Array(513).fill(rule()) },
  ])('rejects invalid root %j', (change) => expect(parseModelCapabilityRules({ ...file([rule()]), ...change })).toBeUndefined())
  it.each([
    { baseUrls: ['http://remote.example/v1'] }, { baseUrls: ['https://user:pass@example.com/v1'] },
    { baseUrls: ['https://example.com/v1?q=1'] }, { baseUrls: ['https://example.com/v1#hash'] },
    { baseUrls: ['https://example.com/v1', 'https://example.com/v1/'] }, { modelIds: ['a', 'a'] },
    { endpointGroup: 'anything' }, { regex: '.*' }, { protocol: 'responses' }, { transport: 'arbitrary' },
    { protocol: 'anthropic', transport: 'responses' }, { capability: { ...cap, encoding: 'claude-adaptive' } },
    { capability: { ...cap, thinking: 'fixed', defaultThinking: 'disabled' } },
    { capability: { ...cap, defaultEffort: 'high' } }, { capability: { ...cap, efforts: ['none'] } },
    { capability: { ...cap, encoding: 'javascript' } }, { capability: { ...cap, unexpected: true } },
  ])('rejects invalid rule %j', (change) => expect(parseModelCapabilityRules(file([{ ...rule(), ...change }]))).toBeUndefined())
  it('rejects non-JSON objects, sparse arrays, accessors and cycles without invoking getters', () => {
    const getter = vi.fn(() => 1)
    expect(parseModelCapabilityRules(Object.defineProperty({}, 'schemaVersion', { get: getter }))).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(parseModelCapabilityRules(file(new Array(2)))).toBeUndefined()
    const cyclic: Record<string, unknown> = file([]); cyclic.self = cyclic
    expect(parseModelCapabilityRules(cyclic)).toBeUndefined()
    expect(parseModelCapabilityRules(file([{ ...rule(), modelIds: ['x'.repeat(513)] }]))).toBeUndefined()
  })
  it('shares strict manual capability validation', () => {
    expect(parseModelThinkingCapability(cap, 'openai')).toEqual(cap)
    expect(parseModelThinkingCapability({ ...cap, encoding: 'openai-effort' }, 'anthropic')).toBeUndefined()
    expect(parseModelThinkingCapability({ ...cap, disabledEfforts: ['high'] })).toBeUndefined()
    expect(parseModelThinkingCapability({ ...cap, thinking: 'unknown' })).toBeUndefined()
  })
})
