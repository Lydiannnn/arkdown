import { describe, expect, it } from 'vitest'
import {
  resolveModelCapabilityProfile,
} from '../../src/shared/model-capability-profiles'

function connection(
  provider: 'deepseek' | 'zhipu' | 'qwen' | 'other',
  baseUrl: string,
  modelId: string,
  capabilityOverride: {
    contextWindowTokens: number
    maxInputTokens?: number
    maxOutputTokens?: number
  } | null = null,
) {
  return { provider, protocol: 'openai' as const, baseUrl, modelId, capabilityOverride }
}

describe('model capability profiles', () => {
  it.each([
    ['deepseek-v4-pro', 1_015_808],
    ['deepseek-v4-flash', 1_015_808],
    ['deepseek-v4-flash-vision-exp', 1_015_808],
  ] as const)('resolves the DeepSeek V4 profile for %s', (modelId, maxInputTokens) => {
    expect(resolveModelCapabilityProfile(
      connection('deepseek', 'https://api.deepseek.com', modelId),
      { requestedOutputTokens: 32_768, thinkingMode: 'default' as const, reasoningEffort: 'default' },
    )).toMatchObject({
      contextWindowTokens: 1_048_576,
      maxInputTokens,
      maxOutputTokens: 384_000,
    })
  })

  it.each(['glm-5.3', 'glm-5.3-flash'] as const)(
    'resolves the exact GLM 5.3 model ID %s with max reasoning',
    (modelId) => {
      expect(resolveModelCapabilityProfile(
        connection('zhipu', 'https://open.bigmodel.cn/api/paas/v4', modelId),
        { requestedOutputTokens: 32_768, thinkingMode: 'enabled' as const, reasoningEffort: 'max' },
      )).toEqual({
        contextWindowTokens: 1_000_000,
        maxInputTokens: 967_232,
        maxOutputTokens: 131_072,
        supportedReasoningEfforts: ['low', 'high', 'max'],
        defaultReasoningEffort: 'max',
        reasoningEncoding: 'thinking-effort',
      })
      expect(resolveModelCapabilityProfile(
        connection('zhipu', 'https://open.bigmodel.cn/api/paas/v4', `${modelId}-max`),
        { requestedOutputTokens: 32_768, thinkingMode: 'enabled' as const, reasoningEffort: 'max' },
      )).toBeUndefined()
    },
  )

  it.each([
    ['disabled', 991_808],
    ['enabled', 983_616],
  ] as const)('uses the Qwen 3.8 %s input limit', (thinkingMode, maxInputTokens) => {
    expect(resolveModelCapabilityProfile(
      connection('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.8-max'),
      { requestedOutputTokens: 32_768, reasoningEffort: 'high', thinkingMode },
    )).toMatchObject({
      contextWindowTokens: 1_000_000,
      maxInputTokens,
      maxOutputTokens: 131_072,
    })
  })

  it('does not invent limits for unknown or custom compatible models', () => {
    expect(resolveModelCapabilityProfile(
      connection('other', 'https://api.example.com/v1', 'deepseek-v4-pro'),
      { requestedOutputTokens: 32_768, thinkingMode: 'default' as const, reasoningEffort: 'default' },
    )).toBeUndefined()
    expect(resolveModelCapabilityProfile(
      connection('deepseek', 'https://proxy.example.com/v1', 'deepseek-v4-pro'),
      { requestedOutputTokens: 32_768, thinkingMode: 'default' as const, reasoningEffort: 'default' },
    )).toBeUndefined()
  })

  it('resolves a valid custom override without retaining mutable input', () => {
    const override = {
      contextWindowTokens: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 40_000,
    }
    const resolved = resolveModelCapabilityProfile(
      connection('other', 'https://api.example.com/v1', 'custom', override),
      { requestedOutputTokens: 20_000, thinkingMode: 'default' as const, reasoningEffort: 'default' },
    )

    expect(resolved).toMatchObject({
      contextWindowTokens: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 40_000,
    })
    override.contextWindowTokens = 1
    expect(resolved?.contextWindowTokens).toBe(200_000)
  })

  it('overlays numeric GLM limits without replacing built-in reasoning capabilities', () => {
    expect(resolveModelCapabilityProfile(
      connection(
        'zhipu',
        'https://open.bigmodel.cn/api/paas/v4',
        'glm-5.3',
        {
          contextWindowTokens: 200_000,
          maxInputTokens: 180_000,
          maxOutputTokens: 40_000,
        },
      ),
      { requestedOutputTokens: 20_000, thinkingMode: 'enabled' as const, reasoningEffort: 'max' },
    )).toEqual({
      contextWindowTokens: 200_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 40_000,
      supportedReasoningEfforts: ['low', 'high', 'max'],
      defaultReasoningEffort: 'max',
      reasoningEncoding: 'thinking-effort',
    })
  })

  it('overlays numeric Qwen limits without disabling thinking mode', () => {
    expect(resolveModelCapabilityProfile(
      connection(
        'qwen',
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
        'qwen3.8-flash',
        {
          contextWindowTokens: 300_000,
          maxInputTokens: 250_000,
          maxOutputTokens: 50_000,
        },
      ),
      { requestedOutputTokens: 20_000, thinkingMode: 'enabled' as const, reasoningEffort: 'high' },
    )).toEqual({
      contextWindowTokens: 300_000,
      maxInputTokens: 250_000,
      maxOutputTokens: 50_000,
      supportedReasoningEfforts: ['low', 'medium', 'xhigh'],
      defaultReasoningEffort: 'xhigh',
      reasoningEncoding: 'openai-effort',
    })
  })
})
