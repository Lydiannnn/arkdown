import { featureModelConnections } from '../../shared/large-model-settings'
import { SCREEN_TRANSLATION_LANGUAGES } from '../../shared/screen-translation'
import type {
  LargeModelSettings,
  ModelConnectionStatus,
  ModelProtocol,
  ModelProviderId,
  ReasoningEffort,
  TargetLanguage,
} from '../../shared/large-model-settings'
import { CheckCircle, WarningCircle } from '@phosphor-icons/react'

export const PROVIDER_LABELS: Readonly<Record<ModelProviderId, string>> = {
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
  zhipu: 'Zcode',
  doubao: 'Doubao',
  minimax: 'MiniMax',
  'xiaomi-mimo': 'Mimo',
  hy: 'Hy',
  other: '其他',
}

export const PROTOCOL_LABELS: Readonly<Record<ModelProtocol, string>> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic 兼容',
}

export const REASONING_LABELS: Readonly<Record<ReasoningEffort, string>> = {
  default: '默认',
  none: '不推理',
  minimal: '极低',
  ultra: '极致',
  xhigh: '超高',
  low: '低',
  medium: '中',
  high: '高',
  max: '最高',
}

export const TARGET_LANGUAGE_OPTIONS: readonly {
  value: TargetLanguage
  label: string
}[] = [
  { value: 'auto', label: '自动' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁体中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'fr', label: '法语' },
  { value: 'de', label: '德语' },
  { value: 'es', label: '西班牙语' },
  { value: 'pt', label: '葡萄牙语' },
  { value: 'ru', label: '俄语' },
  { value: 'it', label: '意大利语' },
  { value: 'ar', label: '阿拉伯语' },
]

export const STATUS_LABELS: Readonly<Record<ModelConnectionStatus, string>> = {
  untested: '未测试',
  connected: '连接正常',
  'authentication-failed': '认证失败',
  'model-not-found': '模型不存在',
  'invalid-endpoint': '接口地址无效',
  timeout: '请求超时',
  'rate-limited': '服务商限流',
  'quota-exceeded': '余额或配额不足',
  'incompatible-response': '响应格式不兼容',
  'encryption-unavailable': 'Windows 加密不可用',
}

interface LargeModelSettingsSectionProps {
  settings: LargeModelSettings
  onManage(): void
}

function ConnectionStatus({ status }: { status: ModelConnectionStatus }) {
  const StatusIcon = status === 'connected' ? CheckCircle : WarningCircle

  return (
    <span
      aria-label={STATUS_LABELS[status]}
      className={`large-model-connection-status is-${status}`}
      role="status"
    >
      <StatusIcon aria-hidden="true" size={16} weight="fill" />
      {STATUS_LABELS[status]}
    </span>
  )
}

export function LargeModelSettingsSection({
  settings,
  onManage,
}: LargeModelSettingsSectionProps) {
  const selected = featureModelConnections(settings).find(
    (connection) => connection.id === settings.selectionTranslation.connectionId,
  )
  const targetLanguage = TARGET_LANGUAGE_OPTIONS.find(
    (candidate) => candidate.value === settings.selectionTranslation.targetLanguage,
  )?.label
  const screenshotSelected = featureModelConnections(settings).find(
    (connection) => connection.id === settings.screenshotTranslation.connectionId,
  )
  const screenshotTargetLanguage = TARGET_LANGUAGE_OPTIONS.find(
    (candidate) => candidate.value === settings.screenshotTranslation.targetLanguage,
  )?.label
  const aiConversationSelected = featureModelConnections(settings).find(
    (connection) => connection.id === settings.aiConversation.connectionId,
  )
  const floatingSelected = featureModelConnections(settings).find(item => item.id === settings.floatingTranslation?.connectionId)

  return (
    <section
      aria-labelledby="preferences-large-model-heading"
      className="preferences-section large-model-settings-section"
    >
      <h2 id="preferences-large-model-heading" tabIndex={-1}>大模型设置</h2>
      <p>管理大模型连接，并为 Arkdown 功能选择使用的模型。</p>
      {!selected && !screenshotSelected && !aiConversationSelected && !floatingSelected && (
        <p className="large-model-empty-state">尚未配置大模型应用</p>
      )}
      <div className="large-model-feature-list">
        <div aria-label="划词翻译" className="large-model-feature-row" role="group">
          <div className="large-model-feature-heading">
            <h3>划词翻译</h3>
            {selected && <ConnectionStatus status={selected.status} />}
          </div>
          {selected ? (
            <dl
              aria-label="当前划词翻译模型"
              data-ui-selectable="true"
              role="group"
              tabIndex={0}
            >
              <div>
                <dt>模型</dt>
                <dd>{PROVIDER_LABELS[selected.provider]} / {selected.name}</dd>
              </div>
              <div>
                <dt>模型 ID</dt>
                <dd>{selected.modelId}</dd>
              </div>
              <div>
                <dt>推理强度</dt>
                <dd>{REASONING_LABELS[settings.selectionTranslation.reasoningEffort]}</dd>
              </div>
              <div>
                <dt>目标语言</dt>
                <dd>{targetLanguage}</dd>
              </div>
            </dl>
          ) : (
            <button
              className="large-model-unconfigured-link"
              onClick={onManage}
              type="button"
            >
              尚未配置
            </button>
          )}
        </div>
        <div aria-label="截图翻译" className="large-model-feature-row" role="group">
          <div className="large-model-feature-heading">
            <h3>截图翻译</h3>
            {screenshotSelected && <ConnectionStatus status={screenshotSelected.status} />}
          </div>
          {screenshotSelected ? (
            <dl
              aria-label="当前截图翻译模型"
              data-ui-selectable="true"
              role="group"
              tabIndex={0}
            >
              <div>
                <dt>模型</dt>
                <dd>{PROVIDER_LABELS[screenshotSelected.provider]} / {screenshotSelected.name}</dd>
              </div>
              <div>
                <dt>模型 ID</dt>
                <dd>{screenshotSelected.modelId}</dd>
              </div>
              <div>
                <dt>推理强度</dt>
                <dd>{REASONING_LABELS[settings.screenshotTranslation.reasoningEffort]}</dd>
              </div>
              <div>
                <dt>目标语言</dt>
                <dd>{screenshotTargetLanguage}</dd>
              </div>
            </dl>
          ) : (
            <button
              className="large-model-unconfigured-link"
              onClick={onManage}
              type="button"
            >
              尚未配置
            </button>
          )}
        </div>
        <div aria-label="悬浮翻译窗" className="large-model-feature-row" role="group">
          <div className="large-model-feature-heading">
            <h3>悬浮翻译窗</h3>
            {floatingSelected && <ConnectionStatus status={floatingSelected.status} />}
          </div>
          {floatingSelected ? (
            <dl aria-label="当前悬浮翻译窗模型" data-ui-selectable="true" role="group" tabIndex={0}>
              <div><dt>模型</dt><dd>{PROVIDER_LABELS[floatingSelected.provider]} / {floatingSelected.name}</dd></div>
              <div><dt>模型 ID</dt><dd>{floatingSelected.modelId}</dd></div>
              <div><dt>推理强度</dt><dd>{REASONING_LABELS[settings.floatingTranslation!.reasoningEffort]}</dd></div>
              <div><dt>目标语言</dt><dd>{SCREEN_TRANSLATION_LANGUAGES.find(item => item.value === (settings.floatingTranslation?.target ?? 'auto'))?.label}</dd></div>
            </dl>
          ) : <button className="large-model-unconfigured-link" onClick={onManage} type="button">尚未配置</button>}
        </div>
        <div aria-label="AI 对话" className="large-model-feature-row" role="group">
          <div className="large-model-feature-heading">
            <h3>AI 对话</h3>
            {aiConversationSelected && <ConnectionStatus status={aiConversationSelected.status} />}
          </div>
          {aiConversationSelected ? (
            <dl
              aria-label="当前 AI 对话模型"
              data-ui-selectable="true"
              role="group"
              tabIndex={0}
            >
              <div>
                <dt>模型</dt>
                <dd>{PROVIDER_LABELS[aiConversationSelected.provider]} / {aiConversationSelected.name}</dd>
              </div>
              <div>
                <dt>模型 ID</dt>
                <dd>{aiConversationSelected.modelId}</dd>
              </div>
              <div>
                <dt>推理强度</dt>
                <dd>{REASONING_LABELS[settings.aiConversation.reasoningEffort]}</dd>
              </div>
            </dl>
          ) : (
            <button
              className="large-model-unconfigured-link"
              onClick={onManage}
              type="button"
            >
              尚未配置
            </button>
          )}
        </div>
      </div>
      <button className="large-model-primary-action" onClick={onManage} type="button">
        管理大模型
      </button>
    </section>
  )
}
