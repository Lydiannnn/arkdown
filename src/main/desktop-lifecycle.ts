import type { ShellIntegrationService } from './shell-integration/service'
import type { AssetService } from './assets/asset-service'
import type { ImageContextService } from './assets/image-context-service'
import type { MermaidImageExportService } from './assets/mermaid-image-export-service'
import type { DraftService } from './drafts/draft-service'
import type { DocxOperations } from './docx/docx-owner'
import type { XlsxExportService } from './xlsx/xlsx-export-service'
import type { DocumentConversionService } from './document-conversion/document-conversion-service'
import { DocumentService, type DocumentServiceOptions } from './documents/document-service'
import {
  WindowAiCurrentDocumentBroker,
  type RendererCurrentDocumentPort,
  type RendererCurrentDocumentPortRegistration,
  type WindowAiWorkspaceAuthority,
} from './documents/window-ai-current-document-broker'
import { registerIpc, type BackgroundIpcService, type StickyNoteIpcService } from './ipc/register-ipc'
import type { ModelConnectionService } from './models/model-connection-service'
import type { CodexCliConnectionService } from './codex/codex-cli-connection-service'
import type { ModelProtocolClient } from './models/model-protocol-client'
import type { ModelSecretVault } from './models/model-secret-vault'
import { TranslationSessionService } from './models/translation-session-service'
import {
  AiConversationSessionService,
  type AiWorkspaceSwitchTicket,
} from './models/ai-conversation-session-service'
import type { ArkdownRuntimeDependencies } from './arkdown-runtime-dependencies'
import {
  DesktopAiWindowLifecycle,
  type DesktopAiTransportLifecycle,
} from './desktop-ai-window-lifecycle'
import { createStructuredRendererCloseRequester } from './renderer-close-requester'
import type { CloseAttemptCoordinator, CloseAttemptSnapshot } from './close/close-attempt-coordinator'
import type { ClosePreparationAttempt } from '../shared/close-preparation'
import { createCloseNativeUserWait } from './close/close-native-user-wait'
import type { SettingsCoordinator } from './settings/settings-coordinator'
import type { SettingsAuthority } from './settings/settings-authority'
import type { SettingsPresentation } from './settings/settings-presentation'
import type { WindowBounds } from './settings/settings-store'
import { installWindowBoundsSaveOnClose } from './settings/window-bounds-close'
import { WorkspaceService } from './workspace/workspace-service'
import type { WorkspaceFileDrag } from './workspace/workspace-file-drag'
import { WorkspaceAiFileService } from './workspace/workspace-ai-file-service'
import type { WorkspaceColorStore } from './workspace/workspace-color-store'
import type { WorkspaceColorId } from '../shared/workspace-color-marks'
import { WorkspaceEntryService } from './workspace/workspace-entry-service'
import { normalizeBrowserSearchPreferences } from '../shared/search-preferences'
import type { BrowserSearchPreferences } from '../shared/search-preferences'
import type {
  EditorAppearancePreferences,
  EditorAppearanceSnapshot,
} from '../shared/editor-appearance-preferences'
import type { LayoutPreferences, LayoutPreferencesSnapshot } from '../shared/layout-preferences'
import type { AppMenuSectionId } from '../shared/app-menu-definition'
import type { ApplicationMenuWindowState } from '../shared/application-menu-model'
import {
  normalizeDesktopLifecyclePreferences,
  type DesktopLifecyclePreferences,
} from '../shared/desktop-lifecycle-preferences'
import {
  STICKY_NOTE_EVENT_CHANNEL,
  AI_CONVERSATION_EVENT_CHANNEL,
  TRANSLATION_EVENT_CHANNEL,
  type ClipboardFormatsSnapshot,
  type DocumentSnapshot,
  type WindowControlAction,
  type WindowStateSnapshot,
} from '../shared/contracts'
import { parseStickyNoteEvent, type StickyNoteEvent } from '../shared/sticky-notes'
import {
  normalizeStickyNotePreferences,
  type StickyNotePreferences,
} from '../shared/sticky-note-preferences'
import type { ArknotePreferences, ArknotePreferencesUpdate } from '../shared/arknote-preferences'
import type { PrintDocumentInput } from '../shared/printing'
import type { ScreenshotOcrModelManager } from './screenshot-translation/screenshot-ocr-model-manager'
import type { ScreenshotResultOperations } from './screenshot-translation/screenshot-translation-coordinator'

type RegisterOptions = Parameters<typeof registerIpc>[0]
type CloseRequesterOptions = Parameters<typeof createStructuredRendererCloseRequester>[0]
type CloseWindow = Parameters<typeof installWindowBoundsSaveOnClose>[0]
type DesktopWindow = RegisterOptions['window'] & CloseRequesterOptions['window'] & CloseWindow & {
  once(event: 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  webContents: RegisterOptions['window']['webContents'] & {
    readonly id: number
    send(channel: string, payload: unknown): void
    isDestroyed(): boolean
  }
}

export interface DesktopAiMainLifecycle {
  readonly ownerId: number
  getWorkspaceAuthority(): Promise<WindowAiWorkspaceAuthority | null>
  registerCurrentDocumentPort(
    port: RendererCurrentDocumentPort,
  ): Promise<RendererCurrentDocumentPortRegistration>
  registerTransportLifecycle(lifecycle: DesktopAiTransportLifecycle): () => void
  registerOrdinaryCleanup(cleanup: () => void | Promise<void>): () => void
  prepareWorkspaceSwitch(): Promise<AiWorkspaceSwitchTicket>
  activateWorkspace(ticket: AiWorkspaceSwitchTicket): Promise<void>
  deactivateWorkspace(ticket: AiWorkspaceSwitchTicket): Promise<void>
  abortWorkspaceSwitch(ticket: AiWorkspaceSwitchTicket): Promise<void>
  synchronizeWorkspaceAfterDirectRootSet(): Promise<void>
}

export function wireDesktopLifecycle(options: {
  updates?: RegisterOptions['updates']
  createWorkspaceFileDrag?(workspace: WorkspaceService): WorkspaceFileDrag
  claimWorkspaceIntroduction?(legacySeen: boolean): Promise<{ showIntroduction: boolean }>
  ipcMain: RegisterOptions['ipcMain'] & CloseRequesterOptions['ipcMain']
  showOpenDialog: RegisterOptions['showOpenDialog']
  window: DesktopWindow
  runtimeDependencies: Pick<
    ArkdownRuntimeDependencies,
    'workspaceCommitAdapter' | 'workspaceAiEditorBoundary' | 'openDocumentRegistry'
      | 'registerWindowCleanup'
  >
  documentConversions: Pick<DocumentConversionService, 'convertResolved'>
  shellIntegration?: Pick<ShellIntegrationService, 'readObserved' | 'updateObserved'>
  defaultApplications?: Pick<import('./default-applications/service').DefaultApplicationsService, 'getStatus' | 'openSettings' | 'setEnabled'>
  settingsCoordinator: SettingsCoordinator | SettingsPresentation
  settingsAuthority?: SettingsAuthority
  settingsPreferences?: RegisterOptions['settingsPreferences']
  observedModelConnections?: RegisterOptions['observedModelConnections']
  observedCodexCliConnections?: RegisterOptions['observedCodexCliConnections']
  keyboardShortcuts?: {
    readObserved(): Promise<import('../shared/keyboard-shortcuts').ObservedShortcutSnapshot>
    updateObserved(update: import('../shared/keyboard-shortcuts').ObservedShortcutUpdate): Promise<import('../shared/keyboard-shortcuts').ObservedShortcutUpdateResult>
    setRecording(active: boolean): void
  }
  normalizeBounds: (bounds: WindowBounds) => WindowBounds | undefined
  saveWindowBounds(bounds: WindowBounds): Promise<void>
  confirmStopAi(attempt: Readonly<ClosePreparationAttempt>): Promise<boolean>
  onCloseStateChanged(snapshot: CloseAttemptSnapshot): void
  reportOperationError: (error: unknown) => void
  reportCloseError: (error: unknown) => void
  documentServiceOptions?: DocumentServiceOptions
  drafts?: DraftService
  chooseSavePath?: (suggestedFileName?: string) => Promise<string | null>
  createAssetService?: (workspace: WorkspaceService) => AssetService
  createImageContextService?: () => ImageContextService
  createMermaidImageExportService?: () => MermaidImageExportService
  openMermaidViewer?: (input: import('../shared/mermaid-viewer').MermaidViewerSnapshot) => Promise<void>
  docx?: DocxOperations
  chooseDocxExportPath?: (suggestedBaseName: string) => Promise<string | null>
  xlsx?: Pick<XlsxExportService, 'export'>
  chooseXlsxExportPath?: (suggestedBaseName: string) => Promise<string | null>
  readClipboardFormats?: () => ClipboardFormatsSnapshot
  onDocumentSourceChanged?: (sourceDocxPath: string | null) => void
  openAsset?: (url: string) => Promise<void>
  openDocumentWindow?: (absolutePath: string, location?: import('../shared/document-view').DocumentViewLocation) => Promise<void>
  showItemInFolder?: (absolutePath: string) => void
  trashItem?: (absolutePath: string) => Promise<void>
  modelCapabilityRules?: RegisterOptions['modelCapabilityRules']
  modelConnections?: ModelConnectionService
  codexCliConnections?: Pick<CodexCliConnectionService, 'test' | 'remove'>
  ensureCodexCli?(signal?: AbortSignal): Promise<boolean>
  startCodexCliLogin?(): Promise<import('../shared/codex-cli-login').CodexCliLoginOutcome>
  cancelCodexCliLogin?(): Promise<void>
  screenshotOcrModels?: Pick<ScreenshotOcrModelManager, 'getState' | 'getObservedState' | 'downloadMedium' | 'cancelMediumDownload' | 'removeMedium'>
  screenshotOcrHost?: Pick<ScreenshotResultOperations, 'submit' | 'settleOcr'>
  closeScreenshotOwner?: () => Promise<void>
  abortScreenshotOwnerClose?: () => void
  modelSecretVault?: ModelSecretVault
  modelProtocolClient: ModelProtocolClient
  searchSelection?: (query: string) => Promise<void>
  openExternal?: (target: string) => Promise<void>
  openApplicationMenu?: (section: AppMenuSectionId, x: number, y: number) => void
  executeApplicationMenuItem?: (itemId: string) => void
  recordRecentDocument?: (absolutePath: string) => Promise<readonly string[]>
  updateApplicationMenuWindowState?: (state: ApplicationMenuWindowState) => void
  controlWindow: (action: WindowControlAction) => WindowStateSnapshot
  getWindowState: () => WindowStateSnapshot
  printDocument?: (input: PrintDocumentInput) => Promise<void>
  stickyNotes?: StickyNoteIpcService
  backgrounds?: BackgroundIpcService
  subscribeStickyNoteEvents?: (listener: (event: StickyNoteEvent) => void) => () => void
  getArknotePreferences?: () => ArknotePreferences | Promise<ArknotePreferences>
  previewArknoteThemeColor?: (themeColor: string) => Promise<void>
  setArknotePreferences?: (preferences: ArknotePreferencesUpdate) => Promise<ArknotePreferences>
  onDesktopLifecyclePreferencesChanged?: (
    preferences: DesktopLifecyclePreferences,
  ) => void | Promise<void>
  onEditorAppearancePreferencesChanged?: (
    snapshot: EditorAppearanceSnapshot,
  ) => void
  onLayoutPreferencesChanged?: (snapshot: LayoutPreferencesSnapshot) => void
  workspaceColorStore?: WorkspaceColorStore
}): {
  workspace: WorkspaceService
  documents: DocumentService
  ai: DesktopAiMainLifecycle
  seedStartupDocumentOwnership(snapshot: DocumentSnapshot): Promise<void>
  authorizeDraftRecovery(draftId: string): Promise<void>
  getCurrentDocumentAbsolutePath(): string | null
  close: CloseAttemptCoordinator
  cancelCodexCliLoginAttempt(): Promise<void>
} {
  const ownerId = options.window.webContents.id
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error('Invalid desktop window owner identity')
  }
  const workspace = new WorkspaceService()
  const commitAdapter = options.runtimeDependencies.workspaceCommitAdapter
  const documents = new DocumentService(workspace, undefined, {
    replaceFile: commitAdapter?.replaceDocumentFile?.bind(commitAdapter),
    ...options.documentServiceOptions,
  })
  const workspaceAiFiles = new WorkspaceAiFileService({
    windowId: ownerId,
    workspace,
    documents,
    editorBoundary: options.runtimeDependencies.workspaceAiEditorBoundary,
    conversions: options.documentConversions,
    docx: options.docx,
    commitAdapter: options.runtimeDependencies.workspaceCommitAdapter,
  })
  const workspaceAuthority = async (): Promise<WindowAiWorkspaceAuthority | null> => {
    try {
      const capability = await workspaceAiFiles.getRootCapability()
      return Object.freeze({
        workspaceId: capability.workspaceId,
        workspaceGeneration: capability.workspaceGeneration,
      })
    } catch {
      return null
    }
  }
  const currentDocument = new WindowAiCurrentDocumentBroker({
    ownerId,
    getWorkspaceAuthority: workspaceAuthority,
  })
  const assets = options.createAssetService?.(workspace)
  const imageContext = options.createImageContextService?.()
  const mermaidImageExport = options.createMermaidImageExportService?.()
  const legacySettings = (): SettingsCoordinator => {
    if (options.settingsAuthority || !('update' in options.settingsCoordinator)) throw new Error('SETTINGS_LEGACY_WRITER_DISABLED')
    return options.settingsCoordinator
  }
  const legacyModels = (): ModelConnectionService => {
    if (options.settingsAuthority || !options.modelConnections) throw new Error('SETTINGS_LEGACY_WRITER_DISABLED')
    return options.modelConnections
  }
  const legacySecrets = (): ModelSecretVault => {
    if (options.settingsAuthority || !options.modelSecretVault) throw new Error('SETTINGS_LEGACY_WRITER_DISABLED')
    return options.modelSecretVault
  }
  const translations = new TranslationSessionService({
    ...(options.settingsAuthority ? { authority: options.settingsAuthority }
      : { settings: legacySettings(), secrets: legacySecrets() }),
    client: options.modelProtocolClient,
    events: {
      emit(event) {
        if (
          options.window.isDestroyed()
          || options.window.webContents.isDestroyed()
        ) return
        options.window.webContents.send(TRANSLATION_EVENT_CHANNEL, event)
      },
    },
  })
  const aiConversations = new AiConversationSessionService({
    ownerId,
    ...(options.settingsAuthority ? { authority: options.settingsAuthority }
      : { settings: legacySettings(), connections: legacyModels() }),
    client: options.modelProtocolClient,
    files: workspaceAiFiles,
    currentDocument,
    getCurrentDocumentWriteAuthority: () => registration?.getCurrentDocumentWriteAuthority() ?? null,
    events: {
      emit(event) {
        if (
          options.window.isDestroyed()
          || options.window.webContents.isDestroyed()
        ) return
        options.window.webContents.send(AI_CONVERSATION_EVENT_CHANNEL, event)
      },
    },
  })
  let registration: ReturnType<typeof registerIpc> | undefined
  let closeRequester: ReturnType<typeof createStructuredRendererCloseRequester> | undefined
  let unsubscribeStickyNoteEvents: () => void = () => undefined
  let acceptingOrdinaryCleanups = true
  const extraOrdinaryCleanups = new Set<() => void | Promise<void>>()
  const disposeOrdinary = async (): Promise<void> => {
    acceptingOrdinaryCleanups = false
    const extras = [...extraOrdinaryCleanups]
    extraOrdinaryCleanups.clear()
    let failed = false
    const run = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation() } catch { failed = true }
    }
    await run(() => translations.dispose())
    await run(unsubscribeStickyNoteEvents)
    for (const cleanup of extras) await run(cleanup)
    // The ready lifetime must remain observable through finalization and the
    // actual native close. Its transport is already settled; closed detaches it.
    await run(() => registration?.dispose())
    if (failed) throw new Error('Desktop window ordinary cleanup failed')
  }
  const aiWindowLifecycle = new DesktopAiWindowLifecycle({
    disposeConversations: () => aiConversations.dispose(),
    disposeCurrentDocument: () => currentDocument.dispose(),
    disposeOrdinary,
  })
  aiWindowLifecycle.registerTransportLifecycle({
    pauseAndDrain: () => registration?.pauseAndDrain(),
    unregister: () => undefined,
  })
  const windowCleanup = options.runtimeDependencies.registerWindowCleanup(
    () => aiWindowLifecycle.dispose(),
  )
  unsubscribeStickyNoteEvents = options.subscribeStickyNoteEvents?.((payload) => {
    const event = parseStickyNoteEvent(payload)
    if (
      !event
      || options.window.isDestroyed()
      || options.window.webContents.isDestroyed()
    ) return
    options.window.webContents.send(STICKY_NOTE_EVENT_CHANNEL, event)
  }) ?? (() => undefined)
  const workspaceEntries = options.trashItem && options.showItemInFolder && options.openDocumentWindow
    ? new WorkspaceEntryService({
        workspace,
        trashItem: options.trashItem,
        revealItem: options.showItemInFolder,
        openWindow: options.openDocumentWindow,
        workspaceColors: options.workspaceColorStore,
      })
    : undefined
  const workspaceColors = options.workspaceColorStore
    ? {
        get: () => options.workspaceColorStore!.get(workspace.getRoot()),
        set: (relativePath: string, color: WorkspaceColorId | null) =>
          options.workspaceColorStore!.set(workspace.getRoot(), relativePath, color),
        move: (fromRelativePath: string, toRelativePath: string) =>
          options.workspaceColorStore!.move(workspace.getRoot(), fromRelativePath, toRelativePath),
        delete: (relativePath: string) =>
          options.workspaceColorStore!.delete(workspace.getRoot(), relativePath),
      }
    : undefined
  const registerCurrentDocumentPort = async (
    port: RendererCurrentDocumentPort,
  ): Promise<RendererCurrentDocumentPortRegistration> => {
    const portRegistration = await currentDocument.registerPort(port)
    let detach: (() => void) | undefined
    try {
      detach = aiWindowLifecycle.registerTransportLifecycle({
        pauseAndDrain: () => undefined,
        unregister: () => portRegistration.unregister(),
      })
    } catch (error) {
      await portRegistration.unregister()
      throw error
    }
    let unregister: Promise<void> | undefined
    return Object.freeze({
      portGeneration: portRegistration.portGeneration,
      unregister: () => {
        if (unregister !== undefined) return unregister
        detach?.()
        unregister = portRegistration.unregister()
        return unregister
      },
    })
  }
  const synchronizeWorkspaceAfterDirectRootSet = async (): Promise<void> => {
    const ticket = await aiConversations.prepareWorkspaceSwitch()
    try {
      await aiConversations.activateWorkspace(ticket)
    } catch (error) {
      try { await aiConversations.abortWorkspaceSwitch(ticket) } catch { /* original failure wins */ }
      throw error
    }
  }
  const ai: DesktopAiMainLifecycle = Object.freeze({
    ownerId,
    getWorkspaceAuthority: workspaceAuthority,
    registerCurrentDocumentPort,
    registerTransportLifecycle: (lifecycle: DesktopAiTransportLifecycle) => (
      aiWindowLifecycle.registerTransportLifecycle(lifecycle)
    ),
    registerOrdinaryCleanup: (cleanup: () => void | Promise<void>) => {
      if (!acceptingOrdinaryCleanups) {
        throw new Error('Desktop ordinary cleanup registration is closed')
      }
      if (typeof cleanup !== 'function') throw new Error('Invalid desktop ordinary cleanup')
      extraOrdinaryCleanups.add(cleanup)
      return () => {
        if (acceptingOrdinaryCleanups) extraOrdinaryCleanups.delete(cleanup)
      }
    },
    prepareWorkspaceSwitch: () => aiConversations.prepareWorkspaceSwitch(),
    activateWorkspace: (ticket: AiWorkspaceSwitchTicket) => aiConversations.activateWorkspace(ticket),
    deactivateWorkspace: (ticket: AiWorkspaceSwitchTicket) => aiConversations.deactivateWorkspace(ticket),
    abortWorkspaceSwitch: (ticket: AiWorkspaceSwitchTicket) => aiConversations.abortWorkspaceSwitch(ticket),
    synchronizeWorkspaceAfterDirectRootSet,
  })
  const nativeCloseUserWait = createCloseNativeUserWait()
  const workspaceFileDrag = options.createWorkspaceFileDrag?.(workspace)
  if (workspaceFileDrag) extraOrdinaryCleanups.add(() => workspaceFileDrag.dispose())
  registration = registerIpc({
    updates: options.updates,
    workspaceFileDrag,
    claimWorkspaceIntroduction: options.claimWorkspaceIntroduction,
    ipcMain: options.ipcMain,
    showOpenDialog: options.showOpenDialog,
    window: options.window,
    workspace,
    documents,
    drafts: options.drafts,
    chooseSavePath: options.chooseSavePath ? name => nativeCloseUserWait.run(() => options.chooseSavePath!(name)) : undefined,
    assets,
    imageContext,
    mermaidImageExport,
    openMermaidViewer: options.openMermaidViewer,
    docx: options.docx,
    workspaceEntries,
    workspaceColors,
    chooseDocxExportPath: options.chooseDocxExportPath ? name => nativeCloseUserWait.run(() => options.chooseDocxExportPath!(name)) : undefined,
    xlsx: options.xlsx,
    chooseXlsxExportPath: options.chooseXlsxExportPath ? name => nativeCloseUserWait.run(() => options.chooseXlsxExportPath!(name)) : undefined,
    readClipboardFormats: options.readClipboardFormats,
    onDocumentSourceChanged: options.onDocumentSourceChanged,
    openAsset: options.openAsset,
    openDocumentWindow: options.openDocumentWindow,
    getLastWorkspace: () => options.settingsCoordinator.get().lastWorkspace,
    setLastWorkspace: (root) => options.settingsAuthority ? options.settingsAuthority.saveWorkspace(root) : legacySettings().update((settings) => ({
      ...settings,
      lastWorkspace: root,
    })),
    getLastFolderPickerPath: () =>
      options.settingsCoordinator.get().lastFolderPickerPath ?? null,
    setLastFolderPickerPath: (root) => options.settingsAuthority ? options.settingsAuthority.saveFolderPickerDirectory(root ?? undefined) : legacySettings().update((settings) => ({
      ...settings,
      ...(root ? { lastFolderPickerPath: root } : { lastFolderPickerPath: undefined }),
    })),
    reportError: options.reportOperationError,
    settingsPreferences: options.settingsPreferences,
    getKeyboardShortcuts: options.keyboardShortcuts?.readObserved,
    updateKeyboardShortcuts: options.keyboardShortcuts?.updateObserved,
    setShortcutRecording: options.keyboardShortcuts?.setRecording,
    getSearchPreferences: () =>
      normalizeBrowserSearchPreferences(options.settingsCoordinator.get().search),
    setSearchPreferences: options.settingsAuthority ? undefined : (search: BrowserSearchPreferences) =>
      legacySettings().update((settings) => ({
        ...settings,
        search,
      })),
    getEditorAppearancePreferences: () =>
      options.settingsCoordinator.getEditorAppearanceSnapshot(),
    setEditorAppearancePreferences: options.settingsAuthority ? undefined : async (appearance: EditorAppearancePreferences) => {
      const snapshot = await legacySettings().setEditorAppearance(appearance)
      try {
        options.onEditorAppearancePreferencesChanged?.(snapshot)
      } catch (error) {
        options.reportOperationError(error)
      }
      return snapshot
    },
    compareAndSetEditorAppearancePreferences: options.settingsAuthority ? undefined : async (
      expectedRevision: number,
      expected: EditorAppearancePreferences,
      replacement: EditorAppearancePreferences,
    ) => {
      const result = await legacySettings().compareAndSetEditorAppearance(
        expectedRevision,
        expected,
        replacement,
      )
      if (result.applied) {
        try {
          options.onEditorAppearancePreferencesChanged?.(result.snapshot)
        } catch (error) {
          options.reportOperationError(error)
        }
      }
      return result.snapshot
    },
    getLayoutPreferences: () => options.settingsCoordinator.getLayoutSnapshot(),
    compareAndSetLayoutPreferences: options.settingsAuthority ? undefined : async (
      expectedRevision: number,
      expected: LayoutPreferences,
      replacement: LayoutPreferences,
    ) => {
      const result = await legacySettings().compareAndSetLayout(
        expectedRevision,
        expected,
        replacement,
      )
      if (!result.applied) return result
      try {
        options.onLayoutPreferencesChanged?.(result.snapshot)
      } catch (error) {
        options.reportOperationError(error)
      }
      return result
    },
    getStickyNotePreferences: () =>
      normalizeStickyNotePreferences(options.settingsCoordinator.get().stickyNotes),
    setStickyNotePreferences: options.settingsAuthority ? undefined : (stickyNotes: StickyNotePreferences) =>
      legacySettings().update((settings) => ({
        ...settings,
        stickyNotes,
      })),
    getArknotePreferences: options.getArknotePreferences,
    setArknotePreferences: options.setArknotePreferences,
    previewArknoteThemeColor: options.previewArknoteThemeColor,
    shellIntegration: options.shellIntegration,
    defaultApplications: options.defaultApplications,
    getDesktopLifecyclePreferences: () =>
      normalizeDesktopLifecyclePreferences(options.settingsCoordinator.get().desktopLifecycle),
    setDesktopLifecyclePreferences: options.settingsAuthority ? undefined : async (desktopLifecycle: DesktopLifecyclePreferences) => {
      await legacySettings().update((settings) => ({
        ...settings,
        desktopLifecycle,
      }))
      await options.onDesktopLifecyclePreferencesChanged?.(desktopLifecycle)
    },
    searchSelection: options.searchSelection,
    openExternal: options.openExternal,
    modelConnections: options.modelConnections,
    observedModelConnections: options.observedModelConnections,
    modelCapabilityRules: options.modelCapabilityRules,
    codexCliConnections: options.codexCliConnections,
    observedCodexCliConnections: options.observedCodexCliConnections,
    ensureCodexCli: options.ensureCodexCli,
    startCodexCliLogin: options.startCodexCliLogin,
    cancelCodexCliLogin: options.cancelCodexCliLogin,
    screenshotOcrModels: options.screenshotOcrModels,
    screenshotOcrHost: options.screenshotOcrHost,
    translations,
    aiConversations,
    desktopAi: ai,
    openDocumentRegistry: options.runtimeDependencies.openDocumentRegistry,
    stickyNotes: options.stickyNotes,
    backgrounds: options.backgrounds,
    openApplicationMenu: options.openApplicationMenu,
    executeApplicationMenuItem: options.executeApplicationMenuItem,
    recordRecentDocument: options.recordRecentDocument,
    updateApplicationMenuWindowState: options.updateApplicationMenuWindowState,
    controlWindow: options.controlWindow,
    getWindowState: options.getWindowState,
    printDocument: options.printDocument,
    showItemInFolder: options.showItemInFolder,
    trashItem: options.trashItem,
  })

  closeRequester = createStructuredRendererCloseRequester({
    ipcMain: options.ipcMain,
    window: options.window,
  })
  let closeTicket: ReturnType<AiConversationSessionService['beginCloseAdmission']> | undefined
  const close = installWindowBoundsSaveOnClose(options.window, {
    saveWindowBounds: options.saveWindowBounds,
    normalizeBounds: options.normalizeBounds,
    reportError: options.reportCloseError,
    notify: options.onCloseStateChanged,
    isPreparationCurrent: attempt => closeRequester!.isCurrent(attempt),
    closeGate: {
      pauseAndDrain: () => registration.quiesceForClose(),
      resume: beforeAdmission => registration.resumeAfterClose(beforeAdmission),
    },
    prepareRendererClose: async (progress, attempt) => {
      // Reserve before the first await; no new AI start can race the document
      // checkpoint. Existing AI is stopped only after an explicit user choice.
      closeTicket = aiConversations.beginCloseAdmission()
      if (closeTicket.hasRunningWork) {
        progress.enter('await-user')
        if (!await options.confirmStopAi(attempt)) return { status: 'cancelled' }
        if (options.window.isDestroyed()) return { status: 'blocked', code: 'editor-unavailable' }
        progress.enter('quiesce-owner')
        const finish = progress.beginAiDrain()
        try { await closeTicket.stopAndDrain() }
        catch { return { status: 'blocked', code: 'ai-drain-failed' } }
        finally { finish() }
      }
      if (options.window.isDestroyed()) return { status: 'blocked', code: 'editor-unavailable' }
      progress.enter('prepare-editor')
      const humanWait = nativeCloseUserWait.observe(progress.enter)
      try { return await closeRequester!.prepare(attempt, { ...progress, enter: humanWait.enter }) }
      finally { humanWait.dispose() }
    },
    restorePreparation: async () => {
      await closeTicket?.resume()
      closeTicket = undefined
    },
    closeOwnedResources: options.closeScreenshotOwner,
    abortOwnedResourcesClose: options.abortScreenshotOwnerClose,
    finalizeClose: () => windowCleanup.disposeWindow(),
  })
  options.window.once('closed', () => {
    close.closed()
    close.dispose()
    closeRequester?.dispose()
    void windowCleanup.disposeWindow().catch(error => {
      try { options.reportCloseError(error) } catch { /* diagnostics cannot prevent cleanup */ }
    }).finally(() => windowCleanup.unregister())
  })
  return {
    workspace,
    documents,
    ai,
    seedStartupDocumentOwnership: registration.seedStartupDocumentOwnership,
    authorizeDraftRecovery: registration.authorizeDraftRecovery,
    getCurrentDocumentAbsolutePath: registration.getCurrentDocumentAbsolutePath,
    close,
    cancelCodexCliLoginAttempt: registration.cancelCodexCliLoginAttempt,
  }
}
