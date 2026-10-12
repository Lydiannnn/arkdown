import { modelObservation, modelCommit } from '../helpers/model-observation'
import type { TransactionalModelConnectionService } from '../../src/main/models/transactional-model-connection-service'
import { expect, it, vi } from 'vitest'
import {
  createIpcOperations,
  registerIpc,
  registerIpcHandlers,
  registerScreenshotResultWindowIpc,
  registerScreenshotSelectionWindowIpc,
} from '../../src/main/ipc/register-ipc'
import { IPC_CHANNELS, SCREENSHOT_OCR_MODEL_CHANNELS } from '../../src/shared/contracts'
import { OcrPreferenceConflictError } from '../../src/shared/screenshot-ocr-models'
import { DEFAULT_LARGE_MODEL_SETTINGS } from '../../src/shared/large-model-settings'

const sessionId = '123e4567-e89b-42d3-a456-426614174000'

it('exposes only public model settings and strict screenshot preference writes to the owning result frame', async () => {
  const ipcMain = registrar()
  const webContents = { mainFrame: {} }
  let settings = structuredClone(DEFAULT_LARGE_MODEL_SETTINGS)
  const original = modelObservation(settings)
  const modelConnections = { getSettings: vi.fn(async () => original), setFeature: vi.fn<TransactionalModelConnectionService['setFeature']>(async (_observed, _feature, input) => {
    settings = { ...settings, screenshotTranslation: { ...settings.screenshotTranslation, ...input } }
    return modelCommit(settings)
  }) }
  registerScreenshotResultWindowIpc({ ipcMain, window: { webContents }, operations: {} as never, observedModelConnections: modelConnections })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  await expect(ipcMain.handlers.get(IPC_CHANNELS.getLargeModelSettings)!(event)).resolves.toEqual({ ok: true, value: settings })
  const patch = { thinkingMode: 'disabled', reasoningEffort: 'low', targetLanguage: 'en' }
  const input = { observed: original, input: patch }
  await expect(ipcMain.handlers.get(IPC_CHANNELS.setScreenshotTranslationSettings)!(event, input)).resolves.toMatchObject({ ok: true, value: { status: 'committed', snapshot: { settings: { screenshotTranslation: patch } } } })
  expect(settings.selectionTranslation).toEqual(DEFAULT_LARGE_MODEL_SETTINGS.selectionTranslation)
  for (const wrong of [{ sender: webContents, senderFrame: {} }, { sender: { mainFrame: {} }, senderFrame: webContents.mainFrame }]) {
    await expect(ipcMain.handlers.get(IPC_CHANNELS.setScreenshotTranslationSettings)!(wrong, input)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
    await expect(ipcMain.handlers.get(IPC_CHANNELS.getLargeModelSettings)!(wrong)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  }
  for (const channel of [IPC_CHANNELS.setAiConversationSettings, IPC_CHANNELS.setSelectionTranslationSettings, IPC_CHANNELS.connectModel]) {
    await expect(ipcMain.handlers.get(channel)!(event, input)).resolves.toMatchObject({ ok: false })
  }
  await expect(ipcMain.handlers.get(IPC_CHANNELS.setScreenshotTranslationSettings)!(event, { ...input, apiKey: 'secret' })).resolves.toMatchObject({ ok: false })
  expect(modelConnections.setFeature).toHaveBeenCalledExactlyOnceWith(original, 'screenshotTranslation', patch)
  expect(modelConnections.getSettings).toHaveBeenCalledOnce()
})

it('parses screenshot intent before calling its injected coordinator', async () => {
  const hit = { processId: 77, rectDip: { x: 10, y: 20, width: 30, height: 40 } }
  const screenshots = { updatePointer: vi.fn().mockResolvedValue(hit), ready: vi.fn(), commit: vi.fn(), cancel: vi.fn() }
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(), screenshots,
  })
  await expect(operations.updateScreenshotCapturePointer({ sessionId, displayId: '1', screenPointDip: { x: 1, y: 2 } })).resolves.toEqual({ ok: true, value: hit })
  await expect(operations.commitScreenshotCapture({ sessionId, displayId: '1', kind: 'region', rectDip: { x: 0, y: 0, width: 1, height: 1 } })).resolves.toEqual({ ok: true, value: null })
  await expect(operations.cancelScreenshotCapture({ sessionId })).resolves.toEqual({ ok: true, value: null })
  await expect(operations.commitScreenshotCapture({ sessionId, displayId: '1', kind: 'region', rectDip: { x: 0, y: 0, width: 0, height: 1 } })).resolves.toMatchObject({ ok: false })
  expect(screenshots.commit).toHaveBeenCalledOnce()
})

it('routes exact OCR host completion through the ordinary-window operation boundary', async () => {
  const screenshotOcrHost = {
    submit: vi.fn(() => true),
    settleOcr: vi.fn(() => true),
  }
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(), screenshotOcrHost,
  })
  const submission = {
    sessionId, generation: 1, status: 'success' as const,
    result: { width: 4, height: 3, language: 'mul', blocks: [] },
  }
  await expect(operations.submitScreenshotOcr(submission)).resolves.toEqual({ ok: true, value: null })
  await expect(operations.settleScreenshotOcr({ sessionId, generation: 1 })).resolves.toEqual({ ok: true, value: null })
  expect(screenshotOcrHost.submit).toHaveBeenCalledWith(submission)
  expect(screenshotOcrHost.settleOcr).toHaveBeenCalledWith({ sessionId, generation: 1 })
})

it('keeps screenshot operations owned by the exact overlay sender and main frame', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  }
  const firstSender = { mainFrame: {} }
  const secondSender = { mainFrame: {} }
  const first = vi.fn().mockResolvedValue({ ok: true, value: null })
  const second = vi.fn().mockResolvedValue({ ok: true, value: null })
  registerIpcHandlers({ ipcMain, window: { webContents: firstSender }, operations: { cancelScreenshotCapture: first } })
  registerIpcHandlers({ ipcMain, window: { webContents: secondSender }, operations: { cancelScreenshotCapture: second } })
  const handler = handlers.get(IPC_CHANNELS.cancelScreenshotCapture)!

  await expect(handler({ sender: firstSender, senderFrame: firstSender.mainFrame }, { sessionId })).resolves.toEqual({ ok: true, value: null })
  await expect(handler({ sender: secondSender, senderFrame: secondSender.mainFrame }, { sessionId })).resolves.toEqual({ ok: true, value: null })
  await expect(handler({ sender: firstSender, senderFrame: secondSender.mainFrame }, { sessionId })).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })

  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
})

function registrar() {
  const handlers = new Map<string, (event: unknown, input?: unknown) => unknown>()
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (event: unknown, input?: unknown) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

it('registers a selection window with only pointer, commit, and cancel operations', async () => {
  const ipcMain = registrar()
  const webContents = { mainFrame: {} }
  const operations = { updatePointer: vi.fn(), ready: vi.fn(), commit: vi.fn(), cancel: vi.fn() }
  registerScreenshotSelectionWindowIpc({
    ipcMain,
    window: { webContents },
    displayId: '1',
    operations,
  })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  await expect(ipcMain.handlers.get(IPC_CHANNELS.updateScreenshotCapturePointer)!(event, {
    sessionId, displayId: '2', screenPointDip: { x: 2, y: 3 },
  })).resolves.toEqual({ ok: true, value: null })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.commitScreenshotCapture)!(event, {
    sessionId, displayId: '2', kind: 'region', rectDip: { x: 0, y: 0, width: 1, height: 1 },
  })).resolves.toEqual({ ok: true, value: null })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.readyScreenshotCapture)!(event, {
    sessionId, displayId: '2',
  })).resolves.toEqual({ ok: true, value: null })
  expect(operations.updatePointer).not.toHaveBeenCalled()
  expect(operations.commit).not.toHaveBeenCalled()
  expect(operations.ready).not.toHaveBeenCalled()
  await expect(ipcMain.handlers.get(IPC_CHANNELS.updateScreenshotCapturePointer)!(event, {
    sessionId, displayId: '1', screenPointDip: { x: 2, y: 3 },
  })).resolves.toEqual({ ok: true, value: null })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.readyScreenshotCapture)!(event, {
    sessionId, displayId: '1',
  })).resolves.toEqual({ ok: true, value: null })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.startScreenshotTranslation)!(event, {
    sessionId, generation: 1,
  })).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
  expect(operations.updatePointer).toHaveBeenCalledTimes(1)
  expect(operations.ready).toHaveBeenCalledTimes(1)
})

it('registers exact result commands, rejects malformed tokens and non-main frames, and exposes no document operations', async () => {
  const ipcMain = registrar()
  const webContents = { mainFrame: {} }
  const operations = {
    submit: vi.fn(() => true),
    settleOcr: vi.fn(() => true),
    start: vi.fn(async (input) => ({ ...input, generation: input.generation + 1 })),
    cancel: vi.fn(() => true),
    minimize: vi.fn(() => true),
    canClose: vi.fn(() => true),
    close: vi.fn(async () => true),
    openSettings: vi.fn(() => true),
  }
  registerScreenshotResultWindowIpc({ ipcMain, window: { webContents }, operations })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const input = { sessionId, generation: 4 }
  const ocrSubmission = {
    sessionId, generation: 4, status: 'success' as const,
    result: { width: 4, height: 3, language: 'mul', blocks: [] },
  }
  await expect(ipcMain.handlers.get(IPC_CHANNELS.submitScreenshotOcr)!(event, ocrSubmission))
    .resolves.toEqual({ ok: true, value: null })
  expect(operations.submit).toHaveBeenCalledWith(ocrSubmission)
  await expect(ipcMain.handlers.get(IPC_CHANNELS.startScreenshotTranslation)!(event, input))
    .resolves.toEqual({ ok: true, value: { sessionId, generation: 5 } })
  expect(operations.start).toHaveBeenCalledWith(input)
  for (const [channel, method] of [
    [IPC_CHANNELS.cancelScreenshotTranslation, operations.cancel],
    [IPC_CHANNELS.minimizeScreenshotTranslation, operations.minimize],
    [IPC_CHANNELS.closeScreenshotTranslation, operations.close],
    [IPC_CHANNELS.openScreenshotTranslationSettings, operations.openSettings],
  ] as const) {
    await expect(ipcMain.handlers.get(channel)!(event, input)).resolves.toEqual({ ok: true, value: null })
    expect(method).toHaveBeenCalledWith(input)
  }
  await expect(ipcMain.handlers.get(IPC_CHANNELS.startScreenshotTranslation)!(event, {
    ...input, generation: 0,
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.submitScreenshotOcr)!(event, {
    ...ocrSubmission, extra: true,
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.submitScreenshotOcr)!({
    sender: webContents, senderFrame: {},
  }, ocrSubmission)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.startScreenshotTranslation)!({
    sender: webContents, senderFrame: {},
  }, input)).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  await expect(ipcMain.handlers.get(IPC_CHANNELS.saveDocument)!(event, {}))
    .resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
  expect(operations.start).toHaveBeenCalledTimes(1)
})

it('returns a safe failure for a stale exact-shaped result token', async () => {
  const ipcMain = registrar()
  const webContents = { mainFrame: {} }
  const operations = {
    submit: vi.fn(() => false),
    settleOcr: vi.fn(() => false),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(() => false),
    minimize: vi.fn(() => false),
    canClose: vi.fn(() => false),
    close: vi.fn(async () => false),
    openSettings: vi.fn(() => false),
  }
  registerScreenshotResultWindowIpc({ ipcMain, window: { webContents }, operations })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const input = { sessionId, generation: 4 }

  for (const channel of [
    IPC_CHANNELS.submitScreenshotOcr,
    IPC_CHANNELS.startScreenshotTranslation,
    IPC_CHANNELS.cancelScreenshotTranslation,
    IPC_CHANNELS.minimizeScreenshotTranslation,
    IPC_CHANNELS.closeScreenshotTranslation,
    IPC_CHANNELS.openScreenshotTranslationSettings,
  ]) {
    await expect(ipcMain.handlers.get(channel)!(event, input))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(operations.close).not.toHaveBeenCalled()
})

it('acknowledges an accepted close before queued teardown drains the invoking handler', async () => {
  const ipcMain = registrar()
  const webContents = { mainFrame: {} }
  const teardown = deferred()
  const close = vi.fn(async (_input: unknown) => teardown.promise)
  const operations = {
    submit: vi.fn(() => true),
    settleOcr: vi.fn(() => true),
    start: vi.fn(async () => undefined),
    cancel: vi.fn(() => true),
    minimize: vi.fn(() => true),
    canClose: vi.fn(() => true),
    close: vi.fn(async (input) => { await close(input); return true }),
    openSettings: vi.fn(() => true),
  }
  registerScreenshotResultWindowIpc({ ipcMain, window: { webContents }, operations })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  const input = { sessionId, generation: 4 }

  await expect(ipcMain.handlers.get(IPC_CHANNELS.closeScreenshotTranslation)!(event, input))
    .resolves.toEqual({ ok: true, value: null })
  expect(close).toHaveBeenCalledWith(input)
  teardown.resolve()
})

it('registers observed OCR mutations only for the exact ordinary-window main frame', async () => {
  const ipcMain = registrar()
  const webContents = { mainFrame: {} }
  const modelState = {
    activeTier: 'small' as const, bundledVersion: '6.0.0', mediumVersion: null,
    availableMediumVersion: '6.0.0', status: 'medium-absent' as const,
    progress: null, errorCode: null,
  }
  const initialization = deferred()
  const observed = { revision: 5, preferredTier: 'small' as const, tierRevision: 2 }
  const models = {
    initialize: vi.fn(() => initialization.promise),
    getState: vi.fn(() => modelState),
    getObservedState: vi.fn(async () => ({ state: modelState, observed })),
    downloadMedium: vi.fn(async () => ({ ...modelState, status: 'medium-installed' as const, mediumVersion: '6.0.0', availableMediumVersion: null })),
    cancelMediumDownload: vi.fn(async () => modelState),
    removeMedium: vi.fn(async () => modelState),
  }
  registerIpc({
    ipcMain,
    window: { webContents },
    showOpenDialog: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    screenshotOcrModels: models,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    controlWindow: vi.fn() as never,
    getWindowState: vi.fn() as never,
  })
  const event = { sender: webContents, senderFrame: webContents.mainFrame }
  expect(models.initialize).not.toHaveBeenCalled()
  const pendingState = ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.getState)!(event)
  await Promise.resolve()
  expect(models.initialize).toHaveBeenCalledOnce()
  expect(models.getObservedState).not.toHaveBeenCalled()
  initialization.resolve()
  await expect(pendingState).resolves.toEqual({ ok: true, value: { state: modelState, observed } })
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.downloadMedium)!(event, observed)).resolves.toMatchObject({ ok: true, value: { status: 'medium-installed' } })
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.cancelMediumDownload)!(event)).resolves.toEqual({ ok: true, value: modelState })
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.removeMedium)!(event, observed)).resolves.toEqual({ ok: true, value: modelState })
  for (const input of [undefined, { ...observed, tierRevision: 9 }, { ...observed, arbitrary: true }]) {
    await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.downloadMedium)!(event, input))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.cancelMediumDownload)!(event, {})).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.getState)!(event, {})).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.getState)!({ sender: webContents, senderFrame: {} })).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.getState)!({ sender: {}, senderFrame: {} })).resolves.toMatchObject({ ok: false, error: { code: 'UNTRUSTED_SENDER' } })
  expect(models.getObservedState).toHaveBeenCalledOnce()
  expect(models.initialize).toHaveBeenCalledOnce()
  expect(models.downloadMedium).toHaveBeenCalledOnce()
  expect(models.downloadMedium).toHaveBeenCalledWith(observed)
  expect(models.cancelMediumDownload).toHaveBeenCalledOnce()
  expect(models.removeMedium).toHaveBeenCalledOnce()
  expect(models.removeMedium).toHaveBeenCalledWith(observed)
  models.downloadMedium.mockRejectedValueOnce(new OcrPreferenceConflictError())
  await expect(ipcMain.handlers.get(SCREENSHOT_OCR_MODEL_CHANNELS.downloadMedium)!(event, observed))
    .resolves.toEqual({ ok: true, value: { status: 'conflict' } })
})
