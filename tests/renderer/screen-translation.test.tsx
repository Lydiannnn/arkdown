import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ScreenTranslationSurface } from '../../src/renderer/screen-translation/ScreenTranslationSurface'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'
import { DEFAULT_SCREEN_TRANSLATION, type ScreenTranslationApi, type ScreenTranslationSnapshot } from '../../src/shared/screen-translation'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'

function fixture(overrides: Partial<ScreenTranslationSnapshot> = {}): ScreenTranslationSnapshot {
  return {
    preferences: { ...DEFAULT_SCREEN_TRANSLATION, backend: 'baidu', target: 'zh', triggerMode: 'automatic' }, models: { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [] },
    configuredBaidu: true, engineReady: true, theme: { mode: 'light', accent: '#2563EB' },
    shortcuts: { once: 'Ctrl+Shift+A', toggle: 'Ctrl+Alt+T', clear: 'Ctrl+Shift+D' },
    status: { automatic: false, triggerMode: 'automatic', busy: false, showOriginal: false, result: { blocks: [] }, error: null, status: '等待开始' },
    ...overrides,
  }
}

function harness(initial = fixture()) {
  let listener: (snapshot: ScreenTranslationSnapshot) => void = () => undefined
  const unsubscribe = vi.fn()
  const api: ScreenTranslationApi = {
    getState: vi.fn(async () => initial), updateSettings: vi.fn(async patch => ({ ...initial, preferences: { ...initial.preferences, ...patch } })),
    command: vi.fn(async () => undefined), saveBaiduCredentials: vi.fn(async () => ({ ...initial, configuredBaidu: true })),
    onState: vi.fn(callback => { listener = callback; return unsubscribe }),
  }
  return { api, unsubscribe, emit: (snapshot: ScreenTranslationSnapshot) => act(() => listener(snapshot)) }
}

describe('screen translation surface', () => {
  function observedState(target = 'zh', revision = 0) {
    const models = structuredClone(DEFAULT_LARGE_MODEL_SETTINGS)
    models.floatingTranslation = { ...models.floatingTranslation!, target }
    const modelObservation: PublicModelSettingsSnapshot = { settings: models,
      observation: { version: 1, revision, minimumBaseRevision: 0,
        fields: { 'models.floatingTranslation.target': revision }, connections: {} } }
    return fixture({ models, modelObservation, preferences: { ...fixture().preferences, target } })
  }

  it('T03 retains a failed target and original observation across state events and retries exactly that edit', async () => {
    const initial = observedState(), newer = observedState('jp', 1)
    const { api, emit } = harness(initial)
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('synthetic-private-failure'))
    render(<ScreenTranslationSurface api={api} />)
    fireEvent.click(await screen.findByRole('combobox', { name: '目标语言' }))
    fireEvent.click(screen.getByRole('option', { name: '英语' }))
    await screen.findByRole('button', { name: '重试保存设置' })
    emit(newer)
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('英语')
    expect(screen.getByRole('combobox', { name: '目标语言' })).toBeDisabled()
    expect(screen.queryByText('synthetic-private-failure')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '翻译一次' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '重试保存设置' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2))
    expect(vi.mocked(api.updateSettings).mock.calls).toEqual([
      [{ target: 'en' }, initial.modelObservation], [{ target: 'en' }, initial.modelObservation],
    ])
    await waitFor(() => expect(screen.queryByRole('button', { name: '重试保存设置' })).not.toBeInTheDocument())
  })

  it('T03 requires explicit reload after conflict and uses the reloaded observation only for a new operation', async () => {
    const initial = observedState(), newer = observedState('jp', 1)
    const { api, emit } = harness(initial)
    vi.mocked(api.updateSettings).mockResolvedValueOnce({ status: 'conflict' })
    render(<ScreenTranslationSurface api={api} />)
    fireEvent.click(await screen.findByRole('combobox', { name: '目标语言' }))
    fireEvent.click(screen.getByRole('option', { name: '英语' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('其他窗口')
    emit(newer)
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('英语')
    expect(screen.queryByRole('button', { name: '重试保存设置' })).not.toBeInTheDocument()
    vi.mocked(api.getState).mockResolvedValueOnce(newer)
    fireEvent.click(screen.getByRole('button', { name: '放弃修改并重新载入' }))
    await waitFor(() => expect(screen.getByRole('combobox', { name: '目标语言' })).toBeEnabled())
    expect(api.getState).toHaveBeenLastCalledWith({ reloadSettings: true })
    expect(api.updateSettings).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('日语')
    fireEvent.click(screen.getByRole('combobox', { name: '目标语言' }))
    fireEvent.click(screen.getByRole('option', { name: '英语' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledTimes(2))
    expect(api.updateSettings).toHaveBeenLastCalledWith({ target: 'en' }, newer.modelObservation)
  })

  it('T03 preserves the failed edit when an explicit reload fails', async () => {
    const { api } = harness(observedState())
    vi.mocked(api.updateSettings).mockRejectedValueOnce(new Error('write failed'))
    render(<ScreenTranslationSurface api={api} />)
    fireEvent.click(await screen.findByRole('combobox', { name: '目标语言' }))
    fireEvent.click(screen.getByRole('option', { name: '英语' }))
    await screen.findByRole('button', { name: '重试保存设置' })
    vi.mocked(api.getState).mockRejectedValueOnce(new Error('read failed'))
    fireEvent.click(screen.getByRole('button', { name: '放弃修改并重新载入' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '重试保存设置' })).toBeEnabled())
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('英语')
  })

  it('offers an explicit component installation before showing translation controls', async () => {
    const { api } = harness(fixture({ engineReady: false, component: {
      status: 'absent', version: '1.0.0', downloadBytes: 1024 * 1024, progress: null, error: null,
    } }))
    render(<ScreenTranslationSurface api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装翻译组件' }))
    expect(api.command).toHaveBeenCalledExactlyOnceWith('install-engine')
    expect(screen.queryByRole('combobox', { name: '翻译方式' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '关闭悬浮翻译窗' })).toBeEnabled()
  })

  it('shows host download progress and allows cancelling a pending installation', async () => {
    const initial = fixture({ engineReady: false, component: {
      status: 'absent', version: '1.0.0', downloadBytes: 1000, progress: null, error: null,
    } })
    const { api, emit } = harness(initial)
    vi.mocked(api.command).mockImplementation(action => action === 'install-engine' ? new Promise(() => {}) : Promise.resolve())
    render(<ScreenTranslationSurface api={api} />)
    fireEvent.click(await screen.findByRole('button', { name: '安装翻译组件' }))
    emit({ ...initial, component: { ...initial.component!, status: 'installing',
      progress: { phase: 'downloading', receivedBytes: 250, totalBytes: 1000 } } })
    expect(screen.getByRole('progressbar', { name: '翻译组件安装进度' })).toHaveAttribute('value', '25')
    fireEvent.click(screen.getByRole('button', { name: '取消下载' }))
    expect(api.command).toHaveBeenCalledWith('cancel-install')
    fireEvent.click(screen.getByRole('button', { name: '关闭悬浮翻译窗' }))
    expect(api.command).toHaveBeenCalledWith('close')
  })

  it('offers retry for component failure and returns to normal controls after installation', async () => {
    const initial = fixture({ engineReady: false, component: {
      status: 'failed', version: '1.0.0', downloadBytes: 1000, progress: null, error: '下载失败，请检查网络后重试。',
    } })
    const { api, emit } = harness(initial)
    render(<ScreenTranslationSurface api={api} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('下载失败，请检查网络后重试。')
    fireEvent.click(screen.getByRole('button', { name: '重试安装' }))
    expect(api.command).toHaveBeenCalledWith('install-engine')
    emit({ ...initial, engineReady: true, component: { ...initial.component!, status: 'installed', error: null } })
    expect(screen.getByRole('combobox', { name: '翻译方式' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '重试安装' })).not.toBeInTheDocument()
  })

  it('defaults to hotkey first and shows the current translation and clear bindings', async () => {
    const initial = fixture({ preferences: { ...DEFAULT_SCREEN_TRANSLATION } })
    const { api, emit } = harness(initial)
    render(<ScreenTranslationSurface api={api} />)
    expect(await screen.findByRole('button', { name: '等待快捷键' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: '翻译方式' })).toHaveTextContent('大模型')
    expect(screen.getByRole('combobox', { name: '目标语言' })).toHaveTextContent('自动')
    expect(screen.getByRole('button', { name: '管理大模型' })).toBeVisible()
    expect(screen.getByRole('heading', { name: '悬浮翻译窗' })).toBeInTheDocument()
    expect(screen.getByText('Ctrl+Shift+A')).toHaveClass('screen-translation-shortcut')
    expect(screen.getByText('Ctrl+Shift+D')).toHaveClass('screen-translation-shortcut')
    fireEvent.click(screen.getByRole('combobox', { name: '触发方式' }))
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['快捷键', '自动'])
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    emit({ ...initial, shortcuts: { ...initial.shortcuts, clear: 'Ctrl+Alt+D' } })
    expect(screen.getByText('Ctrl+Alt+D')).toBeInTheDocument()
    expect(screen.queryByText('Ctrl+Shift+D')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除译文' }))
    expect(api.command).toHaveBeenCalledWith('clear')
  })
  it('offers automatic and fixed language choices and dispatches commands without optimistic state', async () => {
    const { api } = harness()
    render(<ScreenTranslationSurface api={api} />)
    await screen.findByRole('button', { name: '开始翻译' })
    fireEvent.click(screen.getByRole('combobox', { name: '目标语言' }))
    expect(screen.getByRole('option', { name: '自动' })).toBeVisible()
    fireEvent.click(screen.getByRole('option', { name: '英语' }))
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ target: 'en' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '开始翻译' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: '开始翻译' }))
    await waitFor(() => expect(api.command).toHaveBeenCalledWith('start'))
    expect(screen.queryByRole('button', { name: '暂停翻译' })).not.toBeInTheDocument()
  })

  it('requires credentials for translation but keeps configuration and close available', async () => {
    const { api } = harness(fixture({ configuredBaidu: false }))
    render(<ScreenTranslationSurface api={api} />)
    expect(await screen.findByRole('button', { name: '开始翻译' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '翻译一次' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '关闭悬浮翻译窗' })).toBeEnabled()
    fireEvent.click(screen.getByText('百度智能云密钥'))
    expect(screen.getByLabelText('API Key')).toBeEnabled()
    expect(screen.getByLabelText('API Key')).toHaveAttribute('type', 'password')
    expect(screen.getByLabelText('Secret Key')).toHaveValue('')
  })

  it('keeps pause and close available during save and clears credential inputs after success', async () => {
    const initial = fixture()
    initial.status.automatic = true
    const { api } = harness(initial)
    let finish!: (value: ScreenTranslationSnapshot) => void
    vi.mocked(api.saveBaiduCredentials).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<ScreenTranslationSurface api={api} />)
    await screen.findByRole('button', { name: '暂停翻译' })
    fireEvent.click(screen.getByText('百度智能云密钥'))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-key' } })
    fireEvent.change(screen.getByLabelText('Secret Key'), { target: { value: 'synthetic-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }))
    expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '暂停翻译' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭悬浮翻译窗' }))
    expect(api.command).toHaveBeenCalledWith('pause')
    expect(api.command).toHaveBeenCalledWith('close')
    expect(api.saveBaiduCredentials).toHaveBeenCalledTimes(1)
    await act(async () => finish(initial))
    expect(screen.getByLabelText('API Key')).toHaveValue('')
    expect(screen.getByLabelText('Secret Key')).toHaveValue('')
  })

  it('subscribes before initial read and ignores a late initial state', async () => {
    const { api, emit, unsubscribe } = harness()
    let finish!: (value: ScreenTranslationSnapshot) => void
    vi.mocked(api.getState).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const mounted = render(<ScreenTranslationSurface api={api} />)
    const latest = fixture({ theme: { mode: 'dark', accent: '#2563EB' } })
    latest.status.automatic = true
    emit(latest)
    await act(async () => finish(fixture()))
    expect(screen.getByRole('button', { name: '暂停翻译' })).toBeEnabled()
    expect(document.documentElement).toHaveAttribute('data-arkdown-theme', 'dark')
    expect(document.documentElement.style.getPropertyValue('--theme-color-rgb')).toBe('37 99 235')
    mounted.unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('opens existing model management and shows no unsupported thinking controls', async () => {
    const initial = fixture()
    initial.preferences.backend = 'model'
    const { api } = harness(initial)
    render(<ScreenTranslationSurface api={api} />)
    const manage = await screen.findByRole('button', { name: '管理大模型' })
    expect(screen.getByRole('button', { name: '开始翻译' })).toBeDisabled()
    expect(screen.queryByRole('combobox', { name: '悬浮翻译窗思考' })).not.toBeInTheDocument()
    fireEvent.click(manage)
    await waitFor(() => expect(api.command).toHaveBeenCalledWith('open-models'))
  })

  it.each(['toggle', 'fixed'] as const)('hides effort for a %s thinking model while preserving the thinking switch and saved preference', async thinking => {
    const initial = fixture()
    initial.preferences = { ...initial.preferences, backend: 'model', connectionId: 'fixture', thinkingMode: 'enabled', reasoningEffort: 'high' }
    initial.models.connections = [{
      id: 'fixture', name: 'Synthetic model', provider: 'deepseek', protocol: 'openai', accessType: 'standard-api',
      baseUrl: 'https://example.invalid/v1', modelId: 'fixture', apiKeyHint: 'synthetic', status: 'connected', lastTestedAt: null,
      capabilityOverride: { thinking: { thinking, encoding: 'thinking-effort', efforts: ['low', 'high'],
        defaultThinking: 'enabled', defaultEffort: 'low', disabledEfforts: [] } },
    }]
    const { api } = harness(initial)
    render(<ScreenTranslationSurface api={api} />)
    await screen.findByRole('button', { name: '管理大模型' })
    expect(screen.queryByRole('combobox', { name: '悬浮翻译窗推理强度' })).not.toBeInTheDocument()
    if (thinking === 'toggle') {
      fireEvent.click(screen.getByRole('combobox', { name: '悬浮翻译窗思考' }))
      fireEvent.click(screen.getByRole('option', { name: '关' }))
      await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ thinkingMode: 'disabled' }))
      expect(screen.getByRole('combobox', { name: '悬浮翻译窗思考' })).toHaveTextContent('关')
    } else {
      expect(screen.queryByText('思考模式')).not.toBeInTheDocument()
      expect(api.updateSettings).not.toHaveBeenCalled()
    }
    expect(initial.preferences.reasoningEffort).toBe('high')
  })

  it('does not show sensitive exception details after credential failure', async () => {
    const { api } = harness()
    vi.mocked(api.saveBaiduCredentials).mockRejectedValue(new Error('synthetic-secret-in-error'))
    render(<ScreenTranslationSurface api={api} />)
    await screen.findByRole('button', { name: '开始翻译' })
    fireEvent.click(screen.getByText('百度智能云密钥'))
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-key' } })
    fireEvent.change(screen.getByLabelText('Secret Key'), { target: { value: 'synthetic-secret' } })
    fireEvent.click(screen.getByRole('button', { name: '保存密钥' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('密钥保存失败')
    expect(screen.queryByText('synthetic-secret-in-error')).not.toBeInTheDocument()
  })
})
