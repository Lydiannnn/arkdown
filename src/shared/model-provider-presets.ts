import type {
  ModelProtocol,
  ModelProviderId,
  ReasoningEffort,
} from './large-model-settings'
import { normalizeReasoningPreference, resolveModelThinkingCapability, type ThinkingConnection } from './model-thinking'

export interface ModelProviderPreset {
  id: ModelProviderId
  label: string
  protocols: readonly ModelProtocol[]
  defaultBaseUrls: Partial<Record<ModelProtocol, string>>
}

const COMPATIBLE_PROTOCOLS: readonly ModelProtocol[] = Object.freeze(['openai', 'anthropic'])

export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = Object.freeze([
  { id: 'deepseek', label: 'DeepSeek', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://api.deepseek.com', anthropic: 'https://api.deepseek.com/anthropic/v1' } },
  { id: 'qwen', label: 'Qwen', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1', anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic/v1' } },
  { id: 'zhipu', label: 'Zcode', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://open.bigmodel.cn/api/paas/v4', anthropic: 'https://open.bigmodel.cn/api/anthropic/v1' } },
  { id: 'kimi', label: 'Kimi', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://api.moonshot.cn/v1/', anthropic: 'https://api.moonshot.cn/anthropic/v1' } },
  { id: 'doubao', label: 'Doubao', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://ark.cn-beijing.volces.com/api/v3', anthropic: 'https://ark.cn-beijing.volces.com/api/compatible/v1' } },
  { id: 'xiaomi-mimo', label: 'Mimo', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://api.xiaomimimo.com/v1', anthropic: 'https://api.xiaomimimo.com/anthropic/v1' } },
  { id: 'minimax', label: 'MiniMax', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://api.minimax.cn/v1', anthropic: 'https://api.minimax.cn/anthropic/v1' } },
  { id: 'hy', label: 'Hy', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: { openai: 'https://tokenhub.tencentmaas.com/v1', anthropic: 'https://tokenhub.tencentmaas.com/v1' } },
  { id: 'other', label: 'Other', protocols: COMPATIBLE_PROTOCOLS, defaultBaseUrls: {} },
])

export function providerPreset(id: ModelProviderId): ModelProviderPreset {
  const preset = MODEL_PROVIDER_PRESETS.find((candidate) => candidate.id === id)
  if (!preset) throw new Error(`Unknown model provider: ${id}`)
  return preset
}

export function supportsReasoningEffort(connection: ThinkingConnection): boolean {
  return resolveModelThinkingCapability(connection).efforts.length > 0
}

export function supportedReasoningEfforts(connection: ThinkingConnection): readonly ReasoningEffort[] {
  return ['default', ...resolveModelThinkingCapability(connection).efforts]
}

export function normalizeReasoningEffort(connection: ThinkingConnection, effort: ReasoningEffort): ReasoningEffort {
  return normalizeReasoningPreference(connection, effort)
}
