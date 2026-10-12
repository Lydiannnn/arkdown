import { describe, expect, it } from 'vitest'
import {
  MODEL_PROVIDER_PRESETS,
  normalizeReasoningEffort,
  providerPreset,
  supportedReasoningEfforts,
  supportsReasoningEffort,
} from '../../src/shared/model-provider-presets'

describe('model provider presets', () => {
  it('lists every supported provider with verified MiMo endpoints and a manual Other endpoint', () => {
    expect(MODEL_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      'deepseek', 'qwen', 'zhipu', 'kimi', 'doubao', 'xiaomi-mimo', 'minimax', 'hy', 'other',
    ])
    expect(providerPreset('xiaomi-mimo').defaultBaseUrls).toEqual({openai:'https://api.xiaomimimo.com/v1',anthropic:'https://api.xiaomimimo.com/anthropic/v1'})
    expect(providerPreset('other').defaultBaseUrls).toEqual({})
  })

  it('uses the verified OpenAI-compatible endpoint for each known provider', () => {
    expect(providerPreset('kimi').defaultBaseUrls.openai).toBe('https://api.moonshot.cn/v1/')
    expect(providerPreset('deepseek').defaultBaseUrls.openai).toBe('https://api.deepseek.com')
    expect(providerPreset('qwen').defaultBaseUrls.openai).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(providerPreset('zhipu').defaultBaseUrls.openai).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(providerPreset('doubao').defaultBaseUrls.openai).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(providerPreset('minimax').defaultBaseUrls.openai).toBe('https://api.minimax.cn/v1')
  })

  it('defaults Hy to the shared TokenHub endpoint without inferring thinking support', () => {
    expect(providerPreset('hy').label).toBe('Hy')
    expect(providerPreset('hy').defaultBaseUrls).toEqual({
      openai: 'https://tokenhub.tencentmaas.com/v1', anthropic: 'https://tokenhub.tencentmaas.com/v1',
    })
    expect(supportsReasoningEffort({ provider: 'hy', protocol: 'openai', modelId: 'unknown-model' })).toBe(false)
  })

  it('allows a manually entered compatible URL through either protocol for every provider', () => {
    expect(MODEL_PROVIDER_PRESETS.every((preset) => (
      preset.protocols.includes('openai') && preset.protocols.includes('anthropic')
    ))).toBe(true)
  })

  it.each([
    ['o1', true],
    ['o3-mini', true],
    ['O4-MINI', true],
    ['gpt-5', true],
    ['gpt-5-mini', true],
    ['gpt-4o', false],
    ['gpt-50', false],
    ['prefix-gpt-5', false],
  ])('permits OpenAI reasoning effort only for known OpenAI reasoning families: %s', (modelId, expected) => {
    expect(supportsReasoningEffort({
      provider: 'other',
      protocol: 'openai',
      modelId,
    })).toBe(expected)
  })

  it('does not infer reasoning support from a provider or Anthropic protocol', () => {
    expect(supportsReasoningEffort({
      provider: 'deepseek',
      protocol: 'openai',
      modelId: 'o3-mini',
    })).toBe(false)
    expect(supportsReasoningEffort({
      provider: 'other',
      protocol: 'anthropic',
      modelId: 'o3-mini',
    })).toBe(false)
  })

  it('uses exact capability-derived efforts and normalizes stale selections', () => {
    const glm = {
      provider: 'zhipu' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      modelId: 'glm-5.3',
      capabilityOverride: null,
    }

    expect(supportedReasoningEfforts(glm)).toEqual(['default', 'low', 'high', 'max'])
    expect(normalizeReasoningEffort(glm, 'medium')).toBe('high')
    expect(normalizeReasoningEffort(glm, 'max')).toBe('max')
    expect(normalizeReasoningEffort({
      ...glm,
      modelId: 'glm-4',
    }, 'max')).toBe('max')
  })
})
