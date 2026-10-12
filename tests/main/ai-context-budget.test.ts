import { describe, expect, it } from 'vitest'
import type { ModelUsage } from '../../src/shared/ai-conversation'
import type { ModelCapabilityProfile } from '../../src/shared/model-capability-profiles'
import {
  AI_NORMAL_REQUESTED_OUTPUT_TOKENS,
  AI_SUMMARY_REQUESTED_OUTPUT_TOKENS,
  contextInputBudget,
  resolveAiConversationProfile,
  contextUsageSnapshot,
  createAiWireLineage,
  estimateTextTokens,
  estimateWireTokens,
  safeInputTokens,
  shouldCompactContext,
  toolReserveTokens,
} from '../../src/main/models/ai-context-budget'

function profile(overrides: Partial<ModelCapabilityProfile> = {}): ModelCapabilityProfile {
  return {
    contextWindowTokens: 1_000,
    maxInputTokens: 900,
    maxOutputTokens: 400,
    supportedReasoningEfforts: ['default'],
    defaultReasoningEffort: 'default',
    reasoningEncoding: 'none',
    ...overrides,
  }
}

describe('AI context budgets', () => {
  it.each([
    ['other', 'openai', 'https://example.test/v1', 'unknown', undefined, 32_768],
    ['other', 'openai', 'https://example.test/v1', 'known-output', 131_072, 98_304],
    ['deepseek', 'openai', 'https://api.deepseek.com', 'deepseek-flash', undefined, 98_304],
    ['other', 'anthropic', 'https://api.anthropic.com', 'claude', 131_072, 32_768],
    ['other', 'openai', 'https://api.openai.com/v1', 'gpt-6-astra', 131_072, 32_768],
  ] as const)('retains a compatible output cap for incomplete capability or bounded transport: %s/%s/%s/%s', (provider, protocol, baseUrl, modelId, maxOutputTokens, requested) => {
    const resolved = resolveAiConversationProfile({ provider, protocol, baseUrl, modelId,
      capabilityOverride: { contextWindowTokens: 200_000, ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }) },
    }, { reasoningEffort: 'default', thinkingMode: 'default' })!
    expect(contextInputBudget({ profile: resolved, capabilities: { currentDocument: false, workspace: true } }).requestedOutputTokens).toBe(requested)
    expect(resolved.maxInputTokens).toBe(200_000 - requested)
  })
  it.each([
    [1_048_576, 384_000, 98_304, 851_968],
    [128_000, 131_072, 64_000, 32_000],
    [32_768, 32_768, 16_384, 8_192],
    [128_000, 8_192, 8_192, 59_904],
  ])('reserves matching normal output and usable input for window %i / provider output %i', (window, output, requested, input) => {
    expect(contextInputBudget({
      profile: profile({ contextWindowTokens: window, maxInputTokens: window, maxOutputTokens: output }),
      capabilities: { currentDocument: true, workspace: true },
    })).toMatchObject({ requestedOutputTokens: requested, safeInputTokens: input })
  })
  const lineage = createAiWireLineage()
  it('reserves the requested output and workspace tool headroom', () => {
    expect(safeInputTokens({
      maxInputTokens: 1_000_000,
      contextWindowTokens: 1_000_000,
      requestedOutputTokens: 32_768,
      toolReserveTokens: 98_304,
    })).toBe(868_928)
  })

  it('uses the provider maximum input when it is the tighter limit', () => {
    expect(safeInputTokens({
      maxInputTokens: 700,
      contextWindowTokens: 1_000,
      requestedOutputTokens: 100,
      toolReserveTokens: 100,
    })).toBe(700)
  })

  it('exposes the exact request defaults and capability reserves', () => {
    expect(AI_NORMAL_REQUESTED_OUTPUT_TOKENS).toBe(98_304)
    expect(AI_SUMMARY_REQUESTED_OUTPUT_TOKENS).toBe(16_384)
    expect(toolReserveTokens({ currentDocument: false, workspace: false })).toBe(32_768)
    expect(toolReserveTokens({ currentDocument: true, workspace: false })).toBe(65_536)
    expect(toolReserveTokens({ currentDocument: false, workspace: true })).toBe(98_304)
    expect(toolReserveTokens({ currentDocument: true, workspace: true })).toBe(98_304)
  })

  it.each([
    [{ currentDocument: false, workspace: false }, 32_768, 62_464],
    [{ currentDocument: true, workspace: false }, 32_768, 47_616],
    [{ currentDocument: true, workspace: true }, 32_768, 47_616],
    [{ currentDocument: true, workspace: true }, 8_192, 59_904],
  ] as const)('bounds default tool headroom by half the available window for %o with max output %i', (capabilities, maxOutputTokens, safeInput) => {
    expect(contextUsageSnapshot({
      profile: profile({ contextWindowTokens: 128_000, maxInputTokens: 95_000, maxOutputTokens }),
      capabilities,
      estimatedNextRequestTokens: 23_410,
      wireLineage: lineage,
      usageBaseline: null,
    })).toMatchObject({
      visible: true, contextWindowTokens: 128_000,
      safeInputTokens: safeInput, hardLimitTokens: safeInput, percentage: 18,
    })
  })

  it('preserves an explicit reserve override and clamps requested output to the model window', () => {
    expect(contextUsageSnapshot({
      profile: profile({ contextWindowTokens: 128_000, maxInputTokens: 95_000, maxOutputTokens: 32_768 }),
      capabilities: { currentDocument: true, workspace: true },
      toolReserveTokens: 98_304,
      estimatedNextRequestTokens: 100,
      wireLineage: lineage,
      usageBaseline: null,
    })).toMatchObject({ safeInputTokens: 0 })
    expect(contextUsageSnapshot({
      profile: profile({ contextWindowTokens: 1_000, maxInputTokens: 900, maxOutputTokens: 1_000 }),
      requestedOutputTokens: 32_768,
      capabilities: { currentDocument: true, workspace: true },
      estimatedNextRequestTokens: 100,
      wireLineage: lineage,
      usageBaseline: null,
    })).toMatchObject({ safeInputTokens: 1 })
  })

  it('estimates UTF-8 content deterministically without provider tokenizers', () => {
    expect(estimateTextTokens('abc')).toBe(3)
    expect(estimateTextTokens('abcd')).toBe(4)
    expect(estimateTextTokens('你')).toBe(3)
    expect(estimateWireTokens([{ role: 'user', content: 'a' }])).toBe(41)
  })

  it('triggers at exactly 85 percent of the safe input', () => {
    const below = contextUsageSnapshot({
      profile: profile(),
      capabilities: { currentDocument: false, workspace: false },
      requestedOutputTokens: 100,
      toolReserveTokens: 100,
      estimatedNextRequestTokens: 679,
      wireLineage: lineage,
      usageBaseline: null,
    })
    const atThreshold = contextUsageSnapshot({
      profile: profile(),
      capabilities: { currentDocument: false, workspace: false },
      requestedOutputTokens: 100,
      toolReserveTokens: 100,
      estimatedNextRequestTokens: 680,
      wireLineage: lineage,
      usageBaseline: null,
    })

    expect(below).toMatchObject({
      visible: true,
      contextWindowTokens: 1_000,
      safeInputTokens: 800,
      percentage: 68,
    })
    expect(shouldCompactContext(below)).toBe(false)
    expect(shouldCompactContext(atThreshold)).toBe(true)
  })

  it('displays usage against the total context window rather than the safe threshold', () => {
    expect(contextUsageSnapshot({
      profile: profile({ contextWindowTokens: 128_000, maxInputTokens: 120_000, maxOutputTokens: 8_000 }),
      capabilities: { currentDocument: false, workspace: false },
      requestedOutputTokens: 8_000,
      toolReserveTokens: 16_000,
      estimatedNextRequestTokens: 23_410,
      wireLineage: lineage,
      usageBaseline: null,
    })).toMatchObject({
      visible: true,
      inputTokens: 23_410,
      contextWindowTokens: 128_000,
      safeInputTokens: 104_000,
      percentage: 18,
    })
  })

  it('uses matching actual usage as a baseline and adds subsequent wire growth', () => {
    const usage: ModelUsage = {
      inputTokens: 700,
      outputTokens: 25,
      totalTokens: 725,
      cachedInputTokens: 300,
      estimated: false,
    }

    expect(contextUsageSnapshot({
      profile: profile(),
      capabilities: { currentDocument: false, workspace: false },
      requestedOutputTokens: 100,
      toolReserveTokens: 100,
      estimatedNextRequestTokens: 750,
      wireLineage: lineage,
      usageBaseline: {
        usage,
        wireLineage: lineage,
        estimatedNextRequestTokensAtRequest: 600,
      },
    })).toMatchObject({
      visible: true,
      inputTokens: 850,
      contextWindowTokens: 1_000,
      safeInputTokens: 800,
      percentage: 85,
      estimated: true,
    })
  })

  it('ignores stale actual usage from a different wire baseline', () => {
    const usage: ModelUsage = {
      inputTokens: 700,
      outputTokens: 25,
      totalTokens: 725,
      cachedInputTokens: null,
      estimated: false,
    }

    expect(contextUsageSnapshot({
      profile: profile(),
      capabilities: { currentDocument: false, workspace: false },
      requestedOutputTokens: 100,
      toolReserveTokens: 100,
      estimatedNextRequestTokens: 799,
      wireLineage: createAiWireLineage(),
      usageBaseline: {
        usage,
        wireLineage: createAiWireLineage(),
        estimatedNextRequestTokensAtRequest: 600,
      },
    })).toMatchObject({
      inputTokens: 799,
      estimated: true,
    })
  })

  it('hides window percentage and disables automatic thresholds for an unknown profile', () => {
    const snapshot = contextUsageSnapshot({
      profile: undefined,
      capabilities: { currentDocument: false, workspace: false },
      estimatedNextRequestTokens: 321,
      wireLineage: lineage,
      usageBaseline: null,
    })

    expect(snapshot).toEqual({ visible: false, inputTokens: 321, estimated: true })
    expect(shouldCompactContext(snapshot)).toBe(false)
  })

  it('returns a whole-number display percentage clamped to the context window', () => {
    expect(contextUsageSnapshot({
      profile: profile(),
      capabilities: { currentDocument: false, workspace: false },
      estimatedNextRequestTokens: 1_501,
      wireLineage: lineage,
      usageBaseline: null,
    })).toMatchObject({ percentage: 100 })
  })

  it('uses append-only lineage identity for actual-usage baselines', () => {
    expect(createAiWireLineage()).not.toBe(createAiWireLineage())
  })
})
