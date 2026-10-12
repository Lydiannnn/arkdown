import { useState, type ComponentProps } from 'react'
import { modelObservation, modelCommit } from '../helpers/model-observation'
import { ModelPreferenceDraft } from '../../src/renderer/settings/model-preference-draft'
import type { PublicModelSettingsSnapshot } from '../../src/shared/settings-observation'
import { createSettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-schema'
import { reduceSettingsTransaction } from '../../src/main/settings/settings-transaction-reducer'
import { modelFeatureRequest, observeModelSettings, publicModelMutation } from '../../src/main/settings/settings-command-adapter'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { PreferencesPage as ActualPreferencesPage } from '../../src/renderer/settings/PreferencesPage'
import { choosePreferencesOption } from './preferences-select-test-helpers'
import {
  DEFAULT_LARGE_MODEL_SETTINGS,
  type LargeModelSettings,
  type ModelConnectionSummary,
} from '../../src/shared/large-model-settings'
import { DEFAULT_ARKNOTE_PREFERENCES } from '../../src/shared/arknote-preferences'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { ShellIntegrationSnapshot } from '../../src/shared/shell-integration-preferences'
import { ShellIntegrationPreferenceDraft } from '../../src/renderer/settings/shell-integration-preference-draft'
import { createPreferencePersistence } from '../../src/renderer/settings/preference-update-queue'
import type { ScreenshotOcrModelState } from '../../src/shared/screenshot-ocr-models'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { ModelConnectionService } from '../../src/main/models/model-connection-service'

function PreferencesPage(props: ComponentProps<typeof ActualPreferencesPage>) {
  const [owner] = useState(() => { const draft = new ModelPreferenceDraft(createPreferencePersistence()); draft.accept(modelObservation(props.initialLargeModels ?? DEFAULT_LARGE_MODEL_SETTINGS)); return draft })
  return <ActualPreferencesPage {...props} modelPreferences={props.modelPreferences ?? owner} />
}

const initialAppearance = {
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: false,
  editorTheme: 'minimal' as const,
  headingLatinFont: 'Arial',
  headingCjkFont: 'SimHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'SimHei',
  themeColor: '#800080',
  micaOpacityPercent: 0 as const,
}
const systemFonts = ['Arial', 'Georgia', 'Microsoft YaHei', 'SimHei']
const preferencesCss = readFileSync(
  path.join(process.cwd(), 'src/renderer/settings/search-preferences.css'),
  'utf8',
).replace(/\r\n/g, '\n')

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return { promise, resolve, reject }
}

const mediumAbsent: ScreenshotOcrModelState = {
  activeTier: 'small',
  bundledVersion: '1.0.0',
  mediumVersion: null,
  availableMediumVersion: '1.1.0',
  status: 'medium-absent',
  progress: null,
  errorCode: null,
}

function observedOcr(state: ScreenshotOcrModelState) {
  return { state, observed: { revision: 0, preferredTier: state.activeTier, tierRevision: 0 } }
}

const mediumDownloading: ScreenshotOcrModelState = {
  ...mediumAbsent,
  status: 'medium-downloading',
  progress: { receivedBytes: 25, totalBytes: 100 },
}

const mediumInstalled: ScreenshotOcrModelState = {
  ...mediumAbsent,
  activeTier: 'medium',
  mediumVersion: '1.1.0',
  availableMediumVersion: null,
  status: 'medium-installed',
}

const mediumFailedWithInstalledModel: ScreenshotOcrModelState = {
  ...mediumInstalled,
  availableMediumVersion: '1.2.0',
  status: 'medium-failed',
  errorCode: 'OPERATION_FAILED',
}

const instantProps = {
  initialAppearance,
  initialLargeModels: DEFAULT_LARGE_MODEL_SETTINGS,
  initialArknote: { ...DEFAULT_ARKNOTE_PREFERENCES, registerDesktopContextMenu: false },
  initialSearch: { provider: 'bing' as const, customTemplate: '' },
  onAppearanceChange: () => undefined,
  onSearchChange: () => undefined,
  onArknoteChange: () => undefined,
  onClose: () => undefined,
  systemFonts,
}

it('clearly disables and re-enables bundled Medium while explaining that its packaged files remain', async () => {
  const enabled = { ...mediumInstalled, mediumSource: 'bundled' as const }
  const disabled = { ...enabled, activeTier: 'small' as const, status: 'medium-disabled' as const }
  let current: ScreenshotOcrModelState = enabled
  const remove = vi.fn(async () => { current = disabled; return { ok: true as const, value: current } })
  const enable = vi.fn(async () => { current = enabled; return { ok: true as const, value: current } })
  window.arkdown = { ...window.arkdown, getScreenshotOcrModelState: async () => ({ ok: true, value: observedOcr(current) }),
    removeScreenshotOcrMedium: remove, downloadScreenshotOcrMedium: enable,
    onScreenshotOcrModelState: () => () => undefined }
  render(<PreferencesPage {...instantProps} />)
  fireEvent.click(await screen.findByRole('button', { name: '停用' }))
  const dialog = screen.getByRole('dialog', { name: '是否停用PP-OCRv6 Medium模型？' })
  expect(within(dialog).getByText(/内置文件.*保留/)).toBeVisible()
  expect(within(dialog).queryByText(/删除后/)).not.toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: '是' }))
  expect(await screen.findByText('已停用')).toBeVisible()
  expect(screen.getByText(/Full.*内置文件.*保留/)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '启用' }))
  expect(await screen.findByText('已启用')).toBeVisible()
  expect(remove).toHaveBeenCalledOnce()
  expect(enable).toHaveBeenCalledOnce()
})

it('refreshes bundled OCR presentation on focus but keeps a pending confirmation observation', async () => {
  let current = { state: { ...mediumInstalled, mediumSource: 'bundled' as const }, observed: {
    revision: 2, preferredTier: 'medium' as const, tierRevision: 2,
  } }
  const get = vi.fn(async () => ({ ok: true as const, value: current }))
  const remove = vi.fn(async () => ({ ok: true as const, value: { status: 'conflict' as const } }))
  window.arkdown = { ...window.arkdown, getScreenshotOcrModelState: get, removeScreenshotOcrMedium: remove,
    onScreenshotOcrModelState: () => () => undefined }
  render(<PreferencesPage {...instantProps} />)
  const button = await screen.findByRole('button', { name: '停用' })
  current = { ...current, observed: { ...current.observed, revision: 3, tierRevision: 3 } }
  fireEvent(window, new Event('focus'))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  fireEvent.click(button)
  current = { ...current, observed: { ...current.observed, revision: 4, tierRevision: 4 } }
  fireEvent(window, new Event('focus'))
  fireEvent.click(within(screen.getByRole('dialog', { name: '是否停用PP-OCRv6 Medium模型？' })).getByRole('button', { name: '是' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith({ revision: 3, preferredTier: 'medium', tierRevision: 3 }))
})

it('keeps the download/update route for a disabled older bundled generation', async () => {
  const old = { ...mediumInstalled, mediumSource: 'bundled' as const, activeTier: 'small' as const,
    status: 'medium-disabled' as const, availableMediumVersion: '1.2.0' }
  const download = vi.fn(async () => ({ ok: true as const, value: mediumInstalled }))
  window.arkdown = { ...window.arkdown, getScreenshotOcrModelState: async () => ({ ok: true, value: observedOcr(old) }),
    downloadScreenshotOcrMedium: download, onScreenshotOcrModelState: () => () => undefined }
  render(<PreferencesPage {...instantProps} />)
  fireEvent.click(await screen.findByRole('button', { name: '下载并更新' }))
  await waitFor(() => expect(download).toHaveBeenCalledOnce())
  expect(screen.queryByRole('dialog', { name: /是否/ })).not.toBeInTheDocument()
})

it('cannot open an OCR remove confirmation from a state event before its observed baseline is ready', async () => {
  const initial = deferred<Awaited<ReturnType<NonNullable<ArkdownApi['getScreenshotOcrModelState']>>>>()
  let changed!: (state: ScreenshotOcrModelState) => void
  const remove = vi.fn<NonNullable<ArkdownApi['removeScreenshotOcrMedium']>>(async () => ({ ok: true, value: { status: 'conflict' } }))
  window.arkdown = { ...window.arkdown, getScreenshotOcrModelState: () => initial.promise,
    onScreenshotOcrModelState: listener => { changed = listener; return () => {} }, removeScreenshotOcrMedium: remove }
  render(<PreferencesPage {...instantProps} />)
  act(() => changed(mediumInstalled))
  const action = screen.getByRole('button', { name: '已安装' })
  expect(action).toBeDisabled()
  fireEvent.click(action)
  expect(screen.queryByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })).not.toBeInTheDocument()
  const observed = { revision: 9, preferredTier: 'medium' as const, tierRevision: 9 }
  await act(async () => initial.resolve({ ok: true, value: { state: mediumInstalled, observed } }))
  expect(remove).not.toHaveBeenCalled()
  expect(action).toBeEnabled()
  fireEvent.click(action)
  fireEvent.click(within(screen.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })).getByRole('button', { name: '是' }))
  await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(observed))
})

it('retains the displayed OCR observation on failed retries and requires explicit refresh after a conflict', async () => {
  const observed = { revision: 5, preferredTier: 'small' as const, tierRevision: 3 }
  const get = vi.fn(async () => ({ ok: true, value: { state: mediumAbsent, observed } }))
  const download = vi.fn().mockResolvedValueOnce({ ok: false, error: { code: 'OPERATION_FAILED', message: 'failed' } })
    .mockResolvedValueOnce({ ok: true, value: { status: 'conflict' } })
  let changed: ((state: ScreenshotOcrModelState) => void) | undefined
  window.arkdown = { getScreenshotOcrModelState: get, downloadScreenshotOcrMedium: download,
    onScreenshotOcrModelState: (listener: typeof changed) => { changed = listener; return () => undefined } } as unknown as ArkdownApi
  render(<PreferencesPage {...instantProps} />)
  fireEvent.click(await screen.findByRole('button', { name: '下载并更新' }))
  await screen.findByText('下载失败，请稍后重试。')
  fireEvent.click(screen.getByRole('button', { name: '下载并更新' }))
  expect(await screen.findByText('OCR 模型偏好已在其他窗口修改，请刷新后核对，再重新操作。')).toBeVisible()
  expect(download.mock.calls).toEqual([[observed], [observed]])
  act(() => changed?.(mediumAbsent))
  expect(screen.getByText('OCR 模型偏好已在其他窗口修改，请刷新后核对，再重新操作。')).toBeVisible()
  expect(get).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '刷新 OCR 设置' }))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect(download).toHaveBeenCalledTimes(2)
})

function floatingWindowHarness() {
  const initial: LargeModelSettings = { ...structuredClone(DEFAULT_LARGE_MODEL_SETTINGS), codexCli: {
    cliVersion: '1.0', status: 'connected', lastTestedAt: '2026-09-01T00:00:00.000Z',
    models: ['a', 'b'].map(modelId => ({ modelId, displayName: modelId.toUpperCase(), supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', isDefault: modelId === 'a' })),
  }, floatingTranslation: { connectionId: 'codex-cli:a', thinkingMode: 'enabled', reasoningEffort: 'low' } }
  let state = { ...createSettingsTransactionSnapshot({ lastWorkspace: null, models: initial }), revision: 1 }
  const apply = (patch: Parameters<ArkdownApi['setFloatingTranslationSettings']>[0], observed: PublicModelSettingsSnapshot) => {
    const reduced = reduceSettingsTransaction(state, modelFeatureRequest(observed, 'floatingTranslation', patch))
    if (reduced.status === 'prepared') { state = reduced.snapshot; return publicModelMutation({ status: 'committed', snapshot: state, cleanupPending: false }) }
    return publicModelMutation(reduced)
  }
  const service = { getSettings: () => observeModelSettings(state).settings,
    setFloatingTranslation: async (patch: Parameters<ArkdownApi['setFloatingTranslationSettings']>[0]) => apply(patch, observeModelSettings(state)) }
  const get = vi.fn(async () => ({ ok: true as const, value: observeModelSettings(state) }))
  const save = vi.fn<ArkdownApi['setFloatingTranslationSettings']>(async (patch, observed) => ({ ok: true, value: apply(patch, observed) }))
  window.arkdown = { getModelSettingsSnapshot: get, setFloatingTranslationSettings: save } as unknown as ArkdownApi
  return { initial, service, get, save }
}

it('keeps the independently selected floating model when the stale manager changes only language', async () => {
  const { initial, service, save } = floatingWindowHarness()
  render(<PreferencesPage {...instantProps} initialLargeModels={initial} initialTarget="large-model-manager" />)
  await service.setFloatingTranslation({ ...initial.floatingTranslation!, connectionId: 'codex-cli:b' })
  await choosePreferencesOption('悬浮翻译窗目标语言', '日语')
  await waitFor(() => expect(save).toHaveBeenCalledWith({ target: 'jp' }, expect.objectContaining({ observation: expect.objectContaining({ revision: 1 }) })))
  expect(service.getSettings().floatingTranslation).toEqual({ connectionId: 'codex-cli:b', thinkingMode: 'enabled', reasoningEffort: 'low', target: 'jp' })
  expect(screen.getByRole('combobox', { name: '悬浮翻译窗模型' })).toHaveTextContent('Codex CLI · B')
})

it.each(['top', 'large-model-manager'] as const)('refreshes the %s model view after another window saves and this window regains focus', async initialTarget => {
  const { initial, service, get } = floatingWindowHarness()
  const changed = vi.fn()
  render(<PreferencesPage {...instantProps} initialLargeModels={initial} initialTarget={initialTarget} onLargeModelsChange={changed} />)
  await service.setFloatingTranslation({ ...initial.floatingTranslation!, connectionId: 'codex-cli:b' })
  fireEvent.focus(window)
  await waitFor(() => expect(get).toHaveBeenCalled())
  await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.objectContaining({ floatingTranslation: expect.objectContaining({ connectionId: 'codex-cli:b' }) })))
  await waitFor(() => {
    const view = initialTarget === 'top' ? screen.getByRole('group', { name: '当前悬浮翻译窗模型' }) : screen.getByRole('combobox', { name: '悬浮翻译窗模型' })
    expect(view).toHaveTextContent('Codex CLI · B')
  })
})

it('ignores a focus read that arrives after a newer floating binding save', async () => {
  const { initial, get } = floatingWindowHarness()
  const stale = deferred<{ ok: true; value: PublicModelSettingsSnapshot }>()
  get.mockReturnValueOnce(stale.promise)
  render(<PreferencesPage {...instantProps} initialLargeModels={initial} initialTarget="large-model-manager" />)
  fireEvent.focus(window)
  await choosePreferencesOption('悬浮翻译窗模型', 'Codex CLI · B')
  await waitFor(() => expect(screen.getByRole('combobox', { name: '悬浮翻译窗模型' })).toHaveTextContent('Codex CLI · B'))
  await act(async () => { stale.resolve({ ok: true, value: modelObservation(initial) }); await stale.promise })
  expect(screen.getByRole('combobox', { name: '悬浮翻译窗模型' })).toHaveTextContent('Codex CLI · B')
})

it('opens material settings in the shared shell and returns on Escape without closing preferences', async () => {
  window.arkdown = {} as ArkdownApi
  const onClose = vi.fn()
  render(<PreferencesPage {...instantProps} onClose={onClose} />)
  const viewport = screen.getByRole('region', { name: '设置内容' })
  viewport.scrollTop = 432
  fireEvent.click(screen.getByRole('button', { name: '材质设置' }))
  expect(screen.getByRole('heading', { name: '材质设置', level: 1 })).toBeVisible()
  await waitFor(() => expect(viewport.scrollTop).toBe(0))
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.getByRole('heading', { name: '偏好设置', level: 1 })).toBeVisible()
  await waitFor(() => expect(viewport.scrollTop).toBe(432))
  expect(onClose).not.toHaveBeenCalled()
})

it('persists material edits immediately while preserving the other customized material groups', () => {
  window.arkdown = {} as ArkdownApi
  const onArknoteChange = vi.fn()
  const initialArknote = structuredClone(instantProps.initialArknote)
  initialArknote.micaAppearance.luminosityOpacity = .66
  initialArknote.glassAppearances['clear-glass'].luminosityOpacity = .61
  initialArknote.materialEffects['warm-frosted-glass'].transparency = .27
  render(<PreferencesPage {...instantProps} initialArknote={initialArknote} onArknoteChange={onArknoteChange} />)
  fireEvent.click(screen.getByRole('button', { name: '材质设置' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Mica 明度融合' }), { target: { value: '42' } })
  expect(onArknoteChange).toHaveBeenCalledOnce()
  const patch = onArknoteChange.mock.calls[0]![0]
  expect(Object.keys(patch).sort()).toEqual(['glassAppearances', 'materialEffects', 'micaAppearance'])
  expect(patch).toEqual({
    micaAppearance: { ...initialArknote.micaAppearance, luminosityOpacity: .42 },
    glassAppearances: initialArknote.glassAppearances,
    materialEffects: initialArknote.materialEffects,
  })
  expect(initialArknote.micaAppearance.luminosityOpacity).toBe(.66)
})

it('shows three top-level context menu choices before models and retains the pending choice', async () => {
  const observed: ShellIntegrationSnapshot = { values: { documentOpenMenu: false, markdownShellNew: false }, unavailable: [],
    observation: { version: 1, revision: 0, minimumBaseRevision: 0, fields: {} } }
  const native = deferred<{ ok: true; value: ShellIntegrationSnapshot }>()
  const update = vi.fn(() => native.promise)
  const desktop = vi.fn(async () => { throw new Error('桌面菜单冲突') })
  window.arkdown = {
    getShellIntegrationPreferences: async () => ({ ok: true, value: observed }),
    updateShellIntegrationPreference: update,
  } as unknown as ArkdownApi
  render(<PreferencesPage {...instantProps} onDesktopContextMenuChange={desktop}
    shellPreferences={new ShellIntegrationPreferenceDraft(createPreferencePersistence())} />)
  const section = screen.getByRole('region', { name: '右键菜单' })
  expect(within(section).getAllByRole('checkbox')).toHaveLength(4)
  expect(screen.getByRole('heading', { name: 'md/txt默认程序', level: 3 })).toBeVisible()
  expect(screen.getByRole('link', { name: 'md/txt默认程序' })).toHaveClass('preferences-toc-secondary')
  expect(screen.getByRole('link', { name: '右键菜单' })).toHaveClass('preferences-toc-primary')
  expect(section.compareDocumentPosition(screen.getByRole('heading', { name: '大模型设置' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const document = within(section).getByRole('checkbox', { name: 'md/txt文档上右键增加“使用Arkdown打开”' })
  await waitFor(() => expect(document).toBeEnabled())
  expect(update).not.toHaveBeenCalled()
  fireEvent.click(document)
  expect(document).toBeChecked()
  expect(document).toBeDisabled()
  expect(within(section).getByText('正在应用…')).toBeVisible()
  await act(async () => native.resolve({ ok: true, value: { ...observed, values: { documentOpenMenu: true, markdownShellNew: false },
    observation: { ...observed.observation, revision: 1, fields: { documentOpenMenu: 1 } } } }))
  expect(document).toBeChecked()
  fireEvent.click(within(section).getByRole('checkbox', { name: '在桌面右键菜单中增加“创建新便签”' }))
  expect(await within(section).findByRole('alert')).toHaveTextContent('桌面菜单冲突')
  expect(within(section).getByRole('checkbox', { name: '在桌面右键菜单中增加“创建新便签”' })).not.toBeChecked()
  expect(update).toHaveBeenCalledExactlyOnceWith({ feature: 'documentOpenMenu', enabled: true, observed })
})

it('opens the separate main background session from Theme using the existing API', async () => {
  const openBackgroundSettings = vi.fn(async () => ({ ok: true as const, value: undefined }))
  Object.defineProperty(window, 'arkdown', { configurable: true, writable: true, value: { openBackgroundSettings } })
  render(<PreferencesPage {...instantProps} />)
  const theme = screen.getByRole('region', { name: '主题' })
  const colorHeading = within(theme).getByRole('heading', { name: '主题颜色', level: 3 })
  const backgroundHeading = within(theme).getByRole('heading', { name: '设置背景', level: 3 })
  expect(colorHeading.parentElement?.parentElement).toBe(backgroundHeading.parentElement?.parentElement)
  expect(within(theme).queryByRole('button', { name: '恢复默认颜色' })).not.toBeInTheDocument()
  expect(within(theme).getByRole('group', { name: '主题颜色' }).compareDocumentPosition(backgroundHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(screen.getByRole('link', { name: '设置背景' })).toHaveAttribute('href', '#preferences-background-heading')
  fireEvent.click(within(theme).getByRole('button', { name: '打开设置窗口' }))
  await waitFor(() => expect(openBackgroundSettings).toHaveBeenCalledExactlyOnceWith({ kind: 'main' }))
  expect(screen.getByRole('main', { name: '偏好设置' })).toBeVisible()
})

it('shows a failed background-window open beside the Theme entry', async () => {
  Object.defineProperty(window, 'arkdown', { configurable: true, writable: true, value: {
    openBackgroundSettings: async () => ({ ok: false, error: { message: '背景窗口无法打开' } }),
  } })
  render(<PreferencesPage {...instantProps} />)
  fireEvent.click(screen.getByRole('button', { name: '打开设置窗口' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('背景窗口无法打开'))
})

it('instant preferences expose a secondary Close footer without save or cancel actions', () => {
  render(<><style>{preferencesCss}</style><PreferencesPage {...instantProps} /></>)

  expect(screen.getByRole('button', { name: '关闭' })).toHaveClass('preferences-footer-secondary-action')
  expect(getComputedStyle(screen.getByRole('main', { name: '偏好设置' })).gridTemplateRows)
    .toBe('52px minmax(0, 1fr) 64px')
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
})

it('instant preferences emit each valid edit only to its category', async () => {
  const desktopChange = vi.fn(async () => {})
  const appearanceChange = vi.fn()
  const searchChange = vi.fn()
  const arknoteChange = vi.fn()
  render(<PreferencesPage {...instantProps}
    onAppearanceChange={appearanceChange}
    onSearchChange={searchChange}
    onArknoteChange={arknoteChange}
    onDesktopContextMenuChange={desktopChange}
  />)

  fireEvent.click(screen.getByRole('checkbox', { name: '拼写检查' }))
  expect(appearanceChange).toHaveBeenLastCalledWith({ spellCheckEnabled: true })
  choosePreferencesOption('标题英文', 'Georgia')
  expect(appearanceChange).toHaveBeenLastCalledWith({ headingLatinFont: 'Georgia' })
  fireEvent.change(screen.getByLabelText('最小边距'), { target: { value: '70' } })
  expect(appearanceChange).toHaveBeenLastCalledWith({ minimumContentMarginPx: 70 })
  expect(searchChange).not.toHaveBeenCalled()
  expect(arknoteChange).not.toHaveBeenCalled()

  choosePreferencesOption('搜索提供商', '百度（默认）')
  expect(searchChange).toHaveBeenCalledExactlyOnceWith({ provider: 'baidu', customTemplate: '' })
  expect(appearanceChange).toHaveBeenCalledTimes(3)
  fireEvent.click(screen.getByRole('checkbox', { name: '开机启动' }))
  expect(arknoteChange).toHaveBeenCalledExactlyOnceWith({ launchAtLogin: true })
  fireEvent.click(screen.getByRole('checkbox', { name: '在桌面右键菜单中增加“创建新便签”' }))
  await waitFor(() => expect(desktopChange).toHaveBeenCalledExactlyOnceWith(true))
})

it('instant search keeps invalid input local until the template is valid', () => {
  const searchChange = vi.fn()
  render(<PreferencesPage {...instantProps} onSearchChange={searchChange} />)

  choosePreferencesOption('搜索提供商', '自定义')
  expect(searchChange).not.toHaveBeenCalled()
  const template = screen.getByRole('textbox', { name: '自定义搜索地址' })
  fireEvent.change(template, { target: { value: 'https://example.com/search?q=' } })
  expect(template).toHaveValue('https://example.com/search?q=')
  expect(searchChange).not.toHaveBeenCalled()

  fireEvent.change(template, { target: { value: ' https://example.com/search?q={query} ' } })
  expect(searchChange).toHaveBeenCalledExactlyOnceWith({
    provider: 'custom', customTemplate: 'https://example.com/search?q={query}',
  })
  fireEvent.change(template, { target: { value: 'http://example.com/search?q={query}' } })
  expect(searchChange).toHaveBeenCalledTimes(1)
})

it('instant preferences reflect acknowledged or rolled-back props without resubmitting', () => {
  const appearanceChange = vi.fn()
  const searchChange = vi.fn()
  const arknoteChange = vi.fn()
  const props = { ...instantProps, onAppearanceChange: appearanceChange, onSearchChange: searchChange, onArknoteChange: arknoteChange }
  const view = render(<PreferencesPage {...props} />)

  view.rerender(<PreferencesPage {...props}
    initialAppearance={{
      ...initialAppearance, themeColor: '#2563EB', headingLatinFont: 'Georgia',
      bodyCjkFont: 'Microsoft YaHei', minimumContentMarginPx: 60,
      maximumContentWidthPx: 900, preserveSingleLineBreaks: false, spellCheckEnabled: true,
    }}
    initialSearch={{ provider: 'custom', customTemplate: 'https://example.com/?q={query}' }}
    initialArknote={{ ...DEFAULT_ARKNOTE_PREFERENCES, launchAtLogin: true, registerDesktopContextMenu: true }}
  />)

  expect(screen.getByLabelText('当前主题颜色')).toHaveTextContent('#2563EB')
  expect(screen.getByLabelText('标题英文')).toHaveTextContent('Georgia')
  expect(screen.getByLabelText('正文中文')).toHaveTextContent('Microsoft YaHei')
  expect(screen.getByLabelText('最小边距')).toHaveValue('60')
  expect(screen.getByLabelText('正文宽度')).toHaveValue('900')
  expect(screen.getByLabelText('保留单个换行')).not.toBeChecked()
  expect(screen.getByLabelText('拼写检查')).toBeChecked()
  expect(screen.getByLabelText('自定义搜索地址')).toHaveValue('https://example.com/?q={query}')
  expect(screen.getByRole('checkbox', { name: '开机启动' })).toBeChecked()
  expect(screen.getByLabelText('在桌面右键菜单中增加“创建新便签”')).toBeChecked()

  view.rerender(<PreferencesPage {...props} />)
  expect(screen.getByLabelText('正文宽度')).toHaveValue('1200')
  expect(screen.getByRole('checkbox', { name: '开机启动' })).not.toBeChecked()
  expect(appearanceChange).not.toHaveBeenCalled()
  expect(searchChange).not.toHaveBeenCalled()
  expect(arknoteChange).not.toHaveBeenCalled()
})

it('instant preferences keep an invalid search draft during unrelated acknowledgements', () => {
  const searchChange = vi.fn()
  const props = { ...instantProps, onSearchChange: searchChange }
  const view = render(<PreferencesPage {...props} />)
  choosePreferencesOption('搜索提供商', '自定义')
  fireEvent.change(screen.getByLabelText('自定义搜索地址'), { target: { value: 'https://example.com/?q=' } })

  view.rerender(<PreferencesPage {...props}
    initialAppearance={{ ...initialAppearance, spellCheckEnabled: true }}
    initialSearch={{ provider: 'bing', customTemplate: '' }}
  />)

  expect(screen.getByLabelText('自定义搜索地址')).toHaveValue('https://example.com/?q=')
  expect(searchChange).not.toHaveBeenCalled()
})

it('instant preferences surface write failure without disabling edits or return', () => {
  const close = vi.fn()
  const appearanceChange = vi.fn()
  render(<PreferencesPage {...instantProps} onClose={close} onAppearanceChange={appearanceChange}
    persistenceError="设置保存失败，请重试。" />)

  expect(screen.getByRole('alert')).toHaveTextContent('设置保存失败，请重试。')
  fireEvent.click(screen.getByRole('checkbox', { name: '拼写检查' }))
  expect(appearanceChange).toHaveBeenCalledWith({ spellCheckEnabled: true })
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  expect(close).toHaveBeenCalledOnce()
})

it('reloads saved preferences only after the explicit conflict action', () => {
  const reload = vi.fn()
  render(<PreferencesPage {...instantProps} persistenceError="这些设置已在其他窗口更改。你的修改仍保留。"
    onReloadSavedPreferences={reload} />)
  expect(reload).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重新加载已保存设置' }))
  expect(reload).toHaveBeenCalledOnce()
})

it('instant preferences use both manager returns to reach summary before closing', () => {
  const close = vi.fn()
  window.arkdown = {} as ArkdownApi
  render(<><style>{preferencesCss}</style><PreferencesPage {...instantProps} onClose={close} /></>)

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  const footer = screen.getByLabelText('设置操作')
  const returnButton = within(footer).getByRole('button', { name: '返回' })
  expect(getComputedStyle(returnButton).backgroundColor).toBe('rgb(255, 255, 255)')
  expect(getComputedStyle(returnButton).color).toBe('rgb(51, 51, 51)')
  expect(getComputedStyle(screen.getByRole('main', { name: '偏好设置' })).gridTemplateRows)
    .toBe('52px minmax(0, 1fr) 64px')
  fireEvent.click(returnButton)
  expect(screen.getByRole('heading', { name: '偏好设置' })).toBeVisible()
  expect(within(screen.getByLabelText('设置操作')).getByRole('button', { name: '关闭' })).toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  fireEvent.click(screen.getByRole('button', { name: '返回偏好设置' }))
  expect(screen.getByRole('heading', { name: '偏好设置' })).toBeVisible()
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))
  expect(close).toHaveBeenCalledOnce()
})

it('provides a top-left back control that returns to the editor', () => {
  const cancel = vi.fn()
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={cancel}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  const back = screen.getByRole('button', { name: '返回编辑器' })
  expect(back).toHaveClass('preferences-back')
  expect(back).toHaveTextContent('')
  expect(back.querySelector('.app-icon')).not.toBeNull()
  fireEvent.click(back)
  expect(cancel).toHaveBeenCalledOnce()
})

it('keeps the top-left back control exactly 32 CSS px wide', () => {
  expect(preferencesCss).toMatch(/\.preferences-back\s*\{[^}]*\bwidth:\s*32px;/s)
})

it('opens the stable model-manager directory target and marks it current', async () => {
  window.arkdown = {
    connectModel: vi.fn(), listModels: vi.fn(), testModel: vi.fn(), deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(), setAiConversationSettings: vi.fn(),
    setScreenshotTranslationSettings: vi.fn(),
  } as unknown as ArkdownApi
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  const managerLink = screen.getByRole('link', { name: '管理大模型' })
  expect(managerLink).toHaveAttribute('href', '#preferences-large-model-manager')
  fireEvent.click(managerLink)

  const managerHeading = await screen.findByRole('heading', { name: '管理大模型' })
  expect(managerHeading).toHaveAttribute('id', 'preferences-large-model-manager')
  await waitFor(() => expect(managerLink).toHaveAttribute('aria-current', 'location'))
})

it('persists spelling immediately and follows cross-window prop updates', () => {
  const change = vi.fn()
  const props = { ...instantProps, onAppearanceChange: change }
  const view = render(<PreferencesPage {...props} />)
  const checkbox = screen.getByRole('checkbox', { name: '拼写检查' })
  expect(checkbox).not.toBeChecked()

  view.rerender(<PreferencesPage {...props} initialAppearance={{ ...initialAppearance, spellCheckEnabled: true }} />)
  expect(checkbox).toBeChecked()
  view.rerender(<PreferencesPage {...props} />)
  expect(checkbox).not.toBeChecked()
  expect(change).not.toHaveBeenCalled()

  fireEvent.click(checkbox)
  expect(change).toHaveBeenCalledExactlyOnceWith({ spellCheckEnabled: true })
})

it('does not resubmit cross-window appearance fields when another field changes', () => {
  const change = vi.fn()
  const props = { ...instantProps, onAppearanceChange: change }
  const view = render(<PreferencesPage {...props} initialAppearance={{ ...initialAppearance, showEditIndicators: true }} />)

  view.rerender(<PreferencesPage {...props} initialAppearance={{ ...initialAppearance, showEditIndicators: false }} />)
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })

  expect(change).toHaveBeenCalledExactlyOnceWith({ maximumContentWidthPx: 980 })
})

it('marks the concrete search validation error as selectable', () => {
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'custom', customTemplate: 'http://example.com/search?q={query}' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  expect(screen.getByRole('alert')).toHaveAttribute('data-ui-selectable', 'true')
  expect(screen.getByRole('alert')).toHaveAttribute('tabindex', '0')
})

it('persists a theme swatch immediately without resubmitting other appearance fields', () => {
  const change = vi.fn()
  render(<PreferencesPage {...instantProps} onAppearanceChange={change} />)

  fireEvent.click(screen.getByRole('button', { name: '主题颜色：蓝色' }))
  expect(change).toHaveBeenCalledExactlyOnceWith({ themeColor: '#2563EB' })
})

it('edits search, line breaks, local fonts, and responsive width controls', () => {
  const save = vi.fn()
  const previewAppearance = vi.fn()
  window.arkdown = {
    connectModel: vi.fn(),
    listModels: vi.fn(),
    testModel: vi.fn(),
    deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(),
    setAiConversationSettings: vi.fn(),
  } as unknown as ArkdownApi
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={previewAppearance}
      onClose={() => undefined}
      onSearchChange={save}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  const shell = screen.getByRole('main', { name: '偏好设置' })
  expect(shell).toBeVisible()
  expect(shell).toHaveClass('preferences-shell')
  expect(screen.getByLabelText('窗口拖动区域')).toHaveClass('preferences-page-header')
  expect(screen.getByRole('region', { name: '设置内容' })).toHaveClass('preferences-page-content')
  expect(within(screen.getByLabelText('设置操作')).getByRole('button', { name: '关闭' })).toBeVisible()
  expect(screen.getByRole('heading', { name: '大模型设置' })).toBeVisible()
  expect(screen.getByText('尚未配置大模型应用')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  expect(screen.getByRole('heading', { name: '管理大模型' })).toBeVisible()
  expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '取消' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  expect(screen.getByRole('heading', { name: '大模型设置' })).toBeVisible()
  const directory = screen.getByRole('navigation', { name: '偏好设置目录' })
  expect(directory).toBeVisible()
  for (const [name, target] of [
    ['浏览器搜索', '#preferences-search-heading'],
    ['主题', '#preferences-theme-heading'],
    ['编辑器', '#preferences-editor-heading'],
    ['Arknote', '#preferences-arknote-heading'],
    ['右键菜单', '#preferences-context-menu-heading'],
    ['大模型设置', '#preferences-large-model-heading'],
  ] as const) {
    const link = screen.getByRole('link', { name })
    expect(link).toHaveAttribute('href', target)
    expect(link).toHaveClass('preferences-toc-primary')
  }
  for (const [name, target] of [
    ['主题颜色', '#preferences-theme-color-heading'],
    ['字体选择', '#preferences-font-heading'],
    ['编辑器版面', '#preferences-editor-layout-heading'],
    ['保留单个换行', '#preferences-single-line-breaks-heading'],
    ['开机启动', '#preferences-arknote-startup-heading'],
    ['默认材质', '#preferences-arknote-materials-heading'],
    ['默认颜色', '#preferences-arknote-colors-heading'],
  ] as const) {
    const link = screen.getByRole('link', { name })
    expect(link).toHaveAttribute('href', target)
    expect(link).toHaveClass('preferences-toc-secondary')
  }
  expect(screen.queryByRole('link', { name: '便签设置' })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Mica不透明度' })).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Mica不透明度')).not.toBeInTheDocument()
  expect(directory).not.toContainElement(screen.getByText('最小边距'))
  expect(directory).not.toContainElement(screen.getByText('正文宽度'))
  expect(screen.getByRole('heading', { level: 3, name: '保留单个换行' }))
    .toHaveClass('preferences-secondary-heading')
  expect(screen.getByLabelText('正文宽度').closest('.preferences-range-control')
    ?.querySelector('.preferences-setting-label'))
    .toHaveTextContent('正文宽度')
  expect(screen.getByLabelText('正文宽度')).toHaveAttribute('min', '600')
  expect(screen.getByLabelText('正文宽度')).toHaveAttribute('max', '1200')
  expect(screen.queryByRole('option', { name: 'DuckDuckGo' })).not.toBeInTheDocument()
  for (const select of screen.getAllByRole('combobox')) {
    expect(select).toHaveClass('preferences-compact-select')
    expect(select.closest('label')).toBeNull()
  }
  expect(screen.getByText('搜索提供商')).toHaveClass('preferences-setting-label')
  expect(screen.getByRole('heading', { level: 3, name: '字体选择' }))
    .toHaveClass('preferences-font-heading')
  expect(screen.getByLabelText('保留单个换行').parentElement)
    .toHaveClass('preferences-checkbox-description')
  expect(screen.getByLabelText('标题中文')).toBeVisible()
  expect(screen.getByLabelText('标题英文')).toBeVisible()
  expect(screen.getByLabelText('正文中文')).toBeVisible()
  expect(screen.getByLabelText('正文英文')).toBeVisible()
  choosePreferencesOption('搜索提供商', '百度（默认）')
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '980' } })
  expect(previewAppearance).toHaveBeenLastCalledWith({ maximumContentWidthPx: 980 })
  fireEvent.click(screen.getByLabelText('保留单个换行'))
  choosePreferencesOption('标题英文', 'Georgia')
  choosePreferencesOption('标题中文', 'Microsoft YaHei')
  choosePreferencesOption('正文英文', 'Georgia')
  choosePreferencesOption('正文中文', 'Microsoft YaHei')
  expect(screen.getByText('980px')).toBeVisible()
  expect(save).toHaveBeenCalledExactlyOnceWith({ provider: 'baidu', customTemplate: '' })
  expect(previewAppearance.mock.calls.map(([patch]) => patch)).toEqual([
    { maximumContentWidthPx: 980 },
    { preserveSingleLineBreaks: false },
    { headingLatinFont: 'Georgia' },
    { headingCjkFont: 'Microsoft YaHei' },
    { bodyLatinFont: 'Georgia' },
    { bodyCjkFont: 'Microsoft YaHei' },
  ])
})

it('returns to the editor without reverting an immediately submitted change', () => {
  const close = vi.fn()
  const change = vi.fn()
  render(<PreferencesPage {...instantProps} onClose={close} onAppearanceChange={change} />)

  fireEvent.click(screen.getByRole('checkbox', { name: '拼写检查' }))
  fireEvent.click(screen.getByRole('button', { name: '返回编辑器' }))

  expect(close).toHaveBeenCalledOnce()
  expect(change).toHaveBeenCalledExactlyOnceWith({ spellCheckEnabled: true })
})

it('opens model management directly for the large-model-manager target', () => {
  window.arkdown = {
    connectModel: vi.fn(),
    listModels: vi.fn(),
    testModel: vi.fn(),
    deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(),
    setAiConversationSettings: vi.fn(),
  } as unknown as ArkdownApi
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      initialTarget="large-model-manager"
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  expect(screen.getByRole('heading', { name: '管理大模型' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: '偏好设置' })).not.toBeInTheDocument()
})

it('returns a directly opened model manager to the large-model settings heading', () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', vi.fn((frame: FrameRequestCallback) => {
    frames.push(frame)
    return frames.length
  }))
  window.arkdown = {
    connectModel: vi.fn(), listModels: vi.fn(), testModel: vi.fn(), deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(),
    setAiConversationSettings: vi.fn(),
  } as unknown as ArkdownApi
  try {
    render(
      <PreferencesPage
        initialAppearance={initialAppearance}
        initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
        initialSearch={{ provider: 'bing', customTemplate: '' }}
        initialTarget="large-model-manager"
        onAppearanceChange={() => undefined}
        onClose={() => undefined}
        onSearchChange={() => undefined}
        onArknoteChange={() => undefined}
        systemFonts={systemFonts}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '返回' }))
    const viewport = screen.getByRole('region', { name: '设置内容' })
    const heading = screen.getByRole('heading', { name: '大模型设置' })
    const scrollTo = vi.fn()
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 3000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })
    viewport.getBoundingClientRect = () => ({ top: 100 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 900 } as DOMRect)
    Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo })
    act(() => frames.at(-1)?.(0))

    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 700 })
    expect(heading).toHaveFocus()
  } finally {
    vi.unstubAllGlobals()
  }
})

it('scrolls and focuses the current large-model target after mount', () => {
  const requestFrame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  try {
    render(
      <PreferencesPage
        initialAppearance={initialAppearance}
        initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
        initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
        initialSearch={{ provider: 'bing', customTemplate: '' }}
        initialTarget="large-model-current"
        onAppearanceChange={() => undefined}
        onClose={() => undefined}
        onSearchChange={() => undefined}
        onArknoteChange={() => undefined}
        systemFonts={systemFonts}
      />,
    )

    const viewport = screen.getByRole('region', { name: '设置内容' })
    const heading = screen.getByRole('heading', { name: '大模型设置' })
    const scrollTo = vi.fn()
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 3000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })
    viewport.getBoundingClientRect = () => ({ top: 100 } as DOMRect)
    heading.getBoundingClientRect = () => ({ top: 600 } as DOMRect)
    Object.defineProperty(viewport, 'scrollTo', { configurable: true, value: scrollTo })

    const frame = requestFrame.mock.calls[0]?.[0] as FrameRequestCallback | undefined
    expect(frame).toBeTypeOf('function')
    frame?.(0)

    expect(scrollTo).toHaveBeenCalledWith({ behavior: 'smooth', top: 400 })
    expect(heading).toHaveAttribute('tabindex', '-1')
    expect(document.activeElement).toBe(heading)
  } finally {
    vi.unstubAllGlobals()
  }
})

it('restores the summary scroll position and lets the directory leave model management', () => {
  window.arkdown = {
    connectModel: vi.fn(),
    listModels: vi.fn(),
    testModel: vi.fn(),
    deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(),
    setAiConversationSettings: vi.fn(),
  } as unknown as ArkdownApi
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  const content = document.querySelector<HTMLElement>('.preferences-page-content')!
  content.scrollTop = 640
  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  expect(screen.getByRole('heading', { name: '管理大模型' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '返回' }))
  expect(screen.getByRole('heading', { name: '偏好设置' })).toBeVisible()
  expect(content.scrollTop).toBe(640)

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  fireEvent.click(screen.getByRole('link', { name: '主题' }))
  expect(screen.getByRole('heading', { name: '主题' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: '管理大模型' })).not.toBeInTheDocument()
})

it('persists each embedded Arknote edit immediately without resubmitting lifecycle fields', () => {
  const change = vi.fn()
  render(<PreferencesPage {...instantProps} onArknoteChange={change} />)

  const section = screen.getByRole('region', { name: 'Arknote' })
  expect(section).toHaveClass('sticky-note-preferences-section--arkdown-embedded')
  fireEvent.click(within(section).getByRole('checkbox', { name: '开机启动' }))
  expect(change).toHaveBeenLastCalledWith({ launchAtLogin: true })
  expect(within(section).getByLabelText('自定义颜色')).toBeDisabled()
  fireEvent.click(within(section).getByRole('radio', { name: '颜色' }))
  fireEvent.change(within(section).getByLabelText('自定义颜色'), { target: { value: '#112233' } })
  expect(change.mock.calls.at(-1)?.[0]).toEqual({ stickyNotes: { ...DEFAULT_ARKNOTE_PREFERENCES.stickyNotes, defaultAppearance: 'color', defaultColor: '#112233' } })
  expect(change).toHaveBeenCalledTimes(3)
})

it('closes the preferences page when Escape is pressed while idle', () => {
  const cancel = vi.fn()
  const save = vi.fn()
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={cancel}
      onSearchChange={save}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  fireEvent.keyDown(window, { key: 'Escape' })

  expect(cancel).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
})

it('keeps editing and returning available while immediate writes are in flight', () => {
  const close = vi.fn()
  const change = vi.fn().mockReturnValue(new Promise<void>(() => undefined))
  render(<PreferencesPage {...instantProps} onClose={close} onAppearanceChange={change} />)

  fireEvent.click(screen.getByRole('checkbox', { name: '拼写检查' }))
  fireEvent.change(screen.getByLabelText('正文宽度'), { target: { value: '900' } })
  expect(change.mock.calls.map(([patch]) => patch)).toEqual([
    { spellCheckEnabled: true },
    { maximumContentWidthPx: 900 },
  ])
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
})

it('keeps model management open while a feature assignment mutation is pending', async () => {
  const cancel = vi.fn()
  const connection: ModelConnectionSummary = {
    id: '11111111-1111-4111-8111-111111111111',
    name: '主翻译模型',
    provider: 'deepseek',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    modelId: 'deepseek-chat',
    apiKeyHint: '••••7A9F',
    status: 'connected',
    lastTestedAt: '2026-08-12T00:00:00.000Z',
    capabilityOverride: null,
  }
  const settings: LargeModelSettings = {
    version: 6,
    codexCli: null,
    connections: [connection],
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
  const configured: LargeModelSettings = {
    ...settings,
    selectionTranslation: {
      ...settings.selectionTranslation,
      connectionId: connection.id,
    },
  }
  const mutation = deferred<Awaited<ReturnType<ArkdownApi['setSelectionTranslationSettings']>>>()
  window.arkdown = {
    connectModel: vi.fn(),
    listModels: vi.fn(),
    testModel: vi.fn(),
    deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(() => mutation.promise),
    setAiConversationSettings: vi.fn(),
    setScreenshotTranslationSettings: vi.fn(),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={settings}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={cancel}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  choosePreferencesOption('划词翻译模型', '主翻译模型')

  const back = screen.getByRole('button', { name: '返回' })
  expect(back).toBeDisabled()
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.click(screen.getByRole('link', { name: '主题' }))
  expect(cancel).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: '管理大模型' })).toBeVisible()

  await act(async () => {
    mutation.resolve({ ok: true, value: modelCommit(configured) })
    await mutation.promise
  })
  await waitFor(() => expect(back).toBeEnabled())
})

it('blocks manager exit while an added model is connecting, then recovers after persistence', async () => {
  const cancel = vi.fn()
  const connection: ModelConnectionSummary = {
    id: '33333333-3333-4333-8333-333333333333',
    name: '新增模型',
    provider: 'deepseek',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    apiKeyHint: '••••7A9F',
    status: 'connected',
    lastTestedAt: '2026-09-01T00:00:00.000Z',
    capabilityOverride: null,
  }
  const persisted: LargeModelSettings = {
    ...DEFAULT_LARGE_MODEL_SETTINGS,
    connections: [connection],
  }
  const pending = deferred<Awaited<ReturnType<ArkdownApi['connectModel']>>>()
  const connectModel: ArkdownApi['connectModel'] = vi.fn(() => pending.promise)
  window.arkdown = {
    connectModel,
    listModels: vi.fn(),
    testModel: vi.fn(),
    deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(),
    setAiConversationSettings: vi.fn(),
    setScreenshotTranslationSettings: vi.fn(),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={cancel}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  fireEvent.click(screen.getByRole('button', { name: '添加大模型' }))
  fireEvent.change(screen.getByLabelText('配置名称'), { target: { value: connection.name } })
  choosePreferencesOption('服务商', 'DeepSeek')
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: connection.modelId } })
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'new-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  await waitFor(() => expect(connectModel).toHaveBeenCalledOnce())
  const confirm = screen.getByRole('button', { name: '返回', hidden: true })
  expect(confirm).toBeDisabled()
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.click(screen.getByRole('link', { name: '主题', hidden: true }))
  expect(cancel).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: '管理大模型', hidden: true })).toBeVisible()

  await act(async () => {
    pending.resolve({ ok: true, value: modelCommit(persisted) })
    await pending.promise
  })

  await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加大模型' }))
    .not.toBeInTheDocument())
  await waitFor(() => expect(confirm).toBeEnabled())
  fireEvent.click(confirm)
  expect(screen.getByRole('heading', { name: '大模型设置' })).toBeVisible()
})

it('blocks manager exit while an edited model is connecting, then recovers after persistence', async () => {
  const cancel = vi.fn()
  const existing: ModelConnectionSummary = {
    id: '44444444-4444-4444-8444-444444444444',
    name: '已有模型',
    provider: 'deepseek',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    modelId: 'deepseek-chat',
    apiKeyHint: '••••7A9F',
    status: 'connected',
    lastTestedAt: '2026-09-01T00:00:00.000Z',
    capabilityOverride: null,
  }
  const updated: ModelConnectionSummary = { ...existing, modelId: 'deepseek-v4-pro' }
  const initialSettings: LargeModelSettings = {
    ...DEFAULT_LARGE_MODEL_SETTINGS,
    connections: [existing],
  }
  const persisted: LargeModelSettings = { ...initialSettings, connections: [updated] }
  const pending = deferred<Awaited<ReturnType<ArkdownApi['connectModel']>>>()
  const connectModel: ArkdownApi['connectModel'] = vi.fn(() => pending.promise)
  window.arkdown = {
    connectModel,
    listModels: vi.fn(),
    testModel: vi.fn(),
    deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(),
    setAiConversationSettings: vi.fn(),
    setScreenshotTranslationSettings: vi.fn(),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={initialSettings}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={cancel}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  fireEvent.click(screen.getByRole('button', { name: `${existing.name}详情` }))
  fireEvent.click(within(screen.getByRole('article', { name: existing.name }))
    .getByRole('button', { name: '编辑' }))
  fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: updated.modelId } })
  fireEvent.click(screen.getByRole('button', { name: '连接' }))

  await waitFor(() => expect(connectModel).toHaveBeenCalledOnce())
  const confirm = screen.getByRole('button', { name: '返回', hidden: true })
  expect(confirm).toBeDisabled()
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.click(screen.getByRole('link', { name: '主题', hidden: true }))
  expect(cancel).not.toHaveBeenCalled()
  expect(screen.getByRole('heading', { name: '管理大模型', hidden: true })).toBeVisible()

  await act(async () => {
    pending.resolve({ ok: true, value: modelCommit(persisted) })
    await pending.promise
  })

  await waitFor(() => expect(screen.queryByRole('dialog', { name: '编辑大模型' }))
    .not.toBeInTheDocument())
  await waitFor(() => expect(confirm).toBeEnabled())
  fireEvent.click(confirm)
  expect(screen.getByRole('heading', { name: '大模型设置' })).toBeVisible()
})

it('wires AI conversation assignment through the preferences manager and back into the summary', async () => {
  const settingsChanged = vi.fn()
  const conversationModel: ModelConnectionSummary = {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'GPT 5',
    provider: 'other',
    accessType: 'standard-api',
    protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    modelId: 'gpt-5-mini',
    apiKeyHint: '••••9Z9Z',
    status: 'connected',
    lastTestedAt: '2026-08-31T00:00:00.000Z',
    capabilityOverride: null,
  }
  const settings: LargeModelSettings = {
    ...DEFAULT_LARGE_MODEL_SETTINGS,
    connections: [conversationModel],
  }
  const configured: LargeModelSettings = {
    ...settings,
    aiConversation: {
      ...settings.aiConversation,
      connectionId: conversationModel.id,
      thinkingMode: 'enabled' as const, reasoningEffort: 'high',
    },
  }
  const setAiConversationSettings: ArkdownApi['setAiConversationSettings'] =
    vi.fn(async () => ({ ok: true as const, value: modelCommit(configured) }))
  window.arkdown = {
    connectModel: vi.fn(),
    listModels: vi.fn(),
    testModel: vi.fn(),
    deleteModel: vi.fn(),
    setSelectionTranslationSettings: vi.fn(),
    setAiConversationSettings,
    setScreenshotTranslationSettings: vi.fn(),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={settings}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      onLargeModelsChange={settingsChanged}
      systemFonts={systemFonts}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: '管理大模型' }))
  choosePreferencesOption('AI 对话模型', 'GPT 5')

  await waitFor(() => expect(setAiConversationSettings).toHaveBeenCalledWith({
    connectionId: conversationModel.id,
    reasoningEffort: 'default',
  }, modelObservation(settings)))

  fireEvent.click(screen.getByRole('button', { name: '返回' }))

  expect(settingsChanged).toHaveBeenCalledExactlyOnceWith(configured)
  const summary = screen.getByRole('group', { name: 'AI 对话' })
  expect(summary).toHaveTextContent('GPT 5')
  expect(summary).toHaveTextContent('高')
  expect(screen.queryByText('代码解读')).not.toBeInTheDocument()
})

it('lets an open preferences select consume the first Escape press', async () => {
  const cancel = vi.fn()
  const save = vi.fn()
  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={cancel}
      onSearchChange={save}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  const selectTrigger = document.querySelector<HTMLButtonElement>(
    '.preferences-select-trigger',
  )!
  fireEvent.click(selectTrigger)
  await waitFor(() => expect(document.activeElement).toHaveAttribute('role', 'option'))
  const focusedOption = document.activeElement as HTMLElement

  fireEvent.keyDown(focusedOption, { key: 'Escape' })

  expect(cancel).not.toHaveBeenCalled()
  expect(document.querySelector('[role="listbox"]')).not.toBeInTheDocument()
  await waitFor(() => expect(selectTrigger).toHaveFocus())

  fireEvent.keyDown(selectTrigger, { key: 'Escape' })

  expect(cancel).toHaveBeenCalledOnce()
  expect(save).not.toHaveBeenCalled()
})

it('shows the OCR action beside the revised description without downloading on open', async () => {
  let listener: ((state: ScreenshotOcrModelState) => void) | undefined
  const getState = vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumAbsent) })
  const download = vi.fn()
  const unsubscribe = vi.fn()
  window.arkdown = {
    getScreenshotOcrModelState: getState,
    downloadScreenshotOcrMedium: download,
    onScreenshotOcrModelState: vi.fn((nextListener) => {
      listener = nextListener
      return unsubscribe
    }),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  await waitFor(() => expect(screen.getByText('下载并更新')).toBeVisible())
  const heading = screen.getByRole('heading', { level: 2, name: '截图OCR识别' })
  const section = heading.closest('section')!
  const row = section.querySelector('.preferences-screenshot-row')!
  expect(within(row as HTMLElement).getByText(
    '下载使用 PP-OCRv6 Medium 模型以提升识别效果。PP-OCRv6是百度飞桨推出的开源OCR模型。',
  )).toBeVisible()
  expect(within(row as HTMLElement).getByRole('button', { name: '下载并更新' })).toBeVisible()
  expect(screen.queryByText('可下载')).not.toBeInTheDocument()
  expect(getState).toHaveBeenCalledOnce()
  expect(download).not.toHaveBeenCalled()

  const action = screen.getByRole('button', { name: '下载并更新' })
  action.focus()
  act(() => listener?.(mediumDownloading))

  expect(screen.getByRole('button', { name: '正在下载' })).toHaveAttribute('aria-disabled', 'true')
  expect(screen.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuenow', '25')
  expect(screen.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuemin', '0')
  expect(screen.getByRole('progressbar', { name: '下载进度' })).toHaveAttribute('aria-valuemax', '100')
  expect(document.activeElement).toBe(action)
  expect(unsubscribe).not.toHaveBeenCalled()
})

it('runs each OCR model mutation once without writing unrelated preference categories', async () => {
  const mutation = deferred<{ ok: true; value: ScreenshotOcrModelState }>()
  const download = vi.fn(() => mutation.promise)
  const save = vi.fn()
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumAbsent) }),
    downloadScreenshotOcrMedium: download,
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={save}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  const downloadButton = await screen.findByRole('button', { name: '下载并更新' })
  fireEvent.click(downloadButton)
  fireEvent.click(downloadButton)

  expect(download).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: '正在下载' })).toHaveAttribute('aria-disabled', 'true')
  expect(save).not.toHaveBeenCalled()

  await act(async () => {
    mutation.resolve({ ok: true, value: mediumInstalled })
    await mutation.promise
  })
  expect(screen.getByRole('button', { name: '已安装' })).toBeVisible()
})

it('cancels only a download started by this Preferences lifetime when it exits', async () => {
  const mutation = deferred<{ ok: true; value: ScreenshotOcrModelState }>()
  const cancelDownload = vi.fn().mockResolvedValue({ ok: true, value: mediumAbsent })
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumAbsent) }),
    downloadScreenshotOcrMedium: vi.fn(() => mutation.promise),
    cancelScreenshotOcrMediumDownload: cancelDownload,
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  const idle = render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  await screen.findByRole('button', { name: '下载并更新' })
  idle.unmount()
  expect(cancelDownload).not.toHaveBeenCalled()

  const active = render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: '下载并更新' }))
  active.unmount()
  expect(cancelDownload).toHaveBeenCalledOnce()
})

it('synchronously blocks duplicate OCR download and remove activations in one React batch', async () => {
  const downloadMutation = deferred<{ ok: true; value: ScreenshotOcrModelState }>()
  const removeMutation = deferred<{ ok: true; value: ScreenshotOcrModelState }>()
  const download = vi.fn(() => downloadMutation.promise)
  const remove = vi.fn(() => removeMutation.promise)
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumAbsent) }),
    downloadScreenshotOcrMedium: download,
    removeScreenshotOcrMedium: remove,
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  const view = render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  const downloadButton = await screen.findByRole('button', { name: '下载并更新' })
  act(() => {
    fireEvent.click(downloadButton)
    fireEvent.click(downloadButton)
  })
  expect(download).toHaveBeenCalledOnce()

  await act(async () => {
    downloadMutation.resolve({ ok: true, value: mediumInstalled })
    await downloadMutation.promise
  })
  const removeButton = await screen.findByRole('button', { name: '已安装' })
  act(() => {
    fireEvent.click(removeButton)
    fireEvent.click(removeButton)
  })
  fireEvent.click(within(screen.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' }))
    .getByRole('button', { name: '是' }))
  await waitFor(() => expect(remove).toHaveBeenCalledOnce())

  view.unmount()
})

it('uses a fixed public failure message instead of the raw OCR error', async () => {
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({
      ok: true,
      value: observedOcr({ ...mediumAbsent, status: 'medium-failed', errorCode: 'OPERATION_FAILED' }),
    }),
    downloadScreenshotOcrMedium: vi.fn(),
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  const view = render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('下载失败'))
  expect(screen.getByText('下载失败，请稍后重试。')).toBeVisible()
  expect(screen.queryByText('OPERATION_FAILED')).not.toBeInTheDocument()
})

it('requires an explicit yes/no confirmation before removing an installed OCR model', async () => {
  const remove = vi.fn().mockResolvedValue({ ok: true, value: mediumAbsent })
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumInstalled) }),
    removeScreenshotOcrMedium: remove,
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  const installedButton = await screen.findByRole('button', { name: '已安装' })
  fireEvent.click(installedButton)
  const dialog = screen.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })
  expect(within(dialog).getByText('删除后将恢复使用PP-OCRv6轻度模型')).toHaveClass(
    'preferences-confirm-dialog__hint',
  )
  const confirmAction = within(dialog).getByRole('button', { name: '是' })
  expect(confirmAction).toHaveClass('arkdown-dialog__primary')
  expect(confirmAction).not.toHaveClass('arkdown-dialog__danger')
  expect(within(dialog).getByRole('button', { name: '否' })).toHaveFocus()
  fireEvent.click(within(dialog).getByRole('button', { name: '否' }))
  expect(remove).not.toHaveBeenCalled()
  await waitFor(() => expect(screen.queryByRole('dialog', {
    name: '是否删除PP-OCRv6 Medium模型？',
  })).not.toBeInTheDocument())
  fireEvent.click(installedButton)
  fireEvent.click(within(screen.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' }))
    .getByRole('button', { name: '是' }))
  await waitFor(() => expect(remove).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: '下载并更新' })).toBeVisible()
  expect(screen.queryByText('可下载')).not.toBeInTheDocument()
})

it('contains OCR remove focus and restores the installed trigger when the dialog closes', async () => {
  const cancelPreferences = vi.fn()
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumInstalled) }),
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={cancelPreferences}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  const preferences = screen.getByRole('main', { name: '偏好设置' })
  const installedButton = await screen.findByRole('button', { name: '已安装' })

  installedButton.focus()
  fireEvent.click(installedButton)
  const dialog = screen.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })
  const no = within(dialog).getByRole('button', { name: '否' })
  const yes = within(dialog).getByRole('button', { name: '是' })
  expect(no).toHaveFocus()

  fireEvent.keyDown(no, { key: 'Tab', shiftKey: true })
  expect(yes).toHaveFocus()
  fireEvent.keyDown(yes, { key: 'Tab' })
  expect(no).toHaveFocus()
  expect(preferences).toHaveAttribute('aria-hidden', 'true')
  expect(preferences.inert).toBe(true)

  fireEvent.click(no)
  expect(dialog.parentElement).toHaveAttribute('data-state', 'closing')
  await waitFor(() => expect(screen.queryByRole('dialog', {
    name: '是否删除PP-OCRv6 Medium模型？',
  })).not.toBeInTheDocument())
  await waitFor(() => expect(installedButton).toHaveFocus())
  expect(preferences).not.toHaveAttribute('aria-hidden')
  expect(preferences.inert).toBe(false)

  fireEvent.click(installedButton)
  expect(screen.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' })).toBeVisible()
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog', {
    name: '是否删除PP-OCRv6 Medium模型？',
  })).not.toBeInTheDocument())
  await waitFor(() => expect(installedButton).toHaveFocus())
  expect(cancelPreferences).not.toHaveBeenCalled()
})

it('keeps a newer OCR model event when the initial state arrives late', async () => {
  const initialState = deferred<{ ok: true; value: ReturnType<typeof observedOcr> }>()
  let listener: ((state: ScreenshotOcrModelState) => void) | undefined
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn(() => initialState.promise),
    onScreenshotOcrModelState: vi.fn((nextListener) => {
      listener = nextListener
      return () => undefined
    }),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  act(() => listener?.(mediumInstalled))
  await act(async () => {
    initialState.resolve({ ok: true, value: observedOcr(mediumAbsent) })
    await initialState.promise
  })

  expect(screen.getByRole('button', { name: '已安装' })).toBeVisible()
})

it('ignores a first StrictMode lifetime query after the second lifetime receives a newer event', async () => {
  const firstRead = deferred<{ ok: true; value: ReturnType<typeof observedOcr> }>()
  const secondRead = deferred<{ ok: true; value: ReturnType<typeof observedOcr> }>()
  const listeners: Array<(state: ScreenshotOcrModelState) => void> = []
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise),
    onScreenshotOcrModelState: vi.fn((listener) => {
      listeners.push(listener)
      return () => undefined
    }),
  } as unknown as ArkdownApi

  render(
    <StrictMode>
      <PreferencesPage
        initialAppearance={initialAppearance}
        initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
        initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
        initialSearch={{ provider: 'bing', customTemplate: '' }}
        onAppearanceChange={() => undefined}
        onClose={() => undefined}
        onSearchChange={() => undefined}
        onArknoteChange={() => undefined}
        systemFonts={systemFonts}
      />
    </StrictMode>,
  )
  expect(window.arkdown.getScreenshotOcrModelState).toHaveBeenCalledTimes(2)
  act(() => listeners.at(-1)?.(mediumInstalled))
  await act(async () => {
    firstRead.resolve({ ok: true, value: observedOcr(mediumAbsent) })
    await firstRead.promise
  })

  expect(screen.getByRole('button', { name: '已安装' })).toBeVisible()
})

it('keeps a newer OCR download event when an older mutation response succeeds', async () => {
  const mutation = deferred<{ ok: true; value: ScreenshotOcrModelState }>()
  let listener: ((state: ScreenshotOcrModelState) => void) | undefined
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumAbsent) }),
    downloadScreenshotOcrMedium: vi.fn(() => mutation.promise),
    onScreenshotOcrModelState: vi.fn((nextListener) => {
      listener = nextListener
      return () => undefined
    }),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: '下载并更新' }))
  act(() => listener?.(mediumInstalled))
  await act(async () => {
    mutation.resolve({ ok: true, value: mediumAbsent })
    await mutation.promise
  })

  expect(screen.getByRole('button', { name: '已安装' })).toBeVisible()
})

it('does not surface an older OCR download failure after a newer model event', async () => {
  const mutation = deferred<{ ok: true; value: ScreenshotOcrModelState }>()
  let listener: ((state: ScreenshotOcrModelState) => void) | undefined
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumAbsent) }),
    downloadScreenshotOcrMedium: vi.fn(() => mutation.promise),
    onScreenshotOcrModelState: vi.fn((nextListener) => {
      listener = nextListener
      return () => undefined
    }),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: '下载并更新' }))
  act(() => listener?.(mediumInstalled))
  await act(async () => {
    mutation.reject(new Error('private backend detail'))
    try { await mutation.promise } catch { /* expected transport failure */ }
  })

  expect(screen.getByRole('button', { name: '已安装' })).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('keeps an installed OCR model removable after a failed update', async () => {
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({
      ok: true,
      value: observedOcr(mediumFailedWithInstalledModel),
    }),
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )

  await waitFor(() => expect(screen.getByRole('button', { name: '已安装' })).toBeVisible())
  expect(screen.getByRole('alert')).toHaveTextContent('更新失败，请稍后重试。')
})

it('uses a fixed remove failure message while retaining the installed OCR state', async () => {
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn().mockResolvedValue({ ok: true, value: observedOcr(mediumInstalled) }),
    removeScreenshotOcrMedium: vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'OPERATION_FAILED', message: 'private backend detail' },
    }),
    onScreenshotOcrModelState: vi.fn(() => () => undefined),
  } as unknown as ArkdownApi

  render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  fireEvent.click(await screen.findByRole('button', { name: '已安装' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '是否删除PP-OCRv6 Medium模型？' }))
    .getByRole('button', { name: '是' }))

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('删除失败，请稍后重试。'))
  expect(screen.getByRole('button', { name: '已安装' })).toBeVisible()
})

it('unsubscribes from OCR model events and ignores a late initial state after unmount', async () => {
  const initialState = deferred<{ ok: true; value: ReturnType<typeof observedOcr> }>()
  const unsubscribe = vi.fn()
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  window.arkdown = {
    getScreenshotOcrModelState: vi.fn(() => initialState.promise),
    onScreenshotOcrModelState: vi.fn(() => unsubscribe),
  } as unknown as ArkdownApi

  const view = render(
    <PreferencesPage
      initialAppearance={initialAppearance}
      initialArknote={DEFAULT_ARKNOTE_PREFERENCES}
      initialLargeModels={DEFAULT_LARGE_MODEL_SETTINGS}
      initialSearch={{ provider: 'bing', customTemplate: '' }}
      onAppearanceChange={() => undefined}
      onClose={() => undefined}
      onSearchChange={() => undefined}
      onArknoteChange={() => undefined}
      systemFonts={systemFonts}
    />,
  )
  view.unmount()
  await act(async () => {
    initialState.resolve({ ok: true, value: observedOcr(mediumInstalled) })
    await initialState.promise
  })

  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(consoleError).not.toHaveBeenCalled()
  consoleError.mockRestore()
})
