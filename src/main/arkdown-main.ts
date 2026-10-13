import { APP_UPDATE_CHANGED } from '../shared/app-update'
import { createAppUpdateRuntime } from './updates/update-runtime'
import { UpdateExitCoordinator } from './updates/update-exit-coordinator'
import { UpdateInstallCoordinator } from './updates/update-install-coordinator'
import { prepareUpdateHelper, type NativeUpdateHandoff } from './updates/update-helper'
import { createUpdateDiagnosticLog } from './updates/update-diagnostic-log'
import { stopNotesForUpdate, restoreNotesAfterUpdateAbort } from './updates/update-notes'
import type { ArkdownLaunchBroker } from './updates/launch-broker'
import { normalizeEditorAppearancePreferences, resolveEditorTheme } from '../shared/editor-appearance-preferences'
import { ModelCapabilityRulesStore } from './models/model-capability-rules-store'
import { setMainWindowsEditorTheme } from './main-window-native-surface'
import { MODEL_CAPABILITY_RULES_CHANGED, type ModelCapabilityRulesState } from '../shared/model-capability-rules-state'
import { ShellIntegrationService } from './shell-integration/service'
import { restoreArkdownContextMenus } from './shell-integration/startup'
import { DeferredStartupMaintenance, liveStartupMaintenanceWindow } from './deferred-startup-maintenance'
import { canInitializeDesktopRegistration } from './shell-integration/windows-registry'
import { ScreenTranslationModule } from './screen-translation/module'
import { createScreenTranslationComponentManager } from './screen-translation/component-manager'
import { createOptionalRuntimeHost } from './components/optional-runtime-host'
import { createRuntimeComponentOwner } from './components/runtime-component-owner'
import { createCosMediumPreparer } from './screenshot-translation/screenshot-ocr-medium-source'
import { createCodexCliModelAdapter } from './codex/codex-cli-model-adapter'
import { createCodexCliLoginService } from './codex/codex-cli-login-service'
import { DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256 } from '../shared/document-conversion-component-manifest'
import { createWindowsDefaultApplications } from './default-applications/service'
import { brandingResourcePath } from './branding'
import { DefaultApplicationsEnableError, DefaultApplicationsStartup } from './default-applications/startup'
import { readDefaultApplicationsInstallationId } from './default-applications/installation'
import { initializeArknoteOnDemand, readArknoteSettingsSnapshot } from './arknote/arknote-on-demand'
import { ShellMenuRegistration } from './shell-integration/registration'
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, safeStorage, screen, shell, type NativeImage, type OpenDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { readSettingsFileBounded, parseSettingsJson } from './settings/settings-transaction-files'
import { observeModelSettings } from './settings/settings-command-adapter'
import writeFileAtomic from 'write-file-atomic'
import { prepareInitialWorkspace } from './initial-workspace'
import {
  buildApplicationMenuTemplate,
  executeApplicationMenuModelItem,
  executeApplicationMenuRole,
} from './application-menu'
import { AssetAccessRegistry, ASSET_PROTOCOL } from './assets/asset-path'
import { AssetService } from './assets/asset-service'
import { ImageContextService } from './assets/image-context-service'
import { MermaidImageExportService } from './assets/mermaid-image-export-service'
import { MermaidViewerManager } from './mermaid-viewer/manager'
import { createMermaidViewerWindow } from './mermaid-viewer/native-window'
import { openPdfAsset } from './assets/open-asset'
import { DraftService } from './drafts/draft-service'
import { draftPaths, resolveTempRoot } from './drafts/draft-paths'
import { DocxService } from './docx/docx-service'
import { bindDocxOwner } from './docx/docx-owner'
import { XlsxExportService } from './xlsx/xlsx-export-service'
import { RecoveryCoordinator } from './drafts/recovery-coordinator'
import type { RecoveredDraft } from './drafts/draft-types'
import { createMainWindow, preloadPathForBuild } from './create-main-window'
import { createScreenshotSelectionWindow } from './create-screenshot-selection-window'
import { createScreenshotResultWindow } from './create-screenshot-result-window'
import { ArknoteClientRuntime, registerArknoteClientShutdown } from './arknote/arknote-client-runtime'
import { createArknotePreferencesClient } from './arknote/arknote-preferences-client'
import {
  createArknoteStickyNoteIpcService,
  registerBackgroundSettingsWindowIpc,
  registerDocumentConversionIpc,
  registerPrintWindowIpc,
  registerScreenshotResultWindowIpc,
  registerScreenshotSelectionWindowIpc,
  type BackgroundIpcService,
} from './ipc/register-ipc'
import { CosComponentArtifactSource } from './document-conversion/component-artifact-source'
import { createDocumentConversionComponentManager } from './document-conversion/component-manager'
import { createMarkItDownRunner } from './document-conversion/markitdown-runner'
import { DocumentConversionService } from './document-conversion/document-conversion-service'
import {
  createDocumentConversionRuntimeLifecycle,
  runWithDocumentConversionStartupRollback,
} from './document-conversion/document-conversion-lifecycle'
import { RelatedDocumentConverter } from './document-conversion/related-document-converter'
import { DOCUMENT_CONVERSION_COMPONENT_MANIFEST, DOCUMENT_CONVERSION_COMPONENT_RELEASE_BASE_URL } from '../shared/document-conversion-component-manifest'
import {
  loadPrintDocumentSurface,
  PrintDocumentService,
} from './printing/print-document-service'
import { MENU_COMMAND_CHANNEL } from '../shared/menu-commands'
import {
  BACKGROUND_PRESENTATION_CHANNEL,
  EDITOR_APPEARANCE_CHANGED_CHANNEL,
  LAYOUT_PREFERENCES_CHANGED_CHANNEL,
  STICKY_NOTE_EVENT_CHANNEL,
  WINDOW_CHANNELS,
} from '../shared/contracts'
import { createDisplayCaptureService } from './screenshot-translation/display-capture'
import { createWindowHitTestService } from './screenshot-translation/window-hit-test'
import { collectScreenshotWindowExclusions } from './screenshot-translation/window-exclusions'
import { createScreenshotCaptureCoordinator } from './screenshot-translation/screenshot-capture-coordinator'
import { showScreenshotCaptureFailure } from './screenshot-translation/screenshot-capture-failure'
import {
  createScreenshotTranslationCoordinator,
  screenshotCaptureOwner,
  type ScreenshotCoordinatorDiagnosticCode,
  type ScreenshotResultWindowLike,
} from './screenshot-translation/screenshot-translation-coordinator'
import {
  SCREENSHOT_OCR_PROTOCOL,
  createScreenshotOcrProtocolHandler,
  screenshotOcrRuntimeResourcesPath,
} from './screenshot-translation/screenshot-ocr-resources'
import { createLazyScreenshotOcrModelManager } from './screenshot-translation/lazy-screenshot-ocr-model-manager'
import { SCREENSHOT_OCR_MODEL_STATE_CHANNEL } from '../shared/contracts'
import { createScreenshotTranslationService } from './screenshot-translation/screenshot-translation-service'
import {
  registerScreenshotTranslationShortcut,
  type ScreenshotShortcutDiagnosticCode,
} from './screenshot-translation/screenshot-shortcut'
import {
  createScreenshotQuitGate,
  disposeScreenshotRuntime,
  installScreenshotQuitGate,
  type ScreenshotQuitDiagnosticCode,
} from './screenshot-translation/screenshot-shutdown'
import { DOCUMENT_TYPES, isEditableDocumentPath } from '../shared/document-types'
import { TransactionalModelConnectionService } from './models/transactional-model-connection-service'
import { TransactionalCodexConnectionService } from './codex/transactional-codex-connection-service'
import { createModelCatalogClient } from './models/model-catalog-client'
import { createCodexCliConnectionTester } from './codex/codex-cli-connection-test'
import { createModelProtocolClient } from './models/model-protocol-client'
import {
  createSafeStorageModelSecretCipher,
} from './models/model-secret-vault'
import { appError, PublicError } from '../shared/public-errors'
import {
  createOwnerAwareLinkTargetOpener,
  type SystemLinkTargetAdapters,
} from './link-target-opener'
export { openLinkTarget } from './link-target-opener'
import { wireDesktopLifecycle } from './desktop-lifecycle'
import { WorkspaceFileDrag } from './workspace/workspace-file-drag'
import { loadWorkspaceNativeDrag, prepareWorkspaceNativeDrag } from './workspace/workspace-native-drag'
import { createNativeCloseRecovery } from './close/native-close-recovery'
import { createBusinessMessageDialog } from './dialogs/business-message-dialog'
import { installStartupWindowCloseGuard } from './startup-window-close-guard'
import { createStructuredRendererCloseRequester } from './renderer-close-requester'
import { createScreenshotResultCloseLifecycle } from './screenshot-translation/screenshot-result-close-lifecycle'
import { createCloseDiagnosticLog } from './close/close-diagnostic-log'
import {
  createArkdownRuntimeDependencies,
  runWithArkdownRuntimeStartupRollback,
} from './arkdown-runtime-dependencies'
import { documentSaveDialogOptions } from './document-save-dialog'
import {
  createE2ePersistenceObserver,
  createE2eTrayProbe,
} from './e2e-bootstrap'
import { configureNativeTrayObserver } from './native-tray-observer'
import { resolveDataRoot } from './settings/portable-paths'
import { SettingsAuthority } from './settings/settings-authority'
import { SettingsPresentation } from './settings/settings-presentation'
import { SettingsTransactionStore } from './settings/settings-transaction-store'
import { SettingsPreferenceService } from './settings/settings-preference-service'
import { DEFAULT_FLOATING_TRANSLATION_SETTINGS } from '../shared/large-model-settings'
import { parseScreenTranslationPatch } from '../shared/screen-translation'
import { BrowserSearchService } from './search/browser-search'
import { normalizeBrowserSearchPreferences } from '../shared/search-preferences'
import { loadAuthoritativeStartupSettings } from './settings/startup-settings'
import { createDisplayBoundsNormalizer } from './settings/window-bounds'
import {
  chooseStartupWindowIntent,
  createStartupDocumentIntentPresenter,
  startupDocumentIntent,
} from './startup-document-intent'
import { resolveUserGuidePath } from './user-guide-path'
import { RecentDocumentStore } from './recent-documents/recent-document-store'
import { WorkspaceColorStore } from './workspace/workspace-color-store'
import { openRecentDocumentSafely } from './recent-documents/recent-document-actions'
import { ApplicationMenuSynchronizer } from './application-menu-synchronizer'
import { ShortcutSettingsService } from './settings/shortcut-settings-service'
import { createKeyboardShortcutInputHandler } from './settings/keyboard-shortcut-input'
import { SHORTCUTS_CHANGED_CHANNEL, normalizeShortcutBindings, shortcutFor } from '../shared/keyboard-shortcuts'
import { WindowStateCoordinator } from './window-state'
import type { ApplicationMenuSection } from '../shared/application-menu-model'
import { MainBackgroundService } from './backgrounds/background-service'
import { createMainBackgroundBackend } from './backgrounds/background-backends'
import { BackgroundWorkflow } from './backgrounds/background-workflow'
import { BackgroundSettingsWindowRegistry } from './backgrounds/background-settings-window-registry'
import { createBackgroundSettingsWindow } from './create-background-settings-window'
import {
  createDocumentWindowOpener,
  loadDocumentWindowIntentAfterReady,
  openOrdinaryDocumentWithError,
  showStartupDocumentOpenError,
} from './document-window-opener'

function sameWindowsPath(first: string, second: string): boolean {
  return path.normalize(first).toLocaleLowerCase('en-US')
    === path.normalize(second).toLocaleLowerCase('en-US')
}

function safeExportBaseName(value: string): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
    .replace(/[. ]+$/u, '')
    .trim()
  return sanitized || '导出的文档'
}

export function backgroundImageSelectionDialogOptions(defaultPath?: string): OpenDialogOptions {
  return {
    title: '选择背景图片',
    properties: ['openFile'],
    ...(defaultPath ? { defaultPath } : {}),
    filters: [{
      name: '背景图片',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg'],
    }],
  }
}

export async function promptDraftRecovery(options: {
  count: number
  windows: Iterable<BrowserWindow>
  preferred?: BrowserWindow
  showMessageBox: ReturnType<typeof createBusinessMessageDialog>['showMessageBox']
}): Promise<'recover' | 'ignore'> {
  // At startup there is no document window yet. Later reviews belong to a live
  // document, so closing that owner rejects instead of leaving a last-window race.
  const owner = liveStartupMaintenanceWindow(options.windows, options.preferred)
  const result = await options.showMessageBox(owner, {
    type: 'question',
    title: '恢复未保存的内容',
    message: '检测到 ' + options.count + ' 份尚未结束的草稿。',
    detail: '选择“恢复”将在新窗口中打开草稿；选择“暂不恢复”会保留草稿但不再自动提示。可从“文件 → 查看保留的草稿”再次查看。',
    buttons: ['恢复', '暂不恢复'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return result.response === 0 ? 'recover' : 'ignore'
}

export function startArkdown(options: { launchBroker?: ArkdownLaunchBroker; additionalDocuments?: string[] } = {}): Promise<void> {
const trayProbe = createE2eTrayProbe({ environment: process.env, processId: process.pid, role: 'arkdown' })
configureNativeTrayObserver(trayProbe)
const assetAccess = new AssetAccessRegistry()

return app.whenReady().then(async () => {
  // Ownerless startup prompts briefly become the only window. Their dismissal
  // must not trigger Electron's default quit before draft recovery can continue.
  let updateInstall: UpdateInstallCoordinator | undefined
  const finishWindowStartup = installStartupWindowCloseGuard(app, () => updateInstall?.active ?? false)
  const startupIntentPath = startupDocumentIntent(process.argv, app.isPackaged)
  const dataRootOptions = {
    executablePath: app.getPath('exe'),
    fallbackUserDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
  }
  let modelCapabilityRules: ModelCapabilityRulesStore | undefined
  const publishModelRules = (state: ModelCapabilityRulesState) => {
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed() && !target.webContents.isDestroyed()) {
        try { target.webContents.send(MODEL_CAPABILITY_RULES_CHANGED, state) } catch { /* query remains available */ }
      }
    }
  }
  const { dataRoot, authority: settingsAuthority } = await loadAuthoritativeStartupSettings(
    dataRootOptions,
    resolveDataRoot,
    (root) => new SettingsAuthority(new SettingsTransactionStore(root, createSafeStorageModelSecretCipher(safeStorage))),
    async root => { modelCapabilityRules = new ModelCapabilityRulesStore(root, publishModelRules); await modelCapabilityRules.load() },
    async root => {
      // Optional legacy floating-window preferences only; the locked migration
      // preserves every explicit central setting and validates its binding.
      try {
        const bytes = await readSettingsFileBounded(path.join(root, 'screen-translation', 'settings.json'), 16_384)
        if (!bytes) return undefined
        const old = parseScreenTranslationPatch(parseSettingsJson(bytes))
        return old ? { ...DEFAULT_FLOATING_TRANSLATION_SETTINGS,
          ...(old.connectionId === undefined ? {} : { connectionId: old.connectionId }),
          ...(old.thinkingMode === undefined ? {} : { thinkingMode: old.thinkingMode }),
          ...(old.reasoningEffort === undefined ? {} : { reasoningEffort: old.reasoningEffort }),
          ...(old.target === undefined ? {} : { target: old.target }) } : undefined
      } catch { return undefined }
    },
  )
  // Test startup uses the same finite writer after recovery, never a no-op whole-file writer.
  if (process.env.ARKDOWN_E2E === '1' && process.env.ARKDOWN_E2E_WORKSPACE) {
    await settingsAuthority.saveWorkspace(process.env.ARKDOWN_E2E_WORKSPACE)
  }
  const settingsCoordinator = new SettingsPresentation(settingsAuthority)
  const settingsPreferences = new SettingsPreferenceService(settingsAuthority)
  app.once('will-quit', () => { settingsCoordinator.dispose(); settingsAuthority.dispose() })
  const recentDocuments = new RecentDocumentStore(dataRoot.path)
  const workspaceColorStore = new WorkspaceColorStore(dataRoot.path)
  await recentDocuments.loadForStartup()
  await protocol.handle(ASSET_PROTOCOL, async (request) => {
    const fileUrl = await assetAccess.responseUrl(request.url)
    return await net.fetch(fileUrl, { headers: request.headers })
  })
  const normalizeBounds = createDisplayBoundsNormalizer(() =>
    screen.getAllDisplays().map((display) => display.workArea),
  )
  const startupSettings = {
    ...settingsCoordinator.get(),
    windowBounds: normalizeBounds(settingsCoordinator.get().windowBounds),
  }
  const closeDiagnostics = createCloseDiagnosticLog({ directory: path.join(dataRoot.path, 'diagnostics', 'close') })
  const updateDiagnostics = createUpdateDiagnosticLog({ directory: path.join(dataRoot.path, 'diagnostics', 'update') })
  const businessDialogs = createBusinessMessageDialog({
    ipcMain, preloadPath: preloadPathForBuild(__dirname),
    rendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL || undefined,
    rendererFile: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    appearance: () => {
      const { editorTheme } = settingsCoordinator.getEditorAppearanceSnapshot().appearance
      return { dark: editorTheme === 'dark' || editorTheme === 'system' && nativeTheme.shouldUseDarkColors }
    },
  })
  app.once('will-quit', () => businessDialogs.dispose())
  const closeRecovery = createNativeCloseRecovery({
    ipcMain, preloadPath: preloadPathForBuild(__dirname),
    rendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL || undefined,
    rendererFile: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    version: app.getVersion(), platform: process.platform as 'win32' | 'darwin' | 'linux',
    diagnostics: closeDiagnostics, nativeTheme,
    appearance: () => settingsCoordinator.getEditorAppearanceSnapshot().appearance,
    showMessageBox: businessDialogs.showMessageBox,
  })
  app.once('will-quit', () => { closeRecovery.dispose(); closeDiagnostics.dispose() })
  const shellIntegration = new ShellIntegrationService(
    new ShellMenuRegistration({ executablePath: app.getPath('exe'), iconDirectory: path.dirname(brandingResourcePath('ark-md.ico')) }), { authority: settingsAuthority },
  )
  const defaultApplications = createWindowsDefaultApplications(app.getPath('exe'), (uri) => shell.openExternal(uri), path.dirname(brandingResourcePath('ark-md.ico')))
  const defaultApplicationsStartup = new DefaultApplicationsStartup({ authority: settingsAuthority }, defaultApplications, app.getVersion(),
    () => readDefaultApplicationsInstallationId(path.dirname(app.getPath('exe'))))
  let startupMaintenanceWindow: BrowserWindow | undefined
  const arkdownWindows = new Set<BrowserWindow>()
  const currentDocumentPaths = new WeakMap<BrowserWindow, () => string | null>()
  const ocrModelSubscribers = new Set<BrowserWindow>()
  const componentOwnerSignals = new WeakMap<object, AbortSignal>()
  const optionalRuntimes = createOptionalRuntimeHost({
    dataRoot: dataRoot.path, resourcesPath: process.resourcesPath,
    ...(!app.isPackaged ? { developmentRoot: process.cwd() } : {}),
    appearance: () => {
      const appearance = normalizeEditorAppearancePreferences(settingsCoordinator.get().appearance)
      return { dark: resolveEditorTheme(appearance.editorTheme, nativeTheme.shouldUseDarkColors) === 'dark', themeColor: appearance.themeColor }
    },
  })
  const screenshotOcrModels = createLazyScreenshotOcrModelManager({
    dataRoot: dataRoot.path,
    ...(app.isPackaged ? { bundledMediumRoot: path.join(process.resourcesPath, 'components', 'ocr-medium') } : {}),
    prepareMedium: createCosMediumPreparer(),
    settings: settingsAuthority,
    onState: (state) => {
      for (const target of ocrModelSubscribers) {
        if (target.isDestroyed() || target.webContents.isDestroyed()) continue
        try { target.webContents.send(SCREENSHOT_OCR_MODEL_STATE_CHANNEL, state) } catch { /* state remains queryable */ }
      }
    },
  })
  const currentBoxTheme = () => {
    const appearance = normalizeEditorAppearancePreferences(settingsCoordinator.get().appearance)
    return { mode: resolveEditorTheme(appearance.editorTheme, nativeTheme.shouldUseDarkColors) === 'dark' ? 'dark' : 'light', themeColor: appearance.themeColor }
  }
  const parseThemeAck = (value: unknown): null | undefined => value === null ? null : undefined
  const arknote = new ArknoteClientRuntime({ executablePath: app.getPath('exe'),
    onConnected: client => client.request('settings.box-theme', currentBoxTheme(), parseThemeAck).then(() => undefined) })
  let boxThemeTail = Promise.resolve()
  const synchronizeBoxTheme = () => {
    boxThemeTail = boxThemeTail.then(async () => {
      // A theme change must not restart an Arknote instance the user has quit.
      await arknote.requestIfConnected('settings.box-theme', currentBoxTheme(), parseThemeAck)
    }).catch(() => undefined)
  }
  const unsubscribeBoxAppearance = settingsCoordinator.subscribeEditorAppearance(synchronizeBoxTheme)
  nativeTheme.on('updated', synchronizeBoxTheme)
  app.once('will-quit', () => { unsubscribeBoxAppearance(); nativeTheme.removeListener('updated', synchronizeBoxTheme) })
  const stickyNotes = createArknoteStickyNoteIpcService(arknote)
  const arknotePreferences = createArknotePreferencesClient(arknote, () => readArknoteSettingsSnapshot(path.dirname(app.getPath('exe'))))
  const restoreArknoteIntegration = () => initializeArknoteOnDemand(arknotePreferences.readSettings,
    () => arknote.ensureStarted())
  const getArknotePreferences = arknotePreferences.get
  const setArknotePreferences = arknotePreferences.set
  const offerDefaultApplications = async (window: BrowserWindow, trigger: 'startup' | 'close') => {
    if (window.isDestroyed()) return
    const prompt = async (signal?: AbortSignal) => {
      if (window.isDestroyed()) return false
      const result = await businessDialogs.showMessageBox(window, {
        type: 'question', title: '默认程序',
        message: '是否将 Arkdown 设为默认程序？',
        detail: '包括 *.md 和 *.txt 格式文件。',
        buttons: ['是', '否'], defaultId: 0, cancelId: 1, noLink: true,
      }, signal)
      return result.response === 0 && !window.isDestroyed()
    }
    try {
      if (trigger === 'close') await defaultApplicationsStartup.onClose(prompt)
      else await defaultApplicationsStartup.onReady(prompt)
    } catch (error) {
      console.error('Could not offer default applications', error)
      if (!(error instanceof DefaultApplicationsEnableError)) return
      if (!window.isDestroyed()) await businessDialogs.showMessageBox(window, {
        type: 'error', title: '默认程序', message: error.cause instanceof PublicError ? error.cause.message : '默认程序设置未能完成，请在偏好设置中重试。', buttons: ['确定'],
      }).catch(() => undefined)
    }
  }
  const startupMaintenance = new DeferredStartupMaintenance({
    report: error => console.error('Could not finish startup maintenance', error),
    run: async () => {
      const window = liveStartupMaintenanceWindow(arkdownWindows, startupMaintenanceWindow)
      if (!window) return
      await Promise.all([
        restoreArkdownContextMenus(shellIntegration, restoreArknoteIntegration, (message, error) => console.error(message, error)),
        defaultApplications.refreshOwnedRegistration().catch(error => console.error('Could not refresh owned file icons', error)),
        offerDefaultApplications(window, 'startup'),
      ])
    },
  })
  const previewArknoteThemeColor = (themeColor: string) => arknote.requestIfConnected(
    'settings.preview-theme',
    { themeColor },
    (value): null | undefined => value === null ? null : undefined,
  )

  const codexModelAdapter = createCodexCliModelAdapter({ resolveExecutable: () => optionalRuntimes.resolveCodex() })
  const modelProtocolClient = createModelProtocolClient(undefined, undefined, {
    async streamChat(input) {
      if (!await optionalRuntimes.ensureCodex(input.signal)) throw new DOMException('已取消组件准备', 'AbortError')
      input.signal?.throwIfAborted()
      return codexModelAdapter.streamChat(input)
    },
  })
  const modelConnections = new TransactionalModelConnectionService(
    settingsAuthority, modelProtocolClient, createModelCatalogClient(), { nowIso: () => new Date().toISOString(), createId: randomUUID },
  )
  const codexCliConnections = new TransactionalCodexConnectionService(
    settingsAuthority,
    createCodexCliConnectionTester({ resolveExecutable: () => optionalRuntimes.resolveCodex() }),
    () => new Date().toISOString(),
  )
  const codexCliLogin = createCodexCliLoginService({
    resolveExecutable: () => optionalRuntimes.resolveCodex(),
    openExternal: (url) => shell.openExternal(url),
  })
  const browserSearch = new BrowserSearchService({
    getPreferences: () =>
      normalizeBrowserSearchPreferences(settingsCoordinator.get().search),
    openExternal: (url) => shell.openExternal(url),
  })
  const linkTargetAdapters: SystemLinkTargetAdapters = {
    realpath,
    openExternal: (url) => shell.openExternal(url),
    openPath: (absolutePath) => shell.openPath(absolutePath),
  }
  const openExternalTarget = (
    owner: BrowserWindow,
    target: string,
  ): Promise<void> => createOwnerAwareLinkTargetOpener(owner, linkTargetAdapters)(target)
  const tempLocation = await resolveTempRoot({
    executablePath: app.getPath('exe'),
    fallbackUserDataPath: app.getPath('userData'),
    isPackaged: app.isPackaged,
    portableExecutableDirectory: process.env.PORTABLE_EXECUTABLE_DIR,
  })
  const tempRoot = tempLocation.path
  const drafts = new DraftService({ root: tempRoot, appVersion: app.getVersion() })
  const docx = new DocxService({
    tempRoot,
    executablePath: app.getPath('exe'),
    resourcesPath: process.resourcesPath,
    env: process.env,
    ...(app.isPackaged ? { ensurePandoc: async (signal: AbortSignal) => {
      const executable = await optionalRuntimes.ensure('pandoc', signal)
      if (!executable) throw new DOMException('已取消组件准备', 'AbortError')
      return executable
    } } : {}),
  })
  const xlsx = new XlsxExportService({ tempRoot })
  const documentConversionComponentSource = new CosComponentArtifactSource(
    DOCUMENT_CONVERSION_COMPONENT_MANIFEST,
    DOCUMENT_CONVERSION_COMPONENT_RELEASE_BASE_URL,
  )
  const documentConversionComponentManager = await createDocumentConversionComponentManager({
    userData: dataRoot.path,
    descriptor: DOCUMENT_CONVERSION_COMPONENT_MANIFEST,
    source: documentConversionComponentSource,
    treeManifestSha256: DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256,
    ...(app.isPackaged ? { bundledRoot: path.join(process.resourcesPath, 'document-conversion', 'runtime'),
      bundledTreeManifestSha256: DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256 } : {}),
  })
  const documentConversionRunner = createMarkItDownRunner({
    tempRoot: path.join(tempRoot, 'document-conversion'),
  })
  const documentConversions = new DocumentConversionService({
    manager: documentConversionComponentManager,
    runner: documentConversionRunner,
  })
  const documentConversionLifecycle = createDocumentConversionRuntimeLifecycle({
    conversions: documentConversions,
    manager: documentConversionComponentManager,
  })
  return await runWithDocumentConversionStartupRollback(
    documentConversionLifecycle,
    async () => {
  const relatedDocumentConverter = new RelatedDocumentConverter(documentConversions)
  void relatedDocumentConverter
  const updateExit = new UpdateExitCoordinator({
    getWindows: () => [...arkdownWindows].filter(window => !window.isDestroyed()).map(window => ({ id: window.webContents.id, requestClose: () => window.close() })),
    quitApp: () => app.quit(), notify: state => updates.service.setExitState(state),
  })
  const updates = createAppUpdateRuntime({ version: app.getVersion(), isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath, executablePath: process.execPath, channel: 'stable',
    updateRoot: path.join(dataRoot.path, 'application-updates'),
    ensureInstallationId: id => settingsAuthority.ensureUpdateInstallationId(id),
    openWebsite: url => shell.openExternal(url), requestExit: () => updateExit.requestExit(),
    requestInstall: (artifact, file) => updateInstall!.start(artifact, file),
  })
  let installHelper: NativeUpdateHandoff | undefined
  const closeStates = new Map<number, string>()
  updateInstall = new UpdateInstallCoordinator({
    prepare: async (artifact, file) => {
      installHelper = await prepareUpdateHelper({ resourcesPath: process.resourcesPath, executablePath: process.execPath,
        version: app.getVersion(), artifact, verifiedFile: file, diagnostics: updateDiagnostics })
      const helper = installHelper
      return { exited: helper.exited, revoke: async reason => { await helper.revoke(reason); options.launchBroker?.cancelUpdateHandoff() }, commit: input => helper.commit({ ...input,
        documents: [...new Set([...input.documents, ...(options.launchBroker?.sealForUpdate() ?? [])])] }) }
    },
    windows: () => [...arkdownWindows].filter(w => !w.isDestroyed()).map(w => ({ id: w.webContents.id,
      path: () => currentDocumentPaths.get(w)?.() ?? null,
      activate: () => { if (w.isMinimized()) w.restore(); w.show(); w.focus() }, requestClose: () => w.close(),
      isClosing: () => { const state = closeStates.get(w.webContents.id); return !!state && state !== 'cancelled' } })),
    stopArknote: () => stopNotesForUpdate(arknote, installHelper!),
    restoreArknote: () => restoreNotesAfterUpdateAbort(arknote),
    notify: (state, error) => { updates.service.installState(state, error); if (state === 'aborted') options.launchBroker?.cancelUpdateHandoff() },
    quit: () => app.quit(),
  })
  app.once('will-quit', () => updates.dispose())
  let primaryWindow: BrowserWindow | null = null
  const focusedWindow = () => BrowserWindow.getFocusedWindow() ?? primaryWindow
  let installNativeMenu = (_model: readonly ApplicationMenuSection[]): void => undefined
  const applicationMenus = new ApplicationMenuSynchronizer({
    getRecentDocuments: () => recentDocuments.list(),
    getShortcutBindings: () => normalizeShortcutBindings(settingsCoordinator.get().shortcuts),
    getFocusedWebContentsId: () => focusedWindow()?.webContents.id ?? null,
    installNativeModel: (model) => installNativeMenu(model),
  })
  let lastActiveArkdownWindow: BrowserWindow | null = null
  const windowStates = new WeakMap<BrowserWindow, WindowStateCoordinator>()
  const mainBackgrounds = new MainBackgroundService({
    dataRoot: dataRoot.path,
    settings: settingsAuthority,
    createId: randomUUID,
    urlFor: (absolutePath) => assetAccess.urlFor(absolutePath),
  })
  let lastBackgroundImageDirectory: string | undefined
  const backgroundWorkflow = new BackgroundWorkflow({
    backend: createMainBackgroundBackend(mainBackgrounds),
    chooseSource: async () => {
      const owner = BrowserWindow.getFocusedWindow()
      const options = backgroundImageSelectionDialogOptions(lastBackgroundImageDirectory)
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      const selected = result.canceled ? null : (result.filePaths[0] ?? null)
      if (selected) lastBackgroundImageDirectory = path.dirname(selected)
      return selected
    },
    broadcast: (event) => {
      for (const target of arkdownWindows) {
        if (target.isDestroyed() || target.webContents.isDestroyed()) continue
        try {
          target.webContents.send(BACKGROUND_PRESENTATION_CHANNEL, event)
        } catch (error) {
          console.error('Failed to broadcast background presentation', error)
        }
      }
    },
  })
  const backgroundAppearanceWindows = new Set<BrowserWindow>()
  const backgroundSettingsWindows = new BackgroundSettingsWindowRegistry({
    workflow: backgroundWorkflow,
    createWindow: target => {
      const window = createBackgroundSettingsWindow(target, currentBoxTheme().mode === 'dark' ? 'dark' : 'minimal')
      backgroundAppearanceWindows.add(window)
      window.once('closed', () => backgroundAppearanceWindows.delete(window))
      return window
    },
    register: (window, backgrounds) => registerBackgroundSettingsWindowIpc({
      ipcMain,
      window: window as BrowserWindow,
      backgrounds,
      getEditorAppearancePreferences: () => settingsCoordinator.getEditorAppearanceSnapshot(),
    }),
    reportError: (error) => console.error('Background settings operation failed', error),
  })
  const backgroundIpcServices = new WeakMap<BrowserWindow, BackgroundIpcService>()
  const broadcastEditorAppearance = (
    snapshot: import('../shared/editor-appearance-preferences').EditorAppearanceSnapshot,
  ) => {
    setMainWindowsEditorTheme(snapshot.appearance.editorTheme)
    for (const target of [...arkdownWindows, ...backgroundAppearanceWindows]) {
      if (target.isDestroyed() || target.webContents.isDestroyed()) continue
      try {
        target.webContents.send(EDITOR_APPEARANCE_CHANGED_CHANNEL, snapshot)
      } catch (error) {
        console.error('Failed to broadcast editor appearance preferences', error)
      }
    }
  }
  const broadcastLayoutPreferences = (
    snapshot: import('../shared/layout-preferences').LayoutPreferencesSnapshot,
  ) => {
    for (const target of arkdownWindows) {
      if (target.isDestroyed() || target.webContents.isDestroyed()) continue
      try {
        target.webContents.send(LAYOUT_PREFERENCES_CHANGED_CHANNEL, snapshot)
      } catch (error) {
        console.error('Failed to broadcast layout preferences', error)
      }
    }
  }
  const unsubscribeAppearanceBroadcast = settingsCoordinator.subscribeEditorAppearance(() => broadcastEditorAppearance(settingsCoordinator.getEditorAppearanceSnapshot()))
  const unsubscribeLayoutBroadcast = settingsCoordinator.subscribeLayout(() => broadcastLayoutPreferences(settingsCoordinator.getLayoutSnapshot()))
  app.once('will-quit', () => { unsubscribeAppearanceBroadcast(); unsubscribeLayoutBroadcast() })
  const printDocuments = new PrintDocumentService({
    preloadPath: preloadPathForBuild(__dirname),
    createWindow: (options) => new BrowserWindow(options),
    loadSurface: (window, token) => loadPrintDocumentSurface(window, {
      token,
      devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
      rendererHtmlPath: path.join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
    }),
    registerSurface: (window, access) => registerPrintWindowIpc({
      ipcMain,
      window,
      takePrintDocument: access.take,
      readyPrintDocument: access.ready,
    }),
    randomToken: randomUUID,
  })
  await protocol.handle(SCREENSHOT_OCR_PROTOCOL, createScreenshotOcrProtocolHandler({
    resolveBaseRoot: async () => {
      const entry = await optionalRuntimes.resolve('ocr-base')
      return entry ? path.dirname(entry) : undefined
    },
    resourcesPath: screenshotOcrRuntimeResourcesPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      developmentRoot: process.cwd(),
    }),
    resolveActiveMedium: async (name) => {
      const bytes = await screenshotOcrModels.resolveActiveResource(name)
      return bytes ? { bytes, contentType: 'application/x-tar' } : undefined
    },
  }))
  const screenshotBridgePath = (name: 'windows-window-hit-test.ps1'): string => app.isPackaged
    ? path.join(process.resourcesPath, 'screenshot-translation', name)
    : path.join(process.cwd(), 'scripts', name)
  const screenshotCaptureService = createDisplayCaptureService({ screen, desktopCapturer })
  const screenshotHitTest = createWindowHitTestService({
    scriptPath: screenshotBridgePath('windows-window-hit-test.ps1'),
  })
  const reportScreenshotDiagnostic = (code:
    | ScreenshotCoordinatorDiagnosticCode
    | ScreenshotShortcutDiagnosticCode
    | ScreenshotQuitDiagnosticCode) => {
    console.warn('Screenshot translation diagnostic', code)
  }
  const screenshotTranslations = createScreenshotTranslationCoordinator({
    prepareCapture: async (owner: object) => Boolean(await optionalRuntimes.ensure('ocr-base', componentOwnerSignals.get(owner))),
    createCaptureCoordinator: (hooks) => createScreenshotCaptureCoordinator({
      capture: screenshotCaptureService,
      hitTest: screenshotHitTest,
      createWindow: (input) => createScreenshotSelectionWindow(input),
      screen: {
        dipToScreenPoint: (point) => screen.dipToScreenPoint(point),
        screenToDipRect: (display, rect) => screen.screenToDipRect(display, rect),
      },
      createSessionId: randomUUID,
      excludedWindowHandles: () => collectScreenshotWindowExclusions(BrowserWindow.getAllWindows(), arkdownWindows),
      onCaptured: hooks.onCaptured,
      onDeliveryFailed: hooks.onDeliveryFailed,
      onCaptureFailed: (owner, code) => showScreenshotCaptureFailure(
        {
          showMessageBox: (target, options) => businessDialogs.showMessageBox(target as BrowserWindow, options),
        },
        owner as BrowserWindow,
        code,
      ),
      registerOverlay: (window, displayId, operations) => registerScreenshotSelectionWindowIpc({
        ipcMain,
        window: window as BrowserWindow,
        displayId,
        operations,
      }),
    }),
    createResultWindow: (input, configure) => createScreenshotResultWindow(
      input,
      (window) => configure(window as unknown as ScreenshotResultWindowLike),
    ) as unknown as ScreenshotResultWindowLike,
    registerResultWindow: (window, operations) => registerScreenshotResultWindowIpc({
      ipcMain,
      window: window as unknown as BrowserWindow,
      operations,
      observedModelConnections: modelConnections,
      modelCapabilityRules,
    }),
    createResultCloseLifecycle: (window, { finalize }) => {
      const nativeWindow = window as unknown as BrowserWindow
      return createScreenshotResultCloseLifecycle({
        window: nativeWindow,
        requester: createStructuredRendererCloseRequester({ ipcMain, window: nativeWindow }),
        feedback: closeRecovery.attach(nativeWindow),
        finalize,
      })
    },
    createTranslationService: (events) => createScreenshotTranslationService({
      authority: settingsAuthority,
      client: modelProtocolClient,
      events,
    }),
    workAreaFor: (selection) => screen.getDisplayMatching({
      x: Math.floor(selection.x),
      y: Math.floor(selection.y),
      width: Math.max(1, Math.ceil(selection.x + selection.width) - Math.floor(selection.x)),
      height: Math.max(1, Math.ceil(selection.y + selection.height) - Math.floor(selection.y)),
    }).workArea,
    sendSettingsCommand: (owner) => owner.webContents.send(
      MENU_COMMAND_CHANNEL,
      'screenshot-translation-settings',
    ),
    reportDiagnostic: reportScreenshotDiagnostic,
    acquireOcrTier: async (forcedTier) => {
      const lease = forcedTier === 'small'
        ? { tier: 'small' as const, release: () => undefined }
        : await screenshotOcrModels.acquireTier()
      const state = screenshotOcrModels.getState()
      const version = lease.tier === 'medium' ? state.mediumVersion : state.bundledVersion
      return { ...lease, cacheKey: `${lease.tier}:${version ?? state.bundledVersion}` }
    },
    reportOcrTierUnavailable: (tier) => screenshotOcrModels.reportTierUnavailable(tier),
  })
  const beginScreenshotTranslation = (owner: BrowserWindow): Promise<void> => {
    if (updates.service.isWorkBlocked()) return Promise.resolve()
    updates.service.noteWorkStarted(owner.webContents.id)
    return screenshotTranslations.beginCapture(owner).catch(() => {
      reportScreenshotDiagnostic('CAPTURE_LAUNCH_FAILED')
    })
  }
  const screenTranslation = new ScreenTranslationModule({
    dataRoot: dataRoot.path,
    helperPath: app.isPackaged ? path.join(process.resourcesPath, 'screen-translation', 'Arkdown.ScreenTranslation.exe') : path.join(app.getAppPath(), '.native-cache', 'screen-translation', 'Arkdown.ScreenTranslation.exe'),
    createComponentManager: app.isPackaged
      ? () => createScreenTranslationComponentManager({ dataRoot: dataRoot.path,
        bundledRoot: path.join(process.resourcesPath, 'screen-translation', 'runtime') }) : undefined,
    workerPath: app.isPackaged ? undefined : path.join(app.getAppPath(), '.components', 'screen-translation', 'runtime', 'ArkTranslateEngine', 'ArkTranslateEngine.exe'),
    preload: path.join(__dirname, 'screen-translation-preload.js'),
    rendererFile: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    rendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
    settings: settingsCoordinator,
    observedModels: {
      getDisplay: () => observeModelSettings(settingsAuthority.getDisplaySnapshot()),
      getSettings: () => modelConnections.getSettings(),
      setFloatingTranslation: (observed, patch) => modelConnections.setFeature(observed, 'floatingTranslation', patch),
    },
    authority: settingsAuthority, client: modelProtocolClient, globalShortcut,
    admitWork: owner => {
      if (updates.service.isWorkBlocked()) return false
      updates.service.noteWorkStarted(owner.webContents.id); return true
    },
    getModelRules: () => modelCapabilityRules!.getState(),
    openModels: owner => { owner.show(); owner.focus(); owner.webContents.send(MENU_COMMAND_CHANNEL, 'screenshot-translation-settings') },
  })
  let screenshotShortcut: ReturnType<typeof registerScreenshotTranslationShortcut> | undefined
  const runtimeDependencies = createArkdownRuntimeDependencies({
    app,
    process,
    shutdown: {
      docx,
      documentConversion: documentConversionLifecycle,
      screenshot: {
        dispose: async () => {
          await startupMaintenance.dispose()
          await shellIntegration.drain()
          await defaultApplications.drain()
          screenshotShortcut?.dispose()
          await screenTranslation.dispose()
          await disposeScreenshotRuntime(screenshotTranslations, screenshotOcrModels)
        },
      },
    },
    reportDiagnostic: (code) => console.warn('Arkdown runtime shutdown diagnostic', code),
  })
  return await runWithArkdownRuntimeStartupRollback(runtimeDependencies, async () => {
  screenshotShortcut = registerScreenshotTranslationShortcut({
    globalShortcut,
    accelerator: shortcutFor('tools.screenshot-translation', normalizeShortcutBindings(settingsCoordinator.get().shortcuts)),
    getOwner: () => screenshotCaptureOwner(
      BrowserWindow.getFocusedWindow() ?? undefined,
      lastActiveArkdownWindow ?? primaryWindow,
      arkdownWindows,
    ),
    beginCapture: beginScreenshotTranslation,
    onDiagnostic: reportScreenshotDiagnostic,
  })
  const keyboardShortcuts = new ShortcutSettingsService({
    settings: { authority: settingsAuthority },
    screenshot: screenshotShortcut,
    additionalGlobals: screenTranslation.shortcuts,
    refreshMenus: () => applicationMenus.refresh(),
    broadcast: snapshot => {
      for (const target of arkdownWindows) {
        if (target.isDestroyed() || target.webContents.isDestroyed()) continue
        try { target.webContents.send(SHORTCUTS_CHANGED_CHANNEL, snapshot) }
        catch { /* A closing window must not prevent other windows from updating. */ }
      }
    },
  })
  let executeApplicationMenuItemRequest = (
    _window: BrowserWindow,
    _itemId: string,
  ): void => { throw new Error('Application menu is not ready') }
  registerArknoteClientShutdown(app, arknote)

  const mermaidViewers = new MermaidViewerManager<BrowserWindow>({
    createWindow: (owner, snapshot) => createMermaidViewerWindow({
      snapshot,
      ipcMain,
      workArea: screen.getDisplayMatching(owner.getBounds()).workArea,
      preloadPath: preloadPathForBuild(__dirname),
      rendererUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL || undefined,
      rendererFile: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    }),
  })
  const openDocumentInNewWindow = createDocumentWindowOpener({
    getOpenWindows: () => [...arkdownWindows].map(window => ({
      window,
      absolutePath: currentDocumentPaths.get(window)?.() ?? null,
    })),
    createWindow: (absolutePath) => {
      let loaded!: Promise<void>
      const window = createArkdownWindow(
        absolutePath,
        undefined,
        (intentLoaded) => { loaded = intentLoaded },
      )
      return { window, loaded }
    },
  })

  function createArkdownWindow(
    intentPath?: string,
    recovery?: RecoveredDraft,
    observeIntentLoad?: (loaded: Promise<void>) => void,
    startupGuide = false,
  ): BrowserWindow {
    const window = createMainWindow(startupSettings.windowBounds, {
      showWhenReady: !intentPath,
      startupGuide,
      editorTheme: settingsCoordinator.getEditorAppearanceSnapshot().appearance.editorTheme,
    })
    updates.service.onMainWindowCreated(window.webContents.id)
    window.once('show', () => {
      updates.service.onMainWindowReady(window.webContents.id)
      if (!canInitializeDesktopRegistration()) return
      startupMaintenanceWindow = window
      startupMaintenance.schedule()
    })
    ocrModelSubscribers.add(window)
    arkdownWindows.add(window)
    const shortcutOwnerId = window.webContents.id
    const stopUpdateSubscription = updates.attach(shortcutOwnerId, state => {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(APP_UPDATE_CHANGED, state)
    })
    const componentOwner = createRuntimeComponentOwner({
      publishSignal: signal => componentOwnerSignals.set(window, signal),
      closeOwnedResources: () => screenshotTranslations.closeOwner(window),
      abortOwnedResourcesClose: () => screenshotTranslations.abortOwnerClose(window),
    })
    const ownerDocx = bindDocxOwner(docx, () => componentOwner.signal)
    let cancelCodexOwnerLogin = () => codexCliLogin.cancel(String(shortcutOwnerId))
    const invalidateRendererComponents = () => {
      updates.service.invalidateRenderer(shortcutOwnerId)
      componentOwner.invalidate()
      void cancelCodexOwnerLogin().catch(() => undefined)
    }
    window.webContents.on('before-input-event', createKeyboardShortcutInputHandler({
      getBindings: () => keyboardShortcuts.get().bindings,
      isRecording: () => keyboardShortcuts.isRecording(shortcutOwnerId),
      executeNative: itemId => executeApplicationMenuItemRequest(window, itemId),
      executeRenderer: command => {
        if (updates.service.isWorkBlocked()) return
        updates.service.noteWorkStarted(shortcutOwnerId)
        window.webContents.send(MENU_COMMAND_CHANNEL, command)
      },
      sendInputEvent: input => window.webContents.sendInputEvent(input),
      setIgnoreMenuShortcuts: ignore => window.webContents.setIgnoreMenuShortcuts(ignore),
    }))
    window.webContents.once('destroyed', () => {
      keyboardShortcuts.releaseOwner(shortcutOwnerId)
      componentOwner.abort()
      void cancelCodexOwnerLogin().catch(() => undefined)
    })
    window.webContents.on('render-process-gone', () => {
      invalidateRendererComponents()
      keyboardShortcuts.releaseOwner(shortcutOwnerId)
      if (!window.webContents.isDestroyed()) window.webContents.setIgnoreMenuShortcuts(true)
    })
    window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isInPlace && isMainFrame) {
        invalidateRendererComponents()
        keyboardShortcuts.releaseOwner(shortcutOwnerId)
        window.webContents.setIgnoreMenuShortcuts(true)
      }
    })
    lastActiveArkdownWindow = window
    const screenshotWindowCleanup = runtimeDependencies.registerWindowCleanup(
      () => screenshotTranslations.closeOwner(window),
    )
    window.once('closed', () => {
      componentOwner.abort()
      void cancelCodexOwnerLogin().catch(() => undefined)
      arkdownWindows.delete(window)
      stopUpdateSubscription()
      updates.service.detachWindow(shortcutOwnerId)
      updateExit.onWindowClosed(shortcutOwnerId)
      updateInstall?.onWindowClosed(shortcutOwnerId)
      closeStates.delete(shortcutOwnerId)
      ocrModelSubscribers.delete(window)
      if (lastActiveArkdownWindow === window) {
        lastActiveArkdownWindow = [...arkdownWindows]
          .reverse()
          .find((candidate) => !candidate.isDestroyed()) ?? null
      }
      void screenshotWindowCleanup.disposeWindow().catch(() => {
        console.error('screenshot-owner-cleanup-failed')
      }).finally(() => screenshotWindowCleanup.unregister())
    })
    applicationMenus.register(window.webContents)
    const windowState = new WindowStateCoordinator(window, (state) => {
      applicationMenus.updateWindowFullscreen(window.webContents.id, state.fullscreen)
    })
    windowStates.set(window, windowState)
    window.on('focus', () => {
      arkdownWindows.delete(window)
      arkdownWindows.add(window)
      lastActiveArkdownWindow = window
      applicationMenus.refresh()
      // Refresh presentation after another process commits; an old form keeps its
      // own observation and is never silently retried against this newer snapshot.
      void settingsAuthority.readFresh().then(() => {
        if (!window.isDestroyed()) applicationMenus.refresh()
      }).catch(() => console.error('SETTINGS_FOCUS_REFRESH_FAILED'))
    })
    const backgrounds = backgroundSettingsWindows.serviceForOwner(window, (event) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(BACKGROUND_PRESENTATION_CHANNEL, event)
    })
    backgroundIpcServices.set(window, backgrounds)
    let importedDocxSourcePath: string | null = null
    const windowCloseRecovery = closeRecovery.attach(window)
    window.once('closed', windowCloseRecovery.dispose)
    const services = wireDesktopLifecycle({
      updates: updates.bind(shortcutOwnerId, () => !window.isDestroyed() && !window.webContents.isDestroyed()),
      createWorkspaceFileDrag: workspace => new WorkspaceFileDrag({
        workspace, owner: window.webContents,
        prepareNativeDrag: async absolutePath => {
          if (process.platform === 'win32') return prepareWorkspaceNativeDrag(window, absolutePath, () => loadWorkspaceNativeDrag({
            isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, buildDirectory: __dirname, arch: process.arch,
          }))
          const icon = await app.getFileIcon(absolutePath, { size: 'small' })
          if (icon.isEmpty()) throw new Error('File drag icon is unavailable')
          return () => window.webContents.startDrag({ file: absolutePath, icon })
        },
      }),
      workspaceColorStore,
      ipcMain,
      showOpenDialog: (_owner, options) => {
        defaultApplicationsStartup.deferStartupOffer()
        return dialog.showOpenDialog(window, options)
      },
      window,
      runtimeDependencies,
      documentConversions,
      settingsCoordinator,
      settingsAuthority,
      settingsPreferences,
      saveWindowBounds: bounds => settingsAuthority.saveWindowBounds(bounds),
      claimWorkspaceIntroduction: seen => {
        defaultApplicationsStartup.deferStartupOffer()
        return settingsAuthority.claimWorkspaceIntroduction(seen)
      },
      confirmStopAi: windowCloseRecovery.confirmStopAi,
      offerDefaultApplicationsOnClose: async () => {
        if (!canInitializeDesktopRegistration() || updates.service.isWorkBlocked() || updateInstall?.active) return
        await offerDefaultApplications(window, 'close')
      },
      onCloseStateChanged: snapshot => {
        windowCloseRecovery.notify(snapshot); updateExit.onCloseState(shortcutOwnerId, snapshot)
        closeStates.set(shortcutOwnerId, snapshot.state); updateInstall?.onCloseState(shortcutOwnerId, snapshot)
      },
      keyboardShortcuts: {
        readObserved: () => keyboardShortcuts.readObserved(),
        updateObserved: update => keyboardShortcuts.updateObserved(update),
        setRecording: active => {
          if (active) {
            keyboardShortcuts.setRecording(shortcutOwnerId, true)
            try { window.webContents.setIgnoreMenuShortcuts(true) }
            catch (error) { keyboardShortcuts.releaseOwner(shortcutOwnerId); throw error }
          } else {
            try { keyboardShortcuts.setRecording(shortcutOwnerId, false) }
            finally { if (!window.webContents.isDestroyed()) window.webContents.setIgnoreMenuShortcuts(true) }
          }
        },
      },
      shellIntegration,
      defaultApplications,
      backgrounds,
      screenshotOcrModels,
      screenshotOcrHost: {
        submit: (input) => screenshotTranslations.submitOcrForOwner(window, input),
        settleOcr: (input) => screenshotTranslations.settleOcrForOwner(window, input),
      },
      closeScreenshotOwner: componentOwner.prepareClose,
      abortScreenshotOwnerClose: componentOwner.abortClose,
      onEditorAppearancePreferencesChanged: broadcastEditorAppearance,
      onLayoutPreferencesChanged: broadcastLayoutPreferences,
      normalizeBounds,
      reportOperationError: (error) => console.error(
        'Failed to roll back workspace settings after activation failure',
        error,
      ),
      reportCloseError: (error) => console.error(
        'Failed to save window settings before closing',
        error,
      ),
      documentServiceOptions: {
        onStage: createE2ePersistenceObserver(process.env),
      },
      drafts,
      chooseSavePath: async (suggestedFileName) => {
        const result = await dialog.showSaveDialog(window, documentSaveDialogOptions(suggestedFileName))
        return result.canceled ? null : (result.filePath ?? null)
      },
      docx: ownerDocx,
      chooseDocxExportPath: async (suggestedBaseName) => {
        while (true) {
          const result = await dialog.showSaveDialog(window, {
            title: '导出 DOCX',
            defaultPath: `${safeExportBaseName(suggestedBaseName)}.docx`,
            filters: [{
              name: 'DOCX 文档',
              extensions: ['docx'],
            }],
          })
          if (result.canceled || !result.filePath) return null
          const targetPath = result.filePath.toLocaleLowerCase('en-US').endsWith('.docx')
            ? result.filePath
            : `${result.filePath}.docx`
          if (
            importedDocxSourcePath
            && sameWindowsPath(targetPath, importedDocxSourcePath)
          ) {
            await businessDialogs.showMessageBox(window, {
              type: 'warning',
              title: '不能覆盖原 DOCX',
              message: '不能覆盖导入的原 DOCX，请选择其他保存位置。',
              buttons: ['重新选择'],
            })
            continue
          }
          return targetPath
        }
      },
      xlsx,
      chooseXlsxExportPath: async (suggestedBaseName) => {
        const result = await dialog.showSaveDialog(window, {
          title: '导出 XLSX',
          defaultPath: `${safeExportBaseName(suggestedBaseName)}.xlsx`,
          filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
        })
        if (result.canceled || !result.filePath) return null
        return result.filePath.toLocaleLowerCase('en-US').endsWith('.xlsx')
          ? result.filePath
          : `${result.filePath}.xlsx`
      },
      readClipboardFormats: () => {
        const plainText = clipboard.readText('clipboard')
        const markdown = clipboard.read('text/markdown')
        const html = clipboard.readHTML('clipboard')
        return {
          plainText,
          markdown: markdown === '' ? null : markdown,
          html: html === '' ? null : html,
        }
      },
      onDocumentSourceChanged: (sourceDocxPath) => { importedDocxSourcePath = sourceDocxPath },
      createAssetService: (workspace) => new AssetService({
        workspace,
        tempRoot,
        sessionId: randomUUID(),
        access: assetAccess,
        readClipboardImage: () => clipboard.readImage('clipboard'),
      }),
      createImageContextService: () => new ImageContextService({
        reveal: (absolutePath) => shell.showItemInFolder(absolutePath),
        copyImageToClipboard: (absolutePath) => {
          const image = nativeImage.createFromPath(absolutePath)
          if (image.isEmpty()) throw appError('MEDIA_PREVIEW_UNAVAILABLE')
          clipboard.writeImage(image)
        },
        chooseTarget: async (source, mode) => {
          const extension = path.extname(source).slice(1)
          const base = path.basename(source, path.extname(source))
          const result = await dialog.showSaveDialog(window, {
            title: mode === 'save-copy' ? '图片另存为' : '复制图片到',
            defaultPath: path.join(path.dirname(source), `${base} - 副本.${extension}`),
            filters: [{
              name: '图片文件',
              extensions: [extension],
            }],
          })
          if (result.canceled || !result.filePath) return null
          return path.extname(result.filePath)
            ? result.filePath
            : `${result.filePath}.${extension}`
        },
      }),
      createMermaidImageExportService: () => new MermaidImageExportService({
        createNativeImage: (dataUrl) => nativeImage.createFromDataURL(dataUrl),
        writeClipboardImage: (image) => clipboard.writeImage(image as NativeImage),
        chooseTarget: async () => {
          const result = await dialog.showSaveDialog(window, {
            title: 'Mermaid 图形另存为',
            defaultPath: 'Mermaid 图形.svg',
            filters: [
              { name: 'SVG 矢量图', extensions: ['svg'] },
              { name: 'PNG 图片', extensions: ['png'] },
            ],
          })
          if (result.canceled || !result.filePath) return null
          return path.extname(result.filePath) ? result.filePath : `${result.filePath}.svg`
        },
        writeFileAtomic: (targetPath, bytes) => writeFileAtomic(
          targetPath,
          bytes,
          { fsync: true },
        ),
      }),
      openAsset: (url) => openPdfAsset(
        url,
        (candidate) => assetAccess.resolve(candidate),
        (target) => shell.openPath(target),
      ),
      openDocumentWindow: openDocumentInNewWindow,
      openMermaidViewer: (snapshot) => mermaidViewers.open(window, snapshot),
      showItemInFolder: (absolutePath) => shell.showItemInFolder(absolutePath),
      trashItem: (absolutePath) => shell.trashItem(absolutePath),
      searchSelection: (query) => browserSearch.search(query).then(() => undefined),
      observedModelConnections: modelConnections,
      modelCapabilityRules,
      observedCodexCliConnections: codexCliConnections,
      ensureCodexCli: async (signal?: AbortSignal) => Boolean(await optionalRuntimes.ensureCodex(
        signal ? AbortSignal.any([componentOwner.signal, signal]) : componentOwner.signal)) && !window.isDestroyed(),
      startCodexCliLogin: () => window.isDestroyed() || componentOwner.signal.aborted
        ? Promise.resolve({ status: 'cancelled' as const }) : codexCliLogin.start(String(shortcutOwnerId)),
      cancelCodexCliLogin: () => codexCliLogin.cancel(String(shortcutOwnerId)),
      modelProtocolClient,
      openExternal: (target) => openExternalTarget(window, target),
      openApplicationMenu: (section, x, y) => {
        const submenu = Menu.getApplicationMenu()?.getMenuItemById(section)?.submenu
        if (!submenu) throw new Error(`Application menu section is unavailable: ${section}`)
        submenu.popup({ window, x, y })
      },
      executeApplicationMenuItem: (itemId) => executeApplicationMenuItemRequest(window, itemId),
      recordRecentDocument: async (absolutePath) => {
        const updated = await recentDocuments.record(absolutePath)
        applicationMenus.refresh()
        return updated
      },
      updateApplicationMenuWindowState: (state) => {
        applicationMenus.updateWindowState(window.webContents.id, {
          ...state,
          fullscreen: windowState.getSnapshot().fullscreen,
        })
      },
      controlWindow: windowState.controlWindow,
      getWindowState: windowState.getSnapshot,
      printDocument: (input) => printDocuments.print(window, input),
      stickyNotes,
      getArknotePreferences,
      setArknotePreferences,
      previewArknoteThemeColor: (themeColor) => previewArknoteThemeColor(themeColor).then(() => undefined),
      subscribeStickyNoteEvents: (listener) => arknote.subscribe((event) => {
        if (event.type === 'service-stopping' || event.type === 'service-disconnected') return
        listener(event)
      }),
    })
    cancelCodexOwnerLogin = services.cancelCodexCliLoginAttempt
    windowCloseRecovery.bind(services.close)
    currentDocumentPaths.set(window, () => services.getCurrentDocumentAbsolutePath() ?? importedDocxSourcePath)
    const documentConversionRegistration = registerDocumentConversionIpc({
      ipcMain,
      window,
      workspace: services.workspace,
      componentManager: documentConversionComponentManager,
      conversions: documentConversions,
    })
    const unsubscribeArknoteServiceEvents = arknote.subscribe((event) => {
      if (event.type !== 'service-stopping' && event.type !== 'service-disconnected') return
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(STICKY_NOTE_EVENT_CHANNEL, event)
      }
    })
    services.ai.registerOrdinaryCleanup(unsubscribeArknoteServiceEvents)
    services.ai.registerOrdinaryCleanup(cancelCodexOwnerLogin)
    services.ai.registerOrdinaryCleanup(() => documentConversionRegistration.dispose())
    if (intentPath) {
      const intentLoaded = loadDocumentWindowIntentAfterReady({
        window,
        absolutePath: intentPath,
        workspace: services.workspace,
        documents: services.documents,
        seedDocumentOwnership: services.seedStartupDocumentOwnership,
        docx: ownerDocx,
        onImportedSourcePath: (sourceAbsolutePath) => {
          importedDocxSourcePath = sourceAbsolutePath
        },
      }).then(async (result) => {
        await services.ai.synchronizeWorkspaceAfterDirectRootSet()
        return result
      })
      if (observeIntentLoad) {
        observeIntentLoad(intentLoaded)
      } else {
        const presenter = createStartupDocumentIntentPresenter(window)
        void presenter.present(intentLoaded, async (error) => {
          console.error('Failed to open document in new window', error)
          await showStartupDocumentOpenError(window, error, {
            showError: async (message) => {
              await businessDialogs.showMessageBox(window, {
                type: 'error',
                title: '无法打开文档',
                message,
                buttons: ['确定'],
              })
            },
            reportDialogError: (dialogError) => {
              console.error('Failed to show document-open error dialog', dialogError)
            },
          })
        })
      }
    }
    if (!intentPath && !recovery && process.env.ARKDOWN_E2E === '1' && process.env.ARKDOWN_E2E_WORKSPACE) {
      window.webContents.once('did-finish-load', () => {
        void services.workspace.setRoot(process.env.ARKDOWN_E2E_WORKSPACE!).then(async (workspace) => {
          await services.ai.synchronizeWorkspaceAfterDirectRootSet()
          window.webContents.send(WINDOW_CHANNELS.openIntent, { workspace, document: null })
        })
      })
    }
    if (recovery) {
      const grant = services.authorizeDraftRecovery(recovery.manifest.draftId)
      void grant.catch(() => undefined)
      window.webContents.once('did-finish-load', () => {
        void grant.then(() => {
          if (window.isDestroyed()) return
          window.webContents.send(WINDOW_CHANNELS.recoverDraft, {
            draftId: recovery.manifest.draftId,
            manifest: recovery.manifest,
            markdown: recovery.markdown,
          })
        }).catch(async () => {
          if (!window.isDestroyed()) await businessDialogs.showMessageBox(window, {
            type: 'error', title: '无法恢复草稿', message: '草稿未能认领，内容仍保留，请稍后重试。', buttons: ['确定'],
          }).catch(() => undefined)
        })
      })
    }
    return window
  }

  const showPrimaryWindow = (): BrowserWindow => {
    if (!primaryWindow || primaryWindow.isDestroyed()) primaryWindow = createArkdownWindow()
    if (primaryWindow.isMinimized()) primaryWindow.restore()
    primaryWindow.show()
    primaryWindow.focus()
    return primaryWindow
  }
  const recovery = new RecoveryCoordinator({
    drafts,
    prompt: async (summaries) => {
      if (process.env.ARKDOWN_E2E === '1' && process.env.ARKDOWN_E2E_RECOVER === '1') return 'recover'
      return promptDraftRecovery({
        count: summaries.length, windows: arkdownWindows, preferred: lastActiveArkdownWindow ?? undefined,
        showMessageBox: businessDialogs.showMessageBox,
      })
    },
    open: async (draft) => {
      await assetAccess.allowRoot(draftPaths(tempRoot, draft.manifest.draftId).assetDirectory)
        .catch(() => undefined)
      const window = createArkdownWindow(undefined, draft)
      if (!primaryWindow) primaryWindow = window
    },
  })
  const recoveryResult = await recovery.promptAndOpen().catch(async () => {
    await businessDialogs.showMessageBox(undefined, { type: 'warning', title: '草稿暂时无法读取',
      message: '保留的草稿暂时无法读取。内容未删除，可稍后从“文件 → 查看保留的草稿”重试。', buttons: ['确定'] })
      .catch(() => undefined)
    return { found: 0, recovered: 0, ignored: 0 }
  })
  const initialWorkspaceOptions = {
    templateRoot: app.isPackaged
      ? path.join(path.dirname(app.getPath('exe')), '初始工作区')
      : path.join(process.cwd(), 'initial-workspace'),
    documentsRoot: app.getPath('documents'),
    stateRoot: dataRoot.path,
    previousWorkspace: startupSettings.lastWorkspace,
  }
  const startupWindowIntent = chooseStartupWindowIntent({
    explicitDocument: startupIntentPath,
    recoveredDraftCount: recoveryResult.recovered,
    recentDocuments: process.env.ARKDOWN_E2E === '1' && process.env.ARKDOWN_E2E_WORKSPACE
      ? []
      : recentDocuments.list(),
  })
  if (startupWindowIntent.kind === 'document') {
    primaryWindow = createArkdownWindow(startupWindowIntent.absolutePath)
  } else if (startupWindowIntent.kind === 'blank') {
    let welcomePath: string | null = null
    let initialWorkspaceFailed = false
    if (!(process.env.ARKDOWN_E2E === '1' && process.env.ARKDOWN_E2E_WORKSPACE)) {
      try {
        welcomePath = await prepareInitialWorkspace(initialWorkspaceOptions)
      } catch (error) {
        initialWorkspaceFailed = true
        console.error('Could not prepare initial workspace', error)
      }
    }
    primaryWindow = welcomePath
      ? createArkdownWindow(welcomePath)
      : createArkdownWindow(undefined, undefined, undefined, true)
    if (initialWorkspaceFailed) void businessDialogs.showMessageBox(primaryWindow, {
      type: 'warning', title: '初始工作区',
      message: '初始工作区未能复制到文档目录。你可以先开始写作，下次启动会重新尝试。',
      buttons: ['确定'],
    }).catch(error => console.error('Failed to present initial workspace failure', error))
  }
  const screenshotQuitGate = createScreenshotQuitGate({
    coordinator: {
      dispose: async () => {
        let failed = false
        try { await optionalRuntimes.dispose() } catch { failed = true }
        try { await codexCliLogin.dispose() } catch { failed = true }
        try { await runtimeDependencies.dispose() } catch { failed = true }
        try { await codexCliConnections.dispose() } catch { failed = true }
        if (failed) throw new Error('Arkdown runtime cleanup failed')
      },
    },
    shortcut: screenshotShortcut,
    quit: () => app.quit(),
    reportDiagnostic: reportScreenshotDiagnostic,
  })
  installScreenshotQuitGate(app, screenshotQuitGate)
  finishWindowStartup()
  const guidePath = resolveUserGuidePath({
    executablePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    projectRoot: process.cwd(),
  })
  const sendMenuCommand = (
    owner: BrowserWindow,
    command: import('../shared/menu-commands').MenuCommand,
  ) => {
    if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
      if (updates.service.isWorkBlocked() && command !== 'about') return
      if (command !== 'about') updates.service.noteWorkStarted(owner.webContents.id)
      owner.webContents.send(MENU_COMMAND_CHANNEL, command)
    }
  }
  const openRecentDocument = (
    owner: BrowserWindow | undefined,
    absolutePath: string,
  ): void => {
    if (!owner || owner.isDestroyed()) return
    const showRecentError = async (message: string) => {
      if (owner.isDestroyed()) return
      await businessDialogs.showMessageBox(owner, {
        type: 'error', title: '无法打开文档', message, buttons: ['确定'],
      })
    }
    void openRecentDocumentSafely(absolutePath, {
      openDocumentInNewWindow,
      remove: (target) => recentDocuments.remove(target),
      refreshMenus: () => applicationMenus.refresh(),
      showFileNotFound: showRecentError,
      showOpenError: showRecentError,
    }).catch((error) => console.error('Failed to open recent document', error))
  }
  const menuActions = {
      reviewDrafts: (owner?: BrowserWindow) => {
        void recovery.promptAndOpen(true).then(async (result) => {
          if (!result.found && owner && !owner.isDestroyed()) await businessDialogs.showMessageBox(owner, {
            type: 'info', title: '保留的草稿', message: '没有可恢复的草稿。已打开的草稿可在对应窗口中继续编辑。', buttons: ['确定'],
          })
        }).catch(async () => {
          if (owner && !owner.isDestroyed()) await businessDialogs.showMessageBox(owner, {
            type: 'error', title: '保留的草稿', message: '读取草稿失败，请重试。', buttons: ['确定'],
          })
        }).catch(error => console.error('Failed to present retained draft failure', error))
      },
      createNewWindow: () => { createArkdownWindow() },
      openDocument: (owner?: BrowserWindow) => {
        if (!owner || owner.isDestroyed()) return
        void (async () => {
          const result = await dialog.showOpenDialog(owner, {
            properties: ['openFile'],
            filters: [{
              name: '支持的文档',
              extensions: DOCUMENT_TYPES.filter(
                (entry) => isEditableDocumentPath(`file.${entry.extension}`) || entry.importWithPandoc,
              ).map((entry) => entry.extension),
            }, { name: '所有文件', extensions: ['*'] }],
          })
          const selected = result.canceled ? undefined : result.filePaths[0]
          if (!selected) return
          await openOrdinaryDocumentWithError(selected, {
            openDocumentInNewWindow,
            showError: async (message) => {
              if (owner.isDestroyed()) return
              await businessDialogs.showMessageBox(owner, {
                type: 'error',
                title: '无法打开文档',
                message,
                buttons: ['确定'],
              })
            },
          })
        })().catch((error) => console.error('Failed to open document', error))
      },
      closeWindow: (owner?: BrowserWindow) => owner?.close(),
      openBackgroundSettings: (owner?: BrowserWindow) => {
        const target = owner ?? focusedWindow()
        if (!target || target.isDestroyed()) return
        const backgrounds = backgroundIpcServices.get(target)
        if (!backgrounds) return
        void backgrounds.open({ kind: 'main' }).catch((error) => {
          console.error('Failed to open background settings', error)
        })
      },
      openScreenTranslation: (owner?: BrowserWindow) => {
        const target = screenshotCaptureOwner(owner, lastActiveArkdownWindow ?? primaryWindow, arkdownWindows)
        if (target) void screenTranslation.open(target).catch(() => undefined)
      },
      beginScreenshotTranslation: (owner?: BrowserWindow) => {
        const target = screenshotCaptureOwner(
          owner,
          lastActiveArkdownWindow ?? primaryWindow,
          arkdownWindows,
        )
        if (target) void beginScreenshotTranslation(target)
      },
      openGuide: (owner?: BrowserWindow) => {
        void shell.openPath(guidePath).then(async (error) => {
          if (error && owner && !owner.isDestroyed()) await businessDialogs.showMessageBox(owner, {
            type: 'error',
            title: '无法打开使用说明书',
            message: '无法打开使用说明书',
            detail: error,
          })
        }).catch(error => console.error('Failed to open or present user guide failure', error))
      },
      openAbout: (owner?: BrowserWindow) => {
        if (!owner || owner.isDestroyed()) return
        sendMenuCommand(owner, 'about')
      },
      openRecentDocument,
      executeRole: (
        owner: BrowserWindow,
        role: import('../shared/application-menu-model').ApplicationMenuRole,
      ) => {
        executeApplicationMenuRole(owner, role, (target) => windowStates.get(target))
      },
    }
  installNativeMenu = (model) => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(
      buildApplicationMenuTemplate(sendMenuCommand, guardedMenuActions, model),
    ))
  }
  const guardedMenuActions = new Proxy(menuActions, { get(target, property, receiver) {
    const action = Reflect.get(target, property, receiver)
    if (typeof action !== 'function') return action
    return (...args: unknown[]) => {
      if (!['closeWindow', 'openAbout', 'openGuide'].includes(String(property))) {
        if (updates.service.isWorkBlocked()) return
        const owner = focusedWindow(); if (owner) updates.service.noteWorkStarted(owner.webContents.id)
      }
      return action(...args)
    }
  } })
  applicationMenus.refresh()
  executeApplicationMenuItemRequest = (targetWindow, itemId) => {
    if (targetWindow.isDestroyed()) return
    const modelItem = applicationMenus.itemForWindow(targetWindow.webContents.id, itemId)
    if (!modelItem) throw new Error(`Unknown application menu item: ${itemId}`)
    executeApplicationMenuModelItem(targetWindow, modelItem, sendMenuCommand, guardedMenuActions)
  }
  options.launchBroker?.setHandler(async paths => {
    if (updates.service.isWorkBlocked() || updateInstall?.active) return false
    const owner = focusedWindow(); if (owner) updates.service.noteWorkStarted(owner.webContents.id)
    if (!paths.length) { createArkdownWindow(); return true }
    for (const file of paths) await openDocumentInNewWindow(file)
    return true
  })
  for (const file of options.additionalDocuments ?? []) await openDocumentInNewWindow(file)
  })
    },
  )
})
}
