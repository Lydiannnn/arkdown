import type { MenuCommand } from './menu-commands'
import type { ClosePreparationHandler, ClosePreparationAttempt } from './close-preparation'
import type { DocumentLocationIntent, DocumentViewRequest, DocumentViewResult, DocumentViewSnapshot, LocalFileRevealRequest } from './document-view'
import type { ObservedCodexLoginResult, ObservedCodexTestResult, ObservedModelTestResult, ModelFeaturePatches } from './model-settings-commands'
import type { PublicModelSettingsSnapshot, PublicModelMutationResult } from './settings-observation'
import type {
  ApplicationMenuSection,
  ApplicationMenuWindowState,
} from './application-menu-model'
import type {
  StickyNoteContextMenuCommand,
  StickyNoteContextMenuOpenInput,
  StickyNoteContextMenuShowPayload,
} from './sticky-note-context-menu'
import type { BrowserSearchPreferences } from './search-preferences'
import type { PreferenceGroup, PreferencePatchInput, PublicPreferenceMutation, PublicPreferenceSnapshot } from './preference-observation'
import type { ObservedShortcutSnapshot, ObservedShortcutUpdate, ObservedShortcutUpdateResult } from './keyboard-shortcuts'
import type {
  EditorAppearancePreferences,
  EditorAppearanceSnapshot,
} from './editor-appearance-preferences'
import type { LayoutPreferences, LayoutPreferencesSnapshot } from './layout-preferences'
import type { PrintDocumentInput, PrintSurfaceDocumentInput } from './printing'
import type { DesktopLifecyclePreferences } from './desktop-lifecycle-preferences'
import type { ShellIntegrationSnapshot, ObservedShellIntegrationUpdate } from './shell-integration-preferences'
import type { StickyNoteWallpaperAppearances } from './sticky-note-glass-appearance'
import type { StickyNoteMaterialEffects } from './sticky-note-material-effects'
import type { ArknotePreferences, ArknotePreferencesUpdate } from './arknote-preferences'
import type {
  AiConversationSettings,
  CodexCliConnectionTestResult,
  LargeModelSettings,
  ModelConnectionSummary,
} from './large-model-settings'
import type {
  AiConversationCapabilities,
  AiConversationEvent,
  CancelAiConversationInput,
  StartAiConversationInput,
} from './ai-conversation'
import type { ScreenshotOcrModelState } from './screenshot-ocr-models'
import type {
  ConvertedDocument,
  DocumentConversionComponentState,
} from './document-conversion'
import type {
  WorkspaceColorId,
  WorkspaceColorMarksSnapshot,
} from './workspace-color-marks'
import type {
  StartTranslationInput,
  TranslationEvent,
  TranslationStarted,
} from './selection-translation'
import type {
  ScreenshotCaptureCommitInput,
  ScreenshotCaptureEvent,
  ScreenshotCapturePointerInput,
  ScreenshotSessionInput,
  ScreenshotTranslationEvent,
  ScreenshotTranslationGenerationInput,
  ScreenshotWindowHighlight,
} from './screenshot-translation'
import type {
  CreateStickyNoteInput,
  StickyNoteDocument,
  StickyNoteReadDocument,
  StickyNoteContentMeasurement,
  StickyNoteEvent,
  StickyNoteImportResult,
  StickyNoteSelectionImportInput,
  StickyNoteRecord,
  StickyNoteSaveState,
  StickyNoteSearchResult,
  StickyNoteStatus,
  StickyNoteStyleReference,
  StickyNoteSummary,
  StickyNotePreferences,
  StickyNoteLineSpacingMode,
} from './sticky-notes'
import type {
  BackgroundPresentation,
  BackgroundSettings,
  BackgroundTarget,
} from './background-settings'

export type {
  CreateStickyNoteInput,
  StickyNoteDocument,
  StickyNoteContentMeasurement,
  StickyNoteEvent,
  StickyNoteImportResult,
  StickyNoteImportWarning,
  StickyNoteSelectionImportInput,
  StickyNoteSelectionResource,
  StickyNoteIndex,
  StickyNoteRecord,
  StickyNoteSaveState,
  StickyNoteSearchInput,
  StickyNoteSearchResult,
  StickyNoteStatus,
  StickyNoteStyleReference,
  StickyNoteSummary,
  StickyNotePreferences,
  StickyNoteWindowBounds,
} from './sticky-notes'
export type {
  BackgroundPresentation,
  BackgroundSettings,
  BackgroundTarget,
} from './background-settings'

export interface WorkspaceSummary {
  name: string
  absolutePath: string
}

export interface WorkspaceFileDragInput {
  workspace: string
  relativePath: string
}

export interface TreeEntry {
  name: string
  relativePath: string
  kind: 'directory' | 'document'
}

export type DocumentEncoding = 'utf8' | 'utf8-bom'
export interface WorkspaceEntryProperties {
  name: string
  relativePath: string
  absolutePath: string
  kind: 'directory' | 'document'
  size: number
  createdAt: string
  modifiedAt: string
  itemCount: number | null
}

export type NewlineStyle = 'lf' | 'crlf'

export interface DocumentSnapshot {
  relativePath: string
  markdown: string
  revision: string
  encoding: DocumentEncoding
  newline: NewlineStyle
  mtimeMs: number
}

export interface PreparedDroppedPathResult extends DroppedPathResult {
  token: string
}

export interface DroppedPathResult {
  workspace: WorkspaceSummary
  document: DocumentSnapshot | null
}

export interface ImportedAsset {
  assetId: string
  category: 'image' | 'audio' | 'video' | 'pdf' | 'attachment'
  fileName: string
  relativePath: string
  previewUrl: string
  markdown: string
}

export interface ImportedDocx {
  sourceAbsolutePath: string
  sourceFileName: string
  markdown: string
}

export interface WorkspaceEntryRenameResult {
  entry: TreeEntry
  colorMarks: WorkspaceColorMarksSnapshot
}

export interface WorkspaceEntryTrashResult {
  colorMarks: WorkspaceColorMarksSnapshot
}

export interface ExportDocxInput {
  documentSessionId: string
  markdown: string
  mode: 'choose' | 'reuse'
  suggestedBaseName: string
}

export interface ExportDocxResult {
  fileName: string
  reusedTarget: boolean
}

export interface ExportXlsxInput {
  markdown: string
  suggestedBaseName: string
}

export interface ExportXlsxResult {
  fileName: string
}

export interface ClipboardFormatsSnapshot {
  plainText: string
  markdown: string | null
  html: string | null
}

export type ClipboardImageTarget = { draftId: string } | { noteId: string }

export type { MermaidViewerSnapshot } from './mermaid-viewer'

export interface MermaidImageExportInput {
  svgDataUrl: string
  pngDataUrl: string
}

export interface ImportDocxIntent {
  workspace: WorkspaceSummary
  imported: ImportedDocx
}

export interface SaveDraftInput {
  draftId: string
  markdown: string
  expectedOriginalRevision: string | null
  encoding: DocumentEncoding
  newline: NewlineStyle
}

export interface SaveDocumentAsInput {
  draftId: string
  markdown: string
  encoding: DocumentEncoding
  newline: NewlineStyle
  suggestedFileName?: string
}

export interface BeginSaveDocumentAsResult {
  intentId: string
  targetWorkspace: WorkspaceSummary
  targetFileName: string
  targetRelativePath: string
  changesWorkspace: boolean
}

export interface CommitSaveDocumentAsResult extends Omit<DroppedPathResult, 'document'> {
  document: DocumentSnapshot
  changesWorkspace: boolean
  draftEndPending?: true
  aiWorkspace: {
    workspaceId: string
    workspaceGeneration: string
  }
}

export interface DraftSummary {
  draftId: string
  originalAbsolutePath: string | null
  workspaceAbsolutePath: string | null
  originalRevision: string | null
  originalMtimeMs: number | null
  encoding: DocumentEncoding
  newline: NewlineStyle
  updatedAt: string
  ignoredAt: string | null
}

export interface RecoveredDraft {
  manifest: DraftSummary
  markdown: string
}

export interface RecoveryIntent extends RecoveredDraft {
  draftId: string
}

export interface SaveDocumentInput {
  relativePath: string
  markdown: string
  expectedRevision: string
  encoding: DocumentEncoding
  newline: NewlineStyle
}

export interface SaveDocumentResult {
  revision: string
  mtimeMs: number
  markdown?: string
  clipboardAssetsRetained?: true
  draftEndPending?: true
}

export interface ApiError {
  code: string
  message: string
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError }

export interface BackgroundPresentationEvent {
  target: BackgroundTarget
  presentation: BackgroundPresentation
  phase: 'preview' | 'applied' | 'restore'
}

export interface DroppedPathInspection {
  kind: 'file' | 'directory'
  absolutePath: string
}

export type WindowControlAction =
  | 'minimize'
  | 'toggle-maximize'
  | 'toggle-fullscreen'
  | 'exit-fullscreen'
  | 'close'
export interface WindowState {
  maximized: boolean
  fullscreen: boolean
}

export interface WindowStateSnapshot extends WindowState {
  revision: number
}

export const IPC_CHANNELS = Object.freeze({
  getAppUpdateState: 'app-update:get-state',
  notifyUpdateAbout: 'app-update:about',
  openUpdateWebsite: 'app-update:open-website',
  requestRequiredUpdateExit: 'app-update:exit',
  protectUpdateWork: 'app-update:protect',
  performUpdateAction: 'app-update:action',
  chooseWorkspace: 'workspace:choose',
  claimWorkspaceIntroduction: 'workspace:claim-introduction',
  restoreWorkspace: 'workspace:restore',
  listDirectory: 'workspace:list',
  startWorkspaceFileDrag: 'workspace:start-file-drag',
  inspectDroppedPath: 'workspace:inspect-dropped',
  openDroppedPath: 'workspace:open-dropped',
  prepareDroppedPath: 'workspace:prepare-dropped',
  settleDroppedPath: 'workspace:settle-dropped',
  createDocument: 'document:create',
  readDocument: 'document:read',
  peekDocument: 'document:peek',
  saveDocument: 'document:save',
  beginSaveDocumentAs: 'document:save-as:begin',
  commitSaveDocumentAs: 'document:save-as:commit',
  abortSaveDocumentAs: 'document:save-as:abort',
  retryDraftFinalization: 'draft:retry-finalization',
  saveDraft: 'draft:save',
  listRecoverableDrafts: 'draft:list-recoverable',
  readDraft: 'draft:read',
  claimRecoveredDraft: 'draft:claim-recovered',
  cleanDraft: 'draft:clean',
  releaseDraftRecovery: 'draft:release-recovery',
  ignoreDraft: 'draft:ignore',
  discardDraft: 'draft:discard',
  revealDocument: 'document:reveal',
  trashDocument: 'document:trash',
  importDocx: 'docx:import',
  exportDocx: 'docx:export',
  exportXlsx: 'xlsx:export',
  readClipboardFormats: 'clipboard:read-formats',
  pasteClipboardImage: 'clipboard:paste-image',
  importAsset: 'asset:import',
  openAsset: 'asset:open',
  openDocumentWindow: 'window:open-document',
  navigateDocumentView: 'document-view:navigate',
  refreshDocumentView: 'document-view:refresh',
  inspectDocumentView: 'document-view:inspect',
  openDocumentView: 'document-view:open',
  revealLocalFileLink: 'document-view:reveal-local-link',
  controlWindow: 'window:control',
  getWindowState: 'window:get-state',
  getDocumentConversionComponentState: 'document-conversion:get-component-state',
  installDocumentConversionComponent: 'document-conversion:install-component',
  cancelDocumentConversionComponentInstall: 'document-conversion:cancel-component-install',
  removeDocumentConversionComponent: 'document-conversion:remove-component',
  convertWorkspaceDocument: 'document-conversion:convert-workspace-document',
  cancelWorkspaceDocumentConversion: 'document-conversion:cancel-workspace-document',
  getSearchPreferences: 'settings:get-search',
  getPreferenceSnapshot: 'settings:get-preference-snapshot',
  patchPreferences: 'settings:patch-preferences',
  getKeyboardShortcuts: 'settings:get-shortcuts',
  updateKeyboardShortcuts: 'settings:update-shortcuts',
  setShortcutRecording: 'settings:shortcut-recording',
  setSearchPreferences: 'settings:set-search',
  getEditorAppearancePreferences: 'settings:get-editor-appearance',
  setEditorAppearancePreferences: 'settings:set-editor-appearance',
  compareAndSetEditorAppearancePreferences: 'settings:compare-and-set-editor-appearance',
  getLayoutPreferences: 'settings:get-layout',
  compareAndSetLayoutPreferences: 'settings:compare-and-set-layout',
  getStickyNotePreferences: 'settings:get-sticky-notes',
  setStickyNotePreferences: 'settings:set-sticky-notes',
  getDesktopLifecyclePreferences: 'settings:get-desktop-lifecycle',
  getDefaultApplicationsStatus: 'settings:get-default-applications-status',
  openDefaultApplicationsSettings: 'settings:open-default-applications',
  setDefaultApplicationsEnabled: 'settings:set-default-applications-enabled',
  getShellIntegrationPreferences: 'settings:get-shell-integration',
  updateShellIntegrationPreference: 'settings:update-shell-integration',
  setDesktopLifecyclePreferences: 'settings:set-desktop-lifecycle',
  getArknotePreferences: 'arknote-settings:get',
  setArknotePreferences: 'arknote-settings:set',
  previewStickyNoteWallpaperAppearances: 'arknote-settings:preview-wallpaper-appearances',
  getSystemFonts: 'settings:get-system-fonts',
  previewArknoteThemeColor: 'arknote-settings:preview-theme',
  getLargeModelSettings: 'models:get-settings',
  getModelSettingsSnapshot: 'models:get-settings-snapshot',
  getModelCapabilityRules: 'models:get-capability-rules',
  setModelCapabilityRules: 'models:set-capability-rules',
  connectModel: 'models:connect',
  listModels: 'models:list',
  testModel: 'models:test',
  deleteModel: 'models:delete',
  setAiConversationSettings: 'models:set-ai-conversation',
  testCodexCliConnection: 'models:codex-cli-test',
  startCodexCliLogin: 'models:codex-cli-login-start',
  cancelCodexCliLogin: 'models:codex-cli-login-cancel',
  removeCodexCliConnection: 'models:codex-cli-remove',
  setSelectionTranslationSettings: 'models:set-selection-translation',
  setScreenshotTranslationSettings: 'models:set-screenshot-translation',
  setFloatingTranslationSettings: 'models:set-floating-translation',
  startAiConversation: 'ai-conversation:start',
  cancelAiConversation: 'ai-conversation:cancel',
  getAiWorkspaceState: 'ai-conversation:get-workspace-state',
  setAiConversationCapabilities: 'ai-conversation:set-capabilities',
  submitAiAuthorizationResult: 'ai-conversation:authorization-result',
  clearAiConversation: 'ai-conversation:clear',
  notifyAiCurrentDocumentChanged: 'ai-conversation:current-document-changed',
  registerAiCurrentDocumentPort: 'ai-conversation:current-document-port-register',
  unregisterAiCurrentDocumentPort: 'ai-conversation:current-document-port-unregister',
  submitAiCurrentDocumentPortResponse: 'ai-conversation:current-document-port-response',
  registerAiOpenDocumentPort: 'ai-conversation:open-document-port-register',
  unregisterAiOpenDocumentPort: 'ai-conversation:open-document-port-unregister',
  submitAiOpenDocumentPortResponse: 'ai-conversation:open-document-port-response',
  openAiMessageLink: 'ai-conversation:open-message-link',
  aiRendererPortRequest: 'ai-conversation:renderer-port-request',
  beginScreenshotTranslation: 'screenshot-translation:begin',
  updateScreenshotCapturePointer: 'screenshot-translation:capture-pointer',
  readyScreenshotCapture: 'screenshot-translation:capture-ready',
  commitScreenshotCapture: 'screenshot-translation:capture-commit',
  cancelScreenshotCapture: 'screenshot-translation:capture-cancel',
  submitScreenshotOcr: 'screenshot-translation:ocr-submit',
  settleScreenshotOcr: 'screenshot-translation:ocr-settled',
  startScreenshotTranslation: 'screenshot-translation:start',
  cancelScreenshotTranslation: 'screenshot-translation:cancel',
  minimizeScreenshotTranslation: 'screenshot-translation:minimize',
  closeScreenshotTranslation: 'screenshot-translation:close',
  openScreenshotTranslationSettings: 'screenshot-translation:open-settings',
  acceptTranslationPrivacyNotice: 'models:accept-privacy-notice',
  startTranslation: 'translation:start',
  cancelTranslation: 'translation:cancel',
  searchSelection: 'search:selection',
  openExternal: 'external:open-link',
  revealImage: 'image:reveal',
  copyImage: 'image:copy',
  saveImageCopy: 'image:save-copy',
  copyImageTo: 'image:copy-to',
  copyMermaidImage: 'mermaid-image:copy',
  openMermaidViewer: 'mermaid-viewer:open',
  getMermaidViewerSnapshot: 'mermaid-viewer:get',
  saveMermaidImage: 'mermaid-image:save',
  createWorkspaceFolder: 'workspace:create-folder',
  renameWorkspaceEntry: 'workspace:rename-entry',
  duplicateWorkspaceDocument: 'workspace:duplicate-document',
  trashWorkspaceEntry: 'workspace:trash-entry',
  revealWorkspaceEntry: 'workspace:reveal-entry',
  openWorkspaceEntryWindow: 'workspace:open-window',
  getWorkspaceEntryProperties: 'workspace:entry-properties',
  getWorkspaceRootProperties: 'workspace:root-properties',
  getWorkspaceColorMarks: 'workspace:get-color-marks',
  setWorkspaceColorMark: 'workspace:set-color-mark',
  moveWorkspaceColorMark: 'workspace:move-color-mark',
  deleteWorkspaceColorMarks: 'workspace:delete-color-marks',
  openApplicationMenu: 'menu:open-section',
  executeApplicationMenuItem: 'menu:execute-item',
  recordRecentDocument: 'recent-documents:record',
  updateApplicationMenuWindowState: 'menu:update-window-state',
  printDocument: 'print:document',
  takePrintDocument: 'print:take-document',
  readyPrintDocument: 'print:ready',
  connectArknote: 'arknote:connect',
  listStickyNotes: 'sticky-note:list',
  reorderStickyNotes: 'sticky-note:reorder',
  searchStickyNotes: 'sticky-note:search',
  readStickyNote: 'sticky-note:read',
  createStickyNote: 'sticky-note:create',
  renameStickyNote: 'sticky-note:rename',
  archiveStickyNote: 'sticky-note:archive',
  restoreStickyNote: 'sticky-note:restore',
  restoreArchivedStickyNotes: 'sticky-note:restore-archived-batch',
  deleteStickyNote: 'sticky-note:delete',
  deleteArchivedStickyNotes: 'sticky-note:delete-archived-batch',
  importStickyNote: 'sticky-note:import',
  importStickyNoteSelection: 'sticky-note:import-selection',
  stageStickyNoteSave: 'sticky-note:stage-save',
  flushStickyNoteSave: 'sticky-note:flush-save',
  openStickyNote: 'sticky-note:open-window',
  closeStickyNote: 'sticky-note:close-window',
  releaseStickyNote: 'sticky-note:release',
  reclaimStickyNote: 'sticky-note:reclaim',
  setStickyNotePinned: 'sticky-note:set-pinned',
  setStickyNoteStyle: 'sticky-note:set-style',
  setStickyNoteFontSize: 'sticky-note:set-font-size',
  setStickyNoteLineSpacingMode: 'sticky-note:set-line-spacing-mode',
  chooseStickyNoteImage: 'sticky-note:choose-image',
  copyStickyNoteImage: 'sticky-note:copy-image',
  resizeStickyNoteToContent: 'sticky-note:resize-to-content',
  openBackgroundSettings: 'background:open-settings',
  getBackgroundPresentation: 'background:get-presentation',
  chooseBackgroundImage: 'background:choose-image',
  removeBackgroundImage: 'background:remove-image',
  previewBackground: 'background:preview',
  applyBackground: 'background:apply',
  cancelBackgroundSettings: 'background:cancel-settings',
} as const)

export const BACKGROUND_PRESENTATION_CHANNEL = 'background:presentation'

export const DOCUMENT_CONVERSION_IPC_CHANNELS = Object.freeze([
  IPC_CHANNELS.getDocumentConversionComponentState,
  IPC_CHANNELS.installDocumentConversionComponent,
  IPC_CHANNELS.cancelDocumentConversionComponentInstall,
  IPC_CHANNELS.removeDocumentConversionComponent,
  IPC_CHANNELS.convertWorkspaceDocument,
  IPC_CHANNELS.cancelWorkspaceDocumentConversion,
] as const)

export const SCREENSHOT_OCR_MODEL_CHANNELS = Object.freeze({
  getState: 'screenshot-ocr:get-model-state',
  downloadMedium: 'screenshot-ocr:download-medium',
  cancelMediumDownload: 'screenshot-ocr:cancel-medium-download',
  removeMedium: 'screenshot-ocr:remove-medium',
} as const)

export const TRANSLATION_EVENT_CHANNEL = 'translation:event'
export const SCREENSHOT_CAPTURE_EVENT_CHANNEL = 'screenshot-translation:capture-event'
export const SCREENSHOT_TRANSLATION_EVENT_CHANNEL = 'screenshot-translation:event'
export const AI_CONVERSATION_EVENT_CHANNEL = 'ai-conversation:event'
export const SCREENSHOT_OCR_HOST_EVENT_CHANNEL = 'screenshot-translation:ocr-host'
export const SCREENSHOT_OCR_MODEL_STATE_CHANNEL = 'screenshot-ocr:model-state'
export const STICKY_NOTE_EVENT_CHANNEL = 'sticky-note:event'
export const APPLICATION_MENU_CHANGED_CHANNEL = 'menu:application-model-changed'
export const EDITOR_APPEARANCE_CHANGED_CHANNEL = 'settings:editor-appearance-changed'
export const LAYOUT_PREFERENCES_CHANGED_CHANNEL = 'settings:layout-changed'
export const WINDOW_STATE_CHANGED_CHANNEL = 'window:state-changed'
export const DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL = 'document-conversion:component-state'

export const WINDOW_CHANNELS = Object.freeze({
  documentLocation: 'window:document-location',
  openIntent: 'window:open-intent',
  importDocx: 'window:import-docx',
  recoverDraft: 'window:recover-draft',
} as const)

export const CLOSE_CHANNELS = Object.freeze({
  prepare: 'app:prepare-close',
  heartbeat: 'app:prepare-close-heartbeat',
  response: 'app:prepare-close-response',
} as const)

export interface ClosePreparationRequest {
  requestId: string
}

export type ClosePreparationHeartbeat = ClosePreparationRequest

export interface ClosePreparationResponse extends ClosePreparationRequest {
  ok: boolean
}

export interface AiWorkspaceState {
  readonly workspaceId: string
  readonly workspaceGeneration: string
}

export interface SetAiConversationCapabilitiesInput extends AiWorkspaceState {
  readonly conversationId: string
  readonly capabilities: AiConversationCapabilities
}

export interface SubmitAiAuthorizationResultInput {
  readonly requestId: string
  readonly operationId: string
  readonly allowed: boolean
}

export interface ClearAiConversationInput extends AiWorkspaceState {
  readonly conversationId: string
}

export interface AiCurrentDocumentOpenPortInput {
  readonly expectedDocumentId?: string
  readonly cursor: 0
  readonly maxChars: number
}

export interface AiCurrentDocumentReadPortInput {
  readonly snapshotId: string
  readonly cursor: number
  readonly maxChars: number
}

export interface AiCurrentDocumentReleasePortInput {
  readonly snapshotId: string
}

export type AiCurrentDocumentOpenPortResult =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{
      status: 'captured'
      snapshotId: string
      displayName: string
      sourceFormat: string
      dirty: boolean
      content: string
      nextCursor: number | null
      hasMore: boolean
      totalChars: number
    }>

export type AiCurrentDocumentReadPortResult =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<Omit<Extract<AiCurrentDocumentOpenPortResult, { status: 'captured' }>, 'snapshotId'>>

export interface AiCurrentDocumentRendererPort {
  openSnapshot(input: Readonly<AiCurrentDocumentOpenPortInput>): Promise<AiCurrentDocumentOpenPortResult>
  readPage(input: Readonly<AiCurrentDocumentReadPortInput>): Promise<AiCurrentDocumentReadPortResult>
  release(input: Readonly<AiCurrentDocumentReleasePortInput>): void | Promise<void>
}

export type AiOpenDocumentCaptureResult =
  | Readonly<{ status: 'stale' | 'unavailable' }>
  | Readonly<{
      status: 'captured'
      editorRevision: number
      contentHash: string
      markdown: string
      dirty: boolean
    }>
export type AiOpenDocumentPlanResult =
  | Readonly<{ status: 'stale' | 'unavailable' }>
  | Readonly<{
      status: 'planned'
      editorRevision: number
      contentHash: string
    }>
export type AiOpenDocumentApplyResult =
  | Readonly<{ status: 'stale' | 'unknown' }>
  | Readonly<{
      status: 'applied'
      editorRevision: number
      contentHash: string
      dirty: boolean
    }>
export type AiOpenDocumentQueryResult =
  | AiOpenDocumentApplyResult
  | Readonly<{ status: 'not-applied' | 'unavailable' }>

export interface AiOpenDocumentRendererPort {
  captureReadSnapshot(input: Readonly<Record<string, never>>): Promise<AiOpenDocumentCaptureResult>
  planReplacement(input: Readonly<{
    operationId: string
    expectedEditorRevision: number
    expectedContentHash: string
    replacementMarkdown: string
  }>): Promise<AiOpenDocumentPlanResult>
  applyTransaction(input: Readonly<{
    operationId: string
    expectedEditorRevision: number
    expectedContentHash: string
    replacementMarkdown: string
  }>): Promise<AiOpenDocumentApplyResult>
  queryOutcome(input: Readonly<{
    operationId: string
    expectedEditorRevision: number
    expectedContentHash: string
    replacementContentHash: string
  }>): Promise<AiOpenDocumentQueryResult>
}

export type AiRendererPortRequestEnvelope = Readonly<{
  readonly transportRequestId: string
  readonly method: 'openSnapshot' | 'readPage' | 'release'
  readonly payload: Readonly<Record<string, unknown>>
}> | Readonly<{
  readonly transportRequestId: string
  readonly documentHandle: string
  readonly method: 'captureReadSnapshot' | 'planReplacement' | 'applyTransaction' | 'queryOutcome'
  readonly payload: Readonly<Record<string, unknown>>
}>

export interface ArkdownApi {
  getAppUpdateState?(): Promise<ApiResult<import('./app-update').UpdateSnapshot>>
  onAppUpdateChanged?(listener: (state: import('./app-update').UpdateSnapshot) => void): () => void
  notifyUpdateAbout?(input: { interactionId: string; open: boolean }): Promise<ApiResult<null>>
  openUpdateWebsite?(): Promise<ApiResult<boolean>>
  requestRequiredUpdateExit?(): Promise<ApiResult<null>>
  protectUpdateWork?(): Promise<ApiResult<null>>
  performUpdateAction?(action: import('./update-transfer').UpdateAction): Promise<ApiResult<null>>
  chooseWorkspace(): Promise<ApiResult<WorkspaceSummary | null>>
  claimWorkspaceIntroduction?(legacySeen: boolean): Promise<ApiResult<{ showIntroduction: boolean }>>
  restoreWorkspace(): Promise<ApiResult<WorkspaceSummary | null>>
  listDirectory(relativePath: string): Promise<ApiResult<TreeEntry[]>>
  startWorkspaceFileDrag?(input: WorkspaceFileDragInput): Promise<ApiResult<void>>
  inspectDroppedPath?(absolutePath: string, resolveDocumentShortcut?: boolean): Promise<ApiResult<DroppedPathInspection>>
  openDroppedPath(absolutePath: string): Promise<ApiResult<DroppedPathResult>>
  prepareDroppedPath?(absolutePath: string): Promise<ApiResult<PreparedDroppedPathResult>>
  settleDroppedPath?(token: string, accept: boolean): Promise<ApiResult<DroppedPathResult | null>>
  pathForDroppedFile(file: File): string
  createDocument(relativePath: string): Promise<ApiResult<DocumentSnapshot>>
  readDocument(relativePath: string): Promise<ApiResult<DocumentSnapshot>>
  peekDocument(relativePath: string): Promise<ApiResult<DocumentSnapshot>>
  saveDocument(input: SaveDocumentInput): Promise<ApiResult<SaveDocumentResult>>
  beginSaveDocumentAs?(input: SaveDocumentAsInput): Promise<ApiResult<BeginSaveDocumentAsResult | null>>
  commitSaveDocumentAs?(intentId: string): Promise<ApiResult<CommitSaveDocumentAsResult>>
  abortSaveDocumentAs?(intentId: string): Promise<ApiResult<null>>
  retryDraftFinalization?(): Promise<ApiResult<null>>
  saveDraft?(input: SaveDraftInput): Promise<ApiResult<DraftSummary>>
  listRecoverableDrafts?(): Promise<ApiResult<DraftSummary[]>>
  readDraft?(draftId: string): Promise<ApiResult<RecoveredDraft | null>>
  claimRecoveredDraft?(draftId: string): Promise<ApiResult<RecoveredDraft | null>>
  cleanDraft?(draftId: string): Promise<ApiResult<null>>
  releaseDraftRecovery?(draftId: string): Promise<ApiResult<null>>
  ignoreDraft?(draftId: string): Promise<ApiResult<null>>
  discardDraft?(draftId: string): Promise<ApiResult<null>>
  revealDocument(relativePath: string): Promise<ApiResult<null>>
  trashDocument(relativePath: string): Promise<ApiResult<null>>
  importDocx?(relativePath: string): Promise<ApiResult<ImportedDocx>>
  exportDocx?(input: ExportDocxInput): Promise<ApiResult<ExportDocxResult | null>>
  exportXlsx?(input: ExportXlsxInput): Promise<ApiResult<ExportXlsxResult | null>>
  readClipboardFormats?(): Promise<ApiResult<ClipboardFormatsSnapshot>>
  pasteClipboardImage?(target: ClipboardImageTarget): Promise<ApiResult<string | null>>
  importAsset?(absolutePath: string, draftId?: string): Promise<ApiResult<ImportedAsset>>
  openAsset?(url: string): Promise<ApiResult<null>>
  openDocumentWindow?(absolutePath: string): Promise<ApiResult<null>>
  navigateDocumentView?(input: DocumentViewRequest): Promise<ApiResult<DocumentViewResult>>
  refreshDocumentView?(id: string): Promise<ApiResult<DocumentViewSnapshot>>
  inspectDocumentView?(id: string): Promise<ApiResult<{ changed: boolean; exists: boolean }>>
  openDocumentView?(id: string): Promise<ApiResult<null>>
  revealLocalFileLink?(input: LocalFileRevealRequest): Promise<ApiResult<null>>
  controlWindow?(action: WindowControlAction): Promise<ApiResult<WindowStateSnapshot>>
  getWindowState?(): Promise<ApiResult<WindowStateSnapshot>>
  onWindowStateChanged(listener: (state: WindowStateSnapshot) => void): () => void
  getDocumentConversionComponentState?(): Promise<ApiResult<DocumentConversionComponentState>>
  installDocumentConversionComponent?(
    requestId: string,
  ): Promise<ApiResult<DocumentConversionComponentState>>
  cancelDocumentConversionComponentInstall?(requestId: string): Promise<ApiResult<null>>
  removeDocumentConversionComponent?(): Promise<ApiResult<DocumentConversionComponentState>>
  convertWorkspaceDocument?(
    relativePath: string,
    requestId: string,
  ): Promise<ApiResult<ConvertedDocument>>
  cancelWorkspaceDocumentConversion?(requestId: string): Promise<ApiResult<null>>
  onDocumentConversionComponentState?(
    listener: (state: DocumentConversionComponentState) => void,
  ): () => void
  createWorkspaceFolder?(parentRelativePath: string, name: string): Promise<ApiResult<TreeEntry>>
  renameWorkspaceEntry?(
    relativePath: string,
    newName: string,
  ): Promise<ApiResult<WorkspaceEntryRenameResult>>
  duplicateWorkspaceDocument?(relativePath: string): Promise<ApiResult<TreeEntry>>
  trashWorkspaceEntry?(relativePath: string): Promise<ApiResult<WorkspaceEntryTrashResult>>
  revealWorkspaceEntry?(relativePath: string): Promise<ApiResult<null>>
  openWorkspaceEntryWindow?(relativePath: string): Promise<ApiResult<null>>
  getWorkspaceEntryProperties?(
    relativePath: string,
  ): Promise<ApiResult<WorkspaceEntryProperties>>
  getWorkspaceRootProperties?(): Promise<ApiResult<WorkspaceEntryProperties>>
  getWorkspaceColorMarks?(): Promise<ApiResult<WorkspaceColorMarksSnapshot>>
  setWorkspaceColorMark?(
    relativePath: string,
    color: WorkspaceColorId | null,
  ): Promise<ApiResult<WorkspaceColorMarksSnapshot>>
  moveWorkspaceColorMark?(
    fromRelativePath: string,
    toRelativePath: string,
  ): Promise<ApiResult<WorkspaceColorMarksSnapshot>>
  deleteWorkspaceColorMarks?(
    relativePath: string,
  ): Promise<ApiResult<WorkspaceColorMarksSnapshot>>
  openApplicationMenu?(
    section: import('./app-menu-definition').AppMenuSectionId,
    x: number,
    y: number,
  ): Promise<ApiResult<null>>
  executeApplicationMenuItem?(itemId: string): Promise<ApiResult<null>>
  recordRecentDocument(absolutePath: string): Promise<ApiResult<readonly string[]>>
  updateApplicationMenuWindowState(
    state: ApplicationMenuWindowState,
  ): Promise<ApiResult<void>>
  onApplicationMenuChanged(
    listener: (model: readonly ApplicationMenuSection[]) => void,
  ): () => void
  printDocument(input: PrintDocumentInput): Promise<ApiResult<null>>
  takePrintDocument(token: string): Promise<ApiResult<PrintSurfaceDocumentInput>>
  readyPrintDocument(token: string): Promise<ApiResult<null>>
  getSearchPreferences?(): Promise<ApiResult<BrowserSearchPreferences>>
  getPreferenceSnapshot?(group: PreferenceGroup): Promise<ApiResult<PublicPreferenceSnapshot>>
  patchPreferences?(input: PreferencePatchInput): Promise<ApiResult<PublicPreferenceMutation>>
  getKeyboardShortcuts?(): Promise<ApiResult<ObservedShortcutSnapshot>>
  updateKeyboardShortcuts?(update: ObservedShortcutUpdate): Promise<ApiResult<ObservedShortcutUpdateResult>>
  setShortcutRecording?(active: boolean): Promise<ApiResult<null>>
  onKeyboardShortcutsChanged?(handler: (snapshot: ObservedShortcutSnapshot) => void): () => void
  setSearchPreferences?(preferences: BrowserSearchPreferences): Promise<ApiResult<BrowserSearchPreferences>>
  getEditorAppearancePreferences?(): Promise<ApiResult<EditorAppearanceSnapshot>>
  setEditorAppearancePreferences?(
    preferences: EditorAppearancePreferences,
  ): Promise<ApiResult<EditorAppearanceSnapshot>>
  compareAndSetEditorAppearancePreferences?(
    expectedRevision: number,
    expected: EditorAppearancePreferences,
    replacement: EditorAppearancePreferences,
  ): Promise<ApiResult<EditorAppearanceSnapshot>>
  onEditorAppearancePreferencesChanged?(
    listener: (snapshot: EditorAppearanceSnapshot) => void,
  ): () => void
  getLayoutPreferences?(): Promise<ApiResult<LayoutPreferencesSnapshot>>
  compareAndSetLayoutPreferences?(
    expectedRevision: number,
    expected: LayoutPreferences,
    replacement: LayoutPreferences,
  ): Promise<ApiResult<{ applied: boolean; snapshot: LayoutPreferencesSnapshot }>>
  onLayoutPreferencesChanged?(
    listener: (snapshot: LayoutPreferencesSnapshot) => void,
  ): () => void
  openBackgroundSettings(target: BackgroundTarget): Promise<ApiResult<null>>
  getBackgroundPresentation(target: BackgroundTarget): Promise<ApiResult<BackgroundPresentation>>
  chooseBackgroundImage(target: BackgroundTarget): Promise<ApiResult<BackgroundPresentation | null>>
  removeBackgroundImage(target: BackgroundTarget): Promise<ApiResult<BackgroundPresentation>>
  previewBackground(target: BackgroundTarget, settings: BackgroundSettings): Promise<ApiResult<null>>
  applyBackground(target: BackgroundTarget, settings: BackgroundSettings): Promise<ApiResult<import('./background-settings').BackgroundApplyResult>>
  cancelBackgroundSettings(target: BackgroundTarget): Promise<ApiResult<null>>
  onBackgroundPresentation(listener: (event: BackgroundPresentationEvent) => void): () => void
  getStickyNotePreferences?(): Promise<ApiResult<StickyNotePreferences>>
  setStickyNotePreferences?(
    preferences: StickyNotePreferences,
  ): Promise<ApiResult<StickyNotePreferences>>
  getDesktopLifecyclePreferences?(): Promise<ApiResult<DesktopLifecyclePreferences>>
  getDefaultApplicationsStatus?(): Promise<ApiResult<import('./default-applications').DefaultApplicationsStatus>>
  openDefaultApplicationsSettings?(): Promise<ApiResult<null>>
  setDefaultApplicationsEnabled?(enabled: boolean): Promise<ApiResult<import('./default-applications').DefaultApplicationsStatus>>
  getShellIntegrationPreferences?(): Promise<ApiResult<ShellIntegrationSnapshot>>
  updateShellIntegrationPreference?(update: ObservedShellIntegrationUpdate): Promise<ApiResult<ShellIntegrationSnapshot>>
  setDesktopLifecyclePreferences?(
    preferences: DesktopLifecyclePreferences,
  ): Promise<ApiResult<DesktopLifecyclePreferences>>
  previewStickyNoteWallpaperAppearances?(appearances: StickyNoteWallpaperAppearances | null): Promise<ApiResult<StickyNoteWallpaperAppearances>>
  onStickyNoteMaterialEffectsChanged?(handler: (effects: StickyNoteMaterialEffects) => void): () => void
  getArknotePreferences?(): Promise<ApiResult<ArknotePreferences>>
  setArknotePreferences?(
    preferences: ArknotePreferencesUpdate,
  ): Promise<ApiResult<ArknotePreferences>>
  getSystemFonts?(): Promise<ApiResult<string[]>>
  previewArknoteThemeColor?(
    themeColor: string,
  ): Promise<ApiResult<null>>
  onArknoteThemeColorChanged?(handler: (themeColor: string) => void): () => void
  getModelCapabilityRules?(): Promise<ApiResult<import('./model-capability-rules-state').ModelCapabilityRulesState>>
  setModelCapabilityRules?(rules: import('./model-capability-rules').RuleFile | null): Promise<ApiResult<import('./model-capability-rules-state').ModelCapabilityRulesState>>
  onModelCapabilityRulesChanged?(listener: (state: import('./model-capability-rules-state').ModelCapabilityRulesState) => void): () => void
  getLargeModelSettings(): Promise<ApiResult<LargeModelSettings>>
  getModelSettingsSnapshot(): Promise<ApiResult<PublicModelSettingsSnapshot>>
  connectModel(
    input: import('../main/models/model-connection-service').ConnectModelInput,
    observed: PublicModelSettingsSnapshot,
  ): Promise<ApiResult<PublicModelMutationResult>>
  listModels(
    input: import('../main/models/model-connection-service').ListModelsInput,
    observed: PublicModelSettingsSnapshot,
  ): Promise<ApiResult<
    import('../main/models/transactional-model-connection-service').ModelCatalogRead
  >>
  testModel(connectionId: string, observed: PublicModelSettingsSnapshot): Promise<ApiResult<ObservedModelTestResult>>
  deleteModel(connectionId: string, observed: PublicModelSettingsSnapshot): Promise<ApiResult<PublicModelMutationResult>>
  setAiConversationSettings(
    input: ModelFeaturePatches['aiConversation'], observed: PublicModelSettingsSnapshot,
  ): Promise<ApiResult<PublicModelMutationResult>>
  testCodexCliConnection(observed: PublicModelSettingsSnapshot): Promise<ApiResult<ObservedCodexTestResult>>
  startCodexCliLogin?(observed: PublicModelSettingsSnapshot): Promise<ApiResult<ObservedCodexLoginResult>>
  cancelCodexCliLogin?(): Promise<ApiResult<null>>
  removeCodexCliConnection(observed: PublicModelSettingsSnapshot): Promise<ApiResult<PublicModelMutationResult>>
  setSelectionTranslationSettings(
    input: ModelFeaturePatches['selectionTranslation'], observed: PublicModelSettingsSnapshot,
  ): Promise<ApiResult<PublicModelMutationResult>>
  setScreenshotTranslationSettings(
    input: ModelFeaturePatches['screenshotTranslation'], observed: PublicModelSettingsSnapshot,
  ): Promise<ApiResult<PublicModelMutationResult>>
  setFloatingTranslationSettings(
    input: ModelFeaturePatches['floatingTranslation'], observed: PublicModelSettingsSnapshot,
  ): Promise<ApiResult<PublicModelMutationResult>>
  acceptTranslationPrivacyNotice(observed: PublicModelSettingsSnapshot): Promise<ApiResult<PublicModelMutationResult>>
  startAiConversation(
    input: StartAiConversationInput,
  ): Promise<import('./ai-start-failure').AiConversationStartResult>
  cancelAiConversation(input: CancelAiConversationInput): Promise<ApiResult<null>>
  getAiWorkspaceState(): Promise<ApiResult<AiWorkspaceState>>
  setAiConversationCapabilities(input: SetAiConversationCapabilitiesInput): Promise<ApiResult<null>>
  submitAiAuthorizationResult(input: SubmitAiAuthorizationResultInput): Promise<ApiResult<null>>
  clearAiConversation(input: ClearAiConversationInput): Promise<ApiResult<null>>
  notifyAiCurrentDocumentChanged(input: AiWorkspaceState): Promise<ApiResult<null>>
  registerAiCurrentDocumentPort(
    port: AiCurrentDocumentRendererPort,
  ): Promise<ApiResult<{ portGeneration: number }>>
  unregisterAiCurrentDocumentPort(): Promise<ApiResult<null>>
  registerAiOpenDocumentPort(
    port: AiOpenDocumentRendererPort,
  ): Promise<ApiResult<{ documentHandle: string }>>
  unregisterAiOpenDocumentPort(documentHandle: string): Promise<ApiResult<null>>
  openAiMessageLink(target: string): Promise<ApiResult<string | null>>
  startTranslation(
    input: StartTranslationInput,
  ): Promise<ApiResult<TranslationStarted>>
  cancelTranslation(requestId: string): Promise<ApiResult<null>>
  onAiConversationEvent(
    listener: (event: AiConversationEvent) => void,
  ): () => void
  onTranslationEvent(
    handler: (event: TranslationEvent) => void,
  ): () => void
  updateScreenshotCapturePointer?(input: ScreenshotCapturePointerInput): Promise<ApiResult<ScreenshotWindowHighlight | null>>
  readyScreenshotCapture?(input: import('./screenshot-translation').ScreenshotCaptureReadyInput): Promise<ApiResult<null>>
  commitScreenshotCapture?(input: ScreenshotCaptureCommitInput): Promise<ApiResult<null>>
  cancelScreenshotCapture?(input: ScreenshotSessionInput): Promise<ApiResult<null>>
  onScreenshotCaptureEvent?(handler: (event: ScreenshotCaptureEvent) => void): () => void
  submitScreenshotOcr?(input: import('./screenshot-translation').ScreenshotOcrSubmission): Promise<ApiResult<null>>
  settleScreenshotOcr?(input: ScreenshotTranslationGenerationInput): Promise<ApiResult<null>>
  startScreenshotTranslation?(
    input: ScreenshotTranslationGenerationInput,
  ): Promise<ApiResult<ScreenshotTranslationGenerationInput>>
  cancelScreenshotTranslation?(input: ScreenshotTranslationGenerationInput): Promise<ApiResult<null>>
  minimizeScreenshotTranslation?(input: ScreenshotTranslationGenerationInput): Promise<ApiResult<null>>
  closeScreenshotTranslation?(input: ScreenshotTranslationGenerationInput): Promise<ApiResult<null>>
  openScreenshotTranslationSettings?(input: ScreenshotTranslationGenerationInput): Promise<ApiResult<null>>
  onScreenshotTranslationEvent?(handler: (event: ScreenshotTranslationEvent) => void): () => void
  onScreenshotOcrHostCommand?(
    handler: (command: import('./screenshot-translation').ScreenshotOcrHostCommand) => void,
  ): () => void
  getScreenshotOcrModelState?(): Promise<ApiResult<import('./screenshot-ocr-models').ObservedScreenshotOcrState>>
  downloadScreenshotOcrMedium?(observed: import('./screenshot-ocr-models').ObservedOcrPreference): Promise<ApiResult<import('./screenshot-ocr-models').ScreenshotOcrMutationResult>>
  cancelScreenshotOcrMediumDownload?(): Promise<ApiResult<ScreenshotOcrModelState>>
  removeScreenshotOcrMedium?(observed: import('./screenshot-ocr-models').ObservedOcrPreference): Promise<ApiResult<import('./screenshot-ocr-models').ScreenshotOcrMutationResult>>
  onScreenshotOcrModelState?(listener: (state: ScreenshotOcrModelState) => void): () => void
  searchSelection?(query: string): Promise<ApiResult<null>>
  openExternal?(target: string): Promise<ApiResult<null>>
  revealImage?(source: string): Promise<ApiResult<null>>
  copyImage?(source: string): Promise<ApiResult<null>>
  saveImageCopy?(source: string): Promise<ApiResult<string | null>>
  copyImageTo?(source: string): Promise<ApiResult<string | null>>
  copyMermaidImage?(pngDataUrl: string): Promise<ApiResult<null>>
  openMermaidViewer?(input: import('./mermaid-viewer').MermaidViewerSnapshot): Promise<ApiResult<null>>
  getMermaidViewerSnapshot?(): Promise<ApiResult<import('./mermaid-viewer').MermaidViewerSnapshot>>
  saveMermaidImage?(input: MermaidImageExportInput): Promise<ApiResult<null>>
  listStickyNotes(status: StickyNoteStatus): Promise<ApiResult<StickyNoteSummary[]>>
  reorderStickyNotes?(noteIds: readonly string[]): Promise<ApiResult<StickyNoteSummary[]>>
  searchStickyNotes(
    status: StickyNoteStatus,
    query: string,
  ): Promise<ApiResult<StickyNoteSearchResult[]>>
  readStickyNote(noteId: string): Promise<ApiResult<StickyNoteReadDocument>>
  createStickyNote(input: CreateStickyNoteInput): Promise<ApiResult<StickyNoteDocument>>
  renameStickyNote(noteId: string, name: string): Promise<ApiResult<StickyNoteDocument>>
  archiveStickyNote(noteId: string): Promise<ApiResult<StickyNoteDocument>>
  restoreStickyNote(noteId: string): Promise<ApiResult<StickyNoteDocument>>
  restoreArchivedStickyNotes?(noteIds: readonly string[]): Promise<ApiResult<null>>
  deleteStickyNote(noteId: string): Promise<ApiResult<null>>
  deleteArchivedStickyNotes?(noteIds: readonly string[]): Promise<ApiResult<null>>
  importStickyNote(absolutePath: string): Promise<ApiResult<StickyNoteImportResult>>
  importStickyNoteSelection?(
    input: StickyNoteSelectionImportInput,
  ): Promise<ApiResult<StickyNoteImportResult>>
  stageStickyNoteSave(noteId: string, markdown: string): Promise<ApiResult<null>>
  flushStickyNoteSave(noteId: string): Promise<ApiResult<StickyNoteSaveState>>
  openStickyNote(noteId: string, query?: string): Promise<ApiResult<null>>
  closeStickyNote(noteId: string): Promise<ApiResult<null>>
  releaseStickyNote(noteId: string): Promise<ApiResult<null>>
  reclaimStickyNote(noteId: string): Promise<ApiResult<null>>
  setStickyNotePinned(noteId: string, pinned: boolean): Promise<ApiResult<null>>
  setStickyNoteStyle(
    noteId: string,
    style: StickyNoteStyleReference,
  ): Promise<ApiResult<StickyNoteRecord>>
  setStickyNoteFontSize?(noteId: string, fontSizePx: number): Promise<ApiResult<null>>
  setStickyNoteLineSpacingMode?(
    noteId: string,
    lineSpacingMode: StickyNoteLineSpacingMode,
  ): Promise<ApiResult<null>>
  chooseStickyNoteImage?(noteId: string): Promise<ApiResult<string | null>>
  copyStickyNoteImage?(noteId: string, absolutePath: string): Promise<ApiResult<string>>
  resizeStickyNoteToContent(
    noteId: string,
    measurement: StickyNoteContentMeasurement,
  ): Promise<ApiResult<null>>
  openStickyNoteContextMenu?(
    input: StickyNoteContextMenuOpenInput,
  ): Promise<ApiResult<null>>
  closeStickyNoteContextMenu?(requestId: string): Promise<ApiResult<null>>
  readyStickyNoteContextMenu?(requestId: string): Promise<ApiResult<null>>
  executeStickyNoteContextMenuCommand?(
    command: StickyNoteContextMenuCommand,
  ): Promise<ApiResult<null>>
  onStickyNoteContextMenuShow?(
    handler: (payload: StickyNoteContextMenuShowPayload) => void,
  ): () => void
  onStickyNoteContextMenuCommand?(
    handler: (command: StickyNoteContextMenuCommand) => void,
  ): () => void
  onStickyNoteContextMenuClosed?(
    handler: (event: { requestId: string }) => void,
  ): () => void
  onStickyNoteContextMenuReset?(
    handler: (event: { requestId: string }) => void,
  ): () => void
  onStickyNoteEvent(handler: (event: StickyNoteEvent) => void): () => void
  onOpenIntent?(handler: (intent: DroppedPathResult) => void): () => void
  onDocumentLocation?(handler: (intent: DocumentLocationIntent) => void): () => void
  onImportDocxIntent?(handler: (intent: ImportDocxIntent) => void): () => void
  onRecoverDraft?(handler: (intent: RecoveryIntent) => void): () => void
  onPrepareClose(handler: () => Promise<boolean>): () => void
  onPrepareCloseStructured?(handler: ClosePreparationHandler): () => void
  onClosePreparationReleased?(handler: (attempt: ClosePreparationAttempt) => void): () => void
  onMenuCommand?(handler: (command: MenuCommand) => void): () => void
}
