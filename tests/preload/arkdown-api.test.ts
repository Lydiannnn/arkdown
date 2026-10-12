import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import {
  CLOSE_CHANNELS,
  IPC_CHANNELS,
  WINDOW_STATE_CHANGED_CHANNEL,
  type ArkdownApi,
} from '../../src/shared/contracts'

const screenshotSessionId = '123e4567-e89b-42d3-a456-426614174000'

it('sends only the legacy intro fact and rejects malformed claim responses', async () => {
  const invoke = vi.fn(async () => ({ ok: true, value: { showIntroduction: true } }))
  const api = createArkdownApi(invoke)
  expect(await api.claimWorkspaceIntroduction!(false)).toEqual({ ok: true, value: { showIntroduction: true } })
  expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.claimWorkspaceIntroduction, { legacySeen: false })
  expect(await api.claimWorkspaceIntroduction!('yes' as never)).toMatchObject({ ok: false })
  expect(invoke).toHaveBeenCalledTimes(1)
  invoke.mockResolvedValueOnce({ ok: true, value: { showIntroduction: true, arbitraryWrite: true } } as never)
  expect(await api.claimWorkspaceIntroduction!(false)).toMatchObject({ ok: false })
})

it('parses rewritten save Markdown and only a true own clipboard retention flag', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)
  const input = { relativePath: 'note.md', markdown: 'before', expectedRevision: 'a'.repeat(64), encoding: 'utf8' as const, newline: 'lf' as const }
  const saved = { revision: 'b'.repeat(64), mtimeMs: 2, markdown: '![](assets/clip.png)', clipboardAssetsRetained: true }
  invoke.mockResolvedValue({ ok: true, value: saved })
  await expect(api.saveDocument(input)).resolves.toEqual({ ok: true, value: saved })
  for (const value of [{ ...saved, clipboardAssetsRetained: false }, { ...saved, destination: 'C:/escape' }, { ...saved, markdown: 42 }, Object.assign(Object.create({ clipboardAssetsRetained: true }), { revision: saved.revision, mtimeMs: 2 })]) {
    invoke.mockResolvedValue({ ok: true, value })
    await expect(api.saveDocument(input)).resolves.toMatchObject({ ok: false })
  }
})

it('accepts only one clipboard target identity and a bounded Markdown response', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: '![](assets/clip.png)' })
  const api = createArkdownApi(invoke)
  await expect(api.pasteClipboardImage!({ draftId: screenshotSessionId })).resolves.toEqual({ ok: true, value: '![](assets/clip.png)' })
  expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.pasteClipboardImage, { draftId: screenshotSessionId })
  for (const input of [{ draftId: screenshotSessionId, destination: 'C:/escape.png' }, { draftId: screenshotSessionId, noteId: screenshotSessionId }, Object.create({ draftId: screenshotSessionId }), { draftId: '../escape' }]) {
    await expect(api.pasteClipboardImage!(input as never)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(invoke).toHaveBeenCalledTimes(1)
  invoke.mockResolvedValue({ ok: true, value: 'x'.repeat(32769) })
  await expect(api.pasteClipboardImage!({ noteId: screenshotSessionId })).resolves.toMatchObject({ ok: false })
})

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn().mockResolvedValue({ ok: true, value: null }),
  on: vi.fn(),
  removeListener: vi.fn(),
  send: vi.fn(),
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
    send: electronMocks.send,
  },
}))

it('exposes only the frozen Arkdown API allowlist', () => {
  const api = createArkdownApi(vi.fn())

  expect(Object.keys(api)).toEqual([
    'chooseWorkspace',
    'claimWorkspaceIntroduction',
    'restoreWorkspace',
    'listDirectory',
    'startWorkspaceFileDrag',
    'inspectDroppedPath',
    'openDroppedPath',
    'prepareDroppedPath',
    'settleDroppedPath',
    'pathForDroppedFile',
    'createDocument',
    'readDocument',
    'peekDocument',
    'saveDocument',
    'beginSaveDocumentAs',
    'commitSaveDocumentAs',
    'abortSaveDocumentAs',
    'retryDraftFinalization',
    'saveDraft',
    'listRecoverableDrafts',
    'readDraft',
    'claimRecoveredDraft',
    'cleanDraft',
    'releaseDraftRecovery',
    'ignoreDraft',
    'discardDraft',
    'revealDocument',
    'trashDocument',
    'importDocx',
    'exportDocx',
    'exportXlsx',
    'readClipboardFormats',
    'pasteClipboardImage',
    'importAsset',
    'openAsset',
    'openDocumentWindow',
    'navigateDocumentView',
    'refreshDocumentView',
    'inspectDocumentView',
    'openDocumentView', 'revealLocalFileLink',
    'controlWindow',
    'getAppUpdateState', 'onAppUpdateChanged', 'notifyUpdateAbout', 'openUpdateWebsite', 'requestRequiredUpdateExit', 'protectUpdateWork', 'performUpdateAction', 'getWindowState',
    'onWindowStateChanged',
    'getDocumentConversionComponentState',
    'installDocumentConversionComponent',
    'cancelDocumentConversionComponentInstall',
    'removeDocumentConversionComponent',
    'convertWorkspaceDocument',
    'cancelWorkspaceDocumentConversion',
    'onDocumentConversionComponentState',
    'getPreferenceSnapshot',
    'patchPreferences',
    'getSearchPreferences',
    'getKeyboardShortcuts',
    'updateKeyboardShortcuts',
    'setShortcutRecording',
    'onKeyboardShortcutsChanged',
    'setSearchPreferences',
    'getEditorAppearancePreferences',
    'setEditorAppearancePreferences',
    'compareAndSetEditorAppearancePreferences',
    'getLayoutPreferences',
    'compareAndSetLayoutPreferences',
    'getStickyNotePreferences',
    'setStickyNotePreferences',
    'getDesktopLifecyclePreferences',
    'getDefaultApplicationsStatus', 'openDefaultApplicationsSettings', 'setDefaultApplicationsEnabled', 'getShellIntegrationPreferences',
    'updateShellIntegrationPreference',
    'setDesktopLifecyclePreferences',
    'getArknotePreferences',
    'previewStickyNoteWallpaperAppearances',
    'setArknotePreferences',
    'previewArknoteThemeColor',
    'getSystemFonts',
    'getModelCapabilityRules',
    'setModelCapabilityRules',
    'onModelCapabilityRulesChanged',
    'getLargeModelSettings',
    'getModelSettingsSnapshot',
    'connectModel',
    'listModels',
    'testModel',
    'deleteModel',
    'testCodexCliConnection',
    'startCodexCliLogin',
    'cancelCodexCliLogin',
    'removeCodexCliConnection',
    'setAiConversationSettings',
    'setSelectionTranslationSettings',
    'setScreenshotTranslationSettings',
    'setFloatingTranslationSettings',
    'acceptTranslationPrivacyNotice',
    'startTranslation',
    'cancelTranslation',
    'startAiConversation',
    'cancelAiConversation',
    'getAiWorkspaceState',
    'setAiConversationCapabilities',
    'submitAiAuthorizationResult',
    'clearAiConversation',
    'notifyAiCurrentDocumentChanged',
    'registerAiCurrentDocumentPort',
    'unregisterAiCurrentDocumentPort',
    'registerAiOpenDocumentPort',
    'unregisterAiOpenDocumentPort',
    'openAiMessageLink',
    'updateScreenshotCapturePointer',
    'readyScreenshotCapture',
    'commitScreenshotCapture',
    'cancelScreenshotCapture',
    'onScreenshotCaptureEvent',
    'submitScreenshotOcr',
    'settleScreenshotOcr',
    'startScreenshotTranslation',
    'cancelScreenshotTranslation',
    'minimizeScreenshotTranslation',
    'closeScreenshotTranslation',
    'openScreenshotTranslationSettings',
    'onScreenshotTranslationEvent',
    'getScreenshotOcrModelState',
    'downloadScreenshotOcrMedium',
    'cancelScreenshotOcrMediumDownload',
    'removeScreenshotOcrMedium',
    'onScreenshotOcrModelState',
    'onScreenshotOcrHostCommand',
    'searchSelection',
    'openExternal',
    'revealImage',
    'copyImage',
    'saveImageCopy',
    'copyImageTo',
    'copyMermaidImage',
    'openMermaidViewer',
    'getMermaidViewerSnapshot',
    'saveMermaidImage',
    'createWorkspaceFolder',
    'renameWorkspaceEntry',
    'duplicateWorkspaceDocument',
    'trashWorkspaceEntry',
    'revealWorkspaceEntry',
    'openWorkspaceEntryWindow',
    'getWorkspaceEntryProperties',
    'getWorkspaceRootProperties',
    'getWorkspaceColorMarks',
    'setWorkspaceColorMark',
    'moveWorkspaceColorMark',
    'deleteWorkspaceColorMarks',
    'openApplicationMenu',
    'executeApplicationMenuItem',
    'recordRecentDocument',
    'updateApplicationMenuWindowState',
    'onApplicationMenuChanged',
    'onEditorAppearancePreferencesChanged',
    'onLayoutPreferencesChanged',
    'openBackgroundSettings',
    'getBackgroundPresentation',
    'chooseBackgroundImage',
    'removeBackgroundImage',
    'previewBackground',
    'applyBackground',
    'cancelBackgroundSettings',
    'onBackgroundPresentation',
    'printDocument',
    'takePrintDocument',
    'readyPrintDocument',
    'connectArknote',
    'listStickyNotes',
    'reorderStickyNotes',
    'searchStickyNotes',
    'readStickyNote',
    'createStickyNote',
    'renameStickyNote',
    'archiveStickyNote',
    'restoreStickyNote',
    'restoreArchivedStickyNotes',
    'deleteStickyNote',
    'deleteArchivedStickyNotes',
    'importStickyNote',
    'importStickyNoteSelection',
    'stageStickyNoteSave',
    'flushStickyNoteSave',
    'openStickyNote',
    'closeStickyNote',
    'releaseStickyNote',
    'reclaimStickyNote',
    'setStickyNotePinned',
    'setStickyNoteStyle',
    'setStickyNoteFontSize',
    'setStickyNoteLineSpacingMode',
    'chooseStickyNoteImage',
    'copyStickyNoteImage',
    'resizeStickyNoteToContent',
    'openStickyNoteContextMenu',
    'closeStickyNoteContextMenu',
    'readyStickyNoteContextMenu',
    'executeStickyNoteContextMenuCommand',
    'onStickyNoteContextMenuShow',
    'onStickyNoteContextMenuCommand',
    'onStickyNoteContextMenuClosed',
    'onStickyNoteContextMenuReset',
    'onStickyNoteMaterialEffectsChanged',
    'onStickyNoteEvent',
    'onArknoteServiceEvent',
    'onArknoteThemeColorChanged',
    'onDocumentLocation',
    'onOpenIntent',
    'onImportDocxIntent',
    'onRecoverDraft',
    'onMenuCommand',
    'onTranslationEvent',
    'onAiConversationEvent',
    'onPrepareClose',
  ])
  expect(Object.isFrozen(api)).toBe(true)
  expect(api).not.toHaveProperty('ipcRenderer')
  expect(api).not.toHaveProperty('invoke')
  expect(api).not.toHaveProperty('channel')
})

it('submits only an exact OCR success or fixed failure envelope on its dedicated channel', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: null })
  const api = createArkdownApi(invoke)
  const success = {
    sessionId: screenshotSessionId,
    generation: 1,
    status: 'success' as const,
    result: { width: 4, height: 3, language: 'mul', blocks: [] },
  }
  await expect(api.submitScreenshotOcr?.(success)).resolves.toEqual({ ok: true, value: null })
  expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.submitScreenshotOcr, success)
  invoke.mockClear()
  await expect(api.submitScreenshotOcr?.({ ...success, extra: true } as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
  await expect(api.submitScreenshotOcr?.({
    sessionId: screenshotSessionId, generation: 1, status: 'failure', code: 'OCR_TIMEOUT',
  })).resolves.toEqual({ ok: true, value: null })
})

it('invokes fixed channels with the expected payload shapes', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: null })
  const api = createArkdownApi(invoke)
  const saveInput = {
    relativePath: 'note.md',
    markdown: '# changed',
    expectedRevision: 'a'.repeat(64),
    encoding: 'utf8' as const,
    newline: 'lf' as const,
  }

  await api.chooseWorkspace()
  await api.restoreWorkspace()
  await api.listDirectory('folder')
  await api.createDocument('new.md')
  await api.readDocument('note.md')
  await api.peekDocument('preview.md')
  await api.saveDocument(saveInput)
  await api.revealDocument('note.md')
  await api.trashDocument('old.md')
  await api.openApplicationMenu?.('file', 12, 34)
  await api.executeApplicationMenuItem?.('edit.find')

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.chooseWorkspace],
    [IPC_CHANNELS.restoreWorkspace],
    [IPC_CHANNELS.listDirectory, { relativePath: 'folder' }],
    [IPC_CHANNELS.createDocument, { relativePath: 'new.md' }],
    [IPC_CHANNELS.readDocument, { relativePath: 'note.md' }],
    [IPC_CHANNELS.peekDocument, { relativePath: 'preview.md' }],
    [IPC_CHANNELS.saveDocument, saveInput],
    [IPC_CHANNELS.revealDocument, { relativePath: 'note.md' }],
    [IPC_CHANNELS.trashDocument, { relativePath: 'old.md' }],
    [IPC_CHANNELS.openApplicationMenu, { section: 'file', x: 12, y: 34 }],
    [IPC_CHANNELS.executeApplicationMenuItem, { itemId: 'edit.find' }],
  ])
})


const transportFailure = {
  ok: false,
  error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
}

it('contains synchronous invoke throws without leaking transport details', async () => {
  const invoke = vi.fn(() => {
    throw new Error('C:\\private\\sync-stack.txt')
  })
  const api = createArkdownApi(invoke)

  const result = await api.chooseWorkspace()
  expect(result).toEqual(transportFailure)
  expect(JSON.stringify(result)).not.toContain('private')
})

it('contains rejected invoke promises without leaking transport details', async () => {
  const invoke = vi.fn().mockRejectedValue(new Error('C:\\private\\async-stack.txt'))
  const api = createArkdownApi(invoke)

  const result = await api.readDocument('note.md')
  expect(result).toEqual(transportFailure)
  expect(JSON.stringify(result)).not.toContain('private')
})

it('exports DOCX through one exact document-scoped preload payload without a native confirmation API', async () => {
  const invoke = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      value: { fileName: 'report.docx', reusedTarget: false },
    })
  const api = createArkdownApi(invoke) as ArkdownApi & {
    exportDocx?: (input: unknown) => Promise<unknown>
  }
  const input = {
    documentSessionId: '123e4567-e89b-42d3-a456-426614174000',
    markdown: '# Report',
    mode: 'choose',
    suggestedBaseName: 'report',
  }

  expect(typeof api.exportDocx).toBe('function')
  expect('confirmDocxExport' in api).toBe(false)
  expect('confirmClose' in api).toBe(false)
  await expect(api.exportDocx?.(input)).resolves.toEqual({
    ok: true,
    value: { fileName: 'report.docx', reusedTarget: false },
  })
  expect(invoke.mock.calls).toEqual([
    ['docx:export', input],
  ])
})

it('exports XLSX through one exact bounded preload payload', async () => {
  const invoke = vi.fn(async () => ({
    ok: true as const,
    value: { fileName: 'report.xlsx' },
  }))
  const api = createArkdownApi(invoke) as ArkdownApi & {
    exportXlsx?: (input: unknown) => Promise<unknown>
  }
  const input = { markdown: '# Report', suggestedBaseName: 'report' }

  expect(typeof api.exportXlsx).toBe('function')
  await expect(api.exportXlsx?.(input)).resolves.toEqual({
    ok: true,
    value: { fileName: 'report.xlsx' },
  })
  expect(invoke).toHaveBeenCalledWith('xlsx:export', input)
})

it('exposes only exact clipboard-format keys and rejects malformed payloads', async () => {
  const invoke = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      value: { plainText: '# Plain', markdown: null, html: '<h1>HTML</h1>' },
    })
    .mockResolvedValueOnce({
      ok: true,
      value: { plainText: 'Plain', markdown: null, html: null, secret: 'leak' },
    })
  const api = createArkdownApi(invoke) as ArkdownApi & {
    readClipboardFormats?: () => Promise<unknown>
  }

  await expect(api.readClipboardFormats?.()).resolves.toEqual({
    ok: true,
    value: { plainText: '# Plain', markdown: null, html: '<h1>HTML</h1>' },
  })
  await expect(api.readClipboardFormats?.()).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
  expect(invoke).toHaveBeenNthCalledWith(1, 'clipboard:read-formats')
})

it('fails closed when invoke resolves to a malformed non-ApiResult value', async () => {
  for (const malformed of [null, undefined, 'success', { ok: true }, { ok: false, error: 'bad' }]) {
    const api = createArkdownApi(vi.fn().mockResolvedValue(malformed))
    await expect(api.saveDocument({
      relativePath: 'note.md',
      markdown: '# note',
      expectedRevision: 'a'.repeat(64),
      encoding: 'utf8',
      newline: 'lf',
    })).resolves.toEqual(transportFailure)
  }
})

it('exposes strict opaque two-phase Save As intent calls without echoing save content on commit', async () => {
  const beginValue = {
    intentId: '550e8400-e29b-41d4-a716-446655440000',
    targetWorkspace: { name: 'new', absolutePath: 'C:\\new' },
    targetFileName: 'saved.md',
    targetRelativePath: 'saved.md',
    changesWorkspace: true,
  }
  const commitValue = {
    workspace: beginValue.targetWorkspace,
    document: {
      relativePath: 'saved.md', markdown: '# saved', revision: 'a'.repeat(64),
      encoding: 'utf8', newline: 'lf', mtimeMs: 1,
    },
    changesWorkspace: true,
    aiWorkspace: { workspaceId: 'workspace-new', workspaceGeneration: 'generation-new' },
  }
  const invoke = vi.fn(async (channel: string) => ({
    ok: true,
    value: channel === IPC_CHANNELS.beginSaveDocumentAs
      ? beginValue
      : channel === IPC_CHANNELS.commitSaveDocumentAs ? commitValue : null,
  }))
  const api = createArkdownApi(invoke)
  const saveInput = {
    draftId: '123e4567-e89b-42d3-a456-426614174000',
    markdown: '# saved', encoding: 'utf8' as const, newline: 'lf' as const,
    suggestedFileName: 'saved.md',
  }

  await expect(api.beginSaveDocumentAs!(saveInput)).resolves.toEqual({ ok: true, value: beginValue })
  await expect(api.commitSaveDocumentAs!(beginValue.intentId)).resolves.toEqual({ ok: true, value: commitValue })
  await expect(api.abortSaveDocumentAs!(beginValue.intentId)).resolves.toEqual({ ok: true, value: null })
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.beginSaveDocumentAs, saveInput],
    [IPC_CHANNELS.commitSaveDocumentAs, { intentId: beginValue.intentId }],
    [IPC_CHANNELS.abortSaveDocumentAs, { intentId: beginValue.intentId }],
  ])
})

it('real preload entry exposes the exact frozen API and uses ipcRenderer payloads', async () => {
  vi.resetModules()
  electronMocks.invoke.mockResolvedValue({ ok: true, value: null })
  await import('../../src/preload/index')

  expect(electronMocks.exposeInMainWorld).toHaveBeenCalledTimes(4)
  expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith('arkdown', expect.any(Object))
  expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith('arknoteBoxTheme', expect.any(Object))
  const messageApi = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === 'arkdownMessage')?.[1]
  expect(Object.keys(messageApi)).toEqual(['get', 'ready', 'respond'])
  expect(Object.isFrozen(messageApi)).toBe(true)
  const closeApi = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === 'arkdownClose')?.[1]
  expect(Object.keys(closeApi)).toEqual(['get', 'ready', 'subscribe', 'act'])
  expect(Object.isFrozen(closeApi)).toBe(true)
  const api = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === 'arkdown')?.[1] as ArkdownApi
  expect(Object.keys(api)).toEqual(expect.arrayContaining([
    'getLayoutPreferences',
    'compareAndSetLayoutPreferences',
    'onLayoutPreferencesChanged',
  ]))
  expect(Object.keys(api).filter((key) =>
    key !== 'previewArknoteThemeColor'
    && key !== 'onArknoteThemeColorChanged'
    && key !== 'submitScreenshotOcr'
    && key !== 'getLayoutPreferences'
    && key !== 'compareAndSetLayoutPreferences'
    && key !== 'onLayoutPreferencesChanged'
    && key !== 'testCodexCliConnection'
    && key !== 'startCodexCliLogin'
    && key !== 'cancelCodexCliLogin'
    && key !== 'removeCodexCliConnection')).toEqual([
    'chooseWorkspace', 'claimWorkspaceIntroduction', 'restoreWorkspace', 'listDirectory', 'startWorkspaceFileDrag', 'inspectDroppedPath', 'openDroppedPath', 'prepareDroppedPath', 'settleDroppedPath',
    'pathForDroppedFile', 'createDocument', 'readDocument', 'peekDocument',
    'saveDocument', 'beginSaveDocumentAs', 'commitSaveDocumentAs', 'abortSaveDocumentAs', 'retryDraftFinalization', 'saveDraft', 'listRecoverableDrafts', 'readDraft', 'claimRecoveredDraft', 'cleanDraft', 'releaseDraftRecovery', 'ignoreDraft', 'discardDraft', 'revealDocument', 'trashDocument', 'importDocx', 'exportDocx', 'exportXlsx', 'readClipboardFormats', 'pasteClipboardImage', 'importAsset', 'openAsset', 'openDocumentWindow', 'navigateDocumentView', 'refreshDocumentView', 'inspectDocumentView', 'openDocumentView', 'revealLocalFileLink', 'controlWindow', 'getAppUpdateState', 'onAppUpdateChanged', 'notifyUpdateAbout', 'openUpdateWebsite', 'requestRequiredUpdateExit', 'protectUpdateWork', 'performUpdateAction', 'getWindowState', 'onWindowStateChanged', 'getDocumentConversionComponentState', 'installDocumentConversionComponent', 'cancelDocumentConversionComponentInstall', 'removeDocumentConversionComponent', 'convertWorkspaceDocument', 'cancelWorkspaceDocumentConversion', 'onDocumentConversionComponentState', 'getPreferenceSnapshot', 'patchPreferences', 'getSearchPreferences', 'getKeyboardShortcuts', 'updateKeyboardShortcuts', 'setShortcutRecording', 'onKeyboardShortcutsChanged', 'setSearchPreferences', 'getEditorAppearancePreferences', 'setEditorAppearancePreferences', 'compareAndSetEditorAppearancePreferences', 'getStickyNotePreferences', 'setStickyNotePreferences', 'getDesktopLifecyclePreferences', 'getDefaultApplicationsStatus', 'openDefaultApplicationsSettings', 'setDefaultApplicationsEnabled', 'getShellIntegrationPreferences', 'updateShellIntegrationPreference', 'setDesktopLifecyclePreferences', 'getArknotePreferences', 'previewStickyNoteWallpaperAppearances', 'setArknotePreferences', 'getSystemFonts', 'getModelCapabilityRules', 'setModelCapabilityRules', 'onModelCapabilityRulesChanged', 'getLargeModelSettings', 'getModelSettingsSnapshot', 'connectModel', 'listModels', 'testModel', 'deleteModel', 'setAiConversationSettings', 'setSelectionTranslationSettings', 'setScreenshotTranslationSettings', 'setFloatingTranslationSettings', 'acceptTranslationPrivacyNotice', 'startTranslation', 'cancelTranslation', 'startAiConversation', 'cancelAiConversation', 'getAiWorkspaceState', 'setAiConversationCapabilities', 'submitAiAuthorizationResult', 'clearAiConversation', 'notifyAiCurrentDocumentChanged', 'registerAiCurrentDocumentPort', 'unregisterAiCurrentDocumentPort', 'registerAiOpenDocumentPort', 'unregisterAiOpenDocumentPort', 'openAiMessageLink', 'updateScreenshotCapturePointer', 'readyScreenshotCapture', 'commitScreenshotCapture', 'cancelScreenshotCapture', 'onScreenshotCaptureEvent', 'settleScreenshotOcr', 'startScreenshotTranslation', 'cancelScreenshotTranslation', 'minimizeScreenshotTranslation', 'closeScreenshotTranslation', 'openScreenshotTranslationSettings', 'onScreenshotTranslationEvent', 'getScreenshotOcrModelState', 'downloadScreenshotOcrMedium', 'cancelScreenshotOcrMediumDownload', 'removeScreenshotOcrMedium', 'onScreenshotOcrModelState', 'onScreenshotOcrHostCommand', 'searchSelection', 'openExternal', 'revealImage', 'copyImage', 'saveImageCopy', 'copyImageTo', 'copyMermaidImage', 'openMermaidViewer', 'getMermaidViewerSnapshot', 'saveMermaidImage', 'createWorkspaceFolder', 'renameWorkspaceEntry', 'duplicateWorkspaceDocument', 'trashWorkspaceEntry', 'revealWorkspaceEntry', 'openWorkspaceEntryWindow', 'getWorkspaceEntryProperties', 'getWorkspaceRootProperties', 'getWorkspaceColorMarks', 'setWorkspaceColorMark', 'moveWorkspaceColorMark', 'deleteWorkspaceColorMarks', 'openApplicationMenu', 'executeApplicationMenuItem', 'recordRecentDocument', 'updateApplicationMenuWindowState', 'onApplicationMenuChanged', 'onEditorAppearancePreferencesChanged', 'openBackgroundSettings', 'getBackgroundPresentation', 'chooseBackgroundImage', 'removeBackgroundImage', 'previewBackground', 'applyBackground', 'cancelBackgroundSettings', 'onBackgroundPresentation', 'printDocument', 'takePrintDocument', 'readyPrintDocument', 'connectArknote', 'listStickyNotes', 'reorderStickyNotes', 'searchStickyNotes', 'readStickyNote', 'createStickyNote', 'renameStickyNote', 'archiveStickyNote', 'restoreStickyNote',
    'restoreArchivedStickyNotes', 'deleteStickyNote', 'deleteArchivedStickyNotes', 'importStickyNote', 'importStickyNoteSelection', 'stageStickyNoteSave', 'flushStickyNoteSave', 'openStickyNote', 'closeStickyNote', 'releaseStickyNote', 'reclaimStickyNote', 'setStickyNotePinned', 'setStickyNoteStyle', 'setStickyNoteFontSize', 'setStickyNoteLineSpacingMode', 'chooseStickyNoteImage', 'copyStickyNoteImage', 'resizeStickyNoteToContent', 'openStickyNoteContextMenu', 'closeStickyNoteContextMenu', 'readyStickyNoteContextMenu', 'executeStickyNoteContextMenuCommand', 'onStickyNoteContextMenuShow', 'onStickyNoteContextMenuCommand', 'onStickyNoteContextMenuClosed', 'onStickyNoteContextMenuReset', 'onStickyNoteMaterialEffectsChanged', 'onStickyNoteEvent', 'onArknoteServiceEvent', 'onDocumentLocation', 'onOpenIntent', 'onImportDocxIntent', 'onRecoverDraft', 'onMenuCommand', 'onTranslationEvent', 'onAiConversationEvent', 'onPrepareClose', 'onPrepareCloseStructured', 'onClosePreparationReleased',
  ])
  expect(typeof api.testCodexCliConnection).toBe('function')
  expect(typeof api.startCodexCliLogin).toBe('function')
  expect(typeof api.cancelCodexCliLogin).toBe('function')
  expect(typeof api.removeCodexCliConnection).toBe('function')
  expect(Object.isFrozen(api)).toBe(true)

  const onWindowState = vi.fn()
  const stopWindowState = api.onWindowStateChanged(onWindowState)
  const windowStateIpcListener = electronMocks.on.mock.calls.find(
    ([channel]) => channel === WINDOW_STATE_CHANGED_CHANNEL,
  )?.[1] as ((event: unknown, payload: unknown) => void) | undefined
  windowStateIpcListener?.({}, { maximized: true, fullscreen: true, revision: 0 })
  expect(onWindowState).toHaveBeenCalledWith({ maximized: true, fullscreen: true, revision: 0 })
  stopWindowState()
  expect(electronMocks.removeListener).toHaveBeenCalledWith(
    WINDOW_STATE_CHANGED_CHANNEL,
    windowStateIpcListener,
  )

  await api.chooseWorkspace()
  await api.restoreWorkspace()
  await api.listDirectory('folder')
  await api.readDocument('note.md')
  await api.peekDocument('preview.md')
  await api.saveDocument({
    relativePath: 'note.md',
    markdown: '# note',
    expectedRevision: 'a'.repeat(64),
    encoding: 'utf8',
    newline: 'lf',
  })
  expect(electronMocks.invoke.mock.calls).toEqual([
    [IPC_CHANNELS.chooseWorkspace],
    [IPC_CHANNELS.restoreWorkspace],
    [IPC_CHANNELS.listDirectory, { relativePath: 'folder' }],
    [IPC_CHANNELS.readDocument, { relativePath: 'note.md' }],
    [IPC_CHANNELS.peekDocument, { relativePath: 'preview.md' }],
    [IPC_CHANNELS.saveDocument, {
      relativePath: 'note.md',
      markdown: '# note',
      expectedRevision: 'a'.repeat(64),
      encoding: 'utf8',
      newline: 'lf',
    }],
  ])

  const prepare = vi.fn().mockResolvedValue(true)
  const unsubscribe = api.onPrepareClose(prepare)
  expect(electronMocks.on).toHaveBeenCalledWith(CLOSE_CHANNELS.prepare, expect.any(Function))
  const listener = electronMocks.on.mock.calls.find(
    ([channel]) => channel === CLOSE_CHANNELS.prepare,
  )?.[1] as (event: unknown, payload: unknown) => void
  listener({}, { requestId: 'request-1' })
  expect(electronMocks.send).toHaveBeenCalledWith(
    CLOSE_CHANNELS.heartbeat,
    { requestId: 'request-1' },
  )
  await vi.waitFor(() => expect(electronMocks.send).toHaveBeenCalledWith(
    CLOSE_CHANNELS.response,
    { requestId: 'request-1', ok: true },
  ))
  unsubscribe()
  listener({}, { requestId: 'request-2' })
  await vi.waitFor(() => expect(electronMocks.send).toHaveBeenCalledWith(
    CLOSE_CHANNELS.response,
    { requestId: 'request-2', ok: false },
  ))
  expect(electronMocks.removeListener).not.toHaveBeenCalledWith(
    CLOSE_CHANNELS.prepare,
    expect.any(Function),
  )
})


it('rejects inherited response envelopes and success envelopes with extra own keys', async () => {
  const inherited = Object.create({ ok: true, value: null })
  const apiInherited = createArkdownApi(vi.fn().mockResolvedValue(inherited))
  await expect(apiInherited.chooseWorkspace()).resolves.toEqual(transportFailure)

  const apiExtra = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: null,
    stack: 'C:\\private\\stack.txt',
  }))
  await expect(apiExtra.restoreWorkspace()).resolves.toEqual(transportFailure)
})

it('rebuilds known failures with fixed safe messages and rejects extra error keys', async () => {
  const apiKnown = createArkdownApi(vi.fn().mockResolvedValue({
    ok: false,
    error: { code: 'DOCUMENT_CONFLICT', message: 'C:\\private\\secret.md changed' },
  }))
  await expect(apiKnown.saveDocument({
    relativePath: 'note.md', markdown: '# note', expectedRevision: 'a'.repeat(64),
    encoding: 'utf8', newline: 'lf',
  })).resolves.toEqual({
    ok: false,
    error: { code: 'DOCUMENT_CONFLICT', message: '文件已被其他程序修改' },
  })

  const apiExtra = createArkdownApi(vi.fn().mockResolvedValue({
    ok: false,
    error: {
      code: 'OPERATION_FAILED',
      message: '操作未能完成',
      stack: 'C:\\private\\stack.txt',
    },
  }))
  await expect(apiExtra.readDocument('note.md')).resolves.toEqual(transportFailure)
})

it('rejects channel-mismatched success values and extra nested keys', async () => {
  const listApi = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: null }))
  await expect(listApi.listDirectory('')).resolves.toEqual(transportFailure)

  const entryApi = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: [{ name: 'note.md', relativePath: 'note.md', kind: 'document', absolutePath: 'C:\\x' }],
  }))
  await expect(entryApi.listDirectory('')).resolves.toEqual(transportFailure)

  const snapshotApi = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: {
      relativePath: 'note.md', markdown: '# note', revision: 'A'.repeat(64),
      encoding: 'utf8', newline: 'lf', mtimeMs: Number.NaN,
    },
  }))
  await expect(snapshotApi.readDocument('note.md')).resolves.toEqual(transportFailure)
})

it('accepts only exact complete revisioned window state snapshots', async () => {
  const state = { maximized: false, fullscreen: true, revision: Number.MAX_SAFE_INTEGER }
  const validApi = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: state }))
  await expect(validApi.getWindowState?.()).resolves.toEqual({ ok: true, value: state })
  expect((await validApi.getWindowState?.())?.ok).toBe(true)

  const legacyApi = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: { maximized: false, fullscreen: true },
  }))
  await expect(legacyApi.getWindowState?.()).resolves.toEqual(transportFailure)

  const extraApi = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: { ...state, hidden: false },
  }))
  await expect(extraApi.getWindowState?.()).resolves.toEqual(transportFailure)
})

it.each([
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
  '1',
])('rejects invalid window-state revision %s', async (revision) => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: { maximized: false, fullscreen: false, revision },
  }))
  await expect(api.controlWindow?.('minimize')).resolves.toEqual(transportFailure)
})

it('accepts and reconstructs exact valid success values for all invoke methods', async () => {
  const workspace = { name: 'notes', absolutePath: 'C:\\notes' }
  const entries = [{ name: 'note.md', relativePath: 'note.md', kind: 'document' as const }]
  const snapshot = {
    relativePath: 'note.md', markdown: '# note', revision: 'a'.repeat(64),
    encoding: 'utf8-bom' as const, newline: 'crlf' as const, mtimeMs: 12.5,
  }
  const saved = { revision: 'b'.repeat(64), mtimeMs: 13.5 }
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: workspace })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: entries })
    .mockResolvedValueOnce({ ok: true, value: snapshot })
    .mockResolvedValueOnce({ ok: true, value: saved })
  const api = createArkdownApi(invoke)

  const results = [
    await api.chooseWorkspace(),
    await api.restoreWorkspace(),
    await api.listDirectory(''),
    await api.readDocument('note.md'),
    await api.saveDocument({
      relativePath: 'note.md', markdown: '# saved', expectedRevision: 'a'.repeat(64),
      encoding: 'utf8', newline: 'lf',
    }),
  ]
  expect(results).toEqual([
    { ok: true, value: workspace },
    { ok: true, value: null },
    { ok: true, value: entries },
    { ok: true, value: snapshot },
    { ok: true, value: saved },
  ])
  expect((results[0] as { value: unknown }).value).not.toBe(workspace)
  expect((results[2] as { value: unknown }).value).not.toBe(entries)
  expect((results[3] as { value: unknown }).value).not.toBe(snapshot)
  expect((results[4] as { value: unknown }).value).not.toBe(saved)
})


it('uses the bounded dropped-file path adapter and contains adapter failures', () => {
  const file = new File(['# Note'], 'note.md')
  const getPathForFile = vi.fn(() => 'C:\\notes\\note.md')
  const api = createArkdownApi(vi.fn(), undefined, getPathForFile)
  expect(api.pathForDroppedFile(file)).toBe('C:\\notes\\note.md')
  expect(getPathForFile).toHaveBeenCalledWith(file)

  const failed = createArkdownApi(vi.fn(), undefined, () => {
    throw new Error('private path')
  })
  expect(failed.pathForDroppedFile(file)).toBe('')
})

it('opts into document shortcut inspection without changing ordinary file inspection payloads', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: { kind: 'file', absolutePath: 'C:/notes/target.md' } })
  const api = createArkdownApi(invoke)
  await api.inspectDroppedPath?.('C:/Desktop/target.lnk', true)
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.inspectDroppedPath, {
    absolutePath: 'C:/Desktop/target.lnk', resolveDocumentShortcut: true,
  })
  await api.inspectDroppedPath?.('C:/notes/target.md')
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.inspectDroppedPath, { absolutePath: 'C:/notes/target.md' })
})


it('invokes the fixed native sticky-note image chooser channel', async () => {
  const markdown = '![](resources/00000000-0000-4000-8000-000000000099.png)'
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: markdown })
  const api = createArkdownApi(invoke)

  await expect(api.chooseStickyNoteImage?.('00000000-0000-4000-8000-000000000001'))
    .resolves.toEqual({ ok: true, value: markdown })
  expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.chooseStickyNoteImage, {
    noteId: '00000000-0000-4000-8000-000000000001',
  })
})


it('includes the line-spacing setter in the ordinary Arkdown preload allowlist', () => {
  const api = createArkdownApi(vi.fn())

  expect(Object.keys(api)).toContain('setStickyNoteLineSpacingMode')
})
