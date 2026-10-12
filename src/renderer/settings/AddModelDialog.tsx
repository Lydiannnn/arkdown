import { ManualModelThinkingFields } from './ManualModelThinkingFields'
import { CodexCliLoginPanel } from './CodexCliLoginPanel'
import { resolveModelThinkingCapability } from '../../shared/model-thinking'
import { type ModelThinkingCapability } from '../../shared/model-capability-rules'
import { areModelRulesReady, useModelRulesReady, useModelRulesRevision } from './model-rules-runtime'
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { ArkdownApi } from '../../shared/contracts'
import type { PublicModelMutationResult, PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import type { ModelDialogFields } from './model-preference-draft'
import {
  isSafeModelBaseUrl,
  MODEL_BASE_URL_MAX_LENGTH,
  MODEL_CONNECTION_NAME_MAX_LENGTH,
  MODEL_ID_MAX_LENGTH,
  parseModelCapabilityOverride,
  type CodexCliConnectionStatus,
  type LargeModelSettings,
  type ModelCapabilityOverride,
  type ModelConnectionSummary,
  type ModelProtocol,
  type ModelProviderId,
} from '../../shared/large-model-settings'
import {
  MODEL_PROVIDER_PRESETS,
  providerPreset,
} from '../../shared/model-provider-presets'
import { resolveModelCapabilityProfile } from '../../shared/model-capability-profiles'
import { PROVIDER_LABELS, PROTOCOL_LABELS } from './LargeModelSettingsSection'
import { PreferencesSelect } from './PreferencesSelect'
import { mainAppPortalMarker } from '../app/ui-selection-guard'
import { ArkdownDialog, type ArkdownDialogControls } from '../modal/ArkdownDialog'
import { useOptionalContextMenu } from '../context-menu/ContextMenuProvider'
import { AppIcon } from '../icons/AppIcon'

interface AddModelDialogProps {
  connection?: ModelConnectionSummary
  observed: PublicModelSettingsSnapshot
  codexObserved?: PublicModelSettingsSnapshot
  initialFields?: Partial<ModelDialogFields>
  onFieldsChange?(fields: Partial<ModelDialogFields>): void
  onObserved?(snapshot: PublicModelSettingsSnapshot): void
  onCodexObserved?(snapshot: PublicModelSettingsSnapshot): void
  connectModel: ArkdownApi['connectModel']
  listModels?: ArkdownApi['listModels']
  testCodexCliConnection: ArkdownApi['testCodexCliConnection']
  startCodexCliLogin?: ArkdownApi['startCodexCliLogin']
  onCancel(): void
  onConnectionPendingChange?(pending: boolean): void
  onConnected(settings: LargeModelSettings): boolean | void | Promise<boolean | void>
}

type ModelAccessType = 'standard-api' | 'codex-cli'
type ModelField = 'baseUrl' | 'apiKey' | 'modelId' | 'name'
type ModelFieldErrors = Partial<Record<ModelField, string>>

const CODEX_CLI_STATUS_MESSAGES: Record<Exclude<CodexCliConnectionStatus, 'connected'>, string> = {
  'not-found': 'Codex 组件尚未就绪，请重新检测以完成安装。',
  'launch-failed': 'Codex CLI 无法启动，请先在终端确认它能够正常运行。',
  'not-logged-in': 'Codex CLI 尚未使用具备套餐的 ChatGPT 账号登录。',
  timeout: 'Codex CLI 连接检测超时，请确认 CLI 能够正常运行后重试。',
  'incompatible-response': 'Codex CLI 返回了不兼容的响应，请更新后重试。',
}

const fieldErrorIds: Record<ModelField, string> = {
  baseUrl: 'large-model-base-url-error',
  apiKey: 'large-model-api-key-error',
  modelId: 'large-model-model-id-error',
  name: 'large-model-name-error',
}

const helperIds = {
  baseUrl: 'large-model-base-url-helper',
  apiKey: 'large-model-api-key-helper',
  modelId: 'large-model-model-id-helper',
} as const

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(' ')
  return value || undefined
}

function FieldError({ field, message }: { field: ModelField; message?: string }) {
  if (!message) return null
  return (
    <p
      className="preferences-error large-model-field-error"
      data-ui-selectable="true"
      id={fieldErrorIds[field]}
      role="alert"
      tabIndex={0}
    >
      {message}
    </p>
  )
}

function serializeCapabilityOverride(
  contextWindowTokens: string,
  maxInputTokens: string,
  maxOutputTokens: string,
): ModelCapabilityOverride | null | undefined {
  const contextWindow = contextWindowTokens.trim()
  const maxInput = maxInputTokens.trim()
  const maxOutput = maxOutputTokens.trim()
  if (contextWindow === '' && maxInput === '' && maxOutput === '') return null
  const parsed = parseModelCapabilityOverride({
    contextWindowTokens: Number(contextWindow),
    ...(maxInput === '' ? {} : { maxInputTokens: Number(maxInput) }),
    ...(maxOutput === '' ? {} : { maxOutputTokens: Number(maxOutput) }),
  })
  return parsed
}

export function AddModelDialog({
  connection,
  observed,
  codexObserved,
  initialFields,
  onFieldsChange,
  onObserved,
  onCodexObserved,
  connectModel,
  listModels,
  testCodexCliConnection,
  startCodexCliLogin,
  onCancel,
  onConnectionPendingChange,
  onConnected,
}: AddModelDialogProps) {
  useModelRulesRevision()
  const modelRulesReady = useModelRulesReady()
  const contextMenu = useOptionalContextMenu()
  const originalObservation = useRef(structuredClone(observed))
  const [codexObservation, setCodexObservation] = useState(() => structuredClone(codexObserved ?? observed))
  const acceptCodexMutation = (mutation: PublicModelMutationResult) => {
    onObserved?.(mutation.snapshot)
    if (mutation.status === 'conflict') return
    // Advance only this dialog's acknowledged CLI work; API form edits retain their original snapshot.
    setCodexObservation(structuredClone(mutation.snapshot))
    onCodexObserved?.(mutation.snapshot)
  }
  const [manualThinking, setManualThinking] = useState<ModelThinkingCapability | undefined>(initialFields && Object.hasOwn(initialFields, 'manualThinking') ? initialFields.manualThinking : connection?.capabilityOverride?.thinking)
  const [accessType, setAccessType] = useState<ModelAccessType>(initialFields?.accessType ?? 'standard-api')
  const initialProvider = initialFields?.provider ?? connection?.provider ?? 'deepseek'
  const initialProtocol = initialFields?.protocol ?? connection?.protocol ?? 'openai'
  const [name, setName] = useState(initialFields?.name ?? connection?.name ?? '')
  const [nameSource, setNameSource] = useState<'automatic' | 'manual'>(
    initialFields?.nameSource ?? (connection ? 'manual' : 'automatic'),
  )
  const [provider, setProvider] = useState<ModelProviderId>(initialProvider)
  const [protocol, setProtocol] = useState<ModelProtocol>(initialProtocol)
  const [baseUrl, setBaseUrl] = useState(
    initialFields?.baseUrl ?? connection?.baseUrl
      ?? providerPreset(initialProvider).defaultBaseUrls[initialProtocol]
      ?? '',
  )
  const [baseUrlSource, setBaseUrlSource] = useState<'preset' | 'manual'>(
    initialFields?.baseUrlSource ?? (connection ? 'manual' : 'preset'),
  )
  const [modelId, setModelId] = useState(initialFields?.modelId ?? connection?.modelId ?? '')
  const [contextWindowTokens, setContextWindowTokens] = useState(
    initialFields?.contextWindowTokens ?? connection?.capabilityOverride?.contextWindowTokens?.toString() ?? '',
  )
  const [maxInputTokens, setMaxInputTokens] = useState(
    initialFields?.maxInputTokens ?? connection?.capabilityOverride?.maxInputTokens?.toString() ?? '',
  )
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    initialFields?.maxOutputTokens ?? connection?.capabilityOverride?.maxOutputTokens?.toString() ?? '',
  )
  const [modelOptions, setModelOptions] = useState<string[]>(initialFields?.modelOptions ?? [])
  const [modelEntryMode, setModelEntryMode] = useState<'manual' | 'catalog'>(initialFields?.modelEntryMode ?? 'manual')
  const [apiKey, setApiKey] = useState(initialFields?.apiKey ?? '')
  const [fieldErrors, setFieldErrors] = useState<ModelFieldErrors>({})
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [codexLoginRequired, setCodexLoginRequired] = useState(false)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const isConnectingRef = useRef(isConnecting)
  const isLoadingModelsRef = useRef(isLoadingModels)
  const modelCatalogGenerationRef = useRef(0)
  const modelLister = listModels ?? window.arkdown?.listModels
  useEffect(() => { onFieldsChange?.({ name, nameSource, provider, protocol, baseUrl, baseUrlSource, modelId, apiKey,
    accessType, contextWindowTokens, maxInputTokens, maxOutputTokens, manualThinking, modelEntryMode, modelOptions }) },
  [onFieldsChange, name, nameSource, provider, protocol, baseUrl, baseUrlSource, modelId, apiKey, accessType,
    contextWindowTokens, maxInputTokens, maxOutputTokens, manualThinking, modelEntryMode, modelOptions])
  const hasVerifiedPreset = Boolean(providerPreset(provider).defaultBaseUrls[protocol])
  const exactCapabilityProfile = resolveModelCapabilityProfile({
    provider,
    protocol,
    baseUrl: baseUrl.trim(),
    modelId: modelId.trim(),
    capabilityOverride: null,
  }, {
    requestedOutputTokens: 32_768,
    reasoningEffort: 'default',
  })
  const detectedThinking = resolveModelThinkingCapability({ provider, protocol, baseUrl: baseUrl.trim(), modelId: modelId.trim() })
  const numericOverride = exactCapabilityProfile ? null : serializeCapabilityOverride(contextWindowTokens, maxInputTokens, maxOutputTokens)
  const capabilityOverride = numericOverride === undefined ? undefined : manualThinking
    ? parseModelCapabilityOverride({ ...numericOverride, thinking: manualThinking })
    : numericOverride
  const capabilityOverrideError = capabilityOverride === undefined
  const canConnect = modelRulesReady && name.trim() !== ''
    && modelId.trim() !== ''
    && isSafeModelBaseUrl(baseUrl.trim())
    && (connection !== undefined || apiKey !== '')
    && !isConnecting
    && !isLoadingModels
    && !capabilityOverrideError
  const canLoadModels = Boolean(modelLister)
    && isSafeModelBaseUrl(baseUrl.trim())
    && (connection !== undefined || apiKey !== '')
    && !isConnecting
    && !isLoadingModels

  const clearFieldError = (field: ModelField) => {
    setFieldErrors((current) => {
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const openPasteMenu = (
    event: ReactMouseEvent<HTMLInputElement>,
    field: 'apiKey' | 'name',
  ) => {
    if (!contextMenu) return
    event.preventDefault()
    const input = event.currentTarget
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? start
    const maximumLength = field === 'name' ? MODEL_CONNECTION_NAME_MAX_LENGTH : undefined
    contextMenu.openMenu({
      x: event.clientX,
      y: event.clientY,
      items: [{
        kind: 'command',
        id: 'paste',
        label: '粘贴',
        icon: <AppIcon name="paste" />,
      }],
      execute: async (id) => {
        if (id !== 'paste') return
        try {
          if (window.arkdown?.executeApplicationMenuItem) {
            await window.arkdown.executeApplicationMenuItem('edit.paste')
            return
          }
          const clipboardText = await navigator.clipboard.readText()
          const candidate = `${input.value.slice(0, start)}${clipboardText}${input.value.slice(end)}`
          const next = maximumLength === undefined
            ? candidate
            : candidate.slice(0, maximumLength)
          if (field === 'apiKey') {
            modelCatalogGenerationRef.current += 1
            setApiKey(next)
          } else {
            setName(next)
            setNameSource(next.trim() === '' ? 'automatic' : 'manual')
          }
          clearFieldError(field)
          setConnectionError(null)
          requestAnimationFrame(() => {
            input.focus()
            const caret = Math.min(start + clipboardText.length, next.length)
            input.setSelectionRange(caret, caret)
          })
        } catch {
          // Clipboard access can be denied by the OS; leave the protected input unchanged.
        }
      },
      restoreFocus: () => input.focus({ preventScroll: true }),
      rootIconGutter: 'reserved',
      widthCssPx: 132,
    })
  }

  const validateField = (field: ModelField) => {
    let message: string | undefined
    if (field === 'baseUrl') {
      message = baseUrl.trim() === ''
        ? '请输入 Base URL。'
        : !isSafeModelBaseUrl(baseUrl.trim())
          ? 'Base URL 必须是 HTTPS，或使用本机回环地址。'
          : undefined
    } else if (field === 'apiKey') {
      message = connection === undefined && apiKey === '' ? '请输入 API Key。' : undefined
    } else if (field === 'modelId') {
      message = modelId.trim() === '' ? '请输入模型 ID。' : undefined
    } else {
      message = name.trim() === '' ? '请输入配置名称。' : undefined
    }

    setFieldErrors((current) => {
      if (message) return { ...current, [field]: message }
      if (!current[field]) return current
      const next = { ...current }
      delete next[field]
      return next
    })
  }

  const finishClose = (clearApiKey = true) => {
    if (clearApiKey) setApiKey('')
    setFieldErrors({})
    setConnectionError(null)
    onCancel()
  }

  const cancel = () => {
    if (isConnectingRef.current) return
    finishClose()
  }

  isConnectingRef.current = isConnecting
  isLoadingModelsRef.current = isLoadingModels

  const changeProvider = (nextProvider: ModelProviderId) => {
    modelCatalogGenerationRef.current += 1
    setProvider(nextProvider)
    setManualThinking(undefined)
    if (baseUrlSource === 'preset') {
      setBaseUrl(providerPreset(nextProvider).defaultBaseUrls[protocol] ?? '')
      clearFieldError('baseUrl')
    }
    setModelOptions([])
    setModelEntryMode('manual')
    setConnectionError(null)
  }

  const changeProtocol = (nextProtocol: ModelProtocol) => {
    modelCatalogGenerationRef.current += 1
    setProtocol(nextProtocol)
    setManualThinking(undefined)
    const verified = providerPreset(provider).defaultBaseUrls[nextProtocol]
    if (baseUrlSource === 'preset') {
      setBaseUrl(verified ?? '')
      clearFieldError('baseUrl')
    }
    setModelOptions([])
    setModelEntryMode('manual')
    setConnectionError(null)
  }

  const chooseModel = (nextModelId: string) => {
    if (nextModelId !== modelId) setManualThinking(undefined)
    setModelId(nextModelId)
    clearFieldError('modelId')
    setConnectionError(null)
    if (name.trim() === '' || nameSource === 'automatic') {
      setName(nextModelId)
      setNameSource('automatic')
      clearFieldError('name')
    }
  }

  const loadAvailableModels = async () => {
    if (!canLoadModels || !modelLister || isLoadingModelsRef.current) return
    const requestGeneration = ++modelCatalogGenerationRef.current
    isLoadingModelsRef.current = true
    setIsLoadingModels(true)
    setConnectionError(null)
    try {
      const result = await modelLister({
        ...(connection ? { id: connection.id } : {}),
        provider,
        protocol,
        baseUrl: baseUrl.trim(),
        ...(apiKey !== '' ? { apiKey } : {}),
      }, originalObservation.current)
      if (requestGeneration !== modelCatalogGenerationRef.current) return
      if (!result.ok) {
        setConnectionError(result.error.message)
        return
      }
      if (result.value.status === 'conflict') {
        onObserved?.(result.value.snapshot)
        setConnectionError('大模型设置已在其他窗口更改。你的输入仍保留，请重新加载后再调整。')
        return
      }
      setModelOptions(result.value.catalog.models)
      setModelEntryMode('catalog')
      const selected = result.value.catalog.models.includes(modelId) ? modelId : result.value.catalog.recommendedModelId ?? result.value.catalog.models[0]
      if (selected) chooseModel(selected)
    } catch {
      if (requestGeneration === modelCatalogGenerationRef.current) {
        setConnectionError('操作未能完成')
      }
    } finally {
      isLoadingModelsRef.current = false
      setIsLoadingModels(false)
    }
  }

  const submit = async (
    event: FormEvent,
    requestClose: ArkdownDialogControls['requestClose'],
  ) => {
    event.preventDefault()
    if (!areModelRulesReady()) return
    if (isLoggingIn || (accessType === 'standard-api' ? !canConnect : isConnecting) || isConnectingRef.current) return
    isConnectingRef.current = true
    setIsConnecting(true)
    onConnectionPendingChange?.(true)
    setConnectionError(null)
    let closeRequested = false
    try {
      if (accessType === 'codex-cli') {
        const result = await testCodexCliConnection(codexObservation)
        if (!result.ok) {
          setConnectionError(result.error.message)
          return
        }
        acceptCodexMutation(result.value.mutation)
        if (result.value.mutation.status === 'conflict') {
          setConnectionError('大模型设置已在其他窗口更改。你的输入仍保留，请重新加载后再调整。')
          return
        }
        if (result.value.status !== 'connected') {
          setCodexLoginRequired(result.value.status === 'not-logged-in')
          setConnectionError(result.value.status === 'not-logged-in' ? null : result.value.status ? CODEX_CLI_STATUS_MESSAGES[result.value.status] : '连接检测未完成。')
          return
        }
        const shouldClose = await onConnected(result.value.mutation.snapshot.settings)
        if (shouldClose !== false) {
          closeRequested = true
          requestClose(() => finishClose(false))
        }
        return
      }
      const result = await connectModel({
        ...(connection ? { id: connection.id } : {}),
        name: name.trim(),
        provider,
        accessType: 'standard-api',
        protocol,
        baseUrl: baseUrl.trim(),
        modelId: modelId.trim(),
        ...(apiKey !== '' ? { apiKey } : {}),
        ...(capabilityOverride === undefined ? {} : { capabilityOverride }),
      }, originalObservation.current)
      if (!result.ok) {
        setConnectionError(result.error.message)
        return
      }
      onObserved?.(result.value.snapshot)
      if (result.value.status === 'conflict') {
        setConnectionError('大模型设置已在其他窗口更改。你的输入仍保留，请重新加载后再调整。')
        return
      }
      setApiKey('')
      const shouldClose = await onConnected(result.value.snapshot.settings)
      if (shouldClose !== false) {
        closeRequested = true
        requestClose(finishClose)
      }
    } catch {
      setConnectionError('操作未能完成')
    } finally {
      onConnectionPendingChange?.(false)
      if (!closeRequested) {
        isConnectingRef.current = false
        setIsConnecting(false)
      }
    }
  }

  return (
    <ArkdownDialog
      actions={({ requestClose }) => <>
        <button
          disabled={isConnecting}
          onClick={() => requestClose(cancel)}
          type="button"
        >取消</button>
        <button
          className="arkdown-dialog__primary preferences-primary-action"
          disabled={isLoggingIn || (accessType === 'standard-api' ? !canConnect : isConnecting)}
          type="submit"
        >
          {isConnecting ? (accessType === 'codex-cli' ? '检测中…' : '连接中…') : (accessType === 'codex-cli' ? '检测连接' : '连接')}
        </button>
      </>}
      actionsClassName="preferences-actions"
      backdropClassName="large-model-modal-layer"
      backdropData={{
        'data-tooltip-layer': 'modal',
        ...(mainAppPortalMarker() ? { 'data-ui-selection-portal': 'true' } : {}),
      }}
      cancelOnBackdrop={!isConnecting}
      className="preferences-dialog large-model-dialog"
      error={connectionError}
      errorClassName="preferences-error large-model-public-error large-model-connection-error"
      errorData={{ 'data-ui-selectable': 'true' }}
      errorProps={{ tabIndex: 0 }}
      escapeEnabled={!isConnecting && !contextMenu?.isOpen}
      onCancel={cancel}
      onSubmit={(event, { requestClose }) => {
        void submit(event, requestClose)
      }}
      size="large"
      surface="form"
      title={connection ? '编辑大模型' : '添加大模型'}
    >
      {({ closing, requestClose }) => <>
          <div className="preferences-field">
            <span data-testid="model-field-label">服务商</span>
            <PreferencesSelect
              autoFocus
              label="服务商"
              disabled={isConnecting || isLoggingIn}
              onChange={(value: ModelProviderId | 'chatgpt') => {
                if (value === 'chatgpt') {
                  if (!connection) setAccessType('codex-cli')
                } else {
                  setAccessType('standard-api')
                  changeProvider(value)
                }
              }}
              options={MODEL_PROVIDER_PRESETS.flatMap((preset) => [
                ...(preset.id === 'other' && !connection ? [{ value: 'chatgpt' as const, label: 'ChatGPT' }] : []),
                {
                  value: preset.id,
                  label: PROVIDER_LABELS[preset.id],
                },
              ])}
              value={accessType === 'codex-cli' ? 'chatgpt' : provider}
            />
          </div>
          <div className="large-model-connection-kind-row">
            <div className="preferences-field">
              <span data-testid="model-field-label">接入类型</span>
              <PreferencesSelect
                disabled={connection !== undefined || isConnecting || isLoggingIn}
                label="接入类型"
                onChange={(nextAccessType) => setAccessType(nextAccessType as ModelAccessType)}
                options={[
                  { value: 'standard-api', label: '标准 API' },
                  { value: 'codex-cli', label: 'Codex CLI' },
                ]}
                value={accessType}
              />
            </div>
            {accessType === 'standard-api' && (
            <div className="preferences-field">
              <span data-testid="model-field-label">接口协议</span>
              <PreferencesSelect
                label="接口协议"
                onChange={changeProtocol}
                options={providerPreset(provider).protocols.map((candidate) => ({
                  value: candidate,
                  label: PROTOCOL_LABELS[candidate],
                }))}
                value={protocol}
              />
            </div>
            )}
          </div>
          {accessType === 'codex-cli' ? (
            <>
              <p className="large-model-codex-cli-explanation">
                检测连接时会准备 Codex 组件并读取模型列表。已有 ChatGPT 登录可直接复用，连接后可在功能分配中选择模型与推理强度。
              </p>
              {codexLoginRequired && !closing && <CodexCliLoginPanel disabled={isConnecting}
                observed={codexObservation} startLogin={startCodexCliLogin} onMutation={acceptCodexMutation} onPendingChange={pending => {
                setIsLoggingIn(pending)
                onConnectionPendingChange?.(pending)
              }} onConnected={async settings => {
                const shouldClose = await onConnected(settings)
                if (shouldClose !== false) requestClose(() => finishClose(false))
              }} />}
            </>
          ) : <>
          <div className="preferences-field">
            <span data-testid="model-field-label">Base URL</span>
            <input
              aria-describedby={describedBy(
                fieldErrors.baseUrl && fieldErrorIds.baseUrl,
                !hasVerifiedPreset && helperIds.baseUrl,
              )}
              aria-label="Base URL"
              maxLength={MODEL_BASE_URL_MAX_LENGTH}
              onChange={(event) => {
                modelCatalogGenerationRef.current += 1
                setBaseUrl(event.target.value)
                setBaseUrlSource('manual')
                setModelOptions([])
                setModelEntryMode('manual')
                clearFieldError('baseUrl')
                setConnectionError(null)
              }}
              onBlur={() => validateField('baseUrl')}
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              value={baseUrl}
            />
            <FieldError field="baseUrl" message={fieldErrors.baseUrl} />
            {!hasVerifiedPreset && (
              <small id={helperIds.baseUrl}>请手动输入经过确认的 Base URL。</small>
            )}
          </div>
          <div className="preferences-field">
            <span data-testid="model-field-label">API Key</span>
            <input
              aria-describedby={describedBy(
                fieldErrors.apiKey && fieldErrorIds.apiKey,
                connection !== undefined && helperIds.apiKey,
              )}
              aria-label="API Key"
              autoComplete="off"
              onContextMenu={(event) => openPasteMenu(event, 'apiKey')}
              onChange={(event) => {
                modelCatalogGenerationRef.current += 1
                setApiKey(event.target.value)
                clearFieldError('apiKey')
                setConnectionError(null)
              }}
              onBlur={() => validateField('apiKey')}
              placeholder={connection ? '留空以继续使用已保存密钥' : ''}
              type="password"
              value={apiKey}
            />
            <FieldError field="apiKey" message={fieldErrors.apiKey} />
            {connection && (
              <small id={helperIds.apiKey}>留空表示继续使用已加密保存的 API Key。</small>
            )}
          </div>
          <div className="preferences-field">
            <span data-testid="model-field-label">模型 ID</span>
            <div className="large-model-catalog-controls">
              {modelEntryMode === 'catalog' && modelOptions.length > 0 ? (
                <PreferencesSelect
                  ariaDescribedBy={describedBy(
                    fieldErrors.modelId && fieldErrorIds.modelId,
                    helperIds.modelId,
                  )}
                  label="模型 ID"
                  onChange={chooseModel}
                  options={modelOptions.map((candidate) => ({
                    value: candidate,
                    label: candidate,
                  }))}
                  value={modelId}
                />
              ) : (
                <input
                  aria-describedby={describedBy(
                    fieldErrors.modelId && fieldErrorIds.modelId,
                    helperIds.modelId,
                  )}
                  aria-label="模型 ID"
                  maxLength={MODEL_ID_MAX_LENGTH}
                  onChange={(event) => chooseModel(event.target.value)}
                  onBlur={() => validateField('modelId')}
                  spellCheck={false}
                  value={modelId}
                />
              )}
              <button
                disabled={!canLoadModels}
                onClick={() => void loadAvailableModels()}
                type="button"
              >
                {isLoadingModels ? '获取中…' : '获取模型列表'}
              </button>
            </div>
            <FieldError field="modelId" message={fieldErrors.modelId} />
            {modelOptions.length > 0 ? (
              <div className="large-model-catalog-summary" id={helperIds.modelId}>
                <small>已获取 {modelOptions.length} 个模型</small>
                <button
                  className="large-model-catalog-mode"
                  onClick={() => setModelEntryMode(
                    modelEntryMode === 'catalog' ? 'manual' : 'catalog',
                  )}
                  type="button"
                >
                  {modelEntryMode === 'catalog' ? '手动输入模型 ID' : '使用模型列表'}
                </button>
              </div>
            ) : (
              <small id={helperIds.modelId}>
                可以手动输入模型 ID，也可以从服务商获取模型列表。
              </small>
            )}
          </div>
          <fieldset aria-label="高级模型参数" className="large-model-capability-settings">
            <legend>高级模型参数</legend>
            {exactCapabilityProfile ? (
              <div className="large-model-capability-readonly-grid">
                <div>
                  <span>上下文窗口</span>
                  <output>{exactCapabilityProfile.contextWindowTokens}</output>
                </div>
                <div>
                  <span>最大输入</span>
                  <output>{exactCapabilityProfile.maxInputTokens}</output>
                </div>
                <div>
                  <span>最大输出</span>
                  <output>{exactCapabilityProfile.maxOutputTokens}</output>
                </div>
              </div>
            ) : (
              <>
                <p>未知或自定义模型可按服务商文档填写能力限制。</p>
                <div className="large-model-capability-input-grid">
                  <div className="preferences-field">
                    <span>上下文窗口</span>
                    <input
                      aria-invalid={capabilityOverrideError || undefined}
                      aria-label="上下文窗口"
                      inputMode="numeric"
                      min="1"
                      onChange={(event) => setContextWindowTokens(event.target.value)}
                      step="1"
                      type="number"
                      value={contextWindowTokens}
                    />
                  </div>
                  <div className="preferences-field">
                    <span>最大输入</span>
                    <input
                      aria-invalid={capabilityOverrideError || undefined}
                      aria-label="最大输入"
                      inputMode="numeric"
                      min="1"
                      onChange={(event) => setMaxInputTokens(event.target.value)}
                      step="1"
                      type="number"
                      value={maxInputTokens}
                    />
                  </div>
                  <div className="preferences-field">
                    <span>最大输出</span>
                    <input
                      aria-invalid={capabilityOverrideError || undefined}
                      aria-label="最大输出"
                      inputMode="numeric"
                      min="1"
                      onChange={(event) => setMaxOutputTokens(event.target.value)}
                      step="1"
                      type="number"
                      value={maxOutputTokens}
                    />
                  </div>
                </div>
                {capabilityOverrideError && (
                  <p className="preferences-error large-model-capability-error" role="alert">
                    高级模型参数无效。
                  </p>
                )}
              </>
            )}
            <ManualModelThinkingFields protocol={protocol} value={manualThinking} detected={detectedThinking} onChange={setManualThinking} />
          </fieldset>
          <div className="preferences-field">
            <span data-testid="model-field-label">配置名称</span>
            <input
              aria-describedby={describedBy(
                fieldErrors.name && fieldErrorIds.name,
              )}
              aria-label="配置名称"
              maxLength={MODEL_CONNECTION_NAME_MAX_LENGTH}
              onContextMenu={(event) => openPasteMenu(event, 'name')}
              onChange={(event) => {
                const nextName = event.target.value
                setName(nextName)
                setNameSource(
                  nextName.trim() === '' ? 'automatic' : 'manual',
                )
                clearFieldError('name')
                setConnectionError(null)
              }}
              onBlur={() => validateField('name')}
              value={name}
            />
            <FieldError field="name" message={fieldErrors.name} />
          </div>
          </>}
      </>}
    </ArkdownDialog>
  )
}
