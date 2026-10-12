import { afterEach, expect, it, vi } from 'vitest'
import { AiConversationSessionService } from '../../src/main/models/ai-conversation-session-service'
import { wireDesktopLifecycle } from '../../src/main/desktop-lifecycle'
import { DocumentService } from '../../src/main/documents/document-service'
import { OpenDocumentRegistry } from '../../src/main/documents/open-document-registry'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { observeModelSettings } from '../../src/main/settings/settings-command-adapter'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import {
  DOCUMENT_CONVERSION_IPC_CHANNELS,
  IPC_CHANNELS,
  SCREENSHOT_OCR_MODEL_CHANNELS,
  type StickyNoteEvent,
} from '../../src/shared/contracts'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'

class LifecycleWindow {
  readonly webListeners = new Map<string, () => void>()
  readonly webContents = {
    id: 77,
    mainFrame: {},
    send: vi.fn(),
    isDestroyed: vi.fn(() => false),
    on: vi.fn((event: string, listener: () => void) => {
      this.webListeners.set(event, listener)
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (this.webListeners.get(event) === listener) this.webListeners.delete(event)
    }),
  }
  closeCalls = 0
  isDestroyed = vi.fn(() => false)
  isFullScreen = vi.fn(() => { throw new Error('direct fullscreen read') })
  isMaximized = vi.fn(() => { throw new Error('direct maximized read') })
  private closeListener: ((event: { preventDefault(): void }) => void) | undefined
  private closedListener: (() => void) | undefined

  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void {
    if (event === 'close') this.closeListener = listener
  }

  once(event: 'closed', listener: () => void): void {
    if (event === 'closed') this.closedListener = listener
  }

  getSize(): [number, number] {
    return [1200, 800]
  }

  getPosition(): [number, number] {
    return [80, 60]
  }

  close(): void {
    this.closeCalls += 1
    this.closedListener?.()
  }

  triggerClose(): void {
    this.closeListener?.({ preventDefault() {} })
  }
}

afterEach(() => vi.restoreAllMocks())

it.each(['idle AI', 'cancel then drain AI', 'AI drain failure', 'cleanup failure'] as const)('keeps document preparation after AI and live owner IPC before finalization: %s', async mode => {
  const handlers = new Map<string, unknown>()
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    on: vi.fn((channel: string, listener: (event: unknown, payload: unknown) => void) => {
      listeners.set(channel, listener)
    }),
    removeListener: vi.fn((channel: string) => listeners.delete(channel)),
  }
  const save = vi.fn().mockResolvedValue(undefined)
  const models = {
    version: 6 as const,
    codexCli: null,
    connections: [{
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'Test',
      provider: 'deepseek' as const,
      accessType: 'standard-api' as const,
      protocol: 'openai' as const,
      baseUrl: 'https://api.example.com/v1',
      modelId: 'chat-model',
      apiKeyHint: '••••test',
      status: 'connected' as const,
      lastTestedAt: null,
      capabilityOverride: null,
    }],
    selectionTranslation: {
      connectionId: '550e8400-e29b-41d4-a716-446655440000',
      thinkingMode: 'default' as const, reasoningEffort: 'default' as const,
      targetLanguage: 'fr' as const,
      privacyNoticeAccepted: true,
    },
    screenshotTranslation: {
      connectionId: '550e8400-e29b-41d4-a716-446655440000',
      thinkingMode: 'default' as const, reasoningEffort: 'default' as const,
      targetLanguage: 'fr' as const,
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default' as const,
      writePolicy: 'ask-every-time' as const,
    },
  }
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null, models })
  const window = new LifecycleWindow()
  let onDelta: ((delta: string) => void) | undefined
  let onStickyNoteEvent: ((event: StickyNoteEvent) => void) | undefined
  const unsubscribeStickyNotes = vi.fn()
  const onDesktopLifecyclePreferencesChanged = vi.fn()
  const onEditorAppearancePreferencesChanged = vi.fn()
  const controlWindow = vi.fn(() => ({
    maximized: false,
    fullscreen: true,
    revision: 4,
  }))
  const getWindowState = vi.fn(() => ({
    maximized: true,
    fullscreen: false,
    revision: 3,
  }))
  const stickyNotes = {
    list: vi.fn(async () => []),
    search: vi.fn(async () => []),
    read: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    delete: vi.fn(),
    importFile: vi.fn(),
    stageSave: vi.fn(),
    flushSave: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    release: vi.fn(),
    reclaim: vi.fn(),
    setPinned: vi.fn(),
    setStyle: vi.fn(),
      resizeToContent: vi.fn(async () => undefined),
  }
  let finishCodexLogin!: () => void
  const startCodexCliLogin = vi.fn(() => new Promise<{ status: 'cancelled' }>(resolve => {
    finishCodexLogin = () => resolve({ status: 'cancelled' })
  }))
  const cancelCodexCliLogin = vi.fn(async () => { finishCodexLogin?.() })
  const modelObservation = observeModelSettings({ settings: { lastWorkspace: null, models }, revision: 0,
    minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } })
  const modelMutation = { status: 'unchanged' as const, snapshot: modelObservation }
  const codexCliConnections = {
    test: vi.fn(async () => ({
      status: 'connected' as const,
      mutation: modelMutation,
    })),
    remove: vi.fn(async () => modelMutation),
  }
  let settleActiveMediumOcr!: () => void
  const activeMediumOcrSettlement = new Promise<void>((resolve) => {
    settleActiveMediumOcr = resolve
  })
  const closeScreenshotOwner = vi.fn(() => activeMediumOcrSettlement)
  const abortScreenshotOwnerClose = vi.fn()
  const screenshotSessionId = '123e4567-e89b-42d3-a456-426614174000'
  const screenshotOcrHost = {
    submit: vi.fn(() => true),
    settleOcr: vi.fn((input: { sessionId: string; generation: number }) => {
      if (input.sessionId === screenshotSessionId && input.generation === 1) {
        settleActiveMediumOcr()
      }
      return true
    }),
  }
  const mermaidImageExport = {
    copyPng: vi.fn(async () => undefined),
    save: vi.fn(async () => 'C:\\exports\\diagram.svg'),
  }

  const saveWindowBounds = vi.fn(async () => undefined)
  const confirmStopAi = vi.fn(async () => true)
  let finishAiDrain!: () => void
  const aiDrain = new Promise<void>(resolve => { finishAiDrain = resolve })
  const stopped = vi.fn()
  const resumed = vi.fn()
  if (mode === 'cancel then drain AI' || mode === 'AI drain failure') {
    if (mode === 'cancel then drain AI') confirmStopAi.mockResolvedValueOnce(false)
    const original = AiConversationSessionService.prototype.beginCloseAdmission
    vi.spyOn(AiConversationSessionService.prototype, 'beginCloseAdmission').mockImplementation(function (this: AiConversationSessionService) {
      const ticket = original.call(this)
      return {
        hasRunningWork: true,
        stopAndDrain: async () => {
          stopped(); await aiDrain
          if (mode === 'AI drain failure') throw new Error('AI terminal cleanup failed')
          await ticket.stopAndDrain()
        },
        resume: async () => { resumed(); await ticket.resume() },
      }
    })
  }
  const wired = wireDesktopLifecycle({
    ipcMain,
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    window,
    runtimeDependencies: {
      workspaceCommitAdapter: undefined,
      openDocumentRegistry: new OpenDocumentRegistry(),
      workspaceAiEditorBoundary: {
        withIdentityLease: async (_target: unknown, operation: () => unknown) => await operation(),
        lookup: vi.fn(async () => ({ status: 'closed' as const })),
        captureReadSnapshot: vi.fn(),
        planReplacement: vi.fn(),
        applyTransaction: vi.fn(),
        queryOutcome: vi.fn(),
      },
      registerWindowCleanup: vi.fn((cleanup: () => void | Promise<void>) => {
        let promise: Promise<void> | undefined
        return {
          disposeWindow: () => promise ??= Promise.resolve().then(cleanup),
          unregister: vi.fn(),
        }
      }),
    } as never,
    documentConversions: {
      convertResolved: vi.fn(),
    } as never,
    settingsCoordinator: coordinator,
    saveWindowBounds,
    confirmStopAi,
    onCloseStateChanged: vi.fn(),
    normalizeBounds: (bounds) => bounds,
    reportOperationError: vi.fn(),
    reportCloseError: vi.fn(),
    modelConnections: {
      getCredentialSnapshot: vi.fn(async () => ({
        connection: coordinator.get().models!.connections[0]!,
        apiKey: 'api-key',
      })),
    } as never,
    modelSecretVault: { get: vi.fn().mockResolvedValue('api-key') } as never,
    modelProtocolClient: {
      testConnection: vi.fn(),
      streamChat: vi.fn(async (input: { onDelta(delta: string): void }) => {
        onDelta = input.onDelta
        return await new Promise<{ toolCalls: [] }>(() => {})
      }),
    } as never,
    observedCodexCliConnections: codexCliConnections,
    ensureCodexCli: async () => true,
    startCodexCliLogin,
    cancelCodexCliLogin,
    stickyNotes,
    screenshotOcrHost,
    createMermaidImageExportService: () => mermaidImageExport as never,
    closeScreenshotOwner,
    abortScreenshotOwnerClose,
    onDesktopLifecyclePreferencesChanged,
    onEditorAppearancePreferencesChanged,
    controlWindow,
    getWindowState,
    subscribeStickyNoteEvents(listener) {
      onStickyNoteEvent = listener
      return unsubscribeStickyNotes
    },
  })

  expect(wired.workspace).toBeInstanceOf(WorkspaceService)
  expect(wired.documents).toBeInstanceOf(DocumentService)
  expect(wired.ai.ownerId).toBe(77)
  const registeredChannelCount = Object.values(IPC_CHANNELS).length
    - 2
    - DOCUMENT_CONVERSION_IPC_CHANNELS.length
    + Object.values(SCREENSHOT_OCR_MODEL_CHANNELS).length
  expect(handlers).toHaveLength(registeredChannelCount)
  const ownerEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
  const registerAiCurrentDocumentPort = handlers.get(
    IPC_CHANNELS.registerAiCurrentDocumentPort,
  ) as (event: unknown) => Promise<unknown>
  await expect(registerAiCurrentDocumentPort(ownerEvent)).resolves.toEqual({
    ok: true,
    value: { portGeneration: 1 },
  })
  const testCodexCliConnection = handlers.get(IPC_CHANNELS.testCodexCliConnection) as (
    event: unknown,
    input: unknown,
  ) => Promise<unknown>
  const removeCodexCliConnection = handlers.get(IPC_CHANNELS.removeCodexCliConnection) as (
    event: unknown,
    input: unknown,
  ) => Promise<unknown>
  await expect(testCodexCliConnection(ownerEvent, { observed: modelObservation })).resolves.toEqual({
    ok: true,
    value: {
      status: 'connected',
      mutation: modelMutation,
    },
  })
  await expect(removeCodexCliConnection(ownerEvent, { observed: modelObservation })).resolves.toEqual({
    ok: true,
    value: modelMutation,
  })
  expect(codexCliConnections.test).toHaveBeenCalledExactlyOnceWith(modelObservation)
  expect(codexCliConnections.remove).toHaveBeenCalledExactlyOnceWith(modelObservation)
  const copyMermaidImage = handlers.get(IPC_CHANNELS.copyMermaidImage) as (
    event: unknown,
    input: unknown,
  ) => Promise<unknown>
  const pngDataUrl = 'data:image/png;base64,iVBORw0KGgo='
  await expect(copyMermaidImage(ownerEvent, { pngDataUrl })).resolves.toEqual({
    ok: true,
    value: null,
  })
  expect(mermaidImageExport.copyPng).toHaveBeenCalledWith(pngDataUrl)
  const getWindowStateHandler = handlers.get(IPC_CHANNELS.getWindowState) as (
    event: unknown,
  ) => Promise<unknown>
  const controlWindowHandler = handlers.get(IPC_CHANNELS.controlWindow) as (
    event: unknown,
    input: unknown,
  ) => Promise<unknown>
  await expect(getWindowStateHandler(ownerEvent)).resolves.toEqual({
    ok: true,
    value: { maximized: true, fullscreen: false, revision: 3 },
  })
  await expect(controlWindowHandler(ownerEvent, { action: 'toggle-fullscreen' })).resolves.toEqual({
    ok: true,
    value: { maximized: false, fullscreen: true, revision: 4 },
  })
  expect(controlWindow).toHaveBeenCalledWith('toggle-fullscreen')
  expect(window.isFullScreen).not.toHaveBeenCalled()
  expect(window.isMaximized).not.toHaveBeenCalled()
  const setDesktopLifecyclePreferences = handlers.get(
    IPC_CHANNELS.setDesktopLifecyclePreferences,
  ) as (event: unknown, input: unknown) => Promise<unknown>
  const nextDesktopLifecycle = {
    launchAtLogin: true,
    closeBehavior: 'tray' as const,
    stickyNoteAutostartPrompted: true,
  }
  await expect(setDesktopLifecyclePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    nextDesktopLifecycle,
  )).resolves.toEqual({ ok: true, value: nextDesktopLifecycle })
  expect(onDesktopLifecyclePreferencesChanged).toHaveBeenCalledWith(nextDesktopLifecycle)
  const setEditorAppearancePreferences = handlers.get(
    IPC_CHANNELS.setEditorAppearancePreferences,
  ) as (event: unknown, input: unknown) => Promise<unknown>
  const enabledAppearance = {
    ...DEFAULT_EDITOR_APPEARANCE,
    spellCheckEnabled: true,
  }
  const getEditorAppearancePreferences = handlers.get(
    IPC_CHANNELS.getEditorAppearancePreferences,
  ) as (event: unknown) => Promise<unknown>
  await expect(getEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
  )).resolves.toEqual({
    ok: true,
    value: { appearance: DEFAULT_EDITOR_APPEARANCE, revision: 0 },
  })
  await expect(setEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    enabledAppearance,
  )).resolves.toEqual({
    ok: true,
    value: { appearance: enabledAppearance, revision: 1 },
  })
  expect(onEditorAppearancePreferencesChanged).toHaveBeenCalledWith({
    appearance: enabledAppearance,
    revision: 1,
  })

  const compareAndSetEditorAppearancePreferences = handlers.get(
    IPC_CHANNELS.compareAndSetEditorAppearancePreferences,
  ) as (event: unknown, input: unknown) => Promise<unknown>
  await expect(compareAndSetEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    {
      expectedRevision: 1,
      expectedAppearance: enabledAppearance,
      replacement: DEFAULT_EDITOR_APPEARANCE,
    },
  )).resolves.toEqual({
    ok: true,
    value: { appearance: DEFAULT_EDITOR_APPEARANCE, revision: 2 },
  })
  expect(onEditorAppearancePreferencesChanged).toHaveBeenLastCalledWith({
    appearance: DEFAULT_EDITOR_APPEARANCE,
    revision: 2,
  })

  await setEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    enabledAppearance,
  )
  await setEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { ...enabledAppearance },
  )
  await expect(compareAndSetEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    {
      expectedRevision: 3,
      expectedAppearance: enabledAppearance,
      replacement: DEFAULT_EDITOR_APPEARANCE,
    },
  )).resolves.toEqual({
    ok: true,
    value: { appearance: enabledAppearance, revision: 4 },
  })
  expect(onEditorAppearancePreferencesChanged).toHaveBeenCalledTimes(4)
  expect(onEditorAppearancePreferencesChanged).toHaveBeenLastCalledWith({
    appearance: enabledAppearance,
    revision: 4,
  })

  await setEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    DEFAULT_EDITOR_APPEARANCE,
  )
  await setEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { ...enabledAppearance },
  )
  await expect(compareAndSetEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    {
      expectedRevision: 3,
      expectedAppearance: enabledAppearance,
      replacement: DEFAULT_EDITOR_APPEARANCE,
    },
  )).resolves.toEqual({
    ok: true,
    value: { appearance: enabledAppearance, revision: 6 },
  })
  expect(onEditorAppearancePreferencesChanged).toHaveBeenCalledTimes(6)

  save.mockRejectedValueOnce(new Error('appearance persistence failed'))
  await expect(setEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { ...enabledAppearance, spellCheckEnabled: false },
  )).resolves.toMatchObject({ ok: false })
  expect(onEditorAppearancePreferencesChanged).toHaveBeenCalledTimes(6)
  await expect(getEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
  )).resolves.toEqual({
    ok: true,
    value: { appearance: enabledAppearance, revision: 6 },
  })

  save.mockRejectedValueOnce(new Error('rollback persistence failed'))
  await expect(compareAndSetEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    {
      expectedRevision: 6,
      expectedAppearance: enabledAppearance,
      replacement: DEFAULT_EDITOR_APPEARANCE,
    },
  )).resolves.toMatchObject({ ok: false })
  expect(onEditorAppearancePreferencesChanged).toHaveBeenCalledTimes(6)
  await expect(getEditorAppearancePreferences(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
  )).resolves.toEqual({
    ok: true,
    value: { appearance: enabledAppearance, revision: 6 },
  })
  const listStickyNotes = handlers.get(IPC_CHANNELS.listStickyNotes) as (
    event: unknown, input: unknown,
  ) => Promise<unknown>
  await expect(listStickyNotes(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { status: 'active' },
  )).resolves.toEqual({ ok: true, value: [] })
  onStickyNoteEvent?.({
    type: 'index-changed',
    noteId: '00000000-0000-4000-8000-000000000001',
  })
  expect(window.webContents.send).toHaveBeenCalledWith(
    'sticky-note:event',
    expect.objectContaining({ type: 'index-changed' }),
  )
  const start = handlers.get(IPC_CHANNELS.startTranslation) as (
    event: unknown, input: unknown,
  ) => Promise<unknown>
  await start(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    {
      documentKey: 'note.md',
      content: { markdown: 'hello', plainText: 'hello' },
      mode: 'visual',
    },
  )
  expect(window.webContents.send).toHaveBeenCalledWith(
    'translation:event',
    expect.objectContaining({ type: 'started' }),
  )
  window.webContents.isDestroyed.mockReturnValue(true)
  onDelta?.('destroyed-window')
  expect(window.webContents.send).not.toHaveBeenCalledWith(
    'translation:event',
    expect.objectContaining({ delta: 'destroyed-window' }),
  )
  window.webContents.isDestroyed.mockReturnValue(false)

  const startLogin = handlers.get(IPC_CHANNELS.startCodexCliLogin) as (event: unknown, input: unknown) => Promise<unknown>
  const loginPending = startLogin(ownerEvent, { observed: modelObservation })
  await vi.waitFor(() => expect(startCodexCliLogin).toHaveBeenCalledOnce())
  if (mode === 'cleanup failure') wired.ai.registerOrdinaryCleanup(async () => { throw new Error('synthetic cleanup failure') })
  window.triggerClose()
  if (mode === 'AI drain failure') {
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce())
    finishAiDrain()
    await vi.waitFor(() => expect(wired.close.snapshot()?.error).toBe('ai-drain-failed'))
    expect(wired.close.snapshot()).toMatchObject({ canRetry: false, canReturn: false })
    expect(window.closeCalls).toBe(0)
    expect(resumed).not.toHaveBeenCalled()
    expect(closeScreenshotOwner).not.toHaveBeenCalled()
    expect(window.webContents.send).not.toHaveBeenCalledWith('arkdown:close-preparation:request', expect.any(Object))
    // Synthetic teardown only: simulate the native window already being gone.
    window.close()
    await vi.waitFor(() => expect(handlers.size).toBe(0))
    return
  }
  if (mode === 'cancel then drain AI') {
    await vi.waitFor(() => expect(wired.close.snapshot()?.state).toBe('cancelled'))
    expect(resumed).toHaveBeenCalledOnce()
    expect(stopped).not.toHaveBeenCalled()
    expect(closeScreenshotOwner).not.toHaveBeenCalled()
    expect(window.webContents.send).not.toHaveBeenCalledWith('arkdown:close-preparation:request', expect.any(Object))
    window.triggerClose()
    await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce())
    expect(wired.close.snapshot()).toMatchObject({ state: 'running', progress: { stage: 'quiesce-owner', pending: { ai: 1 } } })
    expect(window.webContents.send).not.toHaveBeenCalledWith('arkdown:close-preparation:request', expect.any(Object))
    expect(closeScreenshotOwner).not.toHaveBeenCalled()
    finishAiDrain()
  } else expect(confirmStopAi).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(window.webContents.send).toHaveBeenCalledWith(
    'arkdown:close-preparation:request', expect.any(Object),
  ))
  const [requestChannel, request] = window.webContents.send.mock.calls.find(
    ([channel]) => channel === 'arkdown:close-preparation:request',
  )!
  expect(requestChannel).toBe('arkdown:close-preparation:request')
  listeners.get('arkdown:close-preparation:event')?.(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { ...request, sequence: 1, type: 'stage', stage: 'settle-preferences' },
  )
  listeners.get('arkdown:close-preparation:event')?.(
    { sender: window.webContents, senderFrame: window.webContents.mainFrame },
    { ...request, sequence: 2, type: 'result', result: { status: 'ready' } },
  )
  await vi.waitFor(() => expect(closeScreenshotOwner).toHaveBeenCalledOnce())
  expect(window.closeCalls).toBe(0)
  expect(handlers.size).toBeGreaterThan(0)
  const settleScreenshotOcr = handlers.get(IPC_CHANNELS.settleScreenshotOcr) as (
    event: unknown,
    input: unknown,
  ) => Promise<unknown>
  await expect(settleScreenshotOcr(ownerEvent, {
    sessionId: screenshotSessionId, generation: 1,
  })).resolves.toEqual({ ok: true, value: null })
  expect(screenshotOcrHost.settleOcr).toHaveBeenCalledWith({
    sessionId: screenshotSessionId, generation: 1,
  })
  if (mode === 'cleanup failure') {
    await vi.waitFor(() => expect(wired.close.snapshot()?.error).toBe('cleanup-failed'))
    expect(window.closeCalls).toBe(0)
    expect(wired.close.snapshot()).toMatchObject({ canRetry: false, canReturn: false })
    expect(await wired.close.returnToEditor()).toBe(false)
    wired.close.dispose()
  } else await vi.waitFor(() => expect(window.closeCalls).toBe(1))
  expect(await loginPending).toEqual({ ok: true, value: { status: 'cancelled' } })
  expect(cancelCodexCliLogin).toHaveBeenCalled()
  expect(abortScreenshotOwnerClose).not.toHaveBeenCalled()
  expect(saveWindowBounds).toHaveBeenCalledWith({ width: 1200, height: 800, x: 80, y: 60 })
  expect(wired.close.snapshot()?.state).toBe(mode === 'cleanup failure' ? 'failed' : 'closed')
  if (mode === 'cleanup failure') {
    // Keep frame-lifetime observation until native destruction, including a blocked close.
    expect(window.webListeners).toHaveLength(3)
    window.close() // Synthetic teardown only; no product force-close path.
  }
  onDelta?.('must-not-send')
  expect(window.webContents.send).not.toHaveBeenCalledWith(
    'translation:event', expect.objectContaining({ delta: 'must-not-send' }),
  )
  expect(handlers).toHaveLength(0)
  expect(ipcMain.removeHandler).toHaveBeenCalledTimes(registeredChannelCount)
  expect(listeners).toHaveLength(0)
  expect(window.webListeners).toHaveLength(0)
  expect(ipcMain.removeListener).toHaveBeenCalledWith(
    'arkdown:close-preparation:event',
    expect.any(Function),
  )
  expect(window.webContents.removeListener).toHaveBeenCalledTimes(3)
  expect(unsubscribeStickyNotes).toHaveBeenCalledTimes(1)
})
