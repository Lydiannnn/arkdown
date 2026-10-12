import { DEFAULT_FLOATING_TRANSLATION_SETTINGS, featureModelConnections, type FloatingTranslationSettings } from '../../shared/large-model-settings'
import { ModelRulesSettings } from './ModelRulesSettings'
import { areModelRulesReady, useModelRulesReady, useModelRulesRevision } from './model-rules-runtime'
import { resolveModelThinkingCapability, translationThinkingPreference, modelThinkingControlState } from '../../shared/model-thinking'
import { useRef, useState, useSyncExternalStore } from 'react'
import { CodexCliLoginPanel } from './CodexCliLoginPanel'
import { CheckCircle, WarningCircle } from '@phosphor-icons/react'
import { AppIcon } from '../icons/AppIcon'
import type { ArkdownApi } from '../../shared/contracts'
import type { ApiResult } from '../../shared/contracts'
import type { ModelFeatureName, ModelFeaturePatches } from '../../shared/model-settings-commands'
import type { PublicModelMutationResult, PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import type { ModelPreferenceDraft } from './model-preference-draft'
import type {
  CodexCliConnectionStatus,
  LargeModelSettings,
  ModelConnectionSummary,
  ReasoningEffort,
  TargetLanguage,
  ThinkingMode,
} from '../../shared/large-model-settings'
import {
  normalizeReasoningEffort,
} from '../../shared/model-provider-presets'
import { AddModelDialog } from './AddModelDialog'
import { PreferencesSelect } from './PreferencesSelect'
import { SCREEN_TRANSLATION_LANGUAGES } from '../../shared/screen-translation'
import {
  PROTOCOL_LABELS,
  PROVIDER_LABELS,
  REASONING_LABELS,
  STATUS_LABELS,
  TARGET_LANGUAGE_OPTIONS,
} from './LargeModelSettingsSection'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'

interface ModelManagerPageProps {
  settings: LargeModelSettings
  modelPreferences: ModelPreferenceDraft
  connectModel: ArkdownApi['connectModel']
  listModels?: ArkdownApi['listModels']
  testModel: ArkdownApi['testModel']
  deleteModel: ArkdownApi['deleteModel']
  testCodexCliConnection: ArkdownApi['testCodexCliConnection']
  removeCodexCliConnection: ArkdownApi['removeCodexCliConnection']
  setSelectionTranslationSettings: ArkdownApi['setSelectionTranslationSettings']
  setAiConversationSettings: ArkdownApi['setAiConversationSettings']
  setScreenshotTranslationSettings: ArkdownApi['setScreenshotTranslationSettings']
  setFloatingTranslationSettings: ArkdownApi['setFloatingTranslationSettings']
  onMutationChange?(pending: boolean): void
  onSettingsChange(settings: LargeModelSettings): void
}

const NO_REASONING_EFFORTS: readonly ReasoningEffort[] = ['default']
const THINKING_OPTIONS = [
  { value: 'default' as const, label: '提供商默认' },
  { value: 'enabled' as const, label: '开启' },
  { value: 'disabled' as const, label: '关闭' },
]

const CODEX_CLI_STATUS_LABELS: Record<CodexCliConnectionStatus, string> = {
  connected: '连接正常',
  'not-found': '未找到 CLI',
  'launch-failed': '启动失败',
  'not-logged-in': '尚未登录',
  timeout: '连接超时',
  'incompatible-response': '响应不兼容',
}

const CODEX_CLI_STATUS_MESSAGES: Record<Exclude<CodexCliConnectionStatus, 'connected'>, string> = {
  'not-found': 'Codex 组件尚未就绪，请重新检测以完成安装。',
  'launch-failed': 'Codex CLI 无法启动，请先在终端确认它能够正常运行。',
  'not-logged-in': 'Codex CLI 尚未使用具备套餐的 ChatGPT 账号登录。',
  timeout: 'Codex CLI 连接检测超时，请确认 CLI 能够正常运行后重试。',
  'incompatible-response': 'Codex CLI 返回了不兼容的响应，请更新后重试。',
}

function formatTestTime(value: string | null): string {
  if (value === null) return '尚未测试'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : value
}

export function ModelManagerPage({
  settings,
  modelPreferences,
  connectModel,
  listModels,
  testModel,
  deleteModel,
  testCodexCliConnection,
  removeCodexCliConnection,
  setSelectionTranslationSettings,
  setAiConversationSettings,
  setScreenshotTranslationSettings,
  setFloatingTranslationSettings,
  onMutationChange,
  onSettingsChange,
}: ModelManagerPageProps) {
  useModelRulesRevision()
  const modelRulesReady = useModelRulesReady()
  const businessDialogs = useOptionalBusinessDialog()
  const saved = useSyncExternalStore(modelPreferences.subscribe, modelPreferences.getSnapshot)
  const current = saved.settings ?? settings
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpanded = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const currentRef = useRef(current)
  currentRef.current = current
  const dialog = saved.dialog
  const completedDialogKey = useRef<string | undefined>(undefined)
  const [codexLoginPending, setCodexLoginPending] = useState(false)
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null)
  const [localMutating, setIsMutating] = useState(false)
  const isMutating = localMutating || saved.pendingKeys.length > 0 || saved.loading || !saved.observed
  const mutationLockedRef = useRef(false)
  const connectionRequestPendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const publish = (next: LargeModelSettings) => {
    currentRef.current = next
    onSettingsChange(next)
  }

  const beginMutation = (connectionId: string | null = null): boolean => {
    if (!areModelRulesReady() || mutationLockedRef.current || !saved.observed) return false
    mutationLockedRef.current = true
    setBusyConnectionId(connectionId)
    setIsMutating(true)
    onMutationChange?.(true)
    return true
  }

  const endMutation = () => {
    mutationLockedRef.current = false
    setBusyConnectionId(null)
    setIsMutating(false)
    onMutationChange?.(false)
  }

  const acknowledge = (result: ApiResult<PublicModelMutationResult>): boolean => {
    if (!result.ok) { setError(result.error.message); return false }
    publish(result.value.snapshot.settings)
    if (result.value.status === 'conflict') { setError('大模型设置已在其他窗口更改。你的修改仍保留，请重新加载后再调整。'); return false }
    return true
  }
  const saveFeature = async <F extends ModelFeatureName>(feature: F, patch: ModelFeaturePatches[F],
    write: (patch: ModelFeaturePatches[F], observed: PublicModelSettingsSnapshot) => Promise<ApiResult<PublicModelMutationResult>>) => {
    const observed = saved.observed
    if (!observed || !beginMutation()) return
    setError(null)
    try {
      const field = Object.hasOwn(patch, 'connectionId') ? 'connectionId' : Object.keys(patch)[0]
      if (!field) return
      acknowledge(await modelPreferences.mutate(`feature.${feature}.${field}`, observed,
        original => write(patch, original), { feature, patch }))
    } finally { endMutation() }
  }

  const selected = featureModelConnections(current).find(
    (connection) => connection.id === current.selectionTranslation.connectionId,
  )
  const selectionReasoningEfforts = selected
    ? ['default' as const, ...modelThinkingControlState(selected, current.selectionTranslation).efforts]
    : NO_REASONING_EFFORTS
  const reasoningSupported = selectionReasoningEfforts.some((effort) => effort !== 'default')
  const showUnassignedPrompt = current.selectionTranslation.connectionId === null
    && featureModelConnections(current).some(({ status }) => status === 'connected')
  const screenshotSelected = featureModelConnections(current).find(
    (connection) => connection.id === current.screenshotTranslation.connectionId,
  )
  const screenshotReasoningEfforts = screenshotSelected
    ? ['default' as const, ...modelThinkingControlState(screenshotSelected, current.screenshotTranslation).efforts]
    : NO_REASONING_EFFORTS
  const screenshotReasoningSupported = screenshotReasoningEfforts.some((effort) => effort !== 'default')
  const showScreenshotUnassignedPrompt = current.screenshotTranslation.connectionId === null
    && featureModelConnections(current).some(({ status }) => status === 'connected')
  const aiConversationSelected = featureModelConnections(current).find(
    (connection) => connection.id === current.aiConversation.connectionId,
  )
  const floating = current.floatingTranslation ?? DEFAULT_FLOATING_TRANSLATION_SETTINGS
  const floatingSelected = featureModelConnections(current).find(item => item.id === floating.connectionId)
  const showFloatingUnassignedPrompt = floating.connectionId === null
    && featureModelConnections(current).some(({ status }) => status === 'connected')
  const saveFloating = (patch: Partial<FloatingTranslationSettings>) => saveFeature('floatingTranslation', patch, setFloatingTranslationSettings)
  const aiConversationReasoningEfforts = aiConversationSelected
    ? ['default' as const, ...modelThinkingControlState(aiConversationSelected, current.aiConversation).efforts]
    : NO_REASONING_EFFORTS
  const aiConversationReasoningSupported = aiConversationReasoningEfforts
    .some((effort) => effort !== 'default')
  const showAiConversationUnassignedPrompt = current.aiConversation.connectionId === null
    && featureModelConnections(current).some(({ status }) => status === 'connected')

  const saveSelection = (patch: ModelFeaturePatches['selectionTranslation']) => saveFeature('selectionTranslation', patch, setSelectionTranslationSettings)

  const connected = async (nextSettings: LargeModelSettings) => {
    const connectionId = dialog?.connection?.id ?? null
    const ownsMutation = !connectionRequestPendingRef.current
    if (ownsMutation && !beginMutation(connectionId)) return false
    setError(null)
    try {
      publish(nextSettings)
    } catch {
      setError('操作未能完成')
    } finally {
      if (ownsMutation) endMutation()
    }
    return true
  }

  const setConnectionRequestPending = (pending: boolean) => {
    if (pending) {
      if (!beginMutation(dialog?.connection?.id ?? null)) return
      connectionRequestPendingRef.current = true
      return
    }
    if (!connectionRequestPendingRef.current) return
    connectionRequestPendingRef.current = false
    endMutation()
  }

  const saveScreenshot = (patch: ModelFeaturePatches['screenshotTranslation']) => saveFeature('screenshotTranslation', patch, setScreenshotTranslationSettings)
  const saveAiConversation = (patch: ModelFeaturePatches['aiConversation']) => saveFeature('aiConversation', patch, setAiConversationSettings)

  const runTest = async (connectionId: string) => {
    const observed = saved.observed
    if (!observed || !beginMutation(connectionId)) return
    setError(null)
    try {
      const result = await modelPreferences.perform(`test.${connectionId}`, observed,
        original => testModel(connectionId, original), value => value.mutation)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      acknowledge({ ok: true, value: result.value.mutation })
      if (result.value.error) setError(result.value.error)
    } catch {
      setError('操作未能完成')
    } finally {
      endMutation()
    }
  }

  const remove = async (connection: ModelConnectionSummary) => {
    const observed = saved.observed
    if (!observed || !beginMutation(connection.id)) return
    const inTranslation = currentRef.current.selectionTranslation.connectionId === connection.id
      || currentRef.current.screenshotTranslation.connectionId === connection.id
      || currentRef.current.floatingTranslation?.connectionId === connection.id
    const inAiConversation = currentRef.current.aiConversation.connectionId === connection.id
    if (inTranslation || inAiConversation) {
      if (!businessDialogs) {
        setError('确认弹窗暂不可用')
        endMutation()
        return
      }
      const usageDescription = inTranslation && inAiConversation
        ? '该大模型正在被翻译功能和 AI 对话使用。删除后将解除功能绑定，确定删除吗？'
        : inTranslation
          ? '该大模型正在被翻译功能使用。删除后将解除功能绑定，确定删除吗？'
          : '该大模型正在被 AI 对话使用。删除后将解除功能绑定，确定删除吗？'
      const confirmation = await businessDialogs.confirm({
        title: '删除正在使用的大模型',
        description: usageDescription,
        confirmLabel: '删除',
        cancelLabel: '取消',
        tone: 'danger',
      })
      if (confirmation !== 'confirm') {
        endMutation()
        return
      }
    }

    setError(null)
    try {
      acknowledge(await modelPreferences.mutate(`delete.${connection.id}`, observed, original => deleteModel(connection.id, original)))
    } catch {
      setError('操作未能完成')
    } finally {
      endMutation()
    }
  }

  const runCodexCliTest = async () => {
    const observed = saved.observed
    if (!observed || !beginMutation('codex-cli')) return
    setError(null)
    try {
      const result = await modelPreferences.perform('codex.test', observed, testCodexCliConnection, value => value.mutation)
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (!acknowledge({ ok: true, value: result.value.mutation })) return
      if (result.value.status && result.value.status !== 'connected' && result.value.status !== 'not-logged-in') {
        const message = CODEX_CLI_STATUS_MESSAGES[result.value.status]
        if (businessDialogs) await businessDialogs.alert({ title: message })
        else setError(message)
      }
    } catch {
      setError('操作未能完成')
    } finally {
      endMutation()
    }
  }

  const removeCodexCli = async () => {
    const observed = saved.observed
    if (!observed || !beginMutation('codex-cli')) return
    if (!businessDialogs) {
      setError('确认弹窗暂不可用')
      endMutation()
      return
    }
    const confirmation = await businessDialogs.confirm({
      title: '移除 Codex CLI',
      description: '移除后将不再保留 Codex CLI 的连接检测结果，确定移除吗？',
      confirmLabel: '移除',
      cancelLabel: '取消',
      tone: 'danger',
    })
    if (confirmation !== 'confirm') {
      endMutation()
      return
    }
    setError(null)
    try {
      acknowledge(await modelPreferences.mutate('codex.remove', observed, removeCodexCliConnection))
    } catch {
      setError('操作未能完成')
    } finally {
      endMutation()
    }
  }

  return (
    <div className="large-model-manager">
      <div className="large-model-manager-heading">
        <h1 id="preferences-large-model-manager">管理大模型</h1>
        <p>连接大模型服务，并设置各项功能使用的模型。</p>
      </div>

      {(error || saved.error) && (
        <p
          className="preferences-error large-model-public-error"
          data-ui-selectable="true"
          role="alert"
          tabIndex={0}
        >
          {[...new Set([error, saved.error].filter(Boolean))].join(' ')}
        </p>
      )}
      {(saved.error || saved.failedKeys.length > 0) && <button type="button" disabled={isMutating}
        onClick={() => { setError(null); void modelPreferences.reload(window.arkdown).then(() => {
          const snapshot = modelPreferences.getSnapshot().observed
          if (snapshot) publish(snapshot.settings)
        }) }}>重新加载大模型设置</button>}

      {featureModelConnections(current).length > 0 &&
      <section aria-labelledby="large-model-features-heading" className="preferences-section">
        <h2 id="large-model-features-heading">功能应用</h2>
        <div
          aria-labelledby="large-model-assignment-heading"
          className="large-model-assignment"
          role="group"
        >
          <h3 id="large-model-assignment-heading">划词翻译配置</h3>
          <div className="large-model-assignment-controls">
            <div className={`preferences-field${showUnassignedPrompt ? ' large-model-unassigned-prompt' : ''}`}>
              <span>使用模型</span>
              <PreferencesSelect<string>
                disabled={isMutating || !modelRulesReady}
                label="划词翻译模型"
                onChange={(connectionValue) => {
                  const connectionId = connectionValue || null
                  const next = featureModelConnections(current).find(
                    (candidate) => candidate.id === connectionId,
                  )
                  void saveSelection({ connectionId, ...translationThinkingPreference(next) })
                }}
                options={[
                  { value: '', label: '不使用大模型' },
                  ...featureModelConnections(current).map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                  })),
                ]}
                value={current.selectionTranslation.connectionId ?? ''}
              />
            </div>
            {selected && resolveModelThinkingCapability(selected).thinking === 'toggle' && (
              <div className="preferences-field">
                <span>思考模式</span>
                <PreferencesSelect<ThinkingMode>
                  disabled={isMutating || !modelRulesReady}
                  label="划词翻译思考模式"
                  onChange={(thinkingMode) => void saveSelection({ thinkingMode })}
                  options={THINKING_OPTIONS}
                  value={current.selectionTranslation.thinkingMode}
                />
              </div>
            )}
            {reasoningSupported && (
              <div className="preferences-field">
                <span>推理强度</span>
                <PreferencesSelect<ReasoningEffort>
                  disabled={isMutating || !modelRulesReady}
                  label="推理强度"
                  onChange={(reasoningEffort) => void saveSelection({ reasoningEffort })}
                  options={selectionReasoningEfforts.map((value) => ({
                    value,
                    label: REASONING_LABELS[value],
                  }))}
                  value={selected ? modelThinkingControlState(selected, current.selectionTranslation).value : current.selectionTranslation.reasoningEffort}
                />
              </div>
            )}
            <div className="preferences-field">
              <span>目标语言</span>
              <PreferencesSelect<TargetLanguage>
                disabled={isMutating || !modelRulesReady}
                label="目标语言"
                onChange={(targetLanguage) => void saveSelection({ targetLanguage })}
                options={TARGET_LANGUAGE_OPTIONS}
                value={current.selectionTranslation.targetLanguage}
              />
            </div>
          </div>
        </div>
        <div
          aria-labelledby="large-model-screenshot-assignment-heading"
          className="large-model-assignment"
          role="group"
        >
          <h3 id="large-model-screenshot-assignment-heading">截图翻译配置</h3>
          <div className="large-model-assignment-controls">
            <div className={`preferences-field${showScreenshotUnassignedPrompt ? ' large-model-unassigned-prompt' : ''}`}>
              <span>使用模型</span>
              <PreferencesSelect<string>
                disabled={isMutating || !modelRulesReady}
                label="截图翻译模型"
                onChange={(connectionValue) => {
                  const connectionId = connectionValue || null
                  const next = featureModelConnections(current).find(
                    (candidate) => candidate.id === connectionId,
                  )
                  void saveScreenshot({ connectionId, ...translationThinkingPreference(next) })
                }}
                options={[
                  { value: '', label: '不使用大模型' },
                  ...featureModelConnections(current).map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                  })),
                ]}
                value={current.screenshotTranslation.connectionId ?? ''}
              />
            </div>
            {screenshotSelected && resolveModelThinkingCapability(screenshotSelected).thinking === 'toggle' && (
              <div className="preferences-field">
                <span>思考模式</span>
                <PreferencesSelect<ThinkingMode>
                  disabled={isMutating || !modelRulesReady}
                  label="截图翻译思考模式"
                  onChange={(thinkingMode) => void saveScreenshot({ thinkingMode })}
                  options={THINKING_OPTIONS}
                  value={current.screenshotTranslation.thinkingMode}
                />
              </div>
            )}
            {screenshotReasoningSupported && (
              <div className="preferences-field">
                <span>推理强度</span>
                <PreferencesSelect<ReasoningEffort>
                  disabled={isMutating || !modelRulesReady}
                  label="截图翻译推理强度"
                  onChange={(reasoningEffort) => void saveScreenshot({ reasoningEffort })}
                  options={screenshotReasoningEfforts.map((value) => ({
                    value,
                    label: REASONING_LABELS[value],
                  }))}
                  value={screenshotSelected ? modelThinkingControlState(screenshotSelected, current.screenshotTranslation).value : current.screenshotTranslation.reasoningEffort}
                />
              </div>
            )}
            <div className="preferences-field">
              <span>目标语言</span>
              <PreferencesSelect<TargetLanguage>
                disabled={isMutating || !modelRulesReady}
                label="截图翻译目标语言"
                onChange={(targetLanguage) => void saveScreenshot({ targetLanguage })}
                options={TARGET_LANGUAGE_OPTIONS}
                value={current.screenshotTranslation.targetLanguage}
              />
            </div>
          </div>
        </div>
        <div
          aria-labelledby="large-model-floating-assignment-heading"
          className="large-model-assignment"
          role="group"
        >
          <h3 id="large-model-floating-assignment-heading">悬浮翻译窗配置</h3>
          <div className="large-model-assignment-controls">
            <div className={`preferences-field${showFloatingUnassignedPrompt ? ' large-model-unassigned-prompt' : ''}`}>
              <span>使用模型</span>
              <PreferencesSelect<string> disabled={isMutating || !modelRulesReady} label="悬浮翻译窗模型"
                value={floating.connectionId ?? ''}
                options={[{ value: '', label: '不使用大模型' }, ...featureModelConnections(current).map(item => ({ value: item.id, label: item.name }))]}
                onChange={value => void saveFloating({ connectionId: value || null,
                  ...translationThinkingPreference(featureModelConnections(current).find(item => item.id === value)) })} />
            </div>
            {floatingSelected && resolveModelThinkingCapability(floatingSelected).thinking === 'toggle' && (
              <div className="preferences-field">
                <span>思考模式</span>
                <PreferencesSelect<ThinkingMode> disabled={isMutating || !modelRulesReady} label="悬浮翻译窗思考模式"
                  value={floating.thinkingMode} options={THINKING_OPTIONS}
                  onChange={thinkingMode => void saveFloating({ thinkingMode })} />
              </div>
            )}
            <div className="preferences-field">
              <span>目标语言</span>
              <PreferencesSelect<string> disabled={isMutating || !modelRulesReady} label="悬浮翻译窗目标语言"
                value={floating.target ?? 'auto'} options={SCREEN_TRANSLATION_LANGUAGES}
                onChange={target => void saveFloating({ target })} />
            </div>
          </div>
          <p>模型与目标语言会同步到悬浮翻译窗。</p>
        </div>
        <div
          aria-labelledby="large-model-ai-conversation-assignment-heading"
          className="large-model-assignment"
          role="group"
        >
          <h3 id="large-model-ai-conversation-assignment-heading">AI 对话配置</h3>
          <div className="large-model-assignment-controls is-ai-conversation">
            <div className={`preferences-field${showAiConversationUnassignedPrompt ? ' large-model-unassigned-prompt' : ''}`}>
              <span>使用模型</span>
              <PreferencesSelect<string>
                disabled={isMutating || !modelRulesReady}
                label="AI 对话模型"
                onChange={(connectionValue) => {
                  const connectionId = connectionValue || null
                  const next = featureModelConnections(current).find(
                    (candidate) => candidate.id === connectionId,
                  )
                  void saveAiConversation({ connectionId, reasoningEffort: next ? normalizeReasoningEffort(next,
                    current.aiConversation.reasoningEffort) : 'default' })
                }}
                options={[
                  { value: '', label: '不使用大模型' },
                  ...featureModelConnections(current).map((connection) => ({
                    value: connection.id,
                    label: connection.name,
                  })),
                ]}
                value={current.aiConversation.connectionId ?? ''}
              />
            </div>
            {aiConversationSelected && resolveModelThinkingCapability(aiConversationSelected).thinking === 'toggle' && (
              <div className="preferences-field">
                <span>思考模式</span>
                <PreferencesSelect<ThinkingMode>
                  disabled={isMutating || !modelRulesReady}
                  label="AI 对话思考模式"
                  onChange={(thinkingMode) => void saveAiConversation({ thinkingMode })}
                  options={THINKING_OPTIONS}
                  value={current.aiConversation.thinkingMode}
                />
              </div>
            )}
            {aiConversationReasoningSupported && (
              <div className="preferences-field">
                <span>推理强度</span>
                <PreferencesSelect<ReasoningEffort>
                  disabled={isMutating || !modelRulesReady}
                  label="AI 对话推理强度"
                  onChange={(reasoningEffort) => void saveAiConversation({ reasoningEffort })}
                  options={aiConversationReasoningEfforts.map((value) => ({
                    value,
                    label: REASONING_LABELS[value],
                  }))}
                  value={aiConversationSelected ? modelThinkingControlState(aiConversationSelected, current.aiConversation).value : current.aiConversation.reasoningEffort}
                />
              </div>
            )}
          </div>
        </div>
      </section>
      }

      <section aria-labelledby="large-model-connections-heading" className="preferences-section">
        <div className="large-model-connections-heading">
          <div>
            <h2 id="large-model-connections-heading">已添加的大模型</h2>
            <p>连接操作会立即保存并测试当前配置。</p>
          </div>
          <button
            className="large-model-primary-action"
            disabled={isMutating || !modelRulesReady}
            onClick={() => modelPreferences.openDialog()}
            type="button"
          >
            添加大模型
          </button>
        </div>
        {current.codexCli && (
          <div className="large-model-card-list large-model-codex-cli-card-list">
            <article aria-label="Codex CLI" className="large-model-card large-model-codex-cli-card">
              <div className="large-model-card-title">
                <h3 aria-label="Codex CLI" data-ui-selectable="true">
                  <button aria-label="Codex CLI详情" aria-expanded={expanded.has('codex-cli')}
                    className="large-model-card-disclosure" onClick={() => toggleExpanded('codex-cli')} type="button">
                    <span className="large-model-card-name">Codex CLI</span>
                    <span className={`large-model-status is-${current.codexCli.status}`} data-ui-selectable="true">
                      {current.codexCli.status === 'connected' ? (
                        <CheckCircle aria-hidden="true" className="large-model-status-icon" size={15} weight="fill" />
                      ) : (
                        <WarningCircle aria-hidden="true" className="large-model-status-icon" size={15} weight="fill" />
                      )}
                      {CODEX_CLI_STATUS_LABELS[current.codexCli.status]}
                    </span>
                    <AppIcon className="large-model-card-caret" name="next" size={16} />
                  </button>
                </h3>
              </div>
              {expanded.has('codex-cli') && <div className="large-model-card-details"><div>
              <dl aria-label="Codex CLI 连接详情" data-ui-selectable="true" role="group" tabIndex={0}>
                <div><dt>CLI 版本</dt><dd data-ui-selectable="true">{current.codexCli.cliVersion}</dd></div>
                <div><dt>最近检测</dt><dd data-ui-selectable="true">{formatTestTime(current.codexCli.lastTestedAt)}</dd></div>
                {(current.codexCli.models ?? []).map(model => <div key={model.modelId}>
                  <dt>{model.displayName}{model.unavailable ? '（暂不可用）' : ''}</dt>
                  <dd data-ui-selectable="true">{model.supportedReasoningEfforts.map(effort => REASONING_LABELS[effort]).join(' · ') || '默认'}</dd>
                </div>)}
              </dl>
              <p className="preferences-description">在上方功能分配中选择具体模型与推理强度。重新检测会更新本机 CLI 提供的模型列表。</p>
              {(current.codexCli.status === 'not-logged-in' || codexLoginPending) && saved.observed && <CodexCliLoginPanel disabled={isMutating || !modelRulesReady}
                observed={saved.observed}
                startLogin={original => modelPreferences.perform('codex.login', original,
                  snapshot => window.arkdown.startCodexCliLogin!(snapshot), value => value.status === 'completed' ? value.connection.mutation : undefined)}
                onPendingChange={pending => { setCodexLoginPending(pending); if (pending) beginMutation('codex-cli'); else endMutation() }}
                onConnected={publish} />}
              <div className="large-model-card-actions">
                <button
                  disabled={isMutating || !modelRulesReady}
                  onClick={() => void runCodexCliTest()}
                  type="button"
                >
                  {busyConnectionId === 'codex-cli' ? '检测中…' : '重新检测'}
                </button>
                <button
                  disabled={isMutating || !modelRulesReady}
                  onClick={() => void removeCodexCli()}
                  type="button"
                >移除</button>
              </div>
              </div></div>}
            </article>
          </div>
        )}
        {current.connections.length === 0 ? (
          <p className="large-model-empty-state">暂未接入大模型，点击开始添加</p>
        ) : (
          <div className="large-model-card-list">
            {current.connections.map((connection) => (
              <article
                aria-label={connection.name}
                className="large-model-card"
                key={connection.id}
              >
                <div
                  aria-label={`${connection.name}状态`}
                  className="large-model-card-title"
                  data-ui-selectable="true"
                  role="group"
                  tabIndex={0}
                >
                  <h3 aria-label={connection.name} data-ui-selectable="true">
                    <button aria-label={`${connection.name}详情`} aria-expanded={expanded.has(connection.id)}
                      className="large-model-card-disclosure" onClick={() => toggleExpanded(connection.id)} type="button">
                      <span className="large-model-card-name">{connection.name}</span>
                      <span className={`large-model-status is-${connection.status}`} data-ui-selectable="true">
                        {connection.status === 'connected' ? (
                          <CheckCircle aria-hidden="true" className="large-model-status-icon" size={15} weight="fill" />
                        ) : (
                          <WarningCircle aria-hidden="true" className="large-model-status-icon" size={15} weight="fill" />
                        )}
                        {STATUS_LABELS[connection.status]}
                      </span>
                      <AppIcon className="large-model-card-caret" name="next" size={16} />
                    </button>
                  </h3>
                </div>
                {expanded.has(connection.id) && <div className="large-model-card-details"><div>
                <dl
                  aria-label={`${connection.name}连接详情`}
                  data-ui-selectable="true"
                  role="group"
                  tabIndex={0}
                >
                  <div><dt>服务商</dt><dd data-ui-selectable="true">{PROVIDER_LABELS[connection.provider]}</dd></div>
                  <div><dt>模型 ID</dt><dd data-ui-selectable="true">{connection.modelId}</dd></div>
                  <div><dt>接口协议</dt><dd data-ui-selectable="true">{PROTOCOL_LABELS[connection.protocol]}</dd></div>
                  <div><dt>API Key</dt><dd data-ui-selectable="true">{connection.apiKeyHint}</dd></div>
                  <div className="large-model-card-wide">
                    <dt>Base URL</dt><dd data-ui-selectable="true">{connection.baseUrl}</dd>
                  </div>
                  <div className="large-model-card-wide">
                    <dt>最近检测</dt><dd data-ui-selectable="true">{formatTestTime(connection.lastTestedAt)}</dd>
                  </div>
                </dl>
                <div className="large-model-card-actions">
                  <button
                    disabled={isMutating || !modelRulesReady}
                    onClick={() => void runTest(connection.id)}
                    type="button"
                  >
                    {busyConnectionId === connection.id ? '测试中…' : '测试'}
                  </button>
                  <button
                    disabled={isMutating || !modelRulesReady}
                    onClick={() => modelPreferences.openDialog(connection.id)}
                    type="button"
                  >
                    编辑
                  </button>
                  <button
                    disabled={isMutating || !modelRulesReady}
                    onClick={() => void remove(connection)}
                    type="button"
                  >
                    删除
                  </button>
                </div>
                </div></div>}
              </article>
            ))}
          </div>
        )}
      </section>

      <ModelRulesSettings disabled={isMutating || Boolean(dialog)} />

      {dialog && (
        <AddModelDialog
          key={dialog.key}
          connection={dialog.connection}
          observed={dialog.observed}
          codexObserved={dialog.codexObserved}
          initialFields={dialog.fields}
          onFieldsChange={fields => modelPreferences.updateDialogFields(fields)}
          onObserved={snapshot => modelPreferences.accept(snapshot)}
          onCodexObserved={snapshot => modelPreferences.updateDialogCodexObservation(snapshot)}
          connectModel={(input, observed) => modelPreferences.mutate(`connect.${dialog.key}`, observed, original => connectModel(input, original))}
          listModels={listModels}
          testCodexCliConnection={observed => modelPreferences.perform('codex.test', observed, testCodexCliConnection, value => value.mutation)}
          startCodexCliLogin={observed => modelPreferences.perform('codex.login', observed,
            original => window.arkdown.startCodexCliLogin!(original), value => value.status === 'completed' ? value.connection.mutation : undefined)}
          onCancel={() => {
            if (completedDialogKey.current === dialog.key) modelPreferences.finishDialog()
            else modelPreferences.hideDialog()
            completedDialogKey.current = undefined
          }}
          onConnectionPendingChange={setConnectionRequestPending}
          onConnected={async settings => { const accepted = await connected(settings); if (accepted) completedDialogKey.current = dialog.key; return accepted }}
        />
      )}
    </div>
  )
}
