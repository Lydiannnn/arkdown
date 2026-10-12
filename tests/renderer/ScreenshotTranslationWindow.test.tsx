import { modelObservation, modelCommit } from '../helpers/model-observation'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ArkdownApi } from '../../src/shared/contracts'
import type { ScreenshotTranslationEvent } from '../../src/shared/screenshot-translation'
import { ScreenshotTranslationWindow } from '../../src/renderer/screenshot/ScreenshotTranslationWindow'
import { DEFAULT_LARGE_MODEL_SETTINGS, type LargeModelSettings } from '../../src/shared/large-model-settings'
import { startModelRulesInitialization } from '../../src/renderer/settings/model-rules-runtime'
import type { ClosePreparationAttempt, ClosePreparationHandler } from '../../src/shared/close-preparation'

const sessionId = '123e4567-e89b-42d3-a456-426614174000'
const otherSessionId = '223e4567-e89b-42d3-a456-426614174000'
const image = { width: 400, height: 200, dataUrl: 'data:image/png;base64,AAAA' }
const blocks = [{
  id: 'line-1', text: 'Hello', rectPx: { x: 20, y: 20, width: 120, height: 30 },
  words: [{ text: 'Hello', rectPx: { x: 20, y: 20, width: 120, height: 30 } }],
}]
const documentBlocks = [{
  id: 'line-1', text: 'A'.repeat(600), rectPx: { x: 20, y: 20, width: 120, height: 30 },
  words: [{ text: 'A'.repeat(600), rectPx: { x: 20, y: 20, width: 120, height: 30 } }],
}]

it('gates new thinking writes during structured close and releases only the exact attempt without losing failure', async () => {
  const installed = installApi()
  const configured: LargeModelSettings = { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [{
    id: sessionId, name: 'Screenshot model', provider: 'deepseek', protocol: 'openai', accessType: 'standard-api',
    baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-pro', status: 'connected', apiKeyHint: '••••test', lastTestedAt: null, capabilityOverride: null,
  }], screenshotTranslation: { connectionId: sessionId, thinkingMode: 'disabled', reasoningEffort: 'low', targetLanguage: 'en' } }
  installed.api.getLargeModelSettings.mockResolvedValue({ ok: true, value: configured })
  let prepare!: ClosePreparationHandler, release!: (attempt: ClosePreparationAttempt) => void
  window.arkdown.onPrepareCloseStructured = handler => { prepare = handler; return () => {} }
  window.arkdown.onClosePreparationReleased = handler => { release = handler; return () => {} }
  const pending = deferred<Awaited<ReturnType<ArkdownApi['setScreenshotTranslationSettings']>>>()
  installed.api.setScreenshotTranslationSettings.mockReturnValue(pending.promise)
  startReady(installed)
  const toggle = await screen.findByRole('switch', { name: '截图翻译思考' })
  fireEvent.click(toggle)
  await waitFor(() => expect(installed.api.setScreenshotTranslationSettings).toHaveBeenCalledOnce())
  const context = { attemptId: sessionId, generation: 1, requestId: otherSessionId, enter: vi.fn() }
  let close!: ReturnType<ClosePreparationHandler>
  installed.api.closeScreenshotTranslation.mockImplementation(async () => {
    close = prepare(context)
    return { ok: true, value: null }
  })
  fireEvent.click(screen.getByRole('button', { name: '关闭截图翻译窗口' }))
  expect(installed.api.closeScreenshotTranslation).toHaveBeenCalledOnce()
  expect(context.enter).toHaveBeenCalledWith('settle-preferences')
  await act(async () => pending.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: '保存失败' } }))
  expect(await close).toEqual({ status: 'failed', code: 'preferences-save-failed' })
  expect(toggle).toBeChecked()
  expect(toggle).toBeDisabled()
  act(() => release({ attemptId: sessionId, generation: 2 }))
  expect(toggle).toBeDisabled()
  act(() => release({ attemptId: sessionId, generation: 1 }))
  expect(toggle).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '重新加载截图翻译设置' }))
  await waitFor(() => expect(toggle).not.toBeChecked())
  await act(async () => { expect(await prepare({ ...context, generation: 2 })).toEqual({ status: 'ready' }) })
  expect(installed.api.setScreenshotTranslationSettings).toHaveBeenCalledOnce()
})

function installApi() {
  let listener: ((event: ScreenshotTranslationEvent) => void) | undefined
  const api = {
    getLargeModelSettings: vi.fn(async () => ({ ok: true as const, value: DEFAULT_LARGE_MODEL_SETTINGS })),
    setScreenshotTranslationSettings: vi.fn<ArkdownApi['setScreenshotTranslationSettings']>(),
    setSelectionTranslationSettings: vi.fn<ArkdownApi['setSelectionTranslationSettings']>(),
    onScreenshotTranslationEvent: vi.fn((next: (event: ScreenshotTranslationEvent) => void) => {
      listener = next
      return () => { if (listener === next) listener = undefined }
    }),
    submitScreenshotOcr: vi.fn().mockResolvedValue({ ok: true, value: null }),
    settleScreenshotOcr: vi.fn().mockResolvedValue({ ok: true, value: null }),
    startScreenshotTranslation: vi.fn(async (input: { sessionId: string; generation: number }) => ({
      ok: true as const,
      value: { sessionId: input.sessionId, generation: input.generation + 1 },
    })),
    cancelScreenshotTranslation: vi.fn().mockResolvedValue({ ok: true, value: null }),
    minimizeScreenshotTranslation: vi.fn().mockResolvedValue({ ok: true, value: null }),
    closeScreenshotTranslation: vi.fn().mockResolvedValue({ ok: true, value: null }),
    openScreenshotTranslationSettings: vi.fn().mockResolvedValue({ ok: true, value: null }),
  }
  const observedApi = { ...api, getModelSettingsSnapshot: vi.fn(async () => { const result = await api.getLargeModelSettings(); return { ok: true as const, value: modelObservation(result.value) } }) }
  Object.defineProperty(window, 'arkdown', { configurable: true, value: observedApi as unknown as ArkdownApi })
  return { api: observedApi, emit: (event: ScreenshotTranslationEvent) => act(() => listener?.(event)) }
}

it.each([
  ['MODEL_AUTHENTICATION_FAILED', '模型认证失败，请检查 API Key 或 CLI 登录状态'],
  ['MODEL_NOT_FOUND', '未找到所选模型，请在设置中重新选择'],
  ['MODEL_UNAVAILABLE', '无法连接模型服务，请检查网络和服务地址后重试'],
  ['MODEL_RATE_LIMITED', '模型请求过于频繁，请稍后重试'],
  ['MODEL_QUOTA_EXCEEDED', '模型额度不足，请检查账户额度或更换模型'],
  ['MODEL_RESPONSE_INVALID', '模型返回的译文不完整或格式不正确，请重新翻译'],
  ['MODEL_TIMEOUT', '翻译超时，请重试'],
  ['TRANSLATION_FAILED', '翻译未能完成，请尝试将窗口拉大后重试'],
] as const)('shows an actionable %s error without mislabelling it as a completed translation', async (code, message) => {
  const installed = installApi()
  render(<ScreenshotTranslationWindow sessionId={sessionId} />)
  installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 1, type: 'ocr-completed', blocks })
  installed.emit({ sessionId, generation: 1, type: 'failed', stage: 'translation', code })
  expect(await screen.findByRole('alert')).toHaveTextContent(message)
  expect(screen.getByRole('button', { name: '重新翻译' })).toBeEnabled()
  if (code !== 'TRANSLATION_FAILED') expect(screen.getByRole('alert')).not.toHaveTextContent('拉大')
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderWithClosedSidebar() {
  render(<ScreenshotTranslationWindow sessionId={sessionId} />)
  fireEvent.click(screen.getByRole('button', { name: '关闭侧窗' }))
}

function startReady(installed = installApi()) {
  renderWithClosedSidebar()
  installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 1, type: 'ocr-completed', blocks })
  return installed
}

function startDocumentReady(installed = installApi()) {
  renderWithClosedSidebar()
  installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 1, type: 'ocr-completed', blocks: documentBlocks })
  return installed
}

afterEach(() => vi.restoreAllMocks())

it('keeps OCR results usable but blocks fresh translation until model rules settle', async () => {
  let resolve!: (value: { ok: true; value: { rules: null; bundledRevision: string; warning: null } }) => void
  const session = startModelRulesInitialization({ getModelCapabilityRules: () => new Promise(done => { resolve = done }) })
  try {
    const installed = startReady()
    expect(screen.getByRole('button', { name: '显示译文' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '重新翻译' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
    expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
    await act(async () => { resolve({ ok: true, value: { rules: null, bundledRevision: '2026-09-12', warning: null } }); await session.ready })
    expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
    await waitFor(() => expect(installed.api.startScreenshotTranslation).toHaveBeenCalledOnce())
  } finally { act(() => session.dispose()) }
})

it('disables both left text commands on the original image and dismisses with Escape', () => {
  startReady()
  const viewport = screen.getByLabelText('截图文字区域')
  fireEvent.contextMenu(viewport)
  expect(screen.getByRole('menuitem', { name: '复制' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: '全选' })).toBeDisabled()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(viewport).toHaveFocus()
})

it('selects and copies only visible left translation text, excluding the right pane and toolbar', () => {
  const installed = startReady()
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '左侧译文' }] })
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  const viewport = screen.getByLabelText('截图文字区域')
  window.getSelection()?.removeAllRanges()
  fireEvent.contextMenu(viewport)
  expect(screen.getByRole('menuitem', { name: '复制' })).toBeDisabled()
  fireEvent.click(screen.getByRole('menuitem', { name: '全选' }))
  expect(window.getSelection()?.toString()).toBe('左侧译文')
  fireEvent.keyDown(viewport, { key: 'F10', shiftKey: true })
  expect(screen.getByRole('menuitem', { name: '复制' })).toBeEnabled()
  fireEvent.click(screen.getByRole('menuitem', { name: '复制' }))
  expect(writeText).toHaveBeenCalledWith('左侧译文')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(viewport).toHaveFocus()
})

it('does not let either pane copy a selection from the other pane', () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '译文' }] })
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  const viewport = screen.getByLabelText('截图文字区域')
  const sidebar = screen.getByRole('complementary')
  for (const [selected, menuOwner] of [[sidebar.querySelector('.screenshot-text-sidebar__ocr-text')!, viewport],
    [viewport.querySelector('.screenshot-translated-block')!, sidebar]] as const) {
    const range = document.createRange(); range.selectNodeContents(selected)
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    fireEvent.contextMenu(menuOwner)
    expect(screen.getByRole('menuitem', { name: '复制' })).toBeDisabled()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  }
})

it('keeps just one menu open when keyboard context-menu focus moves between panes', () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '译文' }] })
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  fireEvent.keyDown(screen.getByLabelText('截图文字区域'), { key: 'F10', shiftKey: true })
  fireEvent.keyDown(screen.getByRole('complementary'), { key: 'F10', shiftKey: true })
  expect(screen.getAllByRole('menu')).toHaveLength(1)
})

it('keeps dense new requests on the image while legacy document events remain supported', () => {
  const installed = startDocumentReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-started' })
  expect(screen.queryByRole('region', { name: '文档译文' })).toBeNull()
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '定位译文' }] })
  expect(document.querySelector('.screenshot-translated-block')).toHaveTextContent('定位译文')
  expect(screen.queryByRole('region', { name: '文档译文' })).toBeNull()
})

it('opens extraction by default and allows hiding and reopening it without starting work', () => {
  const installed = installApi()
  render(<ScreenshotTranslationWindow sessionId={sessionId} />)
  expect(screen.getByRole('complementary', { name: '提取的文字' })).toBeVisible()
  expect(screen.getByRole('button', { name: '关闭侧窗' })).toHaveAttribute('aria-expanded', 'true')
  installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 1, type: 'ocr-completed', blocks })
  expect(screen.getByRole('complementary')).toHaveTextContent('Hello')
  fireEvent.click(screen.getByRole('button', { name: '关闭侧窗' }))
  expect(screen.queryByRole('complementary')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  expect(screen.getByRole('complementary')).toHaveTextContent('Hello')
  expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
})

it('persists screenshot thinking to its own feature, blocks retranslating during save, and retains output on failure', async () => {
  const installed = installApi()
  const configured: LargeModelSettings = { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [{
    id: sessionId, name: 'Screenshot model', provider: 'deepseek', protocol: 'openai', accessType: 'standard-api',
    baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-pro', status: 'connected', apiKeyHint: '••••test', lastTestedAt: null, capabilityOverride: null,
  }], screenshotTranslation: { connectionId: sessionId, thinkingMode: 'disabled', reasoningEffort: 'low', targetLanguage: 'en' } }
  installed.api.getLargeModelSettings.mockResolvedValue({ ok: true, value: configured })
  const pending = deferred<Awaited<ReturnType<ArkdownApi['setScreenshotTranslationSettings']>>>()
  installed.api.setScreenshotTranslationSettings.mockReturnValue(pending.promise)
  startReady(installed)
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'Existing output' }] })
  const toggle = await screen.findByRole('switch', { name: '截图翻译思考' })
  fireEvent.click(toggle)
  await waitFor(() => expect(installed.api.setScreenshotTranslationSettings).toHaveBeenCalledWith({
    thinkingMode: 'enabled',
  }, modelObservation(configured)))
  expect(toggle).toBeDisabled()
  expect(screen.getByRole('button', { name: '重新翻译' })).toBeDisabled()
  await act(async () => pending.resolve({ ok: false, error: { code: 'OPERATION_FAILED', message: '保存失败' } }))
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
  expect(toggle).toBeChecked()
  expect(screen.getByText('Existing output')).toBeVisible()
  expect(installed.api.setSelectionTranslationSettings).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重新翻译' }))
  expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '关闭截图翻译窗口' }))
  expect(installed.api.closeScreenshotTranslation).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toHaveTextContent('保存失败')
  expect(toggle).toBeChecked()
  fireEvent.focus(window)
  await waitFor(() => expect(installed.api.getModelSettingsSnapshot).toHaveBeenCalledTimes(2))
  expect(toggle).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: '重新加载截图翻译设置' }))
  await waitFor(() => expect(toggle).not.toBeChecked())
  fireEvent.click(screen.getByRole('button', { name: '重新翻译' }))
  await waitFor(() => expect(installed.api.startScreenshotTranslation).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '关闭截图翻译窗口' }))
  await waitFor(() => expect(installed.api.closeScreenshotTranslation).toHaveBeenCalledTimes(2))
})

it('ignores an older focus refresh after a newer thinking save has committed', async () => {
  const installed = installApi()
  const configured: LargeModelSettings = { ...DEFAULT_LARGE_MODEL_SETTINGS, connections: [{
    id: sessionId, name: 'Screenshot model', provider: 'deepseek', protocol: 'openai', accessType: 'standard-api',
    baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-pro', status: 'connected', apiKeyHint: '••••test', lastTestedAt: null, capabilityOverride: null,
  }], screenshotTranslation: { connectionId: sessionId, thinkingMode: 'disabled', reasoningEffort: 'low', targetLanguage: 'en' } }
  installed.api.getLargeModelSettings.mockResolvedValue({ ok: true, value: configured })
  installed.api.setScreenshotTranslationSettings.mockResolvedValue({ ok: true, value: modelCommit({
    ...configured, screenshotTranslation: { ...configured.screenshotTranslation, thinkingMode: 'enabled' },
  }) })
  startReady(installed)
  const toggle = await screen.findByRole('switch', { name: '截图翻译思考' })
  const oldRead = deferred<{ ok: true; value: LargeModelSettings }>()
  installed.api.getLargeModelSettings.mockReturnValueOnce(oldRead.promise)
  fireEvent.focus(window)
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  await act(async () => oldRead.resolve({ ok: true, value: configured }))
  expect(toggle).toBeChecked()
  expect(installed.api.setScreenshotTranslationSettings).toHaveBeenCalledOnce()
})

it('does not restart OCR when preload replays a snapshot that already has a terminal OCR event', async () => {
  const api = {
    ...installApi().api,
    onScreenshotTranslationEvent: vi.fn((listener: (event: ScreenshotTranslationEvent) => void) => {
      listener({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
      listener({ sessionId, generation: 1, type: 'ocr-completed', blocks })
      return () => undefined
    }),
  } as unknown as ArkdownApi
  Object.defineProperty(window, 'arkdown', { configurable: true, value: api })
  renderWithClosedSidebar()
  await waitFor(() => expect(screen.getByRole('button', { name: '显示译文' })).toBeEnabled())
  expect(api.submitScreenshotOcr).not.toHaveBeenCalled()
})

it('shows the original screenshot immediately and progresses through OCR and translation', () => {
  const installed = installApi()
  renderWithClosedSidebar()
  expect(screen.getByText('正在准备截图…', { selector: '.screenshot-result-status' })).toBeVisible()
  installed.emit({ sessionId: otherSessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  expect(screen.queryByRole('img')).toBeNull()
  installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  expect(screen.getByRole('img', { name: '截图原文' })).toHaveAttribute('src', image.dataUrl)
  const ocrStatus = screen.getByLabelText('OCR识别状态')
  expect(ocrStatus).toHaveTextContent('识别文字中…')
  expect(ocrStatus.querySelector('.screenshot-result-status__spinner')).not.toBeNull()
  expect(screen.getByRole('button', { name: '识别文字中…' })).toBeDisabled()
  installed.emit({ sessionId, generation: 1, type: 'ocr-completed', blocks })
  expect(screen.getByRole('button', { name: '显示译文' })).toBeEnabled()
  installed.emit({ sessionId, generation: 1, type: 'translation-started' })
  expect(screen.getByRole('button', { name: '翻译中…' })).toBeEnabled()
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '你好' }] })
  expect(screen.getByText('你好')).toHaveClass('screenshot-translated-block')
  expect(screen.getByText('你好')).toHaveAttribute('data-block-id', 'line-1')
  expect(screen.getByRole('img', { name: '截图原文' })).toHaveClass('is-translated')
  expect(screen.getByRole('button', { name: '显示原文' })).toBeEnabled()
})

it('cancels translation to the original and rejects a late completion for that generation', () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-started' })
  fireEvent.click(screen.getByRole('button', { name: '翻译中…' }))
  expect(installed.api.cancelScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 1 })
  expect(screen.getByRole('button', { name: '显示译文' })).toBeEnabled()
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '迟到译文' }] })
  expect(screen.queryByText('迟到译文')).toBeNull()
})

it('hides and restores cached translated overlays without starting another request', () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '你好' }] })
  fireEvent.click(screen.getByRole('button', { name: '显示原文' }))
  expect(screen.queryByText('你好')).toBeNull()
  expect(screen.getByRole('img', { name: '截图原文' })).not.toHaveClass('is-translated')
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
  expect(screen.getByText('你好')).toBeVisible()
  expect(screen.getByRole('button', { name: '显示原文' })).toBeEnabled()
})

it('extracts translated text only while translated overlays are visible', () => {
  const installed = startReady()
  installed.emit({
    sessionId,
    generation: 1,
    type: 'translation-completed',
    translations: [{ id: 'line-1', text: '你好' }],
  })

  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  const sidebar = screen.getByRole('complementary')
  expect(sidebar).toHaveTextContent('你好')
  expect(sidebar).not.toHaveTextContent('Hello')

  fireEvent.click(screen.getByRole('button', { name: '显示原文' }))
  expect(sidebar).toHaveTextContent('Hello')
  expect(sidebar).not.toHaveTextContent('你好')
})

it('streams document translation immediately and switches extraction without starting new work', () => {
  const installed = startDocumentReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-started' })
  installed.emit({
    sessionId, generation: 1, type: 'document-translation-progress',
    text: '流式第一段', completedChunks: 0, totalChunks: 2,
  })

  expect(screen.getByRole('region', { name: '文档译文' })).toHaveTextContent('流式第一段')
  expect(screen.getByRole('img', { name: '截图原文' })).toHaveAttribute('src', image.dataUrl)
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  expect(screen.getByRole('complementary')).toHaveTextContent('流式第一段')
  installed.emit({
    sessionId, generation: 1, type: 'document-translation-progress',
    text: '流式第一段\n流式第二段', completedChunks: 1, totalChunks: 2,
  })
  expect(screen.getByRole('region', { name: '文档译文' })).toHaveTextContent('流式第二段')
  expect(screen.getByRole('complementary')).toHaveTextContent('流式第二段')

  installed.emit({
    sessionId, generation: 1, type: 'document-translation-completed',
    text: '完整文档译文',
  })
  expect(screen.getByRole('button', { name: '显示原文' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '显示原文' }))
  expect(screen.queryByRole('region', { name: '文档译文' })).toBeNull()
  expect(screen.getByRole('complementary')).toHaveTextContent('A'.repeat(80))
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(screen.getByRole('region', { name: '文档译文' })).toHaveTextContent('完整文档译文')
  expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
})

it('retains partial document translation when a later chunk fails', () => {
  const installed = startDocumentReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-started' })
  installed.emit({
    sessionId, generation: 1, type: 'document-translation-progress',
    text: '已完成部分', completedChunks: 1, totalChunks: 2,
  })
  installed.emit({
    sessionId, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT',
  })

  expect(screen.getByRole('region', { name: '文档译文' })).toHaveTextContent('已完成部分')
  expect(screen.getByRole('alert')).toHaveTextContent('部分内容翻译未完成，可重新翻译')
  expect(screen.getByRole('button', { name: '重新翻译' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '显示原文' }))
  expect(screen.queryByRole('region', { name: '文档译文' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(screen.getByRole('region', { name: '文档译文' })).toHaveTextContent('已完成部分')
  expect(screen.getByRole('alert')).toHaveTextContent('部分内容翻译未完成')
  expect(screen.getByRole('status')).not.toHaveTextContent('翻译完成')
  expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
})

it('keeps a partial cache partial across a cancelled retry, then replaces it on confirmed completion', async () => {
  const installed = startDocumentReady()
  installed.emit({ sessionId, generation: 1, type: 'document-translation-progress', text: '部分译文', completedChunks: 1, totalChunks: 2 })
  installed.emit({ sessionId, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT' })
  fireEvent.click(screen.getByRole('button', { name: '重新翻译' }))
  await waitFor(() => expect(installed.api.startScreenshotTranslation).toHaveBeenCalledTimes(1))
  installed.emit({ sessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 2, type: 'ocr-completed', blocks: documentBlocks })
  fireEvent.click(screen.getByRole('button', { name: '翻译中…' }))
  installed.emit({ sessionId, generation: 2, type: 'document-translation-completed', text: '取消后迟到的内容' })
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(screen.getByRole('alert')).toHaveTextContent('部分内容翻译未完成')
  expect(screen.getByRole('region', { name: '文档译文' })).toHaveTextContent('部分译文')

  fireEvent.click(screen.getByRole('button', { name: '重新翻译' }))
  await waitFor(() => expect(installed.api.startScreenshotTranslation).toHaveBeenCalledTimes(2))
  installed.emit({ sessionId, generation: 3, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 3, type: 'ocr-completed', blocks: documentBlocks })
  installed.emit({ sessionId, generation: 3, type: 'document-translation-progress', text: '完整译文', completedChunks: 1, totalChunks: 1 })
  installed.emit({ sessionId, generation: 3, type: 'document-translation-completed', text: '完整译文' })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('status')).toHaveTextContent('翻译完成')
  fireEvent.click(screen.getByRole('button', { name: '显示原文' }))
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('region', { name: '文档译文' })).toHaveTextContent('完整译文')
})

it('keeps the previous cache when retranslation fails or is cancelled and replaces it on success', async () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '旧译文' }] })
  const toolbar = document.querySelector<HTMLElement>('.screenshot-result-toolbar')!
  expect(within(toolbar).getAllByRole('button').map((button) => button.textContent)).toEqual([
    '显示原文', '重新翻译', '打开侧窗',
  ])

  fireEvent.click(within(toolbar).getByRole('button', { name: '重新翻译' }))
  await waitFor(() => expect(installed.api.startScreenshotTranslation).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('旧译文')).toBeNull()
  installed.emit({ sessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 2, type: 'ocr-completed', blocks })
  installed.emit({ sessionId, generation: 2, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT' })
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(screen.getByText('旧译文')).toBeVisible()
  expect(installed.api.startScreenshotTranslation).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: '重新翻译' }))
  installed.emit({ sessionId, generation: 3, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 3, type: 'ocr-completed', blocks })
  fireEvent.click(screen.getByRole('button', { name: '翻译中…' }))
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(screen.getByText('旧译文')).toBeVisible()
  await waitFor(() => expect(installed.api.cancelScreenshotTranslation).toHaveBeenCalled())

  fireEvent.click(screen.getByRole('button', { name: '重新翻译' }))
  installed.emit({ sessionId, generation: 4, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 4, type: 'ocr-completed', blocks })
  installed.emit({ sessionId, generation: 4, type: 'translation-completed', translations: [{ id: 'line-1', text: '新译文' }] })
  expect(screen.queryByText('旧译文')).toBeNull()
  expect(screen.getByText('新译文')).toBeVisible()
})

it('keeps the successful cache when a pending retranslation is cancelled before its late generation arrives', async () => {
  const pending = deferred<{ ok: true; value: { sessionId: string; generation: number } }>()
  const installed = installApi()
  installed.api.startScreenshotTranslation = vi.fn(() => pending.promise)
  startReady(installed)
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '旧译文' }] })

  fireEvent.click(screen.getByRole('button', { name: '重新翻译' }))
  fireEvent.click(screen.getByRole('button', { name: '翻译中…' }))
  expect(installed.api.cancelScreenshotTranslation).not.toHaveBeenCalled()

  await act(async () => pending.resolve({ ok: true, value: { sessionId, generation: 2 } }))
  await waitFor(() => expect(installed.api.cancelScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 2 }))
  installed.emit({ sessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 2, type: 'ocr-completed', blocks })
  installed.emit({ sessionId, generation: 2, type: 'translation-completed', translations: [{ id: 'line-1', text: '迟到译文' }] })

  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(screen.getByText('旧译文')).toBeVisible()
  expect(screen.queryByText('迟到译文')).toBeNull()
  expect(installed.api.startScreenshotTranslation).toHaveBeenCalledTimes(1)
})

it('permits retranslation after the first translation fails without a cache', async () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'failed', stage: 'translation', code: 'TRANSLATION_FAILED' })

  const retry = screen.getByRole('button', { name: '重新翻译' })
  expect(retry).toBeEnabled()
  fireEvent.click(retry)
  await waitFor(() => expect(installed.api.startScreenshotTranslation)
    .toHaveBeenCalledWith({ sessionId, generation: 1 }))
})

it('keeps OCR available when no model is configured and opens the exact settings intent', () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_NOT_CONFIGURED' })
  expect(screen.getByRole('alert')).toHaveTextContent('尚未配置截图翻译使用的大模型')
  fireEvent.click(screen.getByRole('button', { name: '前往设置' }))
  expect(installed.api.openScreenshotTranslationSettings).toHaveBeenCalledWith({ sessionId, generation: 1 })
  const translate = screen.getByRole('button', { name: '显示译文' })
  expect(translate).toBeEnabled()
  fireEvent.click(translate)
  expect(installed.api.startScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 1 })
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  expect(screen.getByRole('complementary')).toHaveTextContent('Hello')
})

it('preserves OCR on fixed translation failure and permits a retry', () => {
  const installed = startReady()
  installed.emit({ sessionId, generation: 1, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT' })
  expect(screen.getByRole('alert')).toHaveTextContent('翻译超时，请重试')
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  expect(installed.api.startScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 1 })
})

it('shows OCR-empty state and toggling the sidebar never starts work', () => {
  const installed = installApi()
  renderWithClosedSidebar()
  installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 1, type: 'ocr-completed', blocks: [] })
  expect(screen.getByText('未识别到文字', { selector: '.screenshot-result-status' })).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭侧窗' }))
  expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
})

it('shows OCR progress rather than an empty-result message in the extraction sidebar', () => {
  const installed = installApi()
  renderWithClosedSidebar()
  installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
  fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
  expect(screen.getByRole('complementary')).toHaveTextContent('识别文字中…')
  expect(screen.getByRole('complementary')).not.toHaveTextContent('未识别到文字')
})

it('ignores stale generations after a higher snapshot and wires titlebar intents', async () => {
  const installed = startReady()
  expect(document.title).toBe('Arkdown截图翻译')
  installed.emit({ sessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '旧译文' }] })
  expect(screen.queryByText('旧译文')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '最小化截图翻译窗口' }))
  fireEvent.click(screen.getByRole('button', { name: '关闭截图翻译窗口' }))
  await waitFor(() => {
    expect(installed.api.minimizeScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 2 })
    expect(installed.api.closeScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 2 })
  })
})

it('queues rapid cancel, minimize, and close behind the accepted retry generation', async () => {
  const pending = deferred<{
    ok: true
    value: { sessionId: string; generation: number }
  }>()
  const installed = installApi()
  installed.api.startScreenshotTranslation = vi.fn(() => pending.promise)
  startReady(installed)

  const translate = document.querySelector<HTMLButtonElement>('.screenshot-result-toolbar__translate')!
  const titlebarControls = document.querySelectorAll<HTMLButtonElement>('.screenshot-result-titlebar__controls button')
  fireEvent.click(translate)
  fireEvent.click(translate)
  fireEvent.click(titlebarControls[0]!)
  fireEvent.click(titlebarControls[1]!)

  expect(installed.api.cancelScreenshotTranslation).not.toHaveBeenCalled()
  expect(installed.api.minimizeScreenshotTranslation).not.toHaveBeenCalled()
  expect(installed.api.closeScreenshotTranslation).not.toHaveBeenCalled()
  await act(async () => pending.resolve({ ok: true, value: { sessionId, generation: 2 } }))
  await waitFor(() => {
    expect(installed.api.cancelScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 2 })
    expect(installed.api.minimizeScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 2 })
    expect(installed.api.closeScreenshotTranslation).toHaveBeenCalledWith({ sessionId, generation: 2 })
  })
  installed.emit({
    sessionId,
    generation: 1,
    type: 'translation-completed',
    translations: [{ id: 'line-1', text: '取消后的迟到译文' }],
  })
  expect(screen.queryByText('取消后的迟到译文')).toBeNull()
})

it('exposes polite progress and keeps translated text selectable', () => {
  const installed = startReady()
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: '可选择译文' }] })
  expect(screen.getByText('可选择译文')).toHaveStyle({ userSelect: 'text' })
})

it('announces every live phase, cancellation, completion, and fixed failure', () => {
  const installed = startReady()
  expect(screen.getByRole('status')).toHaveTextContent('文字识别完成')
  installed.emit({ sessionId, generation: 1, type: 'translation-started' })
  expect(screen.getByRole('status')).toHaveTextContent('正在翻译…')
  fireEvent.click(screen.getByRole('button', { name: '翻译中…' }))
  expect(screen.getByRole('status')).toHaveTextContent('已取消翻译')
  installed.emit({ sessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 2, type: 'ocr-completed', blocks })
  installed.emit({ sessionId, generation: 2, type: 'translation-completed', translations: [{ id: 'line-1', text: '完成' }] })
  expect(screen.getByRole('status')).toHaveTextContent('翻译完成')
  installed.emit({ sessionId, generation: 3, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 3, type: 'ocr-completed', blocks })
  installed.emit({ sessionId, generation: 3, type: 'failed', stage: 'translation', code: 'MODEL_TIMEOUT' })
  expect(screen.getByRole('status')).toHaveTextContent('翻译超时，请重试')
  expect(screen.getByRole('alert')).toHaveTextContent('翻译超时，请重试')
})

it('ignores a stale start rejection after a newer snapshot completes', async () => {
  const pending = deferred<{ ok: true; value: { sessionId: string; generation: number } }>()
  const installed = installApi()
  installed.api.startScreenshotTranslation = vi.fn(() => pending.promise)
  startReady(installed)
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  installed.emit({ sessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
  installed.emit({ sessionId, generation: 2, type: 'ocr-completed', blocks })
  installed.emit({ sessionId, generation: 2, type: 'translation-completed', translations: [{ id: 'line-1', text: '新译文' }] })
  await act(async () => pending.reject(new Error('stale transport failure')))
  expect(screen.getByText('新译文')).toBeVisible()
  expect(screen.getByRole('button', { name: '显示原文' })).toBeEnabled()
})

it('ignores an earlier retry rejection while the latest local attempt is running', async () => {
  const first = deferred<{ ok: true; value: { sessionId: string; generation: number } }>()
  const second = deferred<{ ok: true; value: { sessionId: string; generation: number } }>()
  const installed = installApi()
  installed.api.startScreenshotTranslation = vi.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  startReady(installed)
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  fireEvent.click(screen.getByRole('button', { name: '翻译中…' }))
  fireEvent.click(screen.getByRole('button', { name: '显示译文' }))
  await act(async () => first.reject(new Error('old retry failed')))
  expect(screen.getByRole('button', { name: '翻译中…' })).toBeEnabled()
  await act(async () => second.resolve({ ok: true, value: { sessionId, generation: 2 } }))
})

it('keeps all nonempty blocks visible when one overlay cannot fit', async () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (!this.classList.contains('screenshot-translated-block')) return 0
      return this.textContent === 'overflow' ? 200 : 20
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.classList.contains('screenshot-translated-block') ? 20 : 0 },
  })
  try {
    const installed = installApi()
    const secondBlock = {
      id: 'line-2', text: 'World', rectPx: { x: 160, y: 20, width: 120, height: 30 },
      words: [{ text: 'World', rectPx: { x: 160, y: 20, width: 120, height: 30 } }],
    }
    renderWithClosedSidebar()
    installed.emit({ sessionId, generation: 1, type: 'snapshot-ready', image, tier: 'small' })
    installed.emit({ sessionId, generation: 1, type: 'ocr-completed', blocks: [...blocks, secondBlock] })
    fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
    installed.emit({
      sessionId, generation: 1, type: 'translation-completed',
      translations: [{ id: 'line-1', text: 'fits' }, { id: 'line-2', text: 'overflow' }],
    })
    await waitFor(() => expect(screen.getByText('overflow', { selector: '.screenshot-translated-block' })).toBeVisible())
    expect(screen.getByText('fits', { selector: '.screenshot-translated-block' })).toBeVisible()
    expect(screen.getByText('overflow', { selector: '.screenshot-translated-block' })).toHaveAttribute('aria-hidden', 'false')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('img', { name: '截图原文' })).toHaveClass('is-translated')
    expect(screen.getByRole('button', { name: '显示原文' })).toBeEnabled()
    expect(screen.getByRole('complementary', { name: '提取的文字' })).toHaveTextContent('fits')
    expect(screen.getByRole('complementary', { name: '提取的文字' })).toHaveTextContent('overflow')
  } finally {
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  }
})

it('shrinks a translated DOM block through bounded measured candidates until it fits', () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  const measuredFontSizes: number[] = []
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (!this.classList.contains('screenshot-translated-block')) return 0
      const fontSize = Number.parseFloat((this as HTMLElement).style.fontSize)
      measuredFontSizes.push(fontSize)
      return fontSize > 11 ? 60 : 20
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.classList.contains('screenshot-translated-block') ? 30 : 0 },
  })
  try {
    const installed = startReady()
    installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'measured-shrink' }] })
    const translated = screen.getByText('measured-shrink')
    expect(translated).toBeVisible()
    expect(Number.parseFloat(translated.style.fontSize)).toBeGreaterThanOrEqual(10)
    expect(Number.parseFloat(translated.style.fontSize)).toBeLessThanOrEqual(11)
    expect(measuredFontSizes.length).toBeLessThanOrEqual(20)
  } finally {
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  }
})

it('keeps a positive font and a visible fallback when no measured size fits', () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  const measuredFontSizes: number[] = []
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (!this.classList.contains('screenshot-translated-block')) return 0
      measuredFontSizes.push(Number.parseFloat((this as HTMLElement).style.fontSize))
      return 200
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.classList.contains('screenshot-translated-block') ? 20 : 0 },
  })
  try {
    const installed = startReady()
    installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'minimum-overflow' }] })
    expect(screen.getByText('minimum-overflow')).toBeVisible()
    expect(screen.getByText('minimum-overflow')).toHaveAttribute('data-fit', 'unfit')
    expect(Math.min(...measuredFontSizes)).toBeGreaterThan(0)
    expect(measuredFontSizes.length).toBeLessThanOrEqual(20)
  } finally {
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  }
})

it('remeasures an unfit overlay after the extraction sidebar closes without changing translation state', async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains('screenshot-result-viewport')) {
      const sidebarOpen = Boolean(document.querySelector('.screenshot-text-sidebar'))
      return DOMRect.fromRect({ width: sidebarOpen ? 160 : 800, height: 400 })
    }
    return originalRect.call(this)
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('screenshot-translated-block')
        ? Number.parseFloat((this as HTMLElement).style.width)
        : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      if (!this.classList.contains('screenshot-translated-block')) return 0
      const width = Number.parseFloat((this as HTMLElement).style.width)
      return width < 100 ? width + 10 : width
    },
  })
  try {
    const installed = startReady()
    fireEvent.click(screen.getByRole('button', { name: '打开侧窗' }))
    installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'X' }] })
    await waitFor(() => expect(screen.getByText('X', { selector: '.screenshot-translated-block' })).toBeVisible())
    fireEvent.click(screen.getByRole('button', { name: '关闭侧窗' }))
    await waitFor(() => expect(screen.getByText('X', { selector: '.screenshot-translated-block' })).toBeVisible())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '显示原文' })).toBeEnabled()
    expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
    else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  }
})

it('lets a resize remeasure an unfit overlay without changing translation state', async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  let viewportWidth = 160
  let notifyResize: (() => void) | undefined
  class TestResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      notifyResize = () => callback([], this as unknown as ResizeObserver)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: TestResizeObserver })
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList.contains('screenshot-result-viewport')) {
      return DOMRect.fromRect({ width: viewportWidth, height: 400 })
    }
    return originalRect.call(this)
  }
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return this.classList.contains('screenshot-translated-block')
        ? Number.parseFloat((this as HTMLElement).style.width)
        : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get() {
      if (!this.classList.contains('screenshot-translated-block')) return 0
      const width = Number.parseFloat((this as HTMLElement).style.width)
      return width < 100 ? width + 10 : width
    },
  })
  try {
    const installed = startReady()
    installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'R' }] })
    await waitFor(() => expect(screen.getByText('R')).toBeVisible())
    viewportWidth = 800
    act(() => notifyResize?.())
    await waitFor(() => expect(screen.getByText('R')).toBeVisible())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: '显示原文' })).toBeEnabled()
    expect(installed.api.startScreenshotTranslation).not.toHaveBeenCalled()
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    if (originalResizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalResizeObserver)
    else delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver
    if (originalScrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth)
    else delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth
    if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  }
})

it('does not reject a generation only because its current overlay is unfit', async () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (!this.classList.contains('screenshot-translated-block')) return 0
      return this.textContent === 'old-overflow' ? 200 : 20
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.classList.contains('screenshot-translated-block') ? 30 : 0 },
  })
  try {
    const installed = startReady()
    installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'old-overflow' }] })
    await waitFor(() => expect(screen.getByText('old-overflow')).toBeVisible())
    installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'new-fit' }] })
    expect(screen.getByText('new-fit')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  } finally {
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  }
})

it('does not leak an unfit measurement into a retry generation', () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() {
      if (!this.classList.contains('screenshot-translated-block')) return 0
      return this.textContent === 'generation-one-overflow' ? 200 : 20
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() { return this.classList.contains('screenshot-translated-block') ? 30 : 0 },
  })
  try {
    const installed = startReady()
    installed.emit({ sessionId, generation: 1, type: 'translation-completed', translations: [{ id: 'line-1', text: 'generation-one-overflow' }] })
    expect(screen.getByText('generation-one-overflow')).toBeVisible()
    installed.emit({ sessionId, generation: 2, type: 'snapshot-ready', image, tier: 'small' })
    installed.emit({ sessionId, generation: 2, type: 'ocr-completed', blocks })
    installed.emit({ sessionId, generation: 2, type: 'translation-completed', translations: [{ id: 'line-1', text: 'generation-two-fit' }] })
    expect(screen.getByText('generation-two-fit')).toBeVisible()
  } finally {
    if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight)
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight
    if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
  }
})
