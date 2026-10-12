import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { modelObservation, modelCommit } from '../helpers/model-observation'
import { ModelPreferenceDraft } from '../../src/renderer/settings/model-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import type { ObservedModelTestResult } from '../../src/shared/model-settings-commands'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { startModelRulesInitialization } from '../../src/renderer/settings/model-rules-runtime'
import { ModelManagerPage as ActualModelManagerPage } from '../../src/renderer/settings/ModelManagerPage'
import { BusinessDialogProvider } from '../../src/renderer/modal/BusinessDialogProvider'
import { choosePreferencesOption } from './preferences-select-test-helpers'
import type { ArkdownApi } from '../../src/shared/contracts'
import type {
  LargeModelSettings,
  ModelConnectionSummary,
} from '../../src/shared/large-model-settings'

function ModelManagerPage(props: Omit<ComponentProps<typeof ActualModelManagerPage>, 'modelPreferences'>) {
  const [owner] = useState(() => { const draft = new ModelPreferenceDraft(createPreferencePersistence()); draft.accept(modelObservation(props.settings)); return draft })
  const previous = useRef(props.settings)
  useEffect(() => {
    if (previous.current === props.settings) return
    previous.current = props.settings
    owner.accept(modelObservation(props.settings, (owner.getSnapshot().observed?.observation.revision ?? 0) + 1))
  }, [owner, props.settings])
  return <ActualModelManagerPage {...props} modelPreferences={owner} />
}

const connection: ModelConnectionSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: '主翻译模型',
  provider: 'deepseek',
  accessType: 'standard-api',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com/a/very/long/path/that/must/wrap/inside/preferences',
  modelId: 'deepseek-chat',
  apiKeyHint: '••••7A9F',
  status: 'untested',
  lastTestedAt: null,
  capabilityOverride: null,
}
const reasoningConnection: ModelConnectionSummary = {
  ...connection,
  id: '22222222-2222-4222-8222-222222222222',
  name: '推理模型',
  provider: 'other',
  modelId: 'gpt-5-mini',
  baseUrl: 'https://api.example.com/v1',
}
const emptySettings: LargeModelSettings = {
  version: 6,
  codexCli: null,
  connections: [],
  selectionTranslation: {
    connectionId: null,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    targetLanguage: 'auto',
    privacyNoticeAccepted: false,
  },
  screenshotTranslation: {
    connectionId: null,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    targetLanguage: 'auto',
  },
  aiConversation: {
    connectionId: null,
    thinkingMode: 'default' as const, reasoningEffort: 'default',
    writePolicy: 'ask-every-time',
  },
}

it('disables capability-dependent feature setting writes while initial rules are pending', async () => {
  let resolve!: (value: { ok: true; value: { rules: null; bundledRevision: string; warning: null } }) => void
  const session = startModelRulesInitialization({ getModelCapabilityRules: () => new Promise(done => { resolve = done }) })
  const model = { ...connection, baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-flash' }
  const configured = { ...emptySettings, connections: [model], aiConversation: { ...emptySettings.aiConversation, connectionId: model.id } }
  const callbacks = api()
  try {
    render(<ModelManagerPage {...callbacks} settings={configured} onSettingsChange={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'AI 对话推理强度' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'AI 对话模型' })).toBeDisabled()
    expect(callbacks.setAiConversationSettings).not.toHaveBeenCalled()
    await act(async () => { resolve({ ok: true, value: { rules: null, bundledRevision: '2026-09-12', warning: null } }); await session.ready })
    expect(screen.getByRole('combobox', { name: 'AI 对话推理强度' })).toBeEnabled()
  } finally { act(() => session.dispose()) }
})

it('reuses a saved logged-out connection and refreshes its models after explicit login', async () => {
  const onSettingsChange = vi.fn()
  const completed = { ...emptySettings, codexCli: { status: 'connected' as const, cliVersion: '0.144.1', lastTestedAt: '2026-09-15T00:00:00.000Z', models: [] } }
  const startCodexCliLogin = vi.fn(async () => ({ ok: true, value: { status: 'completed', connection: { status: 'connected', mutation: modelCommit(completed) } } }))
  vi.stubGlobal('arkdown', { startCodexCliLogin, cancelCodexCliLogin: vi.fn(async () => ({ ok: true, value: null })) })
  try {
    render(<ModelManagerPage {...api()} settings={{ ...emptySettings, codexCli: { ...completed.codexCli, status: 'not-logged-in' } }} onSettingsChange={onSettingsChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Codex CLI详情' }))
    expect(startCodexCliLogin).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '登录 ChatGPT' }))
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalledWith(completed))
    expect(screen.queryByRole('button', { name: '登录 ChatGPT' })).not.toBeInTheDocument()
  } finally { vi.unstubAllGlobals() }
})

it('limits off-mode Opus effort to active legal grades while preserving its preferred max on toggle', () => {
  const opus = { ...connection, provider: 'other' as const, protocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com/v1', modelId: 'claude-opus-5' }
  const settings = { ...emptySettings, connections: [opus], aiConversation: { ...emptySettings.aiConversation, connectionId: opus.id, thinkingMode: 'disabled' as const, reasoningEffort: 'max' as const } }
  const callbacks = api()
  render(<ModelManagerPage {...callbacks} settings={settings} onSettingsChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('combobox', { name: 'AI 对话推理强度' }))
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['默认', '低', '中', '高'])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })

  return { promise, resolve }
}

function api(overrides: Partial<Pick<
  ArkdownApi,
  'connectModel' | 'testModel' | 'deleteModel' | 'setSelectionTranslationSettings'
    | 'setAiConversationSettings'
    | 'setScreenshotTranslationSettings' | 'setFloatingTranslationSettings'
    | 'testCodexCliConnection' | 'removeCodexCliConnection'
>> = {}) {
  return {
    connectModel: vi.fn(async () => ({
      ok: true as const,
      value: modelCommit({ ...emptySettings, connections: [connection] }),
    })),
    testModel: vi.fn(async () => ({ ok: true as const, value: { mutation: modelCommit({ ...emptySettings, connections: [connection] }), error: null } })),
    deleteModel: vi.fn(async () => ({ ok: true as const, value: modelCommit(emptySettings) })),
    setSelectionTranslationSettings: vi.fn(async () => ({
      ok: true as const,
      value: modelCommit(emptySettings),
    })),
    setAiConversationSettings: vi.fn(async () => ({
      ok: true as const,
      value: modelCommit(emptySettings),
    })),
    setScreenshotTranslationSettings: vi.fn(async () => ({
      ok: true as const,
      value: modelCommit(emptySettings),
    })),
    setFloatingTranslationSettings: vi.fn(async () => ({ ok: true as const, value: modelCommit(emptySettings) })),
    testCodexCliConnection: vi.fn(async () => ({
      ok: true as const,
      value: { status: 'connected' as const, mutation: modelCommit(emptySettings) },
    })),
    removeCodexCliConnection: vi.fn(async () => ({ ok: true as const, value: modelCommit(emptySettings) })),
    ...overrides,
  }
}

const codexCliSettings: LargeModelSettings = {
  ...emptySettings,
  codexCli: {
    cliVersion: 'codex-cli 0.144.1',
    status: 'connected',
    lastTestedAt: '2026-09-01T00:00:00.000Z',
  },
}

it('shows discovered CLI models and their supported effort grades in feature assignments and connection details', async () => {
  const settings: LargeModelSettings = { ...codexCliSettings, codexCli: { ...codexCliSettings.codexCli!, models: [{ modelId: 'account-model', displayName: 'Account model', supportedReasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low', isDefault: true }] }, aiConversation: { ...emptySettings.aiConversation, connectionId: 'codex-cli:account-model', reasoningEffort: 'ultra' } }
  const save = vi.fn<ArkdownApi['setAiConversationSettings']>(async value => ({ ok: true, value: modelCommit({ ...settings, aiConversation: { ...settings.aiConversation, ...value } }) }))
  render(<ModelManagerPage {...api({ setAiConversationSettings: save })} settings={settings} onSettingsChange={vi.fn()} />)
  expect(screen.getByRole('combobox', { name: 'AI 对话模型' })).toHaveTextContent('Codex CLI · Account model')
  fireEvent.click(screen.getByRole('combobox', { name: 'AI 对话推理强度' }))
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['默认', '低', '极致'])
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'AI 对话推理强度' }), { key: 'Escape' })
  await choosePreferencesOption('AI 对话推理强度', '低')
  await waitFor(() => expect(save).toHaveBeenCalledWith({ reasoningEffort: 'low' }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  fireEvent.click(screen.getByRole('button', { name: 'Codex CLI详情' }))
  expect(within(screen.getByRole('article', { name: 'Codex CLI' })).getByText('Account model')).toBeVisible()
})

it('offers Codex CLI for all feature bindings when no API connections exist', async () => {
  const callbacks = api()
  render(<ModelManagerPage {...callbacks} settings={codexCliSettings} onSettingsChange={vi.fn()} />)
  for (const name of ['划词翻译模型', '截图翻译模型', '悬浮翻译窗模型', 'AI 对话模型']) {
    fireEvent.click(screen.getByRole('combobox', { name }))
    expect(screen.getByRole('option', { name: /Codex CLI/ })).toBeVisible()
    fireEvent.keyDown(screen.getByRole('combobox', { name }), { key: 'Escape' })
  }
  await choosePreferencesOption('划词翻译模型', 'Codex CLI')
  await waitFor(() => expect(callbacks.setSelectionTranslationSettings).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'codex-cli' }), expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
})

it('saves a dynamic CLI floating binding without exposing a reasoning effort menu', async () => {
  const settings: LargeModelSettings = { ...codexCliSettings, codexCli: { ...codexCliSettings.codexCli!, models: [{
    modelId: 'floating-cli', displayName: 'Floating CLI', supportedReasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low', isDefault: true,
  }] } }
  const save = vi.fn<ArkdownApi['setFloatingTranslationSettings']>(async value => ({ ok: true, value: modelCommit({ ...settings, floatingTranslation: { ...settings.floatingTranslation!, ...value } }) }))
  render(<ModelManagerPage {...api({ setFloatingTranslationSettings: save })} settings={settings} onSettingsChange={vi.fn()} />)
  await choosePreferencesOption('悬浮翻译窗模型', 'Codex CLI · Floating CLI')
  await waitFor(() => expect(save).toHaveBeenCalledWith({ connectionId: 'codex-cli:floating-cli', thinkingMode: 'enabled', reasoningEffort: 'low' }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(screen.queryByRole('combobox', { name: '悬浮翻译窗推理强度' })).not.toBeInTheDocument()
})

it('starts API and Codex CLI cards collapsed and discloses their details with real buttons', () => {
  render(<ModelManagerPage {...api()} onSettingsChange={() => undefined} settings={{ ...codexCliSettings, connections: [connection] }} />)
  for (const name of ['主翻译模型', 'Codex CLI']) {
    const card = screen.getByRole('article', { name })
    const disclosure = within(card).getByRole('button', { name: `${name}详情` })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(within(card).queryByRole('group', { name: /连接详情/ })).not.toBeInTheDocument()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(within(card).getByRole('group', { name: /连接详情/ })).toBeVisible()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  }
})

it.each(['主翻译模型', 'Codex CLI'])('toggles %s from its name and with Enter and Space', async (name) => {
  const user = userEvent.setup()
  render(<ModelManagerPage {...api()} onSettingsChange={() => undefined} settings={{ ...codexCliSettings, connections: [connection] }} />)
  const card = screen.getByRole('article', { name })
  const disclosure = within(card).getByRole('button', { name: `${name}详情` })

  await user.click(within(card).getByText(name))
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(within(card).getByRole('group', { name: /连接详情/ })).toBeVisible()
  await user.click(within(card).getByText(name))
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')

  disclosure.focus()
  await user.keyboard('{Enter}')
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await user.keyboard(' ')
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
})

it.each(['测试', '编辑', '删除'])('keeps model details expanded when the %s action is clicked', async (action) => {
  const user = userEvent.setup()
  render(<ModelManagerPage {...api({
    testModel: vi.fn(() => new Promise<never>(() => undefined)),
    deleteModel: vi.fn(() => new Promise<never>(() => undefined)),
  })} onSettingsChange={() => undefined} settings={{ ...emptySettings, connections: [connection] }} />)
  const card = screen.getByRole('article', { name: connection.name })
  const disclosure = within(card).getByRole('button', { name: `${connection.name}详情` })
  await user.click(disclosure)
  const details = within(card).getByRole('group', { name: /连接详情/ })
  await user.click(within(card).getByRole('button', { name: action }))
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(details).toBeInTheDocument()
})

it('renders the singleton Codex CLI card with feature assignments', () => {
  render(
    <ModelManagerPage
      {...api()}
      onSettingsChange={() => undefined}
      settings={codexCliSettings}
    />,
  )

  const card = screen.getByRole('article', { name: 'Codex CLI' })
  fireEvent.click(within(card).getByRole('button', { name: 'Codex CLI详情' }))
  expect(within(card).getByRole('heading', { name: 'Codex CLI' })).toBeVisible()
  expect(within(card).getByText('连接正常')).toBeVisible()
  expect(within(card).getByText('codex-cli 0.144.1')).toBeVisible()
  expect(within(card).getByText(/2026\/9\/1/)).toBeVisible()
  expect(within(card).getByRole('button', { name: '重新检测' })).toBeEnabled()
  expect(within(card).getByRole('button', { name: '移除' })).toBeEnabled()
  expect(screen.getByText('暂未接入大模型，点击开始添加')).toBeVisible()

  for (const label of ['划词翻译模型', '截图翻译模型']) {
    expect(screen.getByRole('combobox', { name: label })).toBeVisible()
  }
})

it('re-tests Codex CLI without arguments and reconciles the full returned settings', async () => {
  const refreshed: LargeModelSettings = {
    ...codexCliSettings,
    codexCli: {
      cliVersion: 'codex-cli 0.145.0',
      status: 'connected',
      lastTestedAt: '2026-09-01T01:02:03.000Z',
    },
  }
  const testCodexCliConnection = vi.fn(async () => ({
    ok: true as const,
    value: { status: 'connected' as const, mutation: modelCommit(refreshed) },
  }))
  const onSettingsChange = vi.fn()
  render(
    <ModelManagerPage
      {...api({ testCodexCliConnection })}
      onSettingsChange={onSettingsChange}
      settings={codexCliSettings}
    />,
  )

  const codexCard = screen.getByRole('article', { name: 'Codex CLI' })
  fireEvent.click(within(codexCard).getByRole('button', { name: 'Codex CLI详情' }))
  fireEvent.click(within(codexCard).getByRole('button', { name: '重新检测' }))

  await waitFor(() => expect(testCodexCliConnection).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(onSettingsChange).toHaveBeenLastCalledWith(refreshed)
  expect(screen.getByText('codex-cli 0.145.0')).toBeVisible()
})

it('reconciles a failed Codex CLI re-test and alerts with its public status message', async () => {
  const refreshed: LargeModelSettings = {
    ...codexCliSettings,
    codexCli: {
      ...codexCliSettings.codexCli!,
      status: 'timeout',
      lastTestedAt: '2026-09-01T01:02:03.000Z',
    },
  }
  const testCodexCliConnection = vi.fn(async () => ({
    ok: true as const,
    value: { status: 'timeout' as const, mutation: modelCommit(refreshed) },
  }))
  const onSettingsChange = vi.fn()
  render(
    <BusinessDialogProvider>
      <ModelManagerPage
        {...api({ testCodexCliConnection })}
        onSettingsChange={onSettingsChange}
        settings={codexCliSettings}
      />
    </BusinessDialogProvider>,
  )

  const codexCard = screen.getByRole('article', { name: 'Codex CLI' })
  fireEvent.click(within(codexCard).getByRole('button', { name: 'Codex CLI详情' }))
  fireEvent.click(within(codexCard).getByRole('button', { name: '重新检测' }))

  await waitFor(() => expect(onSettingsChange).toHaveBeenLastCalledWith(refreshed))
  const alert = await screen.findByRole('alertdialog', {
    name: 'Codex CLI 连接检测超时，请确认 CLI 能够正常运行后重试。',
  })
  expect(within(codexCard).getByText('连接超时')).toBeVisible()
  fireEvent.click(within(alert).getByRole('button', { name: '确定' }))
})

it('confirms Codex CLI removal and reconciles the returned full settings', async () => {
  const removeCodexCliConnection = vi.fn(async () => ({ ok: true as const, value: modelCommit(emptySettings) }))
  const onSettingsChange = vi.fn()
  render(
    <BusinessDialogProvider>
      <ModelManagerPage
        {...api({ removeCodexCliConnection })}
        onSettingsChange={onSettingsChange}
        settings={codexCliSettings}
      />
    </BusinessDialogProvider>,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Codex CLI详情' }))
  fireEvent.click(within(screen.getByRole('article', { name: 'Codex CLI' }))
    .getByRole('button', { name: '移除' }))
  const confirmation = await screen.findByRole('dialog', { name: '移除 Codex CLI' })
  fireEvent.click(within(confirmation).getByRole('button', { name: '移除' }))

  await waitFor(() => expect(removeCodexCliConnection).toHaveBeenCalledWith(expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(onSettingsChange).toHaveBeenLastCalledWith(emptySettings)
  expect(screen.queryByRole('article', { name: 'Codex CLI' })).not.toBeInTheDocument()
})

it('renders separate selection, screenshot, and AI conversation configuration groups', () => {
  render(
    <ModelManagerPage
      {...api()}
      onSettingsChange={() => undefined}
      settings={{ ...emptySettings, connections: [connection] }}
    />,
  )

  expect(screen.getByRole('heading', { name: '划词翻译配置' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '截图翻译配置' })).toBeVisible()
  expect(screen.getByRole('heading', { name: 'AI 对话配置' })).toBeVisible()
  const featuresHeading = screen.getByRole('heading', { name: '功能应用' })
  const connectionsHeading = screen.getByRole('heading', { name: '已添加的大模型' })
  expect(featuresHeading.compareDocumentPosition(connectionsHeading)
    & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

it('changes thinking mode without discarding the saved strength preference', async () => {
  const qwen: ModelConnectionSummary = { ...connection, provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/', modelId: 'qwen3.8-max' }
  const settings: LargeModelSettings = { ...emptySettings, connections: [qwen], aiConversation: { connectionId: qwen.id, thinkingMode: 'disabled', reasoningEffort: 'xhigh', writePolicy: 'ask-every-time' } }
  const setAiConversationSettings: ArkdownApi['setAiConversationSettings'] = vi.fn(async (input) => ({ ok: true as const, value: modelCommit({ ...settings, aiConversation: { ...settings.aiConversation, ...input } }) }))
  render(<ModelManagerPage {...api({ setAiConversationSettings })} settings={settings} onSettingsChange={() => undefined} />)
  choosePreferencesOption('AI 对话思考模式', '开启')
  await waitFor(() => expect(setAiConversationSettings).toHaveBeenLastCalledWith({ thinkingMode: 'enabled' }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  choosePreferencesOption('AI 对话思考模式', '关闭')
  await waitFor(() => expect(setAiConversationSettings).toHaveBeenLastCalledWith({ thinkingMode: 'disabled' }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
})

const capabilityCases: { name: string; model: ModelConnectionSummary; assigned: boolean; toggle: boolean; effort: boolean }[] = [
  { name: 'toggle-only Kimi', model: { ...connection, provider: 'kimi', baseUrl: 'https://api.moonshot.ai/v1', modelId: 'kimi-k2.6' }, assigned: true, toggle: true, effort: false },
  { name: 'no assigned model', model: reasoningConnection, assigned: false, toggle: false, effort: false },
  { name: 'unknown model', model: { ...connection, provider: 'other', modelId: 'unknown-model' }, assigned: true, toggle: false, effort: false },
  { name: 'fixed thinking without effort', model: { ...connection, provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelId: 'qwen3.7-max-preview' }, assigned: true, toggle: false, effort: false },
  { name: 'supported effort', model: { ...connection, provider: 'other', baseUrl: 'https://api.openai.com/v1', modelId: 'gpt-6-astra' }, assigned: true, toggle: false, effort: true },
]

it.each(capabilityCases)('only displays available thinking controls for $name across all assignments', ({ model, assigned, toggle, effort }) => {
  const connectionId = assigned ? model.id : null
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [model],
    selectionTranslation: { ...emptySettings.selectionTranslation, connectionId },
    screenshotTranslation: { ...emptySettings.screenshotTranslation, connectionId },
    aiConversation: { ...emptySettings.aiConversation, connectionId },
  }
  render(<ModelManagerPage {...api()} settings={settings} onSettingsChange={() => undefined} />)
  for (const name of ['划词翻译配置', '截图翻译配置', 'AI 对话配置']) {
    const group = within(screen.getByRole('group', { name }))
    expect(group.queryByRole('combobox', { name: /思考模式/ }) !== null).toBe(toggle)
    expect(group.queryByText('思考模式') !== null).toBe(toggle)
    expect(group.queryByRole('combobox', { name: /推理强度/ }) !== null).toBe(effort)
    expect(group.queryByText('推理强度') !== null).toBe(effort)
    expect(group.queryByText('不可调整')).not.toBeInTheDocument()
  }
})

const managerCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/large-model-settings.css'),
  'utf8',
).replace(/\r\n/g, '\n')

function ruleDeclarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declarations = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, 's'))?.[1]
  if (!declarations) throw new Error(`Missing CSS rule for ${selector}`)
  return declarations
}

it('shows the add action before deferring assignment controls when no API model exists', () => {
  render(
    <ModelManagerPage
      {...api()}
      onSettingsChange={() => undefined}
      settings={emptySettings}
    />,
  )

  expect(screen.getByRole('button', { name: '添加大模型' })).toBeVisible()
  expect(screen.getByText('暂未接入大模型，点击开始添加')).toBeVisible()
  expect(screen.queryByRole('heading', { name: '功能应用' })).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name: '划词翻译配置' })).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name: '截图翻译配置' })).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'AI 对话配置' })).not.toBeInTheDocument()
})

it('keeps independent Codex CLI capability visible in the API-model empty state', () => {
  render(
    <ModelManagerPage
      {...api()}
      onSettingsChange={() => undefined}
      settings={codexCliSettings}
    />,
  )

  expect(screen.getByRole('button', { name: '添加大模型' })).toBeVisible()
  expect(screen.getByText('暂未接入大模型，点击开始添加')).toBeVisible()
  expect(screen.getByRole('article', { name: 'Codex CLI' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '功能应用' })).toBeVisible()
})

it('shows exactly thirteen target languages and AI conversation controls when configured', () => {
  const modelApi = api()
  render(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={() => undefined}
      settings={{ ...emptySettings, connections: [connection] }}
    />,
  )

  expect(screen.getByRole('heading', { name: '管理大模型' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '管理大模型' }))
    .toHaveAttribute('id', 'preferences-large-model-manager')
  expect(screen.getByRole('heading', { name: '功能应用' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '已添加的大模型' })).toBeVisible()
  expect(screen.queryByText('暂未接入大模型，点击开始添加')).not.toBeInTheDocument()
  const language = screen.getByRole('combobox', { name: '目标语言' })
  fireEvent.click(language)
  expect(screen.getAllByRole('option')).toHaveLength(13)
  expect(screen.getByRole('option', { name: '自动' })).toBeVisible()
  fireEvent.keyDown(language, { key: 'Escape' })
  expect(screen.getByRole('combobox', { name: 'AI 对话模型' })).toBeVisible()
  expect(screen.queryByText('代码解读')).not.toBeInTheDocument()
  for (const select of screen.getAllByRole('combobox')) {
    expect(select.closest('label')).toBeNull()
  }
})

it('groups the aligned assignment controls under a translation configuration label', () => {
  render(
    <ModelManagerPage
      {...api()}
      onSettingsChange={() => undefined}
      settings={{ ...emptySettings, connections: [connection] }}
    />,
  )

  const assignment = screen.getByRole('group', { name: '划词翻译配置' })
  const conversation = screen.getByRole('group', { name: 'AI 对话配置' })
  expect(within(assignment).getByRole('combobox', { name: '划词翻译模型' })).toBeVisible()
  expect(within(assignment).getByRole('combobox', { name: '目标语言' })).toBeVisible()
  expect(within(conversation).getByRole('combobox', { name: 'AI 对话模型' })).toBeVisible()
  expect(within(conversation).queryByText('目标语言')).toBeNull()
})

it('glows the unassigned model selector when a connected connection is available', () => {
  const connectedSettings: LargeModelSettings = {
    ...emptySettings,
    connections: [{ ...connection, status: 'connected' }],
  }
  render(
    <ModelManagerPage
      {...api()}
      onSettingsChange={() => undefined}
      settings={connectedSettings}
    />,
  )

  for (const name of ['划词翻译模型', '截图翻译模型', '悬浮翻译窗模型', 'AI 对话模型']) {
    expect(screen.getByRole('combobox', { name }).closest('.preferences-field')).toHaveClass('large-model-unassigned-prompt')
  }
  expect(managerCss).toMatch(
    /\.large-model-unassigned-prompt \.preferences-select-trigger\s*\{[^}]*border-color:\s*rgb\(var\(--theme-color-rgb\)\);[^}]*box-shadow:/s,
  )
})

it('keeps floating language and thinking edits independent from the selected model without exposing effort', async () => {
  let current: LargeModelSettings = { ...emptySettings, connections: [{ ...connection, status: 'connected',
    capabilityOverride: { thinking: { thinking: 'toggle', encoding: 'thinking-effort', efforts: ['low', 'high'],
      defaultThinking: 'enabled', defaultEffort: 'low', disabledEfforts: [] } },
  }],
    floatingTranslation: { connectionId: connection.id, thinkingMode: 'disabled', reasoningEffort: 'low', target: 'zh' } }
  const save = vi.fn(async (patch: Partial<NonNullable<LargeModelSettings['floatingTranslation']>>) => {
    current = { ...current, floatingTranslation: { ...current.floatingTranslation!, ...patch } }
    return { ok: true as const, value: modelCommit(current) }
  })
  render(<ModelManagerPage {...api({ setFloatingTranslationSettings: save })} settings={current} onSettingsChange={vi.fn()} />)
  const selector = screen.getByRole('combobox', { name: '悬浮翻译窗模型' })
  expect(screen.queryByRole('combobox', { name: '悬浮翻译窗推理强度' })).not.toBeInTheDocument()
  expect(selector.closest('.preferences-field')).not.toHaveClass('large-model-unassigned-prompt')
  expect(screen.getByRole('combobox', { name: '悬浮翻译窗目标语言' })).toHaveTextContent('简体中文')
  await choosePreferencesOption('悬浮翻译窗目标语言', '德语')
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ target: 'de' }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(selector).toHaveTextContent(connection.name)
  await choosePreferencesOption('悬浮翻译窗目标语言', '自动')
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ target: 'auto' }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(current.floatingTranslation?.connectionId).toBe(connection.id)
  await choosePreferencesOption('悬浮翻译窗思考模式', '开启')
  await waitFor(() => expect(save).toHaveBeenLastCalledWith({ thinkingMode: 'enabled' }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(current.floatingTranslation).toEqual({ connectionId: connection.id, thinkingMode: 'enabled', reasoningEffort: 'low', target: 'auto' })
})

it('does not prompt an unassigned floating model when no connection is usable', () => {
  render(<ModelManagerPage {...api()} settings={{ ...emptySettings, connections: [{ ...connection, status: 'authentication-failed' }] }} onSettingsChange={vi.fn()} />)
  expect(screen.getByRole('combobox', { name: '悬浮翻译窗模型' }).closest('.preferences-field')).not.toHaveClass('large-model-unassigned-prompt')
})

it('keeps manager layout controls at the required dimensions across responsive columns', () => {
  expect(managerCss).toContain('.large-model-assignment-controls {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));')
  expect(managerCss).toContain('.large-model-assignment {\n  padding: 16px;\n  background: #fafafa;\n  border: 1px solid #e5e5e5;\n  border-radius: 8px;')
  expect(managerCss).toContain('@media (max-width: 720px) {\n  .large-model-assignment-controls,')
  expect(managerCss).toContain('grid-template-columns: minmax(0, 1fr);')
  expect(managerCss).toContain('height: 32px;')
  expect(managerCss).toContain('border-radius: 8px;')
  expect(managerCss).toContain('font-size: 13px;')
  expect(managerCss).toContain('.large-model-card {\n  min-width: 0;\n  padding: 17px;\n  background: #fff;\n  border: 1px solid #dedede;\n  border-radius: 8px;')
})

it('keeps the add-model primary action themed in the manager button cascade', () => {
  const computedStyleCss = managerCss.replaceAll(
    'rgb(var(--theme-color-rgb, 198 40 40))',
    'rgb(37, 99, 235)',
  )
  render(
    <>
      <style>{computedStyleCss}</style>
      <ModelManagerPage
        {...api()}
        onSettingsChange={() => undefined}
        settings={{ ...emptySettings, connections: [connection] }}
      />
    </>,
  )

  const primary = screen.getByRole('button', { name: '添加大模型' })
  fireEvent.click(screen.getByRole('button', { name: `${connection.name}详情` }))
  const neutral = within(screen.getByRole('article', { name: connection.name }))
    .getByRole('button', { name: '测试' })

  expect(getComputedStyle(primary).backgroundColor).toBe('rgb(37, 99, 235)')
  expect(getComputedStyle(primary).color).toBe('rgb(255, 255, 255)')
  expect(getComputedStyle(neutral).backgroundColor).toBe('rgb(255, 255, 255)')
  expect(getComputedStyle(neutral).color).toBe('rgb(51, 51, 51)')
})

it('collapses the AI conversation assignment grid to one column under 720px', () => {
  expect(managerCss).toContain(
    '@media (max-width: 720px) {\n'
    + '  .large-model-assignment-controls,\n'
    + '  .large-model-assignment-controls.is-ai-conversation,',
  )
})

it('shows testing feedback and ignores duplicate test submissions while the request is pending', async () => {
  const pendingTest = deferred<{ ok: true; value: ObservedModelTestResult }>()
  const testModel: ArkdownApi['testModel'] = vi.fn(() => pendingTest.promise)
  render(
    <ModelManagerPage
      {...api({ testModel })}
      onSettingsChange={() => undefined}
      settings={{ ...emptySettings, connections: [connection] }}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: `${connection.name}详情` }))
  const testButton = within(screen.getByRole('article', { name: connection.name }))
    .getByRole('button', { name: '测试' })
  fireEvent.click(testButton)
  fireEvent.click(testButton)

  expect(testButton).toHaveTextContent('测试中…')
  expect(testButton).toBeDisabled()
  await waitFor(() => expect(testModel).toHaveBeenCalledTimes(1))

  await act(async () => {
    pendingTest.resolve({ ok: true, value: { mutation: modelCommit({ ...emptySettings, connections: [connection] }), error: null } })
  })
  await waitFor(() => expect(testButton).toHaveTextContent('测试'))
})

it('retains the target language and uses disabled lowest preference for a new translation binding', async () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [reasoningConnection, connection],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      connectionId: reasoningConnection.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      targetLanguage: 'fr',
    },
  }
  const nextSettings: LargeModelSettings = {
    ...settings,
    selectionTranslation: {
      ...settings.selectionTranslation,
      connectionId: connection.id,
      thinkingMode: 'disabled' as const, reasoningEffort: 'low',
    },
  }
  const setSelectionTranslationSettings: ArkdownApi['setSelectionTranslationSettings'] =
    vi.fn(async () => ({ ok: true as const, value: modelCommit(nextSettings) }))
  const modelApi = api({ setSelectionTranslationSettings })

  render(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={() => undefined}
      settings={settings}
    />,
  )

  expect(screen.getByRole('combobox', { name: '推理强度' })).toHaveTextContent('高')
  expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('法语')
  choosePreferencesOption('划词翻译模型', '主翻译模型')

  await waitFor(() => expect(setSelectionTranslationSettings).toHaveBeenCalledWith({
    connectionId: connection.id,
    thinkingMode: 'disabled' as const, reasoningEffort: 'low',
  }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(screen.queryByRole('combobox', { name: '推理强度' })).not.toBeInTheDocument()
  expect(screen.queryByText('不可调整')).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('法语')
})

it('offers real GLM grades and binds translations at the lowest fixed-thinking preference', async () => {
  const glmConnection: ModelConnectionSummary = {
    ...connection,
    id: '33333333-3333-4333-8333-333333333333',
    name: 'GLM 5.3',
    provider: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    modelId: 'glm-5.3',
    status: 'connected',
  }
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [reasoningConnection, glmConnection],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      connectionId: reasoningConnection.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'medium',
    },
  }
  const nextSettings: LargeModelSettings = {
    ...settings,
    selectionTranslation: {
      ...settings.selectionTranslation,
      connectionId: glmConnection.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'low',
    },
  }
  const setSelectionTranslationSettings: ArkdownApi['setSelectionTranslationSettings'] =
    vi.fn(async () => ({ ok: true as const, value: modelCommit(nextSettings) }))

  render(
    <ModelManagerPage
      {...api({ setSelectionTranslationSettings })}
      onSettingsChange={() => undefined}
      settings={settings}
    />,
  )

  choosePreferencesOption('划词翻译模型', 'GLM 5.3')
  await waitFor(() => expect(setSelectionTranslationSettings).toHaveBeenCalledWith({
    connectionId: glmConnection.id,
    thinkingMode: 'enabled' as const, reasoningEffort: 'low',
  }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))

  const reasoning = screen.getByRole('combobox', { name: '推理强度' })
  fireEvent.click(reasoning)
  expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
    '默认', '低', '高', '最高',
  ])
})

it('assigns an AI conversation model and preserves provider-default reasoning', async () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [reasoningConnection, connection],
  }
  const configured: LargeModelSettings = {
    ...settings,
    aiConversation: {
      connectionId: connection.id,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
    },
  }
  const setAiConversationSettings: ArkdownApi['setAiConversationSettings'] =
    vi.fn(async () => ({ ok: true as const, value: modelCommit(configured) }))
  const onSettingsChange = vi.fn()

  render(
    <ModelManagerPage
      {...api({ setAiConversationSettings })}
      onSettingsChange={onSettingsChange}
      settings={settings}
    />,
  )

  choosePreferencesOption('AI 对话模型', '主翻译模型')

  await waitFor(() => expect(setAiConversationSettings).toHaveBeenCalledWith({
    connectionId: connection.id,
    reasoningEffort: 'default',
  }, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(onSettingsChange).toHaveBeenLastCalledWith(configured)
  const conversation = screen.getByRole('group', { name: 'AI 对话配置' })
  expect(within(conversation).queryByText('推理强度')).not.toBeInTheDocument()
  expect(within(conversation).queryByText('不可调整')).not.toBeInTheDocument()
})

it('shows the AI conversation reasoning selector for supported models', () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [reasoningConnection],
    aiConversation: {
      connectionId: reasoningConnection.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      writePolicy: 'ask-every-time',
    },
  }

  render(
    <ModelManagerPage
      {...api()}
      onSettingsChange={() => undefined}
      settings={settings}
    />,
  )

  const conversation = screen.getByRole('group', { name: 'AI 对话配置' })
  expect(within(conversation).getByRole('combobox', { name: 'AI 对话推理强度' }))
    .toHaveTextContent('高')
})

it('updates test status and confirms deletion of an assigned connection', async () => {
  const assigned: LargeModelSettings = {
    ...emptySettings,
    connections: [connection],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      connectionId: connection.id,
      targetLanguage: 'en',
    },
    aiConversation: {
      connectionId: connection.id,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
    },
  }
  const tested = {
    ...connection,
    status: 'connected' as const,
    lastTestedAt: '2026-07-30T03:04:05.000Z',
  }
  const afterDelete: LargeModelSettings = {
    ...emptySettings,
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      targetLanguage: 'en',
    },
  }
  const testModel: ArkdownApi['testModel'] =
    vi.fn(async () => ({ ok: true as const, value: { mutation: modelCommit({ ...assigned, connections: [tested] }), error: null } }))
  const deleteModel: ArkdownApi['deleteModel'] =
    vi.fn(async () => ({ ok: true as const, value: modelCommit(afterDelete, 3) }))
  const onSettingsChange = vi.fn()
  const modelApi = api({ testModel, deleteModel })

  render(
    <BusinessDialogProvider>
      <ModelManagerPage
        {...modelApi}
        onSettingsChange={onSettingsChange}
        settings={assigned}
      />
    </BusinessDialogProvider>,
  )

  const card = screen.getByRole('article', { name: '主翻译模型' })
  fireEvent.click(within(card).getByRole('button', { name: `${connection.name}详情` }))
  const modelName = within(card).getByRole('heading', { level: 3, name: connection.name })
  const provider = within(card).getByText('DeepSeek')
  const modelId = within(card).getByText('deepseek-chat')
  const protocol = within(card).getByText('OpenAI 兼容')
  const apiKeyHint = within(card).getByText('••••7A9F')
  const baseUrl = within(card).getByText(connection.baseUrl)
  const status = within(card).getByText('未测试')
  const connectionStatus = within(card).getByRole('group', { name: '主翻译模型状态' })
  const connectionDetails = within(card).getByRole('group', { name: '主翻译模型连接详情' })

  expect(modelName).toBeVisible()
  expect(modelName).toHaveAttribute('data-ui-selectable', 'true')
  expect(provider).toBeVisible()
  expect(provider).toHaveAttribute('data-ui-selectable', 'true')
  expect(modelId).toBeVisible()
  expect(modelId).toHaveAttribute('data-ui-selectable', 'true')
  expect(protocol).toBeVisible()
  expect(protocol).toHaveAttribute('data-ui-selectable', 'true')
  expect(apiKeyHint).toBeVisible()
  expect(apiKeyHint).toHaveAttribute('data-ui-selectable', 'true')
  expect(baseUrl).toBeVisible()
  expect(baseUrl).toHaveAttribute('data-ui-selectable', 'true')
  expect(status).toBeVisible()
  expect(status).toHaveAttribute('data-ui-selectable', 'true')
  expect(connectionStatus).toHaveAttribute('data-ui-selectable', 'true')
  expect(connectionStatus).toHaveAttribute('tabindex', '0')
  expect(connectionStatus.querySelector('.large-model-status-icon')).not.toBeNull()
  expect(connectionDetails).toHaveAttribute('data-ui-selectable', 'true')
  expect(connectionDetails).toHaveAttribute('tabindex', '0')

  fireEvent.click(within(card).getByRole('button', { name: '测试' }))
  expect(await within(card).findByText('连接正常')).toBeVisible()
  expect(onSettingsChange).toHaveBeenCalledWith({
    ...assigned,
    connections: [tested],
  })

  fireEvent.click(within(card).getByRole('button', { name: '删除' }))
  const confirmation = await screen.findByRole('dialog', {
    name: '删除正在使用的大模型',
  })
  expect(confirmation).toHaveAttribute('data-tone', 'danger')
  expect(confirmation).toHaveTextContent(
    '该大模型正在被翻译功能和 AI 对话使用。删除后将解除功能绑定，确定删除吗？',
  )
  fireEvent.click(within(confirmation).getByRole('button', { name: '删除' }))
  await waitFor(() => expect(deleteModel).toHaveBeenCalledWith(connection.id, expect.objectContaining({ observation: expect.objectContaining({ version: 1 }) })))
  expect(onSettingsChange).toHaveBeenLastCalledWith(afterDelete)
  expect(screen.queryByRole('article', { name: '主翻译模型' })).not.toBeInTheDocument()
})

it('marks the latest-check value in a model card as selectable', () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [connection],
  }
  const modelApi = api()
  render(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={() => undefined}
      settings={settings}
    />,
  )

  const card = screen.getByRole('article', { name: connection.name })
  fireEvent.click(within(card).getByRole('button', { name: `${connection.name}详情` }))
  const latestCheck = Array.from(card.querySelectorAll('dd')).at(-1)!

  expect(latestCheck).toBeVisible()
  expect(latestCheck).toHaveAttribute('data-ui-selectable', 'true')
})

it('marks a page-level model operation failure as selectable', async () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [connection],
  }
  const testModel: ArkdownApi['testModel'] = vi.fn(async () => ({
    ok: false as const,
    error: { code: 'OPERATION_FAILED' as const, message: '模型检测失败' },
  }))
  const modelApi = api({ testModel })
  render(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={() => undefined}
      settings={settings}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: `${connection.name}详情` }))
  fireEvent.click(screen.getByRole('button', { name: '测试' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('模型检测失败')
  expect(alert).toBeVisible()
  expect(alert).toHaveAttribute('data-ui-selectable', 'true')
  expect(alert).toHaveAttribute('tabindex', '0')
})

it('closes the add dialog and adds the connected model card', async () => {
  const connectModel: ArkdownApi['connectModel'] =
    vi.fn(async () => ({
      ok: true as const,
      value: modelCommit({ ...emptySettings, connections: [connection] }),
    }))
  const modelApi = api({ connectModel })
  render(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={() => undefined}
      settings={emptySettings}
    />,
  )

  const addButton = screen.getByRole('button', { name: '添加大模型' })
  addButton.focus()
  fireEvent.click(addButton)
  expect(screen.getAllByTestId('model-field-label').map((label) => label.textContent))
    .toEqual([
      '服务商',
      '接入类型',
      '接口协议',
      'Base URL',
      'API Key',
      '模型 ID',
      '配置名称',
    ])
  expect(screen.getByRole('button', { name: '获取模型列表' })).toBeDisabled()
  expect(screen.getByRole('button', { name: '连接' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: '主翻译模型' } })
  choosePreferencesOption('服务商', 'DeepSeek')
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'deepseek-chat' } })
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  expect(await screen.findByRole('article', { name: '主翻译模型' })).toBeVisible()
  expect(screen.queryByRole('dialog', { name: '添加大模型' })).not.toBeInTheDocument()
  expect(addButton).toHaveFocus()
  expect(screen.getByRole('group', { name: '划词翻译配置' })).toBeVisible()
  expect(screen.getByRole('group', { name: '截图翻译配置' })).toBeVisible()
  expect(screen.getByRole('group', { name: 'AI 对话配置' })).toBeVisible()
  expect(screen.getByRole('combobox', { name: '划词翻译模型' }))
    .toHaveTextContent('不使用大模型')
  expect(screen.getByRole('combobox', { name: '截图翻译模型' }))
    .toHaveTextContent('不使用大模型')
  expect(screen.getByRole('combobox', { name: 'AI 对话模型' }))
    .toHaveTextContent('不使用大模型')
})

it('locks all mutations and adopts the deferred test authoritative snapshot after an external refresh', async () => {
  const initialSettings: LargeModelSettings = {
    ...emptySettings,
    connections: [connection, reasoningConnection],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      connectionId: reasoningConnection.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      targetLanguage: 'fr',
    },
  }
  const tested = {
    ...connection,
    status: 'connected' as const,
    lastTestedAt: '2026-07-30T05:06:07.000Z',
  }
  const pendingTest = deferred<{ ok: true; value: ObservedModelTestResult }>()
  const testModel: ArkdownApi['testModel'] = vi.fn(() => pendingTest.promise)
  const onSettingsChange = vi.fn()
  const modelApi = api({ testModel })
  const { rerender } = render(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={onSettingsChange}
      settings={initialSettings}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: `${connection.name}详情` }))
  fireEvent.click(screen.getByRole('button', { name: `${reasoningConnection.name}详情` }))
  const primaryCard = screen.getByRole('article', { name: connection.name })
  const reasoningCard = screen.getByRole('article', { name: reasoningConnection.name })
  fireEvent.click(within(primaryCard).getByRole('button', { name: '测试' }))

  expect(within(reasoningCard).getByRole('button', { name: '删除' })).toBeDisabled()

  const externalSettings: LargeModelSettings = {
    ...emptySettings,
    connections: [connection],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      targetLanguage: 'fr',
    },
  }
  rerender(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={onSettingsChange}
      settings={externalSettings}
    />,
  )
  await waitFor(() => {
    expect(screen.queryByRole('article', { name: reasoningConnection.name })).not.toBeInTheDocument()
  })

  await act(async () => {
    pendingTest.resolve({ ok: true, value: { mutation: modelCommit({ ...externalSettings, connections: [tested] }, 3), error: null } })
  })

  await waitFor(() => expect(onSettingsChange).toHaveBeenLastCalledWith({
    ...externalSettings,
    connections: [tested],
  }))
  expect(screen.queryByRole('article', { name: reasoningConnection.name })).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '划词翻译模型' }))
    .toHaveTextContent('不使用大模型')
  expect(screen.queryByText('推理强度')).not.toBeInTheDocument()
  expect(screen.queryByText('不可调整')).not.toBeInTheDocument()
})

it('publishes the authoritative edit result without a renderer reconciliation write', async () => {
  const settings: LargeModelSettings = {
    ...emptySettings,
    connections: [reasoningConnection],
    selectionTranslation: {
      ...emptySettings.selectionTranslation,
      connectionId: reasoningConnection.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
      targetLanguage: 'fr',
    },
  }
  const updated = {
    ...reasoningConnection,
    modelId: 'gpt-4o',
  }
  const reconciled: LargeModelSettings = {
    ...settings,
    connections: [updated],
    selectionTranslation: {
      ...settings.selectionTranslation,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'de',
      privacyNoticeAccepted: true,
    },
  }
  const connectModel: ArkdownApi['connectModel'] =
    vi.fn(async () => ({ ok: true as const, value: modelCommit(reconciled) }))
  const setSelectionTranslationSettings = vi.fn()
  const onSettingsChange = vi.fn()
  const modelApi = api({
    connectModel,
    setSelectionTranslationSettings: setSelectionTranslationSettings as never,
  })

  render(
    <ModelManagerPage
      {...modelApi}
      onSettingsChange={onSettingsChange}
      settings={settings}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: `${reasoningConnection.name}详情` }))
  const editButton = within(
    screen.getByRole('article', { name: reasoningConnection.name }),
  ).getByRole('button', { name: '编辑' })
  editButton.focus()
  fireEvent.click(editButton)
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'gpt-4o' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  await waitFor(() => expect(onSettingsChange).toHaveBeenLastCalledWith(reconciled))
  expect(setSelectionTranslationSettings).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑大模型' }))
    .not.toBeInTheDocument())
  expect(screen.queryByText('推理强度')).not.toBeInTheDocument()
  expect(screen.queryByText('不可调整')).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('德语')
  await waitFor(() => expect(within(
    screen.getByRole('article', { name: reasoningConnection.name }),
  ).getByRole('button', { name: '编辑' })).toHaveFocus())
})
