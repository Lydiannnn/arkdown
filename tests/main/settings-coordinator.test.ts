import { afterEach, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../src/main/ipc/register-ipc'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { installWindowBoundsSaveOnClose } from '../../src/main/settings/window-bounds-close'
import type { LargeModelSettings } from '../../src/shared/large-model-settings'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { DEFAULT_LAYOUT_PREFERENCES } from '../../src/shared/layout-preferences'

it('notifies box theme synchronization only after accepted appearance persistence', async () => {
  const save = vi.fn(async () => undefined)
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null })
  const changed = vi.fn()
  const stop = coordinator.subscribeEditorAppearance(changed)
  const dark = { ...DEFAULT_EDITOR_APPEARANCE, editorTheme: 'dark' as const }
  save.mockRejectedValueOnce(new Error('synthetic disk failure'))
  await expect(coordinator.setEditorAppearance(dark)).rejects.toThrow()
  expect(changed).not.toHaveBeenCalled()
  await coordinator.setEditorAppearance(dark)
  expect(changed).toHaveBeenCalledOnce()
  await coordinator.update(current => ({ ...current, lastWorkspace: 'synthetic' }))
  expect(changed).toHaveBeenCalledOnce()
  const state = coordinator.getEditorAppearanceSnapshot()
  await coordinator.compareAndSetEditorAppearance(state.revision + 1, state.appearance, DEFAULT_EDITOR_APPEARANCE)
  expect(changed).toHaveBeenCalledOnce()
  await coordinator.compareAndSetEditorAppearance(state.revision, state.appearance, DEFAULT_EDITOR_APPEARANCE)
  expect(changed).toHaveBeenCalledTimes(2)
  stop()
  await coordinator.setEditorAppearance(dark)
  expect(changed).toHaveBeenCalledTimes(2)
})

it('keeps independent shell integration copies across settings readers and serial updates', async () => {
  const shellIntegration = { documentOpenMenu: false, markdownShellNew: false }
  const coordinator = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: null, shellIntegration })
  shellIntegration.documentOpenMenu = true
  coordinator.get().shellIntegration!.markdownShellNew = true
  expect(coordinator.get().shellIntegration).toEqual({ documentOpenMenu: false, markdownShellNew: false })
  await coordinator.update((current) => ({ ...current, shellIntegration: { ...current.shellIntegration!, documentOpenMenu: true } }))
  expect(coordinator.get().shellIntegration).toEqual({ documentOpenMenu: true, markdownShellNew: false })
})

it('publishes a monotonic AI write-policy revision across an ABA change', async () => {
  const coordinator = new SettingsCoordinator({ save: vi.fn().mockResolvedValue(undefined) }, {
    lastWorkspace: null,
    models: {
      version: 6, codexCli: null,
      connections: [],
      selectionTranslation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto', privacyNoticeAccepted: false },
      screenshotTranslation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto' },
      aiConversation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', writePolicy: 'ask-every-time' },
    },
  })
  const observed: unknown[] = []
  const unsubscribe = coordinator.subscribeAiConversationWritePolicy((snapshot) => observed.push(snapshot))

  await coordinator.update((settings) => ({
    ...settings,
    models: { ...settings.models!, aiConversation: { ...settings.models!.aiConversation, writePolicy: 'workspace-grant' } },
  }))
  await coordinator.update((settings) => ({
    ...settings,
    models: { ...settings.models!, aiConversation: { ...settings.models!.aiConversation, writePolicy: 'ask-every-time' } },
  }))
  await coordinator.update((settings) => ({ ...settings, lastWorkspace: 'C:\\notes' }))
  unsubscribe()

  expect(observed).toEqual([
    { policy: 'workspace-grant', revision: 1 },
    { policy: 'ask-every-time', revision: 2 },
  ])
  expect(coordinator.getAiConversationWritePolicySnapshot())
    .toEqual({ policy: 'ask-every-time', revision: 2 })
})

it('publishes a monotonic AI model-selection revision across provider configuration ABA changes', async () => {
  const coordinator = new SettingsCoordinator({ save: vi.fn().mockResolvedValue(undefined) }, {
    lastWorkspace: null,
    models: {
      version: 6, codexCli: null,
      connections: [{
        id: '550e8400-e29b-41d4-a716-446655440000', name: 'Primary', provider: 'deepseek',
        accessType: 'standard-api', protocol: 'openai', baseUrl: 'https://api.deepseek.com',
        modelId: 'deepseek-v4-pro', apiKeyHint: '••••test', status: 'connected',
        lastTestedAt: null, capabilityOverride: null,
      }],
      selectionTranslation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto', privacyNoticeAccepted: false },
      screenshotTranslation: { connectionId: null, thinkingMode: 'default' as const, reasoningEffort: 'default', targetLanguage: 'auto' },
      aiConversation: { connectionId: '550e8400-e29b-41d4-a716-446655440000', thinkingMode: 'default' as const, reasoningEffort: 'default', writePolicy: 'ask-every-time' },
    },
  })
  const observed: unknown[] = []
  const unsubscribe = coordinator.subscribeAiConversationModelSelection((snapshot) => observed.push(snapshot))

  await coordinator.update((settings) => ({
    ...settings,
    models: { ...settings.models!, connections: settings.models!.connections.map((item) => ({ ...item, modelId: 'deepseek-v4-flash' })) },
  }))
  await coordinator.update((settings) => ({
    ...settings,
    models: { ...settings.models!, connections: settings.models!.connections.map((item) => ({ ...item, modelId: 'deepseek-v4-pro' })) },
  }))
  await coordinator.update((settings) => ({ ...settings, lastWorkspace: 'C:\\notes' }))
  unsubscribe()

  expect(observed).toEqual([
    { connectionId: '550e8400-e29b-41d4-a716-446655440000', thinkingMode: 'default' as const, reasoningEffort: 'default', revision: 1 },
    { connectionId: '550e8400-e29b-41d4-a716-446655440000', thinkingMode: 'default' as const, reasoningEffort: 'default', revision: 2 },
  ])
  expect(coordinator.getAiConversationModelSelectionSnapshot()).toEqual({
    connectionId: '550e8400-e29b-41d4-a716-446655440000', thinkingMode: 'default' as const, reasoningEffort: 'default', revision: 2,
  })
})

import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

it('isolates main background settings from caller mutations', () => {
  const initial = {
    lastWorkspace: null,
    mainBackground: { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 37 },
  }
  const coordinator = new SettingsCoordinator({ save: vi.fn() }, initial)

  initial.mainBackground.imageOpacityPercent = 91
  const first = coordinator.get()
  first.mainBackground!.imageOpacityPercent = 72

  expect(coordinator.get().mainBackground).toEqual({
    ...DEFAULT_BACKGROUND_SETTINGS,
    imageOpacityPercent: 37,
  })
})

it('normalizes a fresh installation to system theme with zero Mica opacity', () => {
  const coordinator = new SettingsCoordinator(
    { save: vi.fn() },
    { lastWorkspace: null },
  )

  expect(coordinator.getEditorAppearanceSnapshot()).toMatchObject({
    appearance: {
      editorTheme: 'system',
      micaOpacityPercent: 0,
    },
    revision: 0,
  })
})

it('keeps layout preferences separate from editor appearance revisions', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: DEFAULT_EDITOR_APPEARANCE },
  )
  const updated = { leftSidebarWidth: 420, rightSidebarWidth: 760 }

  expect(coordinator.getLayoutSnapshot()).toEqual({ layout: DEFAULT_LAYOUT_PREFERENCES, revision: 0 })
  await expect(coordinator.compareAndSetLayout(0, DEFAULT_LAYOUT_PREFERENCES, updated)).resolves.toEqual({
    applied: true,
    snapshot: { layout: updated, revision: 1 },
  })
  expect(coordinator).not.toHaveProperty('setLayout')
  expect(coordinator.getEditorAppearanceSnapshot()).toEqual({
    appearance: DEFAULT_EDITOR_APPEARANCE,
    revision: 0,
  })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ layout: updated }))
})

it('merges interleaved two-window sidebar changes after a layout compare-and-set conflict', async () => {
  const coordinator = new SettingsCoordinator({ save: vi.fn().mockResolvedValue(undefined) }, {
    lastWorkspace: null,
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
  })
  const firstSnapshot = coordinator.getLayoutSnapshot()
  const left = await coordinator.compareAndSetLayout(
    firstSnapshot.revision,
    firstSnapshot.layout,
    { leftSidebarWidth: 420, rightSidebarWidth: 530 },
  )
  const rightConflict = await coordinator.compareAndSetLayout(
    firstSnapshot.revision,
    firstSnapshot.layout,
    { leftSidebarWidth: 300, rightSidebarWidth: 760 },
  )
  const rightRetry = await coordinator.compareAndSetLayout(
    rightConflict.snapshot.revision,
    rightConflict.snapshot.layout,
    { ...rightConflict.snapshot.layout, rightSidebarWidth: 760 },
  )

  expect(left).toMatchObject({ applied: true })
  expect(rightConflict).toMatchObject({ applied: false })
  expect(rightRetry).toEqual({
    applied: true,
    snapshot: { layout: { leftSidebarWidth: 420, rightSidebarWidth: 760 }, revision: 2 },
  })
})

class FakeWindow {
  closeCalls = 0
  private closeListener: ((event: { preventDefault(): void }) => void) | undefined

  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void {
    if (event === 'close') this.closeListener = listener
  }

  getSize(): [number, number] {
    return [1200, 800]
  }

  getPosition(): [number, number] {
    return [80, 60]
  }

  close(): void {
    this.closeCalls += 1
  }

  triggerClose(): { defaultPrevented: boolean } {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    this.closeListener?.(event)
    return event
  }
}

const closeControllers: ReturnType<typeof installWindowBoundsSaveOnClose>[] = []
afterEach(() => { closeControllers.splice(0).forEach(close => close.dispose()) })
// These tests retain the legacy coordinator's serialization fixture. Production
// injects the SettingsAuthority bounds command through the same narrow callback.
function installCoordinatedClose(window: FakeWindow, coordinator: SettingsCoordinator,
  reportError: (error: unknown) => void, closeGate?: { pauseAndDrain(): Promise<void>; resume(): void }) {
  const close = installWindowBoundsSaveOnClose(window, {
    saveWindowBounds: bounds => coordinator.update(settings => ({ ...settings, windowBounds: bounds })),
    prepareRendererClose: async () => ({ status: 'ready' }), reportError, closeGate,
  })
  closeControllers.push(close)
  return close
}

it('serializes settings updates and merges each change into the latest persisted settings', async () => {
  let releaseFirstSave: (() => void) | undefined
  const firstSave = new Promise<void>((resolve) => {
    releaseFirstSave = resolve
  })
  const save = vi.fn()
    .mockImplementationOnce(() => firstSave)
    .mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null },
  )

  const workspaceUpdate = coordinator.update((settings) => ({
    ...settings,
    lastWorkspace: 'C:\\canonical\\notes',
  }))
  const boundsUpdate = coordinator.update((settings) => ({
    ...settings,
    windowBounds: { width: 1200, height: 800, x: 80, y: 60 },
  }))

  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  expect(save.mock.calls[0]?.[0]).toEqual({ lastWorkspace: 'C:\\canonical\\notes' })
  releaseFirstSave?.()
  await Promise.all([workspaceUpdate, boundsUpdate])

  expect(save.mock.calls[1]?.[0]).toEqual({
    lastWorkspace: 'C:\\canonical\\notes',
    windowBounds: { width: 1200, height: 800, x: 80, y: 60 },
  })
  expect(coordinator.get()).toEqual(save.mock.calls[1]?.[0])
})

it('matches the initial appearance revision but skips rollback after a queued newer write persists', async () => {
  let releaseNewerSave: (() => void) | undefined
  const newerSave = new Promise<void>((resolve) => {
    releaseNewerSave = resolve
  })
  const save = vi.fn().mockImplementationOnce(() => newerSave)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: { ...DEFAULT_EDITOR_APPEARANCE, themeColor: '#800080' } },
  )
  const newerAppearance = { ...DEFAULT_EDITOR_APPEARANCE, themeColor: '#2563EB' }
  const originalAppearance = { ...DEFAULT_EDITOR_APPEARANCE, themeColor: '#800080' }

  expect(coordinator.getEditorAppearanceSnapshot()).toEqual({
    appearance: originalAppearance,
    revision: 0,
  })

  const newerWrite = coordinator.setEditorAppearance(newerAppearance)
  const rollback = coordinator.compareAndSetEditorAppearance(
    0,
    originalAppearance,
    DEFAULT_EDITOR_APPEARANCE,
  )
  releaseNewerSave?.()

  await newerWrite
  await expect(rollback).resolves.toMatchObject({
    applied: false,
    snapshot: { appearance: newerAppearance, revision: 1 },
  })
  expect(save).toHaveBeenCalledOnce()
  expect(coordinator.getEditorAppearanceSnapshot()).toEqual({
    appearance: newerAppearance,
    revision: 1,
  })
})

it('increments appearance revision only after successful persisted writes', async () => {
  const save = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValueOnce(undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: DEFAULT_EDITOR_APPEARANCE },
  )
  const enabled = { ...DEFAULT_EDITOR_APPEARANCE, spellCheckEnabled: true }

  await expect(coordinator.setEditorAppearance(enabled)).resolves.toEqual({
    appearance: enabled,
    revision: 1,
  })
  await expect(coordinator.setEditorAppearance(DEFAULT_EDITOR_APPEARANCE))
    .rejects.toThrow('disk full')
  expect(coordinator.getEditorAppearanceSnapshot()).toEqual({
    appearance: enabled,
    revision: 1,
  })
  await expect(coordinator.setEditorAppearance(enabled)).resolves.toEqual({
    appearance: enabled,
    revision: 2,
  })
})

it('rolls back an isolated appearance failure at the exact accepted revision', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: DEFAULT_EDITOR_APPEARANCE },
  )
  const enabled = { ...DEFAULT_EDITOR_APPEARANCE, spellCheckEnabled: true }
  const accepted = await coordinator.setEditorAppearance(enabled)

  await expect(coordinator.compareAndSetEditorAppearance(
    accepted.revision,
    enabled,
    DEFAULT_EDITOR_APPEARANCE,
  )).resolves.toEqual({
    applied: true,
    snapshot: { appearance: DEFAULT_EDITOR_APPEARANCE, revision: 2 },
  })
  expect(save).toHaveBeenCalledTimes(2)
})

it('treats an edit-indicator-only difference as a compare-and-set mismatch', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: DEFAULT_EDITOR_APPEARANCE },
  )

  await expect(coordinator.compareAndSetEditorAppearance(
    0,
    { ...DEFAULT_EDITOR_APPEARANCE, showEditIndicators: false },
    DEFAULT_EDITOR_APPEARANCE,
  )).resolves.toEqual({
    applied: false,
    snapshot: { appearance: DEFAULT_EDITOR_APPEARANCE, revision: 0 },
  })
  expect(save).not.toHaveBeenCalled()
})

it('blocks rollback after a later identical appearance write', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: DEFAULT_EDITOR_APPEARANCE },
  )
  const enabled = { ...DEFAULT_EDITOR_APPEARANCE, spellCheckEnabled: true }
  const first = await coordinator.setEditorAppearance(enabled)
  await coordinator.setEditorAppearance({ ...enabled })

  await expect(coordinator.compareAndSetEditorAppearance(
    first.revision,
    enabled,
    DEFAULT_EDITOR_APPEARANCE,
  )).resolves.toEqual({
    applied: false,
    snapshot: { appearance: enabled, revision: 2 },
  })
  expect(save).toHaveBeenCalledTimes(2)
})

it('blocks rollback after an away-and-back appearance ABA sequence', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: DEFAULT_EDITOR_APPEARANCE },
  )
  const enabled = { ...DEFAULT_EDITOR_APPEARANCE, spellCheckEnabled: true }
  const first = await coordinator.setEditorAppearance(enabled)
  await coordinator.setEditorAppearance(DEFAULT_EDITOR_APPEARANCE)
  await coordinator.setEditorAppearance({ ...enabled })

  await expect(coordinator.compareAndSetEditorAppearance(
    first.revision,
    enabled,
    DEFAULT_EDITOR_APPEARANCE,
  )).resolves.toEqual({
    applied: false,
    snapshot: { appearance: enabled, revision: 3 },
  })
  expect(save).toHaveBeenCalledTimes(3)
})

it('does not advance appearance revision when rollback persistence fails', async () => {
  const save = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('rollback failed'))
  const coordinator = new SettingsCoordinator(
    { save },
    { lastWorkspace: null, appearance: DEFAULT_EDITOR_APPEARANCE },
  )
  const enabled = { ...DEFAULT_EDITOR_APPEARANCE, spellCheckEnabled: true }
  const accepted = await coordinator.setEditorAppearance(enabled)

  await expect(coordinator.compareAndSetEditorAppearance(
    accepted.revision,
    enabled,
    DEFAULT_EDITOR_APPEARANCE,
  )).rejects.toThrow('rollback failed')
  expect(coordinator.getEditorAppearanceSnapshot()).toEqual({
    appearance: enabled,
    revision: 1,
  })
})

it('deep-copies public model settings at construction, read, update, and save boundaries', async () => {
  const models: LargeModelSettings = {
    version: 6,
    codexCli: null,
    connections: [{
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'DeepSeek',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com',
      modelId: 'deepseek-chat',
      apiKeyHint: '••••cret',
      status: 'connected',
      lastTestedAt: '2026-07-30T08:00:00.000Z',
      capabilityOverride: {
        contextWindowTokens: 200_000,
        maxInputTokens: 180_000,
      },
    }],
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
  const save = vi.fn().mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null, models })
  models.connections[0]!.name = 'Mutated outside'
  models.connections[0]!.capabilityOverride!.contextWindowTokens = 1
  const read = coordinator.get()
  read.models!.connections[0]!.name = 'Mutated read'
  read.models!.connections[0]!.capabilityOverride!.maxInputTokens = 1
  read.models!.selectionTranslation.targetLanguage = 'fr'

  await coordinator.update((settings) => ({
    ...settings,
    lastWorkspace: 'C:\\canonical\\notes',
  }))
  const saved = save.mock.calls[0]?.[0]
  saved.models.connections[0].name = 'Mutated saved argument'
  saved.models.connections[0].capabilityOverride.contextWindowTokens = 2

  expect(coordinator.get().models).toEqual({
    ...models,
    connections: [{
      ...models.connections[0],
      name: 'DeepSeek',
      capabilityOverride: {
        contextWindowTokens: 200_000,
        maxInputTokens: 180_000,
      },
    }],
    selectionTranslation: {
      ...models.selectionTranslation,
      targetLanguage: 'auto',
    },
    aiConversation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
    },
  })
})

it('keeps a concurrent lastWorkspace update when close saves window bounds', async () => {
  let releaseWorkspaceSave: (() => void) | undefined
  const workspaceSave = new Promise<void>((resolve) => {
    releaseWorkspaceSave = resolve
  })
  const save = vi.fn()
    .mockImplementationOnce(() => workspaceSave)
    .mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null })
  const workspaceUpdate = coordinator.update((settings) => ({
    ...settings,
    lastWorkspace: 'C:\\canonical\\notes',
  }))
  const window = new FakeWindow()
  installCoordinatedClose(window, coordinator, () => {})

  expect(window.triggerClose().defaultPrevented).toBe(true)
  releaseWorkspaceSave?.()
  await workspaceUpdate
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))

  expect(save.mock.calls[1]?.[0]).toEqual({
    lastWorkspace: 'C:\\canonical\\notes',
    windowBounds: { width: 1200, height: 800, x: 80, y: 60 },
  })
})

it('keeps the window open and retries when a coordinated close save fails', async () => {
  const save = vi.fn()
    .mockRejectedValueOnce(new Error('disk full'))
    .mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null })
  const window = new FakeWindow()
  const reportError = vi.fn()
  const close = installCoordinatedClose(window, coordinator, reportError)

  window.triggerClose()
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1))
  expect(window.closeCalls).toBe(0)

  await close.retry()
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
})


function createIpcMainForClose() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  return {
    handlers,
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  }
}

function createCloseRegistration(operation: () => unknown) {
  const ipcMain = createIpcMainForClose()
  const mainFrame = {}
  const webContents = { mainFrame }
  const operations = {
    chooseWorkspace: vi.fn(operation),
    restoreWorkspace: vi.fn(), listDirectory: vi.fn(), readDocument: vi.fn(), saveDocument: vi.fn(),
  }
  const registration = registerIpcHandlers({
    ipcMain: ipcMain as never,
    window: { webContents },
    operations: operations as never,
  })
  return {
    handler: ipcMain.handlers.get(IPC_CHANNELS.chooseWorkspace)!,
    event: { sender: webContents, senderFrame: mainFrame },
    operation: operations.chooseWorkspace,
    registration,
  }
}

it('keeps renderer IPC available for close preparation, then blocks new operations', async () => {
  const coordinator = new SettingsCoordinator(
    { save: vi.fn().mockResolvedValue(undefined) },
    { lastWorkspace: null },
  )
  const ipc = createCloseRegistration(() => ({ ok: true, value: null }))
  const window = new FakeWindow()
  installCoordinatedClose(window, coordinator, () => {}, ipc.registration)

  window.triggerClose()
  await expect(ipc.handler(ipc.event)).resolves.toEqual({ ok: true, value: null })
  expect(ipc.operation).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
  await expect(ipc.handler(ipc.event)).resolves.toEqual({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
})

it('drains an entered workspace update before saving bounds and closing', async () => {
  let releaseWorkspaceSave: (() => void) | undefined
  const workspaceSave = new Promise<void>((resolve) => {
    releaseWorkspaceSave = resolve
  })
  const save = vi.fn().mockImplementationOnce(() => workspaceSave).mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null })
  const ipc = createCloseRegistration(async () => {
    await coordinator.update((settings) => ({
      ...settings,
      lastWorkspace: 'C:\\canonical\\notes',
    }))
    return { ok: true, value: null }
  })
  const window = new FakeWindow()
  installCoordinatedClose(window, coordinator, () => {}, ipc.registration)

  const entered = ipc.handler(ipc.event)
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  window.triggerClose()
  expect(window.closeCalls).toBe(0)
  expect(save).toHaveBeenCalledTimes(1)

  releaseWorkspaceSave?.()
  await expect(entered).resolves.toEqual({ ok: true, value: null })
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
  expect(save.mock.calls[1]?.[0]).toEqual({
    lastWorkspace: 'C:\\canonical\\notes',
    windowBounds: { width: 1200, height: 800, x: 80, y: 60 },
  })
})

it('resumes IPC after a coordinated bounds save failure', async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null })
  const ipc = createCloseRegistration(() => ({ ok: true, value: null }))
  const window = new FakeWindow()
  const reportError = vi.fn()
  const close = installCoordinatedClose(window, coordinator, reportError, ipc.registration)

  window.triggerClose()
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1))
  expect(window.closeCalls).toBe(0)
  await close.returnToEditor()
  await expect(ipc.handler(ipc.event)).resolves.toEqual({ ok: true, value: null })
  expect(ipc.operation).toHaveBeenCalledTimes(1)

  window.triggerClose()
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
})

it('resumes IPC and skips settings save when draining fails', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const coordinator = new SettingsCoordinator({ save }, { lastWorkspace: null })
  const closeGate = {
    pauseAndDrain: vi.fn().mockRejectedValue(new Error('drain failed')),
    resume: vi.fn(),
  }
  const window = new FakeWindow()
  const reportError = vi.fn()
  const close = installCoordinatedClose(window, coordinator, reportError, closeGate)

  window.triggerClose()
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1))
  expect(save).not.toHaveBeenCalled()
  await close.returnToEditor()
  expect(closeGate.resume).toHaveBeenCalledTimes(1)
  expect(window.closeCalls).toBe(0)
})
