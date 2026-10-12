import { flushSync } from 'react-dom'
import { applyMainWindowTheme, initialMainWindowTheme, useResolvedMainWindowTheme } from './main-window-theme'
import { WORKSPACE_ENTRY_MIME, decodeWorkspaceDrag } from '../workspace/workspace-drag'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type {
  AiWorkspaceState,
  DocumentSnapshot,
  RecoveryIntent,
  WindowStateSnapshot,
  WorkspaceSummary,
} from '../../shared/contracts'
import type { ImportedDocx } from '../../shared/contracts'
import type { ConvertedDocument } from '../../shared/document-conversion'
import type { DocumentLocationIntent } from '../../shared/document-view'
import type { MenuCommand } from '../../shared/menu-commands'
import { documentTypeForPath, isCodeDocumentPath } from '../../shared/document-types'
import {
  isDroppedDocumentLinkPath,
  type DroppedLinkInsertion,
  type DroppedMarkdownInsertion,
} from '../editor/dropped-link-insertion'
import { visualDropRequestIdForEvent } from '../editor/visual-drop-insertion'
import { normalizeHeaderFileName } from '../../shared/document-header-file-name'
import { EditorPane, type EditorMode, type EditorPaneHandle, type EditorFindRequest } from '../editor/EditorPane'
import {
  type AiConversationStore,
} from '../editor/use-ai-conversation'
import {
  WorkspaceAiConversationProvider,
  useWorkspaceAiConversationController,
} from '../editor/WorkspaceAiConversationProvider'
import type {
  EditorRightSidebarState,
  EditorRightSidebarTab,
} from '../editor/EditorRightSidebar'
import { nextEditorZoom, type EditorZoomAction } from '../editor/editor-zoom'
import { createEditorWheelZoomHandler } from '../editor/editor-wheel-zoom'
import { useDocumentSession } from '../editor/use-document-session'
import { isDocumentBodyDrop } from '../editor/document-drop-target'
import { DocumentConversionDialog } from '../document-conversion/DocumentConversionDialog'
import { useDocumentConversion } from '../document-conversion/use-document-conversion'
import { useEditIndicatorModel } from '../editor/edit-indicators/use-edit-indicator-model'
import type {
  DocumentOpenResult,
  SaveAsIntentConfirmation,
  SavedAsTransition,
} from '../editor/use-document-session'
import { useWorkspace } from '../workspace/use-workspace'
import { ContextWorkspaceSidebar } from '../workspace/ContextWorkspaceSidebar'
import {
  workspaceColorFromMenuCommand,
  type WorkspaceMenuTarget,
} from '../workspace/workspace-menu-model'
import {
  canonicalWorkspaceColorPath,
  type WorkspaceColorMarksSnapshot,
} from '../../shared/workspace-color-marks'
import { WorkspaceNameDialog } from '../workspace/WorkspaceNameDialog'
import { FolderDropDialog, type FolderDropChoice } from '../workspace/FolderDropDialog'
import { useSidebarResize } from './use-sidebar-resize'
import { PreferencesPage } from '../settings/PreferencesPage'
import {
  createPreferencePersistence,
  type PreferenceBatchResult,
  type PreferencePersistence,
  type PreferenceUpdate,
  type PreferenceUpdateQueue,
} from '../settings/preference-update-queue'
import type { PreferencesOpenTarget } from '../settings/preferences-open-target'
import { createObservedPreferenceDrafts, type ObservedPreferenceDrafts, type PreferenceDraftAttempt } from '../settings/observed-preference-draft'
import { ShellIntegrationPreferenceDraft } from '../settings/shell-integration-preference-draft'
import { ModelPreferenceDraft } from '../settings/model-preference-draft'
import { startModelPreferenceSync } from '../settings/model-preference-sync'
import { settleClosePreferences } from '../settings/close-model-preferences'
import { ShortcutPreferenceDraft } from '../settings/shortcut-preference-draft'
import type { PublicPreferenceSnapshot } from '../../shared/preference-observation'
import type { ClosePreparationHandler, ClosePreparationHandlerContext, ClosePreparationResult } from '../../shared/close-preparation'
import type { BrowserSearchPreferences } from '../../shared/search-preferences'
import type { LargeModelSettings } from '../../shared/large-model-settings'
import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_FONT_CHOICES,
  editorFontFamilyCss,
  type EditorAppearancePreferences,
  type EditorTheme,
} from '../../shared/editor-appearance-preferences'
import {
  DEFAULT_LAYOUT_PREFERENCES,
  layoutPreferencesEqual,
  type LayoutPreferences,
} from '../../shared/layout-preferences'
import { normalizeThemeColor, themeColorRgbChannels } from '../../shared/theme-color'
import { AppTitleBar } from '../chrome/AppTitleBar'
import { FullscreenHint } from '../chrome/FullscreenHint'
import { DocumentHeader } from '../chrome/DocumentHeader'
import { arknotePreferencesForUpdate, copyArknotePreferences, type ArknotePreferences } from '../../shared/arknote-preferences'
import { StickyNoteBoxPanel } from '../sticky-notes/StickyNoteBoxPanel'
import { installUiSelectionGuard } from './ui-selection-guard'
import type { ApplicationMenuSection } from '../../shared/application-menu-model'
import { RecentDocumentRecordTracker } from './recent-document-record-tracker'
import { WindowStateSnapshotController } from './window-state-snapshot-controller'
import { useTranslationHistory } from './use-translation-history'
import { ScreenshotOcrHost } from '../screenshot/ScreenshotOcrHost'
import { BusinessDialogProvider, useBusinessDialog } from '../modal/BusinessDialogProvider'
import { useAppUpdate } from '../updates/use-app-update'
import { UpdateDialog, updateIndicatorLabel } from '../updates/UpdateDialog'
import { AboutDialog } from '../about/AboutDialog'
import { KeyboardShortcutsDialog } from '../settings/KeyboardShortcutsDialog'
import { useKeyboardShortcuts } from '../settings/use-keyboard-shortcuts'
import {
  sameWorkspacePath,
  WORKSPACE_AI_SWITCH_COPY,
  workspacePathForDroppedInspection,
} from './workspace-ai-switch-gate'
import type {
  TranslationHistoryStore,
  TranslationHistoryWindowPort,
} from '../editor/translation-history'
import type { MermaidAppearance } from '../editor/mermaid/mermaid-types'
import type { BackgroundPresentation } from '../../shared/background-settings'
import { BackgroundImageLayer } from '../backgrounds/BackgroundImageLayer'
import startWritingMarkdown from '../../../initial-workspace/01-欢迎使用.md?raw'

interface PreferencesSnapshot {
  search: BrowserSearchPreferences
  appearance: EditorAppearancePreferences
  systemFonts: string[]
  largeModels: LargeModelSettings
  arknote: ArknotePreferences
}

class PreferenceUpdateError extends Error {
  constructor(message: string, readonly persisted = false) { super(message) }
}

const UNREADY_CLOSE: ClosePreparationHandler = async () => ({ status: 'failed', code: 'editor-unavailable' })
interface InstalledCloseHandler {
  handler: ClosePreparationHandler
  release(): void
  owner: object | null
  adopted: SavedAsTransition | null
  readLifecycle(): number
}
interface PreparedClose {
  context: ClosePreparationHandlerContext
  registration: InstalledCloseHandler
  preparing: boolean
  handoff: { transition: SavedAsTransition; ready: Promise<InstalledCloseHandler | null>; accept(next: InstalledCloseHandler | null): void } | null
}

function mermaidBodyFontFamily(appearance: EditorAppearancePreferences): string {
  return [appearance.bodyLatinFont, appearance.bodyCjkFont]
    .map((font) => JSON.stringify(font))
    .join(', ')
}

interface PreparedRecovery {
  intent: RecoveryIntent
  snapshot: DocumentSnapshot | null
  conflict: boolean
}

interface WorkspaceShellProps {
  documentLocation: DocumentLocationIntent | null
  onDocumentLocationHandled(intent: DocumentLocationIntent): void
  aiConversationStore: AiConversationStore
  preferencePersistence: PreferencePersistence
  preferenceDrafts: ObservedPreferenceDrafts
  shellPreferences: ShellIntegrationPreferenceDraft
  shortcutPreferences: ShortcutPreferenceDraft
  modelPreferences: ModelPreferenceDraft
  aiWorkspace: AiWorkspaceState | null
  rightSidebarOpen: boolean
  rightSidebarTab: EditorRightSidebarTab
  onCloseRightSidebar(): void
  onOpenRightSidebar(tab: EditorRightSidebarTab): void
  onToggleRightSidebar(): void
  workspace: WorkspaceSummary | null
  chooseWorkspace: () => Promise<void>
  confirmWorkspaceSwitch(targetWorkspaceAbsolutePath: string): Promise<boolean>
  confirmSaveAsIntent: SaveAsIntentConfirmation
  workspaceError: string | null
  isChoosing: boolean
  installCloseHandler(handler: ClosePreparationHandler, release: () => void, owner: object, adopted: SavedAsTransition | null, readLifecycle: () => number): () => void
  initialDocument: DocumentSnapshot | null
  initialSavedAsTransition: SavedAsTransition | null
  initialImportedDocx: ImportedDocx | null
  initialRecovery: PreparedRecovery | null
  startupGuide: boolean
  onDocumentActivated(): void
  editorZoomPercent: number
  onEditorZoom(action: EditorZoomAction): void
  onWindowStateChange(state: WindowStateSnapshot): void
  onRecoveryHandled(): void
  onDroppedWorkspace(workspace: WorkspaceSummary, document: DocumentSnapshot | null): void
  onSavedAsWorkspace(transition: SavedAsTransition, preserveSession?: boolean): void
  onSavedAsTransitionHandled(transition: SavedAsTransition): void
  windowState: WindowStateSnapshot
  translationHistory: TranslationHistoryWindowPort
  createUntitledDocumentKey(): string
  translationNavigation: TranslationNavigationController
}

interface PendingTranslationReveal {
  documentKey: string
  recordId: string
  generation: number
  alignment: import('../editor/translation-history').TranslationHistoryRevealAlignment
}

interface TranslationNavigationController {
  pendingRef: { current: PendingTranslationReveal | null }
  generationRef: { current: number }
  delegateRef: { current: ((
    recordId: string,
    alignment?: import('../editor/translation-history').TranslationHistoryRevealAlignment,
  ) => void) | null }
  navigate(
    recordId: string,
    alignment?: import('../editor/translation-history').TranslationHistoryRevealAlignment,
  ): void
  invalidate(): void
}

function normalizeSavedDocumentKey(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
}

function sameDocumentKey(left: string, right: string): boolean {
  if (left.startsWith('__untitled__:') || right.startsWith('__untitled__:')) return left === right
  return normalizeSavedDocumentKey(left) === normalizeSavedDocumentKey(right)
}

function createTranslationHistoryWindowPort(
  store: TranslationHistoryStore,
): TranslationHistoryWindowPort {
  return {
    get records() { return store.records },
    get selectedRecordId() { return store.selectedRecordId },
    finalize: store.finalize,
    selectLatest: store.selectLatest,
    selectById: store.selectById,
    selectPrevious: store.selectPrevious,
    selectNext: store.selectNext,
    updateAnchor: store.updateAnchor,
    updateDocumentIdentity: store.updateDocumentIdentity,
    recordsForDocument: (documentKey) => (
      store.records.filter((record) => record.documentKey === documentKey)
    ),
    onAnchorsChanged: (documentKey, updates) => {
      const visibleRecordIds = new Set(
        store.records
          .filter((record) => record.documentKey === documentKey)
          .map(({ id }) => id),
      )
      for (const update of updates) {
        if (visibleRecordIds.has(update.recordId)) {
          store.updateAnchor(update.recordId, update.anchor)
        }
      }
    },
    onOpenRecord: (recordId) => { store.selectById(recordId) },
    openHistory: (recordId) => {
      if (recordId) store.selectById(recordId)
      else store.selectLatest()
    },
    closeHistory: () => undefined,
  }
}

type WorkspaceNameAction = {
  kind: 'new-document' | 'new-folder' | 'rename'
  target: WorkspaceMenuTarget
}

type PendingFolderDrop = Omit<DroppedLinkInsertion, 'kind'>

function workspaceChildPath(parent: string, name: string): string {
  return [parent, name].filter(Boolean).join('/').replaceAll('\\', '/')
}

function hasFileTransfer(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.files.length > 0
    || Array.from(dataTransfer.types).includes('Files')
    || Array.from(dataTransfer.types).includes(WORKSPACE_ENTRY_MIME)
  )
}

function propertiesText(properties: {
  name: string
  absolutePath: string
  kind: 'directory' | 'document'
  size: number
  createdAt: string
  modifiedAt: string
  itemCount: number | null
}): string {
  const lines = [
    `名称：${properties.name}`,
    `类型：${properties.kind === 'directory' ? '文件夹' : '文档'}`,
    `位置：${properties.absolutePath}`,
    `大小：${properties.size.toLocaleString('zh-CN')} 字节`,
    `创建时间：${new Date(properties.createdAt).toLocaleString('zh-CN')}`,
    `修改时间：${new Date(properties.modifiedAt).toLocaleString('zh-CN')}`,
  ]
  if (properties.itemCount !== null) lines.push(`包含项目：${properties.itemCount}`)
  return lines.join('\n')
}

function WorkspaceShell({
  documentLocation,
  onDocumentLocationHandled,
  aiConversationStore,
  preferencePersistence,
  preferenceDrafts,
  shellPreferences,
  shortcutPreferences,
  modelPreferences,
  aiWorkspace,
  rightSidebarOpen,
  rightSidebarTab,
  onCloseRightSidebar,
  onOpenRightSidebar,
  onToggleRightSidebar,
  workspace,
  chooseWorkspace,
  confirmWorkspaceSwitch,
  confirmSaveAsIntent,
  workspaceError,
  isChoosing,
  installCloseHandler,
  initialDocument,
  initialSavedAsTransition,
  initialImportedDocx,
  initialRecovery,
  startupGuide,
  onDocumentActivated,
  editorZoomPercent,
  onEditorZoom,
  onWindowStateChange,
  onRecoveryHandled,
  onDroppedWorkspace,
  onSavedAsWorkspace,
  onSavedAsTransitionHandled,
  windowState,
  translationHistory,
  createUntitledDocumentKey,
  translationNavigation,
}: WorkspaceShellProps) {
  const businessDialogs = useBusinessDialog()
  const appShellRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorPaneHandle>(null)
  const consumedSavedAsTransitionRef = useRef<SavedAsTransition | null>(null)
  const consumedInitialDocumentRef = useRef<DocumentSnapshot | null>(null)
  const consumedInitialImportedDocxRef = useRef<ImportedDocx | null>(null)
  const consumedRecoveryRef = useRef<PreparedRecovery | null>(null)
  const [recoveryEditorGeneration, setRecoveryEditorGeneration] = useState(0)
  const initialAdoptionEffectHasRunRef = useRef(false)
  const activeTranslationDocumentRef = useRef<{
    documentKey: string
    workspaceAbsolutePath: string | null
    documentRelativePath: string | null
    documentAbsolutePath: string | null
    documentRevision: string | null
  } | null>(null)
  const [editorMode, setEditorMode] = useState<EditorMode>('visual')
  const [mainBackgroundPresentation, setMainBackgroundPresentation] = useState<
    BackgroundPresentation | null
  >(null)
  const [untitledDocumentKey, setUntitledDocumentKey] = useState(
    createUntitledDocumentKey,
  )
  const fullscreenExitPendingRef = useRef(false)
  const fullscreenExitFocusRef = useRef<HTMLElement | null>(null)
  const previousFullscreenRef = useRef(windowState.fullscreen)
  const [applicationMenuModel, setApplicationMenuModel] = useState<
    readonly ApplicationMenuSection[] | undefined
  >(undefined)
  const recentDocumentRecordTracker = useRef(new RecentDocumentRecordTracker())
  const openSelectionRequest = useRef(0)
  const [findRequest, setFindRequest] = useState<EditorFindRequest | null>(null)
  const searchWorkspaceRef = useRef(workspace)
  searchWorkspaceRef.current = workspace
  const reloadFromDiskInFlight = useRef<{
    documentLifecycle: number
    transitionGeneration: number
  } | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const handleAiWorkspaceFilesChanged = useCallback((changedWorkspace: AiWorkspaceState) => {
    if (aiWorkspace?.workspaceId !== changedWorkspace.workspaceId
      || aiWorkspace.workspaceGeneration !== changedWorkspace.workspaceGeneration) return
    setRefreshVersion(version => version + 1)
  }, [aiWorkspace])
  const [openingDocumentPath, setOpeningDocumentPath] = useState<string | null>(null)
  const [workspaceLocateRequest, setWorkspaceLocateRequest] = useState<{
    relativePath: string
    version: number
  } | null>(null)
  const [fileActionError, setFileActionError] = useState<string | null>(null)
  const [workspaceColorMarks, setWorkspaceColorMarks] = useState<
    WorkspaceColorMarksSnapshot['marks']
  >({})
  const workspaceColorMarksRef = useRef<WorkspaceColorMarksSnapshot['marks']>({})
  const workspaceColorLifecycle = useRef(0)
  const workspaceColorInitialLoad = useRef(0)
  const workspaceColorMutationQueue = useRef<Promise<void>>(Promise.resolve())
  const [workspaceNameAction, setWorkspaceNameAction] = useState<WorkspaceNameAction | null>(null)
  const [pendingFolderDrop, setPendingFolderDrop] = useState<PendingFolderDrop | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [translationSettingsRevision, setTranslationSettingsRevision] = useState(0)
  const [stickyNoteBoxOpen, setStickyNoteBoxOpen] = useState(false)
  const [stickyNoteBoxMounted, setStickyNoteBoxMounted] = useState(false)
  const [stickyNoteBoxPanelVersion, setStickyNoteBoxPanelVersion] = useState(0)
  const stickyNoteBoxOpenRef = useRef(false)
  const stickyNoteBoxOpenFrame = useRef<number | null>(null)
  const arknoteConnecting = useRef(false)
  const arknoteConnectionEpoch = useRef(0)
  const arknoteDisconnectNotified = useRef(false)
  const [preferences, setPreferences] = useState<PreferencesSnapshot | null>(null)
  const [aboutOpen, setAboutOpen] = useState(false)
  const appUpdate = useAppUpdate(aboutOpen, Boolean(initialRecovery) || isChoosing)
  const [keyboardShortcutsOpen, setKeyboardShortcutsOpen] = useState(false)
  const keyboardShortcuts = useKeyboardShortcuts()
  const preferencesRef = useRef<PreferencesSnapshot | null>(null)
  const persistedPreferencesRef = useRef<PreferencesSnapshot | null>(null)
  const searchFormObservationRef = useRef<PublicPreferenceSnapshot<'search'> | null>(null)
  const [preferenceReloadEpoch, setPreferenceReloadEpoch] = useState(0)
  const preferenceUpdateQueueRef = useRef<PreferenceUpdateQueue | null>(null)
  const [preferencesPersistenceError, setPreferencesPersistenceError] = useState<string | null>(null)
  const [preferencesTarget, setPreferencesTarget] = useState<PreferencesOpenTarget>('top')
  const preferencesOpenRequest = useRef(0)
  const activePreferencesOpenRequest = useRef<{
    request: number
    target: PreferencesOpenTarget
  } | null>(null)
  const [preferencesPageSession, setPreferencesPageSession] = useState(0)
  const workspaceShellMounted = useRef(true)
  const [appearance, setAppearance] = useState<EditorAppearancePreferences>(() => ({
    ...DEFAULT_EDITOR_APPEARANCE, editorTheme: initialMainWindowTheme(),
  }))
  const persistedAppearanceRef = useRef<EditorAppearancePreferences>(DEFAULT_EDITOR_APPEARANCE)
  const appearanceRevisionRef = useRef(-1)
  const resolvedTheme = useResolvedMainWindowTheme(appearance.editorTheme)
  const mermaidColorScheme = resolvedTheme === 'dark' ? 'dark' : 'light'
  const mermaidAppearanceSnapshotRef = useRef<{
    key: string
    value: MermaidAppearance
  } | null>(null)
  const appearanceMenuMutationPending = useRef(false)
  const appearanceMenuFieldsRef = useRef(preferenceDrafts.menuAppearanceFields)
  const [layout, setLayout] = useState<LayoutPreferences>(DEFAULT_LAYOUT_PREFERENCES)
  const [layoutLoaded, setLayoutLoaded] = useState(false)
  const layoutUpdateQueueRef = useRef<PreferenceUpdateQueue | null>(null)
  const [layoutPersistenceError, setLayoutPersistenceError] = useState<string | null>(() => preferencePersistence.snapshot().failures.layout?.message ?? null)
  const layoutUserResizeGenerationRef = useRef({
    leftSidebarWidth: 0,
    rightSidebarWidth: 0,
  })
  const currentLayoutRef = useRef<LayoutPreferences>(DEFAULT_LAYOUT_PREFERENCES)
  const reflectPreferenceUpdates = useCallback(() => {
    if (!workspaceShellMounted.current) return
    const outstanding = preferenceUpdateQueueRef.current?.outstanding() ?? {}
    const draftAppearance = preferenceDrafts.appearance.ready() ? preferenceDrafts.appearance.view() : persistedAppearanceRef.current
    const nextAppearance = { ...draftAppearance }
    for (const field of appearanceMenuFieldsRef.current) {
      Object.assign(nextAppearance, { [field]: persistedAppearanceRef.current[field] })
    }
    setAppearance(nextAppearance)
    void window.arkdown.previewArknoteThemeColor?.(nextAppearance.themeColor).catch(() => undefined)
    const current = preferencesRef.current
    const persisted = persistedPreferencesRef.current
    if (current && persisted) {
      const next = {
        ...current,
        appearance: draftAppearance,
        search: preferenceDrafts.search.ready() ? preferenceDrafts.search.view() : persisted.search,
        arknote: { ...persisted.arknote, ...outstanding.arknote },
      }
      preferencesRef.current = next
      setPreferences(next)
    }
  }, [preferenceDrafts])
  const acceptAppearanceSnapshot = useCallback((
    snapshot: PublicPreferenceSnapshot<'appearance'>,
    syncOpenPreferences = true,
  ): boolean => {
    preferenceDrafts.appearance.adopt(snapshot)
    const current = preferenceDrafts.appearance.snapshot()
    appearanceRevisionRef.current = current.observation.revision
    persistedAppearanceRef.current = current.values
    if (persistedPreferencesRef.current) {
      persistedPreferencesRef.current = { ...persistedPreferencesRef.current, appearance: current.values }
    }
    if (!workspaceShellMounted.current) return true
    if (syncOpenPreferences) reflectPreferenceUpdates()
    else setAppearance(preferenceDrafts.appearance.view())
    return true
  }, [preferenceDrafts, reflectPreferenceUpdates])
  useLayoutEffect(() => {
    applyMainWindowTheme(resolvedTheme)
    document.documentElement.style.setProperty('--theme-color-rgb', themeColorRgbChannels(appearance.themeColor))
    return () => {
      delete document.documentElement.dataset.arkdownTheme
      document.documentElement.style.removeProperty('--theme-color-rgb')
    }
  }, [resolvedTheme, appearance.themeColor])
  const normalizedMermaidThemeColor = normalizeThemeColor(appearance.themeColor)
  const mermaidFontFamily = mermaidBodyFontFamily(appearance)
  const mermaidAppearanceKey = JSON.stringify([
    appearanceRevisionRef.current,
    appearance.editorTheme,
    mermaidColorScheme,
    normalizedMermaidThemeColor,
    mermaidFontFamily,
  ])
  if (mermaidAppearanceSnapshotRef.current?.key !== mermaidAppearanceKey) {
    const previousRevision = mermaidAppearanceSnapshotRef.current?.value.revision ?? -1
    mermaidAppearanceSnapshotRef.current = {
      key: mermaidAppearanceKey,
      value: Object.freeze({
        revision: Math.max(previousRevision + 1, appearanceRevisionRef.current),
        editorTheme: resolvedTheme,
        colorScheme: mermaidColorScheme,
        themeColor: normalizedMermaidThemeColor,
        bodyFontFamily: mermaidFontFamily,
      }),
    }
  }
  const mermaidAppearance = mermaidAppearanceSnapshotRef.current.value
  useEffect(() => {
    workspaceShellMounted.current = true
    return () => {
      workspaceShellMounted.current = false
      preferencesOpenRequest.current += 1
      activePreferencesOpenRequest.current = null
    }
  }, [])
  useEffect(() => {
    let active = true
    let receivedMainPresentation = false
    const unsubscribe = window.arkdown.onBackgroundPresentation?.((event) => {
      if (event.target.kind !== 'main') return
      receivedMainPresentation = true
      setMainBackgroundPresentation(event.presentation)
    }) ?? (() => undefined)
    const getBackgroundPresentation = window.arkdown.getBackgroundPresentation
    if (getBackgroundPresentation) {
      void getBackgroundPresentation({ kind: 'main' }).then((result) => {
        if (active && !receivedMainPresentation && result.ok) {
          setMainBackgroundPresentation(result.value)
        }
      }, () => undefined)
    }
    return () => {
      active = false
      unsubscribe()
    }
  }, [])
  const sidebarResize = useSidebarResize({
    initialWidth: layout.leftSidebarWidth,
    minWidth: 180,
    maxWidth: 600,
  })
  currentLayoutRef.current = {
    leftSidebarWidth: sidebarResize.width,
    rightSidebarWidth: layout.rightSidebarWidth,
  }
  const reconcileLayoutWithPersisted = useCallback(() => {
    if (!preferenceDrafts.layout.ready()) return
    const merged = preferenceDrafts.layout.view()
    currentLayoutRef.current = merged
    setLayout((previous) => layoutPreferencesEqual(previous, merged) ? previous : merged)
  }, [preferenceDrafts])
  const acceptLayoutSnapshot = useCallback((snapshot: PublicPreferenceSnapshot<'layout'>): boolean => {
    preferenceDrafts.layout.adopt(snapshot)
    if (!workspaceShellMounted.current) return true
    reconcileLayoutWithPersisted()
    setLayoutLoaded(true)
    return true
  }, [preferenceDrafts, reconcileLayoutWithPersisted])
  const queueLayoutUpdate = useCallback((changes: Partial<LayoutPreferences>) => {
    if (!preferenceDrafts.layout.ready()) return
    preferenceDrafts.layout.edit(changes)
    if (!layoutUpdateQueueRef.current) {
      layoutUpdateQueueRef.current = preferencePersistence.createQueue({
        coalesceMs: 180,
        write: async batch => {
          try {
            for (const attempt of preferenceDrafts.layout.begin(batch.layout ?? {})) {
              try {
                const response = await window.arkdown.patchPreferences?.({ observed: attempt.observed, changes: attempt.changes })
                if (!response) throw new PreferenceUpdateError('偏好设置不可用')
                if (!response.ok) throw new PreferenceUpdateError(response.error.message)
                const mutation = response.value
                if (mutation.snapshot.group !== 'layout') throw new PreferenceUpdateError('偏好设置不可用')
                preferenceDrafts.layout.finish(attempt, mutation.status === 'conflict'
                  ? { status: 'conflict', snapshot: mutation.snapshot, reason: mutation.reason, fields: [] }
                  : { status: mutation.status, snapshot: mutation.snapshot })
                if (mutation.status === 'conflict') throw new PreferenceUpdateError('窗口布局已在其他窗口更改。你的调整仍保留，请重新加载窗口布局。')
              } catch (error) { preferenceDrafts.layout.fail(attempt); throw error }
            }
            if (preferenceDrafts.layout.hasFailures()) throw new PreferenceUpdateError('窗口布局尚未保存，请重新加载窗口布局。')
            return { layout: { ok: true } }
          } catch (error) {
            return { layout: { ok: false, message: error instanceof PreferenceUpdateError ? error.message : '窗口布局保存失败。', persisted: false } }
          }
        },
        onSettled: () => {
          if (!workspaceShellMounted.current) return
          reconcileLayoutWithPersisted()
          setLayoutPersistenceError(preferencePersistence.snapshot().failures.layout?.message ?? null)
        },
        onError: () => { if (workspaceShellMounted.current) setLayoutPersistenceError('窗口布局保存失败。') },
      })
    }
    layoutUpdateQueueRef.current.enqueue({ layout: changes })
    reconcileLayoutWithPersisted()
  }, [preferenceDrafts, preferencePersistence, reconcileLayoutWithPersisted])
  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.arkdown.getPreferenceSnapshot?.('layout').then(result => {
        if (active && result.ok && result.value.group === 'layout') acceptLayoutSnapshot(result.value)
      }).catch(() => undefined)
    }
    refresh()
    const unsubscribe = window.arkdown.onLayoutPreferencesChanged?.(refresh) ?? (() => undefined)
    window.addEventListener('focus', refresh)
    return () => {
      active = false
      unsubscribe()
      window.removeEventListener('focus', refresh)
    }
  }, [acceptLayoutSnapshot])
  useLayoutEffect(() => {
    if (sidebarResize.userResizeGeneration <= layoutUserResizeGenerationRef.current.leftSidebarWidth) return
    layoutUserResizeGenerationRef.current.leftSidebarWidth = sidebarResize.userResizeGeneration
    queueLayoutUpdate({ leftSidebarWidth: sidebarResize.width })
  }, [queueLayoutUpdate, sidebarResize.userResizeGeneration, sidebarResize.width])
  const flushEditor = useCallback(() => {
    editorRef.current?.flush()
  }, [])
  const guardedDropRef = useRef<AbortController | null>(null)
  const [acceptingDrop, setAcceptingDrop] = useState(false)
  const [closePrepared, setClosePrepared] = useState(false)
  const closeOwnerRef = useRef<object>({})
  const acceptingDropRef = useRef(false)
  const handleSavedAs = useCallback((transition: SavedAsTransition) => {
    const result = transition.result
    const previous = activeTranslationDocumentRef.current
    const nextDocument = result.document
    if (previous && nextDocument) {
      const nextDocumentKey = workspaceChildPath(
        result.workspace.absolutePath,
        nextDocument.relativePath,
      )
      translationHistory.updateDocumentIdentity(previous.documentKey, {
        nextDocumentKey,
        workspaceAbsolutePath: result.workspace.absolutePath,
        documentRelativePath: nextDocument.relativePath,
        documentAbsolutePath: nextDocumentKey,
        documentRevision: nextDocument.revision,
      })
    }
    if (!result.changesWorkspace) setRefreshVersion((version) => version + 1)
    const preserveSession = Boolean(guardedDropRef.current && !guardedDropRef.current.signal.aborted)
    if (result.changesWorkspace && !preserveSession) {
      // The session just flushed and captured its continuation. Commit this
      // destructive remount in the same turn, before the old editor can edit.
      flushSync(() => onSavedAsWorkspace(transition, false))
    } else {
      onSavedAsWorkspace(transition, preserveSession)
    }
  }, [onSavedAsWorkspace, translationHistory])
  const handleSaved = useCallback((saved: {
    relativePath: string | null
    revision: string | null
  }) => {
    const current = activeTranslationDocumentRef.current
    if (!current) return
    translationHistory.updateDocumentIdentity(current.documentKey, {
      nextDocumentKey: current.documentKey,
      workspaceAbsolutePath: current.workspaceAbsolutePath,
      documentRelativePath: saved.relativePath,
      documentAbsolutePath: current.documentAbsolutePath,
      documentRevision: saved.revision,
    })
  }, [translationHistory])
  const session = useDocumentSession(
    flushEditor,
    handleSavedAs,
    handleSaved,
    businessDialogs,
    confirmSaveAsIntent,
    onDocumentActivated,
    startupGuide ? { markdown: startWritingMarkdown.replace(/\r\n/g, '\n'), displayName: '欢迎使用.md' } : undefined,
  )
  const documentConversion = useDocumentConversion()
  const droppedPathInspection = useRef(0)
  const droppedEditorLifecycle = useRef(0)

  useEffect(() => {
    droppedEditorLifecycle.current += 1
    droppedPathInspection.current += 1
    setPendingFolderDrop(null)
  }, [
    editorMode,
    session.state.relativePath,
    session.state.sourceRelativePath,
    untitledDocumentKey,
    workspace?.absolutePath,
  ])

  useEffect(() => () => {
    droppedPathInspection.current += 1
    guardedDropRef.current?.abort()
  }, [])

  const replaceWorkspaceColorMarks = useCallback((
    marks: WorkspaceColorMarksSnapshot['marks'],
  ) => {
    workspaceColorMarksRef.current = marks
    setWorkspaceColorMarks(marks)
  }, [])

  const isCurrentWorkspaceColorLifecycle = useCallback((lifecycle: number): boolean => (
    workspaceColorLifecycle.current === lifecycle
  ), [])

  const enqueueWorkspaceColorMutation = useCallback(<T,>(
    mutation: (lifecycle: number) => Promise<T>,
  ): Promise<T | undefined> => {
    const lifecycle = workspaceColorLifecycle.current
    workspaceColorInitialLoad.current += 1
    const pending = workspaceColorMutationQueue.current.then(() => (
      isCurrentWorkspaceColorLifecycle(lifecycle)
        ? mutation(lifecycle)
        : undefined
    ))
    workspaceColorMutationQueue.current = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }, [isCurrentWorkspaceColorLifecycle])

  const acceptWorkspaceColorSnapshot = useCallback((
    snapshot: WorkspaceColorMarksSnapshot,
    lifecycle: number,
  ): boolean => {
    if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return false
    replaceWorkspaceColorMarks(snapshot.marks)
    return true
  }, [isCurrentWorkspaceColorLifecycle, replaceWorkspaceColorMarks])

  const reloadWorkspaceColorSnapshot = useCallback(async (
    lifecycle: number,
    initialLoad?: number,
  ) => {
    if (
      !isCurrentWorkspaceColorLifecycle(lifecycle)
      || (initialLoad !== undefined && workspaceColorInitialLoad.current !== initialLoad)
      || !window.arkdown.getWorkspaceColorMarks
    ) return
    try {
      const result = await window.arkdown.getWorkspaceColorMarks()
      if (
        result.ok
        && (initialLoad === undefined || workspaceColorInitialLoad.current === initialLoad)
      ) acceptWorkspaceColorSnapshot(result.value, lifecycle)
    } catch {
      // Keep the last snapshot when the authoritative reload is unavailable.
    }
  }, [acceptWorkspaceColorSnapshot, isCurrentWorkspaceColorLifecycle])

  useEffect(() => {
    const lifecycle = ++workspaceColorLifecycle.current
    const initialLoad = ++workspaceColorInitialLoad.current
    workspaceColorMutationQueue.current = Promise.resolve()
    replaceWorkspaceColorMarks({})
    if (workspace && window.arkdown.getWorkspaceColorMarks) {
      void reloadWorkspaceColorSnapshot(lifecycle, initialLoad)
    }
    return () => {
      if (workspaceColorLifecycle.current === lifecycle) {
        workspaceColorLifecycle.current += 1
      }
    }
  }, [reloadWorkspaceColorSnapshot, replaceWorkspaceColorMarks, workspace?.absolutePath])

  const invalidatePendingTranslationReveal = useCallback(() => {
    translationNavigation.invalidate()
  }, [translationNavigation])
  const listDirectory = useCallback(
    (path: string) => workspace
      ? window.arkdown.listDirectory(path)
      : Promise.resolve({ ok: true as const, value: [] }),
    [workspace?.absolutePath],
  )
  const readDocument = useCallback(
    (path: string) => workspace
      ? window.arkdown.peekDocument(path)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'OPERATION_FAILED', message: '请先打开文件夹' },
        }),
    [workspace?.absolutePath],
  )
  const openDocument = useCallback(async (path: string, contentQuery?: string): Promise<void> => {
    invalidatePendingTranslationReveal()
    const requestId = ++openSelectionRequest.current
    const requestedWorkspace = workspace
    setFindRequest(null)
    setFileActionError(null)
    setOpeningDocumentPath(path)
    try {
      const definition = documentTypeForPath(path)
      if (definition?.convertWithMarkItDown) {
        session.supersedePendingOpen()
        documentConversion.begin(path)
      } else if (definition?.importWithPandoc) {
        documentConversion.cancel()
        await session.importDocx(path)
      } else {
        documentConversion.cancel()
        const result = await session.open(path)
        if (result.status === 'opened' && contentQuery && requestedWorkspace
          && openSelectionRequest.current === requestId
          && searchWorkspaceRef.current === requestedWorkspace) {
          const lifecycle = session.getDocumentLifecycle()
          const transition = session.getDocumentTransitionGeneration()
          // Readiness may arrive later, after another navigation has already begun.
          setFindRequest({
            id: requestId,
            documentKey: workspaceChildPath(requestedWorkspace.absolutePath, path),
            query: contentQuery,
            isCurrent: () => workspaceShellMounted.current
              && openSelectionRequest.current === requestId
              && searchWorkspaceRef.current === requestedWorkspace
              && session.getDocumentLifecycle() === lifecycle
              && session.getDocumentTransitionGeneration() === transition,
          })
        }
      }
    } finally {
      if (openSelectionRequest.current === requestId) setOpeningDocumentPath(null)
    }
  }, [
    documentConversion.begin,
    documentConversion.cancel,
    invalidatePendingTranslationReveal,
    session.importDocx,
    session.open,
    session.supersedePendingOpen,
    session.getDocumentLifecycle,
    session.getDocumentTransitionGeneration,
    workspace,
  ])
  const adoptConvertedDocument = useCallback(async (converted: ConvertedDocument) => {
    const adopted = await session.adoptConverted(converted)
    if (!adopted) return false
    invalidatePendingTranslationReveal()
    setUntitledDocumentKey(createUntitledDocumentKey())
    return true
  }, [createUntitledDocumentKey, invalidatePendingTranslationReveal, session.adoptConverted])
  const locateWorkspaceEntry = useCallback((relativePath: string) => {
    setWorkspaceLocateRequest((current) => ({
      relativePath,
      version: (current?.version ?? 0) + 1,
    }))
  }, [])
  const completeWorkspaceLocate = useCallback((version: number) => {
    setWorkspaceLocateRequest((current) => current?.version === version ? null : current)
  }, [])
  const createDocument = useCallback(async (path: string) => {
    if (!workspace) return false
    invalidatePendingTranslationReveal()
    setFileActionError(null)
    const created = await session.create(path)
    if (created) {
      setRefreshVersion((version) => version + 1)
      locateWorkspaceEntry(path)
    } else setFileActionError(session.state.error)
    return created
  }, [invalidatePendingTranslationReveal, locateWorkspaceEntry, session.create, session.state.error, workspace])
  const reloadFromDisk = useCallback(async () => {
    if (!workspace) return
    const documentLifecycle = session.getDocumentLifecycle()
    const transitionGeneration = session.getDocumentTransitionGeneration()
    const currentFlight = reloadFromDiskInFlight.current
    if (
      currentFlight?.documentLifecycle === documentLifecycle
      && currentFlight.transitionGeneration === transitionGeneration
    ) return
    const flight = { documentLifecycle, transitionGeneration }
    reloadFromDiskInFlight.current = flight
    try {
      const reloadableRelativePath = session.state.persistenceKind === 'imported-docx'
        ? session.state.sourceRelativePath
        : session.state.persistenceKind === 'saved-document'
          ? session.state.relativePath
          : null
      if (!reloadableRelativePath) {
        setRefreshVersion((version) => version + 1)
        return
      }
      const pendingChange = editorRef.current?.flush() !== null
      if (session.dirty || pendingChange) {
        const confirmation = await businessDialogs.confirm({
          title: '从磁盘重新加载',
          description: '从磁盘重新加载会放弃当前未保存的修改。是否继续？',
          confirmLabel: '继续',
          cancelLabel: '取消',
          actionOrder: 'confirm-cancel',
          tone: 'danger',
        })
        if (confirmation !== 'confirm') return
      }
      invalidatePendingTranslationReveal()
      setFileActionError(null)
      const reload = session.reload()
      flight.transitionGeneration = session.getDocumentTransitionGeneration()
      if (!(await reload)) return
      setRefreshVersion((version) => version + 1)
    } finally {
      if (reloadFromDiskInFlight.current === flight) {
        reloadFromDiskInFlight.current = null
      }
    }
  }, [
    businessDialogs,
    invalidatePendingTranslationReveal,
    session.dirty,
    session.getDocumentLifecycle,
    session.getDocumentTransitionGeneration,
    session.reload,
    session.state.persistenceKind,
    session.state.relativePath,
    session.state.sourceRelativePath,
    workspace,
  ])
  const revealDocument = useCallback(() => {
    const path = session.state.relativePath
    if (!path) return
    setFileActionError(null)
    void window.arkdown.revealDocument(path).then((result) => {
      if (!result.ok) setFileActionError(result.error.message)
    })
  }, [session.state.relativePath])
  const trashDocument = useCallback(async () => {
    const path = session.state.relativePath
    if (!path) return
    const confirmation = await businessDialogs.confirm({
      title: '移入回收站',
      description: `确定要将“${path}”移入回收站吗？`,
      confirmLabel: '移入回收站',
      cancelLabel: '取消',
      tone: 'danger',
    })
    if (confirmation !== 'confirm') return
    if (!window.arkdown.trashWorkspaceEntry) {
      setFileActionError('移到回收站功能不可用')
      return
    }
    invalidatePendingTranslationReveal()
    setFileActionError(null)
    void enqueueWorkspaceColorMutation(async (lifecycle) => {
      try {
        const result = await window.arkdown.trashWorkspaceEntry!(path)
        if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return
        if (!result.ok) {
          await reloadWorkspaceColorSnapshot(lifecycle)
          if (isCurrentWorkspaceColorLifecycle(lifecycle)) {
            setFileActionError(result.error.message)
          }
          return
        }
        if (!acceptWorkspaceColorSnapshot(result.value.colorMarks, lifecycle)) return
        session.clear()
        setRefreshVersion((version) => version + 1)
      } catch (caught) {
        if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return
        await reloadWorkspaceColorSnapshot(lifecycle)
        if (isCurrentWorkspaceColorLifecycle(lifecycle)) {
          setFileActionError(caught instanceof Error ? caught.message : '移到回收站失败')
        }
      }
    })
  }, [
    acceptWorkspaceColorSnapshot,
    businessDialogs,
    enqueueWorkspaceColorMutation,
    invalidatePendingTranslationReveal,
    isCurrentWorkspaceColorLifecycle,
    reloadWorkspaceColorSnapshot,
    session.clear,
    session.state.relativePath,
  ])
  const submitWorkspaceName = useCallback(async (value: string): Promise<string | null> => {
    const action = workspaceNameAction
    if (!action) return '操作已取消。'
    const target = action.target
    const refresh = () => setRefreshVersion((version) => version + 1)

    if (action.kind === 'new-document') {
      const normalized = /\.[^/\\]+$/.test(value) ? value : `${value}.md`
      const parent = target.kind === 'directory' ? target.relativePath : ''
      const created = await createDocument(workspaceChildPath(parent, normalized))
      return created
        ? null
        : '未能新建文档。请检查名称，或确认当前文档的保存操作。'
    }

    if (action.kind === 'new-folder') {
      if (!window.arkdown.createWorkspaceFolder) return '新建文件夹功能不可用。'
      const parent = target.kind === 'directory' ? target.relativePath : ''
      const result = await window.arkdown.createWorkspaceFolder(parent, value)
      if (!result.ok) return result.error.message
      refresh()
      locateWorkspaceEntry(result.value.relativePath)
      return null
    }

    if (target.kind === 'root' || !window.arkdown.renameWorkspaceEntry) {
      return '重命名功能不可用。'
    }
    if (value === target.name) return null

    const currentPath = session.state.relativePath
    const affectsCurrent = Boolean(
      currentPath
      && (
        currentPath === target.relativePath
        || (target.kind === 'directory' && currentPath.startsWith(`${target.relativePath}/`))
      ),
    )
    let nextCurrentPath: string | null = null
    let operationError: string | null = null
    let renamed = false
    let renamedPath: string | null = null
    let staleWorkspace = false
    const perform = async () => {
      const completed = await enqueueWorkspaceColorMutation(async (lifecycle) => {
        let result: Awaited<ReturnType<NonNullable<typeof window.arkdown.renameWorkspaceEntry>>>
        try {
          result = await window.arkdown.renameWorkspaceEntry!(target.relativePath, value)
        } catch (caught) {
          if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return false
          await reloadWorkspaceColorSnapshot(lifecycle)
          if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return false
          operationError = caught instanceof Error ? caught.message : '重命名失败'
          return true
        }
        if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return false
        if (!result.ok) {
          await reloadWorkspaceColorSnapshot(lifecycle)
          if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return false
          operationError = result.error.message
          return true
        }
        const renamedEntry = result.value.entry
        if (!acceptWorkspaceColorSnapshot(result.value.colorMarks, lifecycle)) return false
        renamed = true
        renamedPath = renamedEntry.relativePath
        if (affectsCurrent && currentPath) {
          nextCurrentPath = target.kind === 'document'
            ? renamedEntry.relativePath
            : workspaceChildPath(
                renamedEntry.relativePath,
                currentPath.slice(target.relativePath.length).replace(/^\/+/, ''),
              )
          session.clear()
        }
        return true
      })
      if (completed !== true) staleWorkspace = true
    }

    if (affectsCurrent) {
      invalidatePendingTranslationReveal()
      if (!(await session.transitionAfterSave(perform))) return '重命名已取消。'
    } else {
      await perform()
    }
    if (staleWorkspace) return null
    if (operationError) return operationError
    if (!renamed) return '重命名未能完成。'
    refresh()
    if (renamedPath) locateWorkspaceEntry(renamedPath)
    if (nextCurrentPath) await openDocument(nextCurrentPath)
    return null
  }, [
    acceptWorkspaceColorSnapshot,
    createDocument,
    enqueueWorkspaceColorMutation,
    invalidatePendingTranslationReveal,
    isCurrentWorkspaceColorLifecycle,
    locateWorkspaceEntry,
    openDocument,
    reloadWorkspaceColorSnapshot,
    session.clear,
    session.state.relativePath,
    session.transitionAfterSave,
    workspaceNameAction,
  ])
  const runWorkspaceMenuCommand = useCallback(async (
    command: string,
    target: WorkspaceMenuTarget,
  ) => {
    setFileActionError(null)
    const fail = (message: string) => setFileActionError(message)
    const refresh = () => setRefreshVersion((version) => version + 1)
    const currentPath = session.state.relativePath
    const affectsCurrent = target.kind !== 'root' && Boolean(
      currentPath
      && (
        currentPath === target.relativePath
        || (target.kind === 'directory' && currentPath.startsWith(`${target.relativePath}/`))
      ),
    )
    const selectedColor = workspaceColorFromMenuCommand(command)
    if (
      target.kind !== 'root'
      && selectedColor !== undefined
    ) {
      const key = canonicalWorkspaceColorPath(target.relativePath)
      if (!key || !window.arkdown.setWorkspaceColorMark) {
        fail('工作区颜色标记功能不可用')
        return
      }
      await enqueueWorkspaceColorMutation(async (lifecycle) => {
        if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return
        const before = workspaceColorMarksRef.current
        const next = Object.assign(
          Object.create(null) as WorkspaceColorMarksSnapshot['marks'],
          before,
        )
        if (selectedColor === null) delete next[key]
        else next[key] = selectedColor
        replaceWorkspaceColorMarks(next)
        try {
          const result = await window.arkdown.setWorkspaceColorMark!(
            target.relativePath,
            selectedColor,
          )
          if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return
          if (result.ok) acceptWorkspaceColorSnapshot(result.value, lifecycle)
          else {
            replaceWorkspaceColorMarks(before)
            fail(result.error.message)
          }
        } catch (caught) {
          if (isCurrentWorkspaceColorLifecycle(lifecycle)) {
            replaceWorkspaceColorMarks(before)
            fail(caught instanceof Error ? caught.message : '颜色标记写入失败')
          }
        }
      })
      return
    }
    const properties = async () => {
      const result = target.kind === 'root'
        ? await window.arkdown.getWorkspaceRootProperties?.()
        : await window.arkdown.getWorkspaceEntryProperties?.(target.relativePath)
      if (!result) {
        fail('工作区属性功能不可用')
        return null
      }
      if (!result.ok) {
        fail(result.error.message)
        return null
      }
      return result.value
    }

    if (command === 'workspace-open') {
      if (target.kind === 'document') openDocument(target.relativePath)
      return
    }
    if (command === 'workspace-open-folder') {
      invalidatePendingTranslationReveal()
      await chooseWorkspace()
      return
    }
    if (command === 'workspace-open-file') {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.md,.markdown,.mdx,.txt,.text,.docx'
      input.addEventListener('change', () => {
        const file = input.files?.[0]
        if (!file) return
        const absolutePath = window.arkdown.pathForDroppedFile(file)
        if (!absolutePath || !window.arkdown.openDocumentWindow) {
          fail('无法打开所选文件')
          return
        }
        void window.arkdown.openDocumentWindow(absolutePath).then((result) => {
          if (!result.ok) fail(result.error.message)
        })
      }, { once: true })
      input.click()
      return
    }
    if (command === 'workspace-refresh') {
      refresh()
      return
    }
    if (command === 'workspace-new-document') {
      setWorkspaceNameAction({ kind: 'new-document', target })
      return
    }
    if (command === 'workspace-new-folder') {
      setWorkspaceNameAction({ kind: 'new-folder', target })
      return
    }
    if (command === 'workspace-open-new-window') {
      const result = await window.arkdown.openWorkspaceEntryWindow?.(target.relativePath)
      if (result && !result.ok) fail(result.error.message)
      return
    }
    if (command === 'workspace-rename') {
      if (target.kind !== 'root') setWorkspaceNameAction({ kind: 'rename', target })
      return
    }
    if (command === 'workspace-duplicate') {
      const result = await window.arkdown.duplicateWorkspaceDocument?.(target.relativePath)
      if (result && !result.ok) fail(result.error.message)
      else if (result) refresh()
      return
    }
    if (command === 'workspace-reveal') {
      if (target.kind === 'root') {
        const value = await properties()
        if (value) {
          const result = await window.arkdown.openExternal?.(value.absolutePath)
          if (result && !result.ok) fail(result.error.message)
        }
      } else {
        const result = await window.arkdown.revealWorkspaceEntry?.(target.relativePath)
        if (result && !result.ok) fail(result.error.message)
      }
      return
    }
    if (command === 'workspace-copy-path') {
      const value = await properties()
      if (value) await navigator.clipboard.writeText(value.absolutePath)
      return
    }
    if (command === 'workspace-properties') {
      const value = await properties()
      if (value) await businessDialogs.alert({
        title: '属性',
        description: propertiesText(value),
        confirmLabel: '确定',
      })
      return
    }
    if (command === 'workspace-trash') {
      if (target.kind === 'root' || !window.arkdown.trashWorkspaceEntry) return
      const confirmation = await businessDialogs.confirm({
        title: '移到回收站',
        description: `确定要将“${target.name}”移到回收站吗？`,
        confirmLabel: '移到回收站',
        cancelLabel: '取消',
        tone: 'danger',
      })
      if (confirmation !== 'confirm') return
      if (target.kind === 'directory') {
        const directoryConfirmation = await businessDialogs.confirm({
          title: '确认移动文件夹',
          description: '文件夹可能包含其他文件。确定要继续吗？',
          confirmLabel: '继续',
          cancelLabel: '取消',
          tone: 'danger',
        })
        if (directoryConfirmation !== 'confirm') return
      }
      const perform = async () => {
        await enqueueWorkspaceColorMutation(async (lifecycle) => {
          let result: Awaited<ReturnType<NonNullable<typeof window.arkdown.trashWorkspaceEntry>>>
          try {
            result = await window.arkdown.trashWorkspaceEntry!(target.relativePath)
          } catch (caught) {
            if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return
            await reloadWorkspaceColorSnapshot(lifecycle)
            if (isCurrentWorkspaceColorLifecycle(lifecycle)) {
              fail(caught instanceof Error ? caught.message : '移到回收站失败')
            }
            return
          }
          if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return
          if (!result.ok) {
            await reloadWorkspaceColorSnapshot(lifecycle)
            if (isCurrentWorkspaceColorLifecycle(lifecycle)) fail(result.error.message)
            return
          }
          if (!acceptWorkspaceColorSnapshot(result.value.colorMarks, lifecycle)) return
          if (affectsCurrent) session.clear()
          refresh()
        })
      }
      if (affectsCurrent) {
        invalidatePendingTranslationReveal()
        await session.transitionAfterSave(perform)
      } else {
        await perform()
      }
    }
  }, [
    acceptWorkspaceColorSnapshot,
    businessDialogs,
    chooseWorkspace,
    createDocument,
    enqueueWorkspaceColorMutation,
    invalidatePendingTranslationReveal,
    isCurrentWorkspaceColorLifecycle,
    openDocument,
    replaceWorkspaceColorMarks,
    reloadWorkspaceColorSnapshot,
    session.clear,
    session.open,
    session.state.relativePath,
    session.transitionAfterSave,
  ])
  const openDroppedWorkspace = useCallback((absolutePath: string) => {
    void (async () => {
      const inspectDroppedPath = window.arkdown.inspectDroppedPath
      if (!inspectDroppedPath) {
        setFileActionError('无法在切换工作区前验证目标路径')
        return
      }
      const inspected = await inspectDroppedPath(absolutePath)
      if (!inspected.ok) {
        setFileActionError(inspected.error.message)
        return
      }
      const targetWorkspace = workspacePathForDroppedInspection(inspected.value)
      if (!targetWorkspace) {
        setFileActionError('无法在切换工作区前验证目标路径')
        return
      }
      if (!(await confirmWorkspaceSwitch(targetWorkspace))) return
      invalidatePendingTranslationReveal()
      await session.transitionAfterSave(async () => {
        const result = await window.arkdown.openDroppedPath(inspected.value.absolutePath)
        if (!result.ok) {
          setFileActionError(result.error.message)
          return
        }
        setFileActionError(null)
        if (
          workspace
          && sameWorkspacePath(result.value.workspace.absolutePath, workspace.absolutePath)
        ) {
          if (result.value.document) {
            documentConversion.cancel()
            session.adopt(result.value.document)
          }
          return
        }
        onDroppedWorkspace(result.value.workspace, result.value.document)
      })
    })().catch((caught: unknown) => {
      setFileActionError(caught instanceof Error ? caught.message : '无法打开工作区')
    })
  }, [documentConversion.cancel, invalidatePendingTranslationReveal, onDroppedWorkspace,
    confirmWorkspaceSwitch, session.adopt, session.transitionAfterSave, workspace?.absolutePath])

  const insertDroppedPath = useCallback((input: DroppedLinkInsertion): boolean => {
    const inserted = editorRef.current?.insertDroppedLink(input) ?? false
    setFileActionError(inserted ? null : '无法在释放位置插入文件路径')
    return inserted
  }, [])

  const insertDroppedMarkdown = useCallback((input: DroppedMarkdownInsertion): boolean => {
    const inserted = editorRef.current?.insertDroppedMarkdown(input) ?? false
    setFileActionError(inserted ? null : '无法在释放位置插入资源')
    return inserted
  }, [])

  const chooseFolderDrop = useCallback((choice: FolderDropChoice) => {
    const pending = pendingFolderDrop
    setPendingFolderDrop(null)
    if (!pending || choice === 'cancel') return
    if (choice === 'path') {
      insertDroppedPath({ ...pending, kind: 'folder' })
      return
    }
    openDroppedWorkspace(pending.absolutePath)
  }, [insertDroppedPath, openDroppedWorkspace, pendingFolderDrop])

  const openDroppedFile = useCallback((
    file: File | string,
    overEditor: boolean,
    point: Pick<DroppedLinkInsertion, 'clientX' | 'clientY' | 'visualDropRequestId'>,
    inBody: boolean,
    dropController: AbortController,
  ) => {
    const inspectionRequest = ++droppedPathInspection.current
    const editorLifecycle = droppedEditorLifecycle.current
    const documentChangeGeneration = session.getDocumentChangeGeneration()
    const documentTransitionGeneration = session.getDocumentTransitionGeneration()
    const droppedEditor = editorRef.current
    const isCurrentDrop = () => (
      droppedPathInspection.current === inspectionRequest
      && droppedEditorLifecycle.current === editorLifecycle
      && session.getDocumentChangeGeneration() === documentChangeGeneration
      && session.getDocumentTransitionGeneration() === documentTransitionGeneration
      && editorRef.current === droppedEditor
    )
    const absolutePath = typeof file === 'string' ? file : window.arkdown.pathForDroppedFile(file)
    if (!absolutePath) {
      setFileActionError('无法读取拖入项目的 Windows 路径')
      return
    }
    const definition = documentTypeForPath(absolutePath)
    const resolveDocumentShortcut = !inBody && /\.lnk$/i.test(absolutePath)
    if (isDroppedDocumentLinkPath(absolutePath) || resolveDocumentShortcut) {
      const opensAtBlank = definition?.extension !== 'docx' && !inBody
      if (!overEditor && !opensAtBlank) {
        setFileActionError('请将文件拖入编辑区域')
        return
      }
      const inspectDroppedPath = window.arkdown.inspectDroppedPath
      if (!inspectDroppedPath) {
        setFileActionError('无法识别拖入项目')
        return
      }
      const inspection = resolveDocumentShortcut
        ? inspectDroppedPath(absolutePath, true) : inspectDroppedPath(absolutePath)
      void inspection.then(async (result) => {
        if (!isCurrentDrop()) return
        if (!result.ok) {
          setFileActionError(result.error.message)
          return
        }
        if (result.value.kind !== 'file') {
          setFileActionError('只能插入普通文件的路径')
          return
        }
        if (opensAtBlank) {
          const path = result.value.absolutePath
          const currentPath = workspace && session.state.relativePath
            ? workspaceChildPath(workspace.absolutePath, session.state.relativePath) : null
          if (currentPath && sameWorkspacePath(currentPath, path)) { setFileActionError(null); return }
          const targetWorkspace = workspacePathForDroppedInspection(result.value)
          if (!targetWorkspace) return
          if (!(await confirmWorkspaceSwitch(targetWorkspace)) || !isCurrentDrop()) return
          guardedDropRef.current = dropController
          const ownsDrop = () => !dropController.signal.aborted
          try {
            invalidatePendingTranslationReveal()
            await session.transitionAfterSave(async () => {
              const generation = session.getDocumentTransitionGeneration()
              const { prepareDroppedPath, settleDroppedPath } = window.arkdown
              if (!prepareDroppedPath || !settleDroppedPath) { setFileActionError('无法打开文档'); return }
              const changes = session.getDocumentChangeGeneration()
              const opened = await prepareDroppedPath(path)
              if (!opened.ok) {
                if (ownsDrop()) setFileActionError(opened.error.message)
                return
              }
              let settled = false
              let locked = false
              const canAccept = () => ownsDrop()
                && session.getDocumentTransitionGeneration() === generation
                && session.getDocumentChangeGeneration() === changes
              try {
                flushEditor()
                if (!canAccept()) return
                // Keep the current editor state while synchronously preventing new transactions.
                // A final checkpoint still reaches the session before its own lock is acquired.
                locked = true
                acceptingDropRef.current = true
                flushSync(() => setAcceptingDrop(true))
                flushEditor()
                if (!canAccept()) return
                session.setInteractionLocked(true)
                settled = true
                const accepted = await settleDroppedPath(opened.value.token, true)
                if (!accepted.ok) { setFileActionError(accepted.error.message); return }
                if (!accepted.value) { setFileActionError('无法打开文档'); return }
                setFileActionError(null)
                documentConversion.cancel()
                onDroppedWorkspace(accepted.value.workspace, accepted.value.document)
              } finally {
                try {
                  if (!settled) await settleDroppedPath(opened.value.token, false)
                } finally {
                  if (locked) {
                    session.setInteractionLocked(false)
                    acceptingDropRef.current = false
                    setAcceptingDrop(false)
                  }
                }
              }
            }, ownsDrop, {
              title: '打开新文档',
              description: `即将打开文档 ${path.replaceAll('\\', '/').split('/').at(-1)}，是否保存当前文档？`,
              signal: dropController.signal,
            })
          } finally {
            if (guardedDropRef.current === dropController) guardedDropRef.current = null
          }
          return
        }
        insertDroppedPath({ absolutePath: result.value.absolutePath, ...point, kind: 'file' })
      }, (caught: unknown) => {
        if (!isCurrentDrop()) return
        setFileActionError(caught instanceof Error ? caught.message : '无法识别拖入项目')
      }).catch((caught: unknown) => {
        if (!dropController.signal.aborted) setFileActionError(caught instanceof Error ? caught.message : '无法打开文档')
      })
      return
    }
    if (definition?.insertInEditor) {
      if (!overEditor) {
        setFileActionError('请将资源拖入编辑区域')
        return
      }
      if (!window.arkdown.importAsset) {
        setFileActionError('无法引用该资源')
        return
      }
      void window.arkdown.importAsset(absolutePath).then((result) => {
        if (!isCurrentDrop()) return
        if (!result.ok) {
          setFileActionError(result.error.message)
          return
        }
        insertDroppedMarkdown({ markdown: result.value.markdown, ...point })
      }, (caught: unknown) => {
        if (!isCurrentDrop()) return
        setFileActionError(caught instanceof Error ? caught.message : '无法引用该资源')
      })
      return
    }
    if (definition?.importWithPandoc) {
      if (!window.arkdown.openDocumentWindow) {
        setFileActionError('无法在新窗口中打开 DOCX')
        return
      }
      void window.arkdown.openDocumentWindow(absolutePath).then((result) => {
        if (!result.ok) setFileActionError(result.error.message)
        else setFileActionError(null)
      })
      return
    }
    if (!definition || !definition.openAsDocument) {
      const inspectDroppedPath = window.arkdown.inspectDroppedPath
      if (!inspectDroppedPath) {
        setFileActionError('无法识别拖入项目')
        return
      }
      void inspectDroppedPath(absolutePath).then((result) => {
        if (!isCurrentDrop()) return
        if (!result.ok) {
          setFileActionError(result.error.message)
          return
        }
        if (result.value.kind === 'directory') {
          setFileActionError(null)
          setPendingFolderDrop({ absolutePath: result.value.absolutePath, ...point })
          return
        }
        if (!overEditor) {
          setFileActionError('请将文件拖入编辑区域')
          return
        }
        insertDroppedPath({ absolutePath: result.value.absolutePath, ...point, kind: 'file' })
      }, (caught: unknown) => {
        if (!isCurrentDrop()) return
        setFileActionError(caught instanceof Error ? caught.message : '无法识别拖入项目')
      })
      return
    }
    if (
      definition?.openAsDocument
      && (session.state.relativePath !== null || session.state.markdown.trim() !== '')
      && window.arkdown.openDocumentWindow
    ) {
      void window.arkdown.openDocumentWindow(absolutePath).then((result) => {
        if (!result.ok) setFileActionError(result.error.message)
        else setFileActionError(null)
      })
      return
    }
    openDroppedWorkspace(absolutePath)
  }, [
    insertDroppedMarkdown,
    insertDroppedPath,
    openDroppedWorkspace,
    confirmWorkspaceSwitch,
    documentConversion.cancel,
    invalidatePendingTranslationReveal,
    onDroppedWorkspace,
    session.transitionAfterSave,
    workspace,
    session.getDocumentChangeGeneration,
    session.getDocumentTransitionGeneration,
    session.state.markdown,
    session.state.relativePath,
  ])

  const switchWorkspace = useCallback(async () => {
    invalidatePendingTranslationReveal()
    await session.transitionAfterSave(chooseWorkspace)
  }, [chooseWorkspace, invalidatePendingTranslationReveal, session.transitionAfterSave])
  const closePreferences = useCallback(() => {
    preferencesOpenRequest.current += 1
    activePreferencesOpenRequest.current = null
    preferencesRef.current = null
    setPreferencesTarget('top')
    setPreferences(null)
  }, [])
  const prepareClose = useCallback(
    async (context: ClosePreparationHandlerContext): Promise<ClosePreparationResult> => {
      if (preferencesRef.current) {
        closePreferences()
        return { status: 'cancelled' }
      }
      const update = await window.arkdown.getAppUpdateState?.()
      if (update && !update.ok) return { status: 'blocked', code: 'editor-unavailable' }
      const prepared = await session.prepareForClose(context.enter, { requireSaved: update?.ok && update.value.transfer?.phase === 'closing' })
      if (prepared.status !== 'ready') return prepared
      const lifecycle = session.getDocumentLifecycle()
      setClosePrepared(true)
      const result = await settleClosePreferences({ persistence: preferencePersistence, models: modelPreferences,
        api: window.arkdown, confirm: businessDialogs.confirm, enter: context.enter })
      if (!workspaceShellMounted.current || session.getDocumentLifecycle() !== lifecycle) return { status: 'cancelled' }
      return result
    },
    [closePreferences, preferencePersistence, modelPreferences, businessDialogs.confirm, session.prepareForClose, session.getDocumentLifecycle],
  )


  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.arkdown.getPreferenceSnapshot?.('appearance').then(result => {
        if (active && result.ok && result.value.group === 'appearance') acceptAppearanceSnapshot(result.value)
      }).catch(() => undefined)
    }
    refresh()
    const unsubscribe = window.arkdown.onEditorAppearancePreferencesChanged?.(refresh) ?? (() => undefined)
    window.addEventListener('focus', refresh)
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', refresh) }
  }, [acceptAppearanceSnapshot])

  const changeAppearanceFromMenu = useCallback((
    field: 'spellCheckEnabled' | 'showEditIndicators' | 'editorTheme',
    target: boolean | EditorTheme,
  ) => {
    if (appearanceMenuMutationPending.current) return
    if (!window.arkdown.patchPreferences || !preferenceDrafts.appearance.ready()) {
      setFileActionError('偏好设置不可用')
      return
    }
    appearanceMenuMutationPending.current = true
    void (async () => {
      const patch = { [field]: target }
      updatePreferences({ appearance: patch }, false)
      await preferencePersistence.drain()
    })().catch(() => {
      setFileActionError('操作未能完成，请重试。')
    }).finally(() => {
      appearanceMenuMutationPending.current = false
    })
  }, [preferenceDrafts, preferencePersistence])

  const openPreferences = useCallback((target: PreferencesOpenTarget = 'top') => {
    if (!workspaceShellMounted.current) return
    const request = ++preferencesOpenRequest.current
    activePreferencesOpenRequest.current = { request, target }
    if (
      !window.arkdown.getPreferenceSnapshot
      || !window.arkdown.getModelSettingsSnapshot
      || !window.arkdown.getArknotePreferences
    ) {
      activePreferencesOpenRequest.current = null
      setFileActionError('偏好设置不可用')
      return
    }
    const getPreferenceSnapshot = window.arkdown.getPreferenceSnapshot
    const getArknotePreferences = window.arkdown.getArknotePreferences
    void (async () => {
      await preferencePersistence.drain()
      if (!workspaceShellMounted.current || request !== preferencesOpenRequest.current) return null
      return await Promise.all([
        getPreferenceSnapshot('search'),
        getPreferenceSnapshot('appearance'),
        window.arkdown.getSystemFonts
          ? window.arkdown.getSystemFonts()
          : Promise.resolve({ ok: true as const, value: [...DEFAULT_FONT_CHOICES] }),
        window.arkdown.getModelSettingsSnapshot(),
        getArknotePreferences(),
      ])
    })().then((results) => {
      if (!results) return
      const [searchResult, appearanceResult, fontsResult, largeModelsResult, arknoteResult] = results
      if (
        request !== preferencesOpenRequest.current
        || activePreferencesOpenRequest.current?.request !== request
      ) return
      activePreferencesOpenRequest.current = null
      if (!searchResult.ok) {
        setFileActionError(searchResult.error.message)
        return
      }
      if (!appearanceResult.ok) {
        setFileActionError(appearanceResult.error.message)
        return
      }
      if (!largeModelsResult.ok) {
        setFileActionError(largeModelsResult.error.message)
        return
      }
      if (!arknoteResult.ok) {
        setFileActionError(arknoteResult.error.message)
        return
      }
      if (searchResult.value.group !== 'search' || appearanceResult.value.group !== 'appearance') {
        setFileActionError('偏好设置不可用')
        return
      }
      preferenceDrafts.search.adopt(searchResult.value)
      modelPreferences.accept(largeModelsResult.value)
      searchFormObservationRef.current = searchResult.value
      acceptAppearanceSnapshot(appearanceResult.value)
      const snapshotAppearance = preferenceDrafts.appearance.view()
      if (arknoteResult.value.themeColor !== snapshotAppearance.themeColor) {
        void window.arkdown.previewArknoteThemeColor?.(snapshotAppearance.themeColor)
      }
      setFileActionError(null)
      const snapshot = {
        search: preferenceDrafts.search.view(),
        appearance: snapshotAppearance,
        systemFonts: fontsResult.ok ? fontsResult.value : [...DEFAULT_FONT_CHOICES],
        largeModels: largeModelsResult.value.settings,
        arknote: arknoteResult.value,
      }
      preferencesRef.current = snapshot
      persistedPreferencesRef.current = snapshot
      setPreferencesPersistenceError(Object.values(preferencePersistence.snapshot().failures).flatMap(failure => failure ? [failure.message] : []).join(' ') || null)
      setPreferencesTarget(target)
      setPreferencesPageSession(request)
      setPreferences(snapshot)
    }, () => {
      if (
        request !== preferencesOpenRequest.current
        || activePreferencesOpenRequest.current?.request !== request
      ) return
      activePreferencesOpenRequest.current = null
      setFileActionError('操作未能完成，请重试。')
    })
  }, [acceptAppearanceSnapshot, preferenceDrafts, preferencePersistence, modelPreferences])

  const reportPreferenceErrors = useCallback(() => {
    if (!workspaceShellMounted.current) return
    const message = Object.values(preferencePersistence.snapshot().failures).flatMap(failure => failure ? [failure.message] : []).join(' ') || null
    setPreferencesPersistenceError(message)
    setFileActionError(message)
  }, [preferencePersistence])
  const persistAppearanceUpdate = useCallback(async (attempts: readonly PreferenceDraftAttempt<'appearance'>[]) => {
    const api = window.arkdown.patchPreferences
    if (!api) throw new PreferenceUpdateError('偏好设置不可用')
    for (const attempt of attempts) {
      try {
        const result = await api({ observed: attempt.observed, changes: attempt.changes })
        if (!result.ok) throw new PreferenceUpdateError(result.error.message)
        const mutation = result.value
        if (mutation.snapshot.group !== 'appearance') throw new PreferenceUpdateError('偏好设置不可用')
        preferenceDrafts.appearance.finish(attempt, mutation.status === 'conflict'
          ? { status: 'conflict', snapshot: mutation.snapshot, reason: mutation.reason, fields: [] }
          : { status: mutation.status, snapshot: mutation.snapshot })
        if (mutation.status !== 'conflict') for (const field of Object.keys(attempt.changes) as Array<keyof EditorAppearancePreferences>) {
          if (!Object.hasOwn(preferenceDrafts.appearance.dirty(), field)) appearanceMenuFieldsRef.current.delete(field)
        }
        acceptAppearanceSnapshot(mutation.snapshot)
        if (mutation.status === 'conflict') throw new PreferenceUpdateError('这些设置已在其他窗口更改。你的修改仍保留，请重新加载已保存设置后再调整。')
      } catch (error) { preferenceDrafts.appearance.fail(attempt); throw error }
    }
    if (preferenceDrafts.appearance.hasFailures()) throw new PreferenceUpdateError('仍有未保存的外观修改，请重新加载已保存设置后再调整。')
  }, [acceptAppearanceSnapshot, preferenceDrafts])
  const updatePreferences = useCallback((update: PreferenceUpdate, previewAppearance = true) => {
    if (!workspaceShellMounted.current) return
    if (update.search) preferenceDrafts.search.edit(update.search, searchFormObservationRef.current ?? preferenceDrafts.search.snapshot())
    if (update.appearance) {
      for (const field of Object.keys(update.appearance) as Array<keyof EditorAppearancePreferences>) {
        if (previewAppearance) appearanceMenuFieldsRef.current.delete(field)
        else appearanceMenuFieldsRef.current.add(field)
      }
      preferenceDrafts.appearance.edit(update.appearance)
    }
    // A read started before this edit is no longer a valid display or rollback baseline.
    preferencesOpenRequest.current += 1
    activePreferencesOpenRequest.current = null
    if (!preferenceUpdateQueueRef.current) {
      preferenceUpdateQueueRef.current = preferencePersistence.createQueue({
        write: async (batch) => {
          // Fix every category's lineage before any earlier category awaits IPC.
          const searchAttempts = batch.search ? preferenceDrafts.search.begin(batch.search) : []
          const appearanceAttempts = batch.appearance ? preferenceDrafts.appearance.begin(batch.appearance) : []
          const outcomes: PreferenceBatchResult = {}
          const saveCategory = async (category: keyof PreferenceUpdate, write: () => Promise<void>) => {
            try {
              await write()
              outcomes[category] = { ok: true }
            } catch (error) {
              outcomes[category] = { ok: false,
                message: error instanceof PreferenceUpdateError ? error.message : '操作未能完成，请重试。',
                persisted: error instanceof PreferenceUpdateError && error.persisted,
              }
            }
          }
          if (batch.search) await saveCategory('search', async () => {
            for (const attempt of searchAttempts) {
              try {
                const result = await window.arkdown.patchPreferences?.({ observed: attempt.observed, changes: attempt.changes })
                if (!result) throw new PreferenceUpdateError('偏好设置不可用')
                if (!result.ok) throw new PreferenceUpdateError(result.error.message)
                const mutation = result.value
                if (mutation.snapshot.group !== 'search') throw new PreferenceUpdateError('偏好设置不可用')
                preferenceDrafts.search.finish(attempt, mutation.status === 'conflict'
                  ? { status: 'conflict', snapshot: mutation.snapshot, reason: mutation.reason, fields: [] }
                  : { status: mutation.status, snapshot: mutation.snapshot })
                if (mutation.status === 'conflict') throw new PreferenceUpdateError('这些设置已在其他窗口更改。你的修改仍保留，请重新加载已保存设置后再调整。')
                searchFormObservationRef.current = mutation.snapshot
              } catch (error) { preferenceDrafts.search.fail(attempt); throw error }
            }
            const current = persistedPreferencesRef.current
            if (current) persistedPreferencesRef.current = { ...current, search: preferenceDrafts.search.snapshot().values }
            if (preferenceDrafts.search.hasFailures()) throw new PreferenceUpdateError('仍有未保存的搜索修改，请重新加载已保存设置后再调整。')
          })
          if (batch.appearance) await saveCategory('appearance', async () => {
            await persistAppearanceUpdate(appearanceAttempts)
          })
          if (batch.arknote) await saveCategory('arknote', async () => {
            // Read the latest Arknote settings so changing one preference does
            // not overwrite other settings changed in the standalone window.
            const currentResult = await window.arkdown.getArknotePreferences?.()
            if (!currentResult) throw new PreferenceUpdateError('偏好设置不可用')
            if (!currentResult.ok) throw new PreferenceUpdateError(currentResult.error.message)
            const submitted = arknotePreferencesForUpdate(
              currentResult.value,
              { ...batch.arknote, themeColor: persistedAppearanceRef.current.themeColor },
            )
            const result = await window.arkdown.setArknotePreferences?.(submitted)
            if (!result) throw new PreferenceUpdateError('偏好设置不可用')
            if (!result.ok) {
              if (result.error.code === 'WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED') {
                // Persistence succeeded. Retain the accepted write even if the
                // saved-state refresh fails, rather than roll back to old recipes.
                let saved = copyArknotePreferences({ ...currentResult.value, ...submitted })
                try {
                  const refreshed = await window.arkdown.getArknotePreferences?.()
                  if (refreshed?.ok) saved = refreshed.value
                } catch { /* the acknowledged write remains our saved baseline */ }
                const current = persistedPreferencesRef.current
                if (current) persistedPreferencesRef.current = { ...current, arknote: saved }
                // onSettled overlays newer queued edits on this baseline.
              }
              throw new PreferenceUpdateError(result.error.message, result.error.code === 'WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED')
            }
            const current = persistedPreferencesRef.current
            if (current) persistedPreferencesRef.current = { ...current, arknote: result.value }
          })
          return outcomes
        },
        onSettled: () => { reflectPreferenceUpdates(); reportPreferenceErrors() },
        onError: () => {
          if (!workspaceShellMounted.current) return
          setPreferencesPersistenceError('设置保存失败，请重新调整该设置以重试。')
          setFileActionError('设置保存失败，请重新调整该设置以重试。')
        },
      })
    }
    reportPreferenceErrors()
    preferenceUpdateQueueRef.current.enqueue(update)
    reflectPreferenceUpdates()
  }, [preferenceDrafts, preferencePersistence, persistAppearanceUpdate, reflectPreferenceUpdates, reportPreferenceErrors])
  const updateSearchPreferences = useCallback((search: Partial<BrowserSearchPreferences>) => {
    updatePreferences({ search })
  }, [updatePreferences])
  const reloadSavedPreferences = useCallback(async () => {
    await preferencePersistence.drain()
    const searchGeneration = preferenceDrafts.search.editGeneration()
    const appearanceGeneration = preferenceDrafts.appearance.editGeneration()
    const api = window.arkdown.getPreferenceSnapshot
    if (!api) return
    try {
      const [search, appearance] = await Promise.all([api('search'), api('appearance')])
      if (!workspaceShellMounted.current) return
      if (searchGeneration !== preferenceDrafts.search.editGeneration()
        || appearanceGeneration !== preferenceDrafts.appearance.editGeneration()) return
      if (!search.ok) throw new PreferenceUpdateError(search.error.message)
      if (!appearance.ok) throw new PreferenceUpdateError(appearance.error.message)
      if (search.value.group !== 'search' || appearance.value.group !== 'appearance') throw new PreferenceUpdateError('偏好设置不可用')
      searchFormObservationRef.current = search.value
      const searchChanges = preferenceDrafts.search.reload(search.value)
      const appearanceChanges = preferenceDrafts.appearance.reload(appearance.value)
      updatePreferences({ ...(Object.keys(searchChanges).length ? { search: searchChanges } : {}),
        ...(Object.keys(appearanceChanges).length ? { appearance: appearanceChanges } : {}) })
      acceptAppearanceSnapshot(appearance.value)
      setPreferenceReloadEpoch(value => value + 1)
      reflectPreferenceUpdates()
    } catch (error) {
      setPreferencesPersistenceError(error instanceof PreferenceUpdateError ? error.message : '无法重新加载设置。')
    }
  }, [acceptAppearanceSnapshot, preferenceDrafts, preferencePersistence, reflectPreferenceUpdates, updatePreferences])
  const reloadSavedLayout = useCallback(async () => {
    await preferencePersistence.drain()
    const generation = preferenceDrafts.layout.editGeneration()
    try {
      const result = await window.arkdown.getPreferenceSnapshot?.('layout')
      if (!workspaceShellMounted.current) return
      if (generation !== preferenceDrafts.layout.editGeneration()) return
      if (!result?.ok || result.value.group !== 'layout') throw new Error('unavailable')
      const changes = preferenceDrafts.layout.reload(result.value)
      queueLayoutUpdate(changes)
    } catch { setLayoutPersistenceError('无法重新加载窗口布局。') }
  }, [preferenceDrafts, preferencePersistence, queueLayoutUpdate])
  const updateAppearancePreferences = useCallback((patch: Partial<EditorAppearancePreferences>) => {
    updatePreferences({
      appearance: patch,
      ...(patch.themeColor ? { arknote: { themeColor: patch.themeColor } } : {}),
    })
  }, [updatePreferences])
  const updateArknotePreferences = useCallback((arknote: Partial<ArknotePreferences>) => {
    updatePreferences({ arknote })
  }, [updatePreferences])
  const updateDesktopContextMenu = useCallback(async (registerDesktopContextMenu: boolean) => {
    updatePreferences({ arknote: { registerDesktopContextMenu } })
    await preferencePersistence.drain()
    const error = preferencePersistence.snapshot().failures.arknote
    if (error) throw new PreferenceUpdateError(error.message, error.persisted)
    if (persistedPreferencesRef.current?.arknote.registerDesktopContextMenu !== registerDesktopContextMenu) {
      throw new PreferenceUpdateError('右键菜单设置未能保存，请重试。')
    }
  }, [preferencePersistence, updatePreferences])
  const acceptLargeModelSettings = useCallback((largeModels: LargeModelSettings) => {
    if (!workspaceShellMounted.current) return
    preferencesOpenRequest.current += 1
    activePreferencesOpenRequest.current = null
    if (persistedPreferencesRef.current) {
      persistedPreferencesRef.current = { ...persistedPreferencesRef.current, largeModels }
    }
    const current = preferencesRef.current
    if (current) {
      const next = { ...current, largeModels }
      preferencesRef.current = next
      setPreferences(next)
    }
    setTranslationSettingsRevision((revision) => revision + 1)
  }, [])
  const closeStickyNoteBox = useCallback(() => {
    stickyNoteBoxOpenRef.current = false
    if (stickyNoteBoxOpenFrame.current !== null) {
      window.cancelAnimationFrame(stickyNoteBoxOpenFrame.current)
      stickyNoteBoxOpenFrame.current = null
    }
    setStickyNoteBoxOpen(false)
  }, [])
  const openStickyNoteBox = useCallback(() => {
    stickyNoteBoxOpenRef.current = true
    setStickyNoteBoxMounted(true)
    if (stickyNoteBoxOpenFrame.current !== null) {
      window.cancelAnimationFrame(stickyNoteBoxOpenFrame.current)
    }
    stickyNoteBoxOpenFrame.current = window.requestAnimationFrame(() => {
      if (!stickyNoteBoxOpenRef.current) {
        stickyNoteBoxOpenFrame.current = null
        return
      }
      stickyNoteBoxOpenFrame.current = window.requestAnimationFrame(() => {
        stickyNoteBoxOpenFrame.current = null
        if (stickyNoteBoxOpenRef.current) setStickyNoteBoxOpen(true)
      })
    })
  }, [])
  const toggleStickyNoteBox = useCallback(() => {
    if (stickyNoteBoxOpenRef.current) {
      closeStickyNoteBox()
      return
    }
    if (arknoteConnecting.current) return
    if (!window.arkdown.connectArknote) {
      openStickyNoteBox()
      return
    }
    arknoteConnecting.current = true
    const connectionEpoch = ++arknoteConnectionEpoch.current
    void window.arkdown.connectArknote().then((result) => {
      if (connectionEpoch !== arknoteConnectionEpoch.current) return
      if (!result.ok) {
        setFileActionError('无法启动 Arknote')
        return
      }
      // Keep the closing panel intact; only replace its list/subscriptions after
      // the user's next explicit connection has succeeded.
      if (arknoteDisconnectNotified.current) setStickyNoteBoxPanelVersion((version) => version + 1)
      arknoteDisconnectNotified.current = false
      setFileActionError(null)
      openStickyNoteBox()
    }, () => {
      if (connectionEpoch === arknoteConnectionEpoch.current) setFileActionError('无法启动 Arknote')
    }).finally(() => {
      if (connectionEpoch === arknoteConnectionEpoch.current) arknoteConnecting.current = false
    })
  }, [closeStickyNoteBox, openStickyNoteBox])

  useEffect(() => () => {
    if (stickyNoteBoxOpenFrame.current !== null) {
      window.cancelAnimationFrame(stickyNoteBoxOpenFrame.current)
    }
  }, [])

  useEffect(() => window.arkdown.onArknoteServiceEvent?.(() => {
    arknoteConnectionEpoch.current += 1
    arknoteConnecting.current = false
    if (arknoteDisconnectNotified.current) return
    arknoteDisconnectNotified.current = true
    closeStickyNoteBox()
    setFileActionError('Arknote 服务已断开')
  }) ?? (() => undefined), [closeStickyNoteBox])
  const createBlankDocument = useCallback(async () => {
    invalidatePendingTranslationReveal()
    await session.transitionAfterSave(async () => {
      session.clear()
      setUntitledDocumentKey(createUntitledDocumentKey())
    })
  }, [invalidatePendingTranslationReveal, session.transitionAfterSave, session.clear])
  useEffect(() => {
    const act = (event: Event) => {
      const action = (event as CustomEvent).detail
      if (action === 'choose-workspace') void switchWorkspace()
      else if (action === 'new-document') void createBlankDocument()
    }
    window.addEventListener('arkdown:welcome-action', act)
    return () => window.removeEventListener('arkdown:welcome-action', act)
  }, [switchWorkspace, createBlankDocument])
  useEffect(() => window.arkdown.onMenuCommand?.((command: MenuCommand) => {
    if (acceptingDropRef.current) return
    if (document.activeElement?.closest('.document-view-panel')) {
      if (command === 'find-in-document' || command === 'toggle-document-find') {
        window.dispatchEvent(new CustomEvent('arkdown:document-view-command', { detail: command }))
        return
      }
      if (['save', 'save-as', 'export-docx', 'export-xlsx', 'print-document', 'toggle-source-mode', 'toggle-document-outline'].includes(command)) return
    }
    if (command === 'shortcut-settings') {
      setKeyboardShortcutsOpen(true)
      return
    }
    if (command === 'about') {
      setAboutOpen(true)
      return
    }
    if (command === 'select-editor-theme-system' || command === 'select-editor-theme-minimal' || command === 'select-editor-theme-dark') {
      changeAppearanceFromMenu('editorTheme', command === 'select-editor-theme-system' ? 'system' : command === 'select-editor-theme-dark' ? 'dark' : 'minimal')
      return
    }
    if (command === 'open-sticky-note-box') {
      if (!stickyNoteBoxOpen) toggleStickyNoteBox()
      return
    }
    if (command === 'open-workspace') {
      void switchWorkspace()
      return
    }
    if (command === 'save') {
      void session.save()
      return
    }
    if (command === 'save-as') {
      void session.saveAs()
      return
    }
    if (command === 'export-docx') {
      if (!window.arkdown.exportDocx) {
        setFileActionError('DOCX 导出不可用')
        return
      }
      const markdown = editorRef.current?.flush() ?? session.state.markdown
      const sourceName = session.state.displayName
        ?? session.state.relativePath?.split('/').at(-1)
        ?? '导出的文档'
      const suggestedBaseName = sourceName.replace(/\.[^.]+$/u, '') || '导出的文档'
      void (async () => {
        const result = await window.arkdown.exportDocx?.({
          documentSessionId: session.documentExportSessionId,
          markdown,
          mode: 'choose',
          suggestedBaseName,
        })
        if (!result?.ok) {
          if (result) setFileActionError(result.error.message)
          return
        }
        setFileActionError(null)
      })()
      return
    }
    if (command === 'export-xlsx') {
      if (!window.arkdown.exportXlsx) {
        setFileActionError('XLSX 导出不可用')
        return
      }
      const markdown = editorRef.current?.flush() ?? session.state.markdown
      const sourceName = session.state.displayName
        ?? session.state.relativePath?.split('/').at(-1)
        ?? '导出的文档'
      const suggestedBaseName = sourceName.replace(/\.[^.]+$/u, '') || '导出的文档'
      void window.arkdown.exportXlsx({ markdown, suggestedBaseName }).then((result) => {
        if (!result.ok) setFileActionError(result.error.message)
        else setFileActionError(null)
      })
      return
    }
    if (command === 'print-document') {
      const markdown = editorRef.current?.flush() ?? session.state.markdown
      if (!markdown.trim()) return
      const currentFileName = session.state.relativePath?.split('/').at(-1)
      const documentName = session.state.displayName ?? currentFileName ?? 'Untitled'
      const currentRelativePath = session.state.relativePath ?? session.state.sourceRelativePath
      const currentAbsolutePath = workspace && currentRelativePath
        ? workspaceChildPath(workspace.absolutePath, currentRelativePath)
        : (
            initialImportedDocx
            && session.state.relativePath === null
            && session.state.sourceRelativePath === null
            && session.state.displayName === initialImportedDocx.sourceFileName
              ? initialImportedDocx.sourceAbsolutePath
              : null
          )
      void window.arkdown.printDocument({
        markdown,
        documentName,
        appearance,
        documentAbsolutePath: currentAbsolutePath,
      }).then((result) => {
        setFileActionError(result.ok ? null : result.error.message)
      }, () => setFileActionError('Unable to print document'))
      return
    }
    if (command === 'toggle-spell-check') {
      changeAppearanceFromMenu('spellCheckEnabled', !persistedAppearanceRef.current.spellCheckEnabled)
      return
    }
    if (command === 'toggle-edit-indicators') {
      changeAppearanceFromMenu('showEditIndicators', !persistedAppearanceRef.current.showEditIndicators)
      return
    }
    if (
      command === 'editor-zoom-in'
      || command === 'editor-zoom-out'
      || command === 'editor-zoom-reset'
    ) {
      const action = command === 'editor-zoom-in'
        ? 'in'
        : command === 'editor-zoom-out' ? 'out' : 'reset'
      onEditorZoom(action)
      return
    }
    if (command === 'new-document') {
      void createBlankDocument()
      return
    }
    if (command === 'toggle-sidebar') {
      setSidebarVisible((visible) => !visible)
      return
    }
    if (command === 'preferences') {
      openPreferences()
      return
    }
    if (command === 'screenshot-translation-settings') {
      openPreferences('large-model-manager')
      return
    }
    if (command === 'close-window') {
      window.close()
      return
    }
    window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: command }))
  }) ?? (() => {}), [
    createBlankDocument, session.clear, session.save, session.saveAs, session.state.markdown,
    session.state.displayName, session.state.relativePath, session.state.sourceRelativePath,
    session.transitionAfterSave, switchWorkspace, openPreferences,
    stickyNoteBoxOpen, toggleStickyNoteBox, appearance, initialImportedDocx, workspace,
    createUntitledDocumentKey, invalidatePendingTranslationReveal, onEditorZoom,
    changeAppearanceFromMenu,
  ])
  useEffect(() => {
    const applyBodyParagraphShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented
        || event.isComposing
        || event.repeat
        || event.code !== 'Backquote'
        || (!event.ctrlKey && !event.metaKey)
        || event.altKey
        || event.shiftKey
      ) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.editor-host, .ProseMirror, .cm-content')) {
        return
      }
      event.preventDefault()
      window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: 'paragraph' }))
    }
    window.addEventListener('keydown', applyBodyParagraphShortcut)
    return () => window.removeEventListener('keydown', applyBodyParagraphShortcut)
  }, [])
  useEffect(() => {
    const supersedesMountedConversion = initialAdoptionEffectHasRunRef.current
    initialAdoptionEffectHasRunRef.current = true
    if (initialRecovery) {
      if (consumedRecoveryRef.current === initialRecovery) return
      consumedRecoveryRef.current = initialRecovery
      session.recover(
        initialRecovery.intent.draftId,
        initialRecovery.intent.markdown,
        initialRecovery.snapshot,
        initialRecovery.conflict,
      )
      // Recovery adopts a new document lifetime even if its path is still the
      // same untitled key. Recreate the visual editor from the recovered payload.
      setRecoveryEditorGeneration(generation => generation + 1)
      onRecoveryHandled()
      return
    }
    if (initialImportedDocx) {
      if (consumedInitialImportedDocxRef.current !== initialImportedDocx) {
        consumedInitialImportedDocxRef.current = initialImportedDocx
        if (supersedesMountedConversion) documentConversion.cancel()
        session.adoptImportedDocx(initialImportedDocx)
      }
      return
    }
    if (initialSavedAsTransition) {
      if (consumedSavedAsTransitionRef.current !== initialSavedAsTransition) {
        consumedSavedAsTransitionRef.current = initialSavedAsTransition
        session.adoptSavedAs(initialSavedAsTransition)
        locateWorkspaceEntry(initialSavedAsTransition.result.document.relativePath)
        onSavedAsTransitionHandled(initialSavedAsTransition)
      }
      return
    }
    if (initialDocument && consumedInitialDocumentRef.current !== initialDocument) {
      consumedInitialDocumentRef.current = initialDocument
      if (supersedesMountedConversion) documentConversion.cancel()
      session.adopt(initialDocument)
    }
  }, [documentConversion.cancel, locateWorkspaceEntry, initialDocument, initialImportedDocx, initialRecovery, initialSavedAsTransition,
    onRecoveryHandled, onSavedAsTransitionHandled, session.adopt, session.adoptImportedDocx,
    session.adoptSavedAs, session.recover])
  // Publish close ownership after the saved continuation has actually been
  // adopted. A new shell alone is not proof that it owns this close's document.
  useEffect(() => installCloseHandler(prepareClose, () => {
    session.setInteractionLocked(false)
    setClosePrepared(false)
  }, closeOwnerRef.current, consumedSavedAsTransitionRef.current, session.getDocumentLifecycle),
  [installCloseHandler, prepareClose, session.setInteractionLocked, session.getDocumentLifecycle, initialSavedAsTransition])
  const fileName = session.state.relativePath?.split('/').at(-1)
  const label = session.state.displayName ?? fileName ?? '未命名'
  const editorRelativePath = session.state.relativePath ?? session.state.sourceRelativePath
  const documentAbsolutePath = workspace && editorRelativePath
    ? workspaceChildPath(workspace.absolutePath, editorRelativePath)
    : (
        initialImportedDocx
        && session.state.relativePath === null
        && session.state.sourceRelativePath === null
        && session.state.displayName === initialImportedDocx.sourceFileName
          ? initialImportedDocx.sourceAbsolutePath
          : null
      )
  const translationDocumentKey = documentAbsolutePath
    ?? untitledDocumentKey
  const rightSidebarState: EditorRightSidebarState = {
    open: rightSidebarOpen,
    activeTab: rightSidebarTab,
  }
  const editIndicatorModel = useEditIndicatorModel({
    documentKey: translationDocumentKey,
    openingMarkdown: session.state.openingMarkdown,
    savedMarkdown: session.state.savedMarkdown,
    currentMarkdown: session.state.markdown,
    enabled: editorMode === 'source',
  })
  activeTranslationDocumentRef.current = {
    documentKey: translationDocumentKey,
    workspaceAbsolutePath: workspace?.absolutePath ?? null,
    documentRelativePath: editorRelativePath,
    documentAbsolutePath,
    documentRevision: session.state.revision,
  }
  const consumePendingTranslationReveal = useCallback((
    readyDocumentKey: string,
    readyMode: EditorMode,
  ) => {
    const pending = translationNavigation.pendingRef.current
    if (!pending || !sameDocumentKey(pending.documentKey, readyDocumentKey)) return
    if (!sameDocumentKey(translationDocumentKey, readyDocumentKey)) return
    const record = translationHistory.records.find(({ id }) => id === pending.recordId)
    if (!record || !sameDocumentKey(record.documentKey, pending.documentKey)) {
      translationNavigation.pendingRef.current = null
      return
    }
    if (record.mode !== readyMode || record.anchor.status !== 'valid') {
      if (record.mode === readyMode) translationNavigation.pendingRef.current = null
      return
    }
    const identityMatches = record.documentKey.startsWith('__untitled__:')
      ? record.documentKey === translationDocumentKey
        && record.documentRevision === null
        && session.state.revision === null
      : record.documentRevision === null
        ? session.state.revision === null
        : record.documentRevision === session.state.revision
    if (!identityMatches) {
      translationNavigation.pendingRef.current = null
      return
    }
    const editor = editorRef.current
    if (!editor) return
    translationNavigation.pendingRef.current = null
    if (pending.alignment === 'center') {
      editor.revealTranslationHistoryRecord(record.id, 'center')
    } else {
      editor.revealTranslationHistoryRecord(record.id)
    }
  }, [
    session.state.revision,
    translationDocumentKey,
    translationHistory,
    translationNavigation,
  ])

  const navigateToTranslationHistoryRecord = useCallback(async (
    recordId: string,
    alignment: import('../editor/translation-history').TranslationHistoryRevealAlignment = 'nearest',
  ) => {
    const record = translationHistory.records.find(({ id }) => id === recordId)
    if (!record) {
      invalidatePendingTranslationReveal()
      return
    }
    translationHistory.selectById(recordId)
    for (const update of editorRef.current?.flushTranslationHistoryAnchors() ?? []) {
      translationHistory.updateAnchor(update.recordId, update.anchor)
    }

    const generation = ++translationNavigation.generationRef.current
    translationNavigation.pendingRef.current = {
      documentKey: record.documentKey,
      recordId,
      generation,
      alignment,
    }
    if (record.anchor.status !== 'valid') {
      translationNavigation.pendingRef.current = null
      return
    }

    if (sameDocumentKey(record.documentKey, translationDocumentKey)) {
      if (record.mode === editorMode) {
        consumePendingTranslationReveal(translationDocumentKey, editorMode)
      } else {
        window.dispatchEvent(new CustomEvent('arkdown:editor-command', {
          detail: 'toggle-source-mode',
        }))
      }
      return
    }

    if (!record.documentRelativePath || !record.workspaceAbsolutePath) {
      translationNavigation.pendingRef.current = null
      return
    }

    let outcome: DocumentOpenResult
    try {
      if (
        workspace
        && normalizeSavedDocumentKey(workspace.absolutePath)
          === normalizeSavedDocumentKey(record.workspaceAbsolutePath)
      ) {
        outcome = await session.open(record.documentRelativePath)
      } else if (record.documentAbsolutePath) {
        if (!(await confirmWorkspaceSwitch(record.workspaceAbsolutePath))) {
          translationNavigation.pendingRef.current = null
          return
        }
        let droppedOutcome: DocumentOpenResult = { status: 'cancelled' }
        const transitioned = await session.transitionAfterSave(async () => {
          const opened = await window.arkdown.openDroppedPath(record.documentAbsolutePath!)
          if (!opened.ok) {
            droppedOutcome = opened.error.code === 'FILE_NOT_FOUND'
              ? { status: 'missing' }
              : { status: 'failed', message: opened.error.message }
            return
          }
          if (!opened.value.document) {
            droppedOutcome = { status: 'missing' }
            return
          }
          droppedOutcome = { status: 'opened' }
          onDroppedWorkspace(opened.value.workspace, opened.value.document)
        })
        outcome = transitioned ? droppedOutcome : { status: 'cancelled' }
      } else {
        outcome = { status: 'missing' }
      }
    } catch (error) {
      outcome = {
        status: 'failed',
        message: error instanceof Error && error.message
          ? error.message
          : 'Unable to open translation history document.',
      }
    }

    const currentPending = translationNavigation.pendingRef.current
    if (!currentPending || currentPending.generation !== generation) return
    if (outcome.status !== 'opened') {
      translationNavigation.pendingRef.current = null
      if (outcome.status === 'failed') setFileActionError(outcome.message)
    }
  }, [
    consumePendingTranslationReveal,
    confirmWorkspaceSwitch,
    editorMode,
    invalidatePendingTranslationReveal,
    onDroppedWorkspace,
    session.open,
    session.transitionAfterSave,
    translationDocumentKey,
    translationHistory,
    translationNavigation,
    workspace,
  ])
  translationNavigation.delegateRef.current = (recordId, alignment) => {
    void navigateToTranslationHistoryRecord(recordId, alignment)
  }

  const hasPrintableDocument = session.state.markdown.trim().length > 0
  const pendingTranslationRecord = translationNavigation.pendingRef.current
    && sameDocumentKey(
      translationNavigation.pendingRef.current.documentKey,
      translationDocumentKey,
    )
    ? translationHistory.records.find(
      ({ id }) => id === translationNavigation.pendingRef.current?.recordId,
    ) ?? null
    : null

  useEffect(() => window.arkdown.onApplicationMenuChanged((model) => {
    setApplicationMenuModel(model)
  }), [])

  useEffect(() => {
    void window.arkdown.updateApplicationMenuWindowState({
      editorTheme: appearance.editorTheme,
      hasPrintableDocument,
      spellCheckEnabled: appearance.spellCheckEnabled,
      showEditIndicators: appearance.showEditIndicators,
      editorZoomPercent,
      fullscreen: windowState.fullscreen,
    }).then((result) => {
      if (!result.ok) setFileActionError(result.error.message)
    })
  }, [
    appearance.editorTheme,
    appearance.showEditIndicators,
    appearance.spellCheckEnabled,
    editorZoomPercent,
    hasPrintableDocument,
    windowState.fullscreen,
  ])

  useEffect(() => {
    if (session.state.status !== 'ready' || !documentAbsolutePath) return
    const attempt = recentDocumentRecordTracker.current.begin({
      absolutePath: documentAbsolutePath,
      revision: session.state.revision,
      savedMarkdown: session.state.savedMarkdown,
    })
    if (!attempt) return
    void window.arkdown.recordRecentDocument(documentAbsolutePath).then((result) => {
      attempt.complete(result.ok)
      if (!result.ok) setFileActionError(result.error.message)
    }, () => attempt.complete(false))
  }, [
    documentAbsolutePath,
    session.state.revision,
    session.state.savedMarkdown,
    session.state.status,
  ])
  const renameHeaderDocument = useCallback(async (input: string): Promise<boolean> => {
    flushEditor()
    const normalized = normalizeHeaderFileName(
      input,
      label,
      Boolean(session.state.relativePath),
    )
    if (!normalized.ok) {
      setFileActionError(normalized.message)
      return false
    }
    setFileActionError(null)
    if (normalized.value === label) return true
    invalidatePendingTranslationReveal()

    const currentPath = session.state.relativePath
    if (!currentPath) {
      session.setDisplayName(normalized.value)
      return true
    }
    if (!window.arkdown.renameWorkspaceEntry) {
      setFileActionError('重命名功能不可用。')
      return false
    }

    return (await enqueueWorkspaceColorMutation(async (lifecycle) => {
      let result: Awaited<ReturnType<NonNullable<typeof window.arkdown.renameWorkspaceEntry>>>
      try {
        result = await window.arkdown.renameWorkspaceEntry!(currentPath, normalized.value)
      } catch (caught) {
        if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return false
        await reloadWorkspaceColorSnapshot(lifecycle)
        if (isCurrentWorkspaceColorLifecycle(lifecycle)) {
          setFileActionError(caught instanceof Error ? caught.message : '重命名失败')
        }
        return false
      }
      if (!isCurrentWorkspaceColorLifecycle(lifecycle)) return false
      if (!result.ok) {
        await reloadWorkspaceColorSnapshot(lifecycle)
        if (isCurrentWorkspaceColorLifecycle(lifecycle)) {
          setFileActionError(result.error.message)
        }
        return false
      }
      if (!acceptWorkspaceColorSnapshot(result.value.colorMarks, lifecycle)) return false
      session.rebindPath(result.value.entry.relativePath)
      setRefreshVersion((version) => version + 1)
      locateWorkspaceEntry(result.value.entry.relativePath)
      return true
    })) ?? false
  }, [
    acceptWorkspaceColorSnapshot,
    enqueueWorkspaceColorMutation,
    flushEditor,
    invalidatePendingTranslationReveal,
    isCurrentWorkspaceColorLifecycle,
    label,
    locateWorkspaceEntry,
    reloadWorkspaceColorSnapshot,
    session.rebindPath,
    session.setDisplayName,
    session.state.relativePath,
  ])

  useEffect(() => {
    document.title = (session.dirty ? '● ' : '') + label + ' — Arkdown'
  }, [label, session.dirty])

  useEffect(() => {
    const root = appShellRef.current
    return root ? installUiSelectionGuard(root) : undefined
  }, [])
  useEffect(() => {
    const wasFullscreen = previousFullscreenRef.current
    previousFullscreenRef.current = windowState.fullscreen
    if (windowState.fullscreen) return
    fullscreenExitPendingRef.current = false
    if (!wasFullscreen) return
    const preferred = fullscreenExitFocusRef.current
    fullscreenExitFocusRef.current = null
    queueMicrotask(() => {
      if (preferred?.isConnected) {
        preferred.focus({ preventScroll: true })
        return
      }
      const active = document.activeElement instanceof HTMLElement
        && document.activeElement !== document.body
        && document.activeElement !== document.documentElement
        && document.activeElement.isConnected
        ? document.activeElement
        : null
      if (active) return
      const root = appShellRef.current
      const fallback = root?.querySelector<HTMLElement>(
        '.ProseMirror, .cm-content, textarea',
      ) ?? root?.querySelector<HTMLElement>(
        'input, button, [tabindex]:not([tabindex="-1"])',
      ) ?? null
      fallback?.focus({ preventScroll: true })
    })
  }, [windowState.fullscreen])

  useEffect(() => {
    const exitFullscreenOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape'
        || event.defaultPrevented
        || !windowState.fullscreen
        || fullscreenExitPendingRef.current
      ) return
      if (document.querySelector([
        '[aria-modal="true"]',
        '[role="menu"]',
        '.document-find-bar',
        '.workspace-search',
        '.translation-popover',
        '.editor-right-sidebar',
        '.preferences-page',
        '[role="listbox"]',
        '[role="tooltip"]',
      ].join(', '))) return

      event.preventDefault()
      fullscreenExitPendingRef.current = true
      fullscreenExitFocusRef.current = document.activeElement instanceof HTMLElement
        && document.activeElement !== document.body
        ? document.activeElement
        : appShellRef.current?.querySelector<HTMLElement>(
            '.ProseMirror, .cm-content, textarea, input, button, [tabindex]:not([tabindex="-1"])',
          ) ?? null
      const request = window.arkdown.controlWindow?.('exit-fullscreen')
      if (!request) {
        fullscreenExitPendingRef.current = false
        return
      }
      void request.then((result) => {
        if (result.ok) onWindowStateChange(result.value)
        else fullscreenExitPendingRef.current = false
      }, () => {
        fullscreenExitPendingRef.current = false
      })
    }
    window.addEventListener('keydown', exitFullscreenOnEscape)
    return () => window.removeEventListener('keydown', exitFullscreenOnEscape)
  }, [onWindowStateChange, windowState.fullscreen])

  const hasMainBackgroundImage = mainBackgroundPresentation !== null
    && mainBackgroundPresentation.imageUrl !== null

  return <div
    inert={acceptingDrop || closePrepared}
    ref={appShellRef}
    data-editor-theme={resolvedTheme}
    className={[
      'app-shell',
      sidebarVisible ? '' : 'sidebar-collapsed',
      preferences ? 'preferences-open' : '',
      stickyNoteBoxMounted ? 'sticky-note-box-mounted' : '',
      stickyNoteBoxOpen ? 'sticky-note-box-open' : '',
      appearance.preserveSingleLineBreaks ? 'preserve-single-line-breaks' : '',
    ].filter(Boolean).join(' ')}
    style={{
      '--sidebar-width': `${sidebarResize.width}px`,
      '--task-checkbox-size': `${25 / (window.devicePixelRatio || 1)}px`,
      '--theme-color-rgb': themeColorRgbChannels(appearance.themeColor),
      '--editor-minimum-margin': `${appearance.minimumContentMarginPx}px`,
      '--editor-maximum-width': `${appearance.maximumContentWidthPx}px`,
      '--heading-latin-font': editorFontFamilyCss(appearance.headingLatinFont),
      '--heading-cjk-font': JSON.stringify(appearance.headingCjkFont),
      '--body-latin-font': editorFontFamilyCss(appearance.bodyLatinFont),
      '--body-cjk-font': JSON.stringify(appearance.bodyCjkFont),
    } as CSSProperties}
    onDragEnter={(event) => {
      if (hasFileTransfer(event.dataTransfer)) event.preventDefault()
    }}
    onDragOver={(event) => {
      if (!hasFileTransfer(event.dataTransfer)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'link'
    }}
    onDrop={(event) => {
      if (!hasFileTransfer(event.dataTransfer)) return
      if (acceptingDropRef.current) { event.preventDefault(); return }
      event.preventDefault()
      droppedPathInspection.current += 1
      guardedDropRef.current?.abort()
      const dropController = new AbortController()
      const target = event.target as Element | null
      const point = { clientX: event.clientX, clientY: event.clientY,
        visualDropRequestId: visualDropRequestIdForEvent(event.nativeEvent) }
      const inBody = isDocumentBodyDrop(target, point)
      const workspaceEntry = Array.from(event.dataTransfer.types ?? []).includes(WORKSPACE_ENTRY_MIME)
        ? decodeWorkspaceDrag(event.dataTransfer.getData(WORKSPACE_ENTRY_MIME), workspace?.absolutePath)
        : null
      if (workspaceEntry) {
        if (workspaceEntry.kind === 'file' && /\.(?:md|markdown|txt)$/i.test(workspaceEntry.absolutePath)) {
          openDroppedFile(workspaceEntry.absolutePath, Boolean(target?.closest('.editor-host')), point, inBody, dropController)
          return
        }
        if (target?.closest('.editor-surface')) {
          const inserted = editorRef.current?.insertDroppedLink({ ...workspaceEntry,
            clientX: event.clientX, clientY: event.clientY,
            visualDropRequestId: visualDropRequestIdForEvent(event.nativeEvent) })
          if (!inserted) setFileActionError('未能插入路径，请拖到正文中的文字位置。')
        }
        return
      }
      const file = event.dataTransfer.files[0] ?? null
      if (file) {
        const target = event.target as Element | null
        const visualDropRequestId = visualDropRequestIdForEvent(event.nativeEvent)
        openDroppedFile(
          file,
          Boolean(target?.closest('.editor-host')),
          {
            clientX: event.clientX,
            clientY: event.clientY,
            ...(visualDropRequestId === undefined ? {} : { visualDropRequestId }),
          },
          inBody,
          dropController,
        )
      }
    }}
  >
    <AppTitleBar
      updateLabel={updateIndicatorLabel(appUpdate.state)}
      onOpenUpdate={() => { void appUpdate.action('open') }}
      sidebarVisible={sidebarVisible}
      onToggleSidebar={() => setSidebarVisible((visible) => !visible)}
      menuModel={applicationMenuModel}
      menuState={{
        editorTheme: appearance.editorTheme,
        hasPrintableDocument,
        spellCheckEnabled: appearance.spellCheckEnabled,
        showEditIndicators: appearance.showEditIndicators,
        editorZoomPercent,
        fullscreen: windowState.fullscreen,
      }}
      onExecuteItem={(itemId) => {
        void window.arkdown.executeApplicationMenuItem?.(itemId).then((result) => {
          if (result && !result.ok) setFileActionError(result.error.message)
        })
      }}
      onWindowStateChange={onWindowStateChange}
      windowState={windowState}
    />
    <ContextWorkspaceSidebar
      chooseWorkspace={switchWorkspace}
      colorMarks={workspaceColorMarks}
      currentDocument={
        openingDocumentPath ?? session.state.sourceRelativePath ?? session.state.relativePath
      }
      isChoosing={isChoosing}
      listDirectory={listDirectory}
      locateRequest={workspaceLocateRequest}
      onLocateComplete={completeWorkspaceLocate}
      markdown={session.state.markdown}
      onCreateDocument={createDocument}
      onOpenDocument={openDocument}
      onReloadDocument={reloadFromDisk}
      onRevealDocument={revealDocument}
      onTrashDocument={trashDocument}
      onWorkspaceMenuCommand={runWorkspaceMenuCommand}
      readDocument={readDocument}
      refreshVersion={refreshVersion}
      workspace={workspace}
      workspaceError={workspaceError}
    />
    <div className="sidebar-resizer" {...sidebarResize.separatorProps}
      aria-disabled={!layoutLoaded} onPointerDown={layoutLoaded ? sidebarResize.separatorProps.onPointerDown : undefined}
      onKeyDown={layoutLoaded ? sidebarResize.separatorProps.onKeyDown : undefined}
      onDoubleClick={layoutLoaded ? sidebarResize.separatorProps.onDoubleClick : undefined} />
    <main
      className="editor-host"
      data-testid="editor-host"
      style={{ '--editor-zoom-factor': editorZoomPercent / 100 } as CSSProperties}
    >
      {(session.state.error ?? fileActionError) && <div className="document-error-notice" role="alert">{session.state.error ?? fileActionError}</div>}
      {layoutPersistenceError && <div className="document-error-notice" role="alert">{layoutPersistenceError}
        <button type="button" onClick={() => void reloadSavedLayout()}>重新加载窗口布局</button>
      </div>}
      <DocumentHeader
        editorMode={editorMode}
        codeDocument={isCodeDocumentPath(documentAbsolutePath ?? label)}
        fileName={label}
        hasBodyContent={session.state.markdown.trim().length > 0}
        hasOriginal={Boolean(session.state.relativePath)}
        onRename={renameHeaderDocument}
        onSave={() => { void session.save() }}
        savePresentation={session.savePresentation}
        onToggleRightSidebar={onToggleRightSidebar}
        onToggleStickyNotes={toggleStickyNoteBox}
        rightSidebarOpen={rightSidebarState.open}
        stickyNotesOpen={stickyNoteBoxOpen}
        onCommand={(command) => {
          window.dispatchEvent(new CustomEvent('arkdown:editor-command', { detail: command }))
        }}
      />
      <div className={[
        'editor-content',
        hasMainBackgroundImage ? 'background-image-present' : '',
      ].filter(Boolean).join(' ')}>
        {hasMainBackgroundImage && (
          <BackgroundImageLayer
            anchor={mainBackgroundPresentation.settings.imageAlignment}
            imageUrl={mainBackgroundPresentation.imageUrl}
            settings={mainBackgroundPresentation.settings}
          />
        )}
        {session.state.status === 'loading'
          ? <p className="hint">正在读取文档…</p>
          : <EditorPane
              modelPreferences={modelPreferences}
              ref={editorRef}
              interactionLocked={acceptingDrop || closePrepared}
              key={`${translationDocumentKey}:recovery-${recoveryEditorGeneration}`}
              aiConversationStore={aiConversationStore}
              aiWorkspace={aiWorkspace}
              onWorkspaceFilesChanged={handleAiWorkspaceFilesChanged}
              documentKey={translationDocumentKey}
              findRequest={findRequest}
              readClipboardImage={session.readClipboardImage}
              documentAbsolutePath={documentAbsolutePath}
              documentLocation={documentLocation}
              onDocumentLocationHandled={onDocumentLocationHandled}
              documentDisplayName={label}
              documentSourceFormat={session.state.sourceFormat ?? aiDocumentSourceFormat(label)}
              documentDirty={session.dirty}
              editIndicatorModel={editIndicatorModel}
              markdown={session.state.markdown}
              showEditIndicators={appearance.showEditIndicators}
              editorTheme={resolvedTheme}
              mermaidAppearance={mermaidAppearance}
              spellCheckEnabled={appearance.spellCheckEnabled}
              zoomPercent={editorZoomPercent}
              onChange={(...args) => { appUpdate.markWorkStarted(); session.change(...args) }}
              onOpenLargeModelSettings={() => openPreferences('large-model-current')}
              onModeChange={setEditorMode}
              initialMode={isCodeDocumentPath(documentAbsolutePath ?? label) ? 'source' : pendingTranslationRecord?.mode ?? 'visual'}
              initialTranslationHistoryRecordId={pendingTranslationRecord?.id ?? null}
              onNavigateTranslationHistoryRecord={translationNavigation.navigate}
              onTranslationHistoryReady={consumePendingTranslationReveal}
              translationSettingsRevision={translationSettingsRevision}
              rightSidebarState={rightSidebarState}
              rightSidebarWidth={layout.rightSidebarWidth}
              onOpenRightSidebar={(activeTab: EditorRightSidebarTab) => {
                onOpenRightSidebar(activeTab)
              }}
              onCloseRightSidebar={onCloseRightSidebar}
              onRightSidebarWidthChange={(rightSidebarWidth) => {
                if (!layoutLoaded || currentLayoutRef.current.rightSidebarWidth === rightSidebarWidth) return
                queueLayoutUpdate({ rightSidebarWidth })
              }}
              translationHistory={translationHistory}
              translationHistoryRecords={translationHistory.records}
              translationHistoryIdentity={{
                workspaceAbsolutePath: workspace?.absolutePath ?? null,
                documentRelativePath: editorRelativePath,
                documentRevision: session.state.revision,
              }}
            />}
      </div>
    </main>
    {stickyNoteBoxMounted && <div className="sticky-note-box-motion" data-open={stickyNoteBoxOpen}>
      <StickyNoteBoxPanel key={stickyNoteBoxPanelVersion} onClose={closeStickyNoteBox} />
    </div>}
    {preferences && (
      <PreferencesPage
        shellPreferences={shellPreferences}
        key={preferencesPageSession}
        initialAppearance={preferences.appearance}
        initialLargeModels={preferences.largeModels}
        modelPreferences={modelPreferences}
        initialArknote={preferences.arknote}
        initialSearch={preferences.search}
        initialTarget={preferencesTarget}
        systemFonts={preferences.systemFonts}
        onClose={closePreferences}
        onSearchChange={updateSearchPreferences}
        onAppearanceChange={updateAppearancePreferences}
        onArknoteChange={updateArknotePreferences}
        onDesktopContextMenuChange={updateDesktopContextMenu}
        onLargeModelsChange={acceptLargeModelSettings}
        persistenceError={preferencesPersistenceError}
        onReloadSavedPreferences={preferencePersistence.snapshot().failures.search || preferencePersistence.snapshot().failures.appearance
          ? () => void reloadSavedPreferences() : undefined}
        reloadRevision={preferenceReloadEpoch}
      />
    )}
    {workspaceNameAction && (
      <WorkspaceNameDialog
        confirmLabel={workspaceNameAction.kind === 'rename' ? '重命名' : '创建'}
        initialValue={
          workspaceNameAction.kind === 'new-document'
            ? '未命名.md'
            : workspaceNameAction.kind === 'new-folder'
              ? '新建文件夹'
              : workspaceNameAction.target.name
        }
        onCancel={() => setWorkspaceNameAction(null)}
        onSubmit={submitWorkspaceName}
        title={workspaceNameAction.kind === 'new-document'
          ? '新建文档'
          : workspaceNameAction.kind === 'new-folder' ? '新建文件夹' : '重命名'}
      />
    )}
    {pendingFolderDrop && <FolderDropDialog onChoose={chooseFolderDrop} />}
    {aboutOpen && <AboutDialog colorScheme={mermaidColorScheme} onClose={() => setAboutOpen(false)} update={appUpdate.state} onOpenUpdateWebsite={appUpdate.openWebsite} onUpdateExit={appUpdate.requestExit} updateError={appUpdate.error} />}
    <UpdateDialog state={appUpdate.state} onAction={action => { void appUpdate.action(action) }} onExit={appUpdate.requestExit} error={appUpdate.error} />
    {keyboardShortcutsOpen && <KeyboardShortcutsDialog
      draft={shortcutPreferences}
      snapshot={keyboardShortcuts.snapshot}
      onSnapshot={keyboardShortcuts.acceptSnapshot}
      onCancel={() => setKeyboardShortcutsOpen(false)}
    />}
    <DocumentConversionDialog
      controller={documentConversion}
      onAccept={adoptConvertedDocument}
    />
  </div>
}

function ArkdownApp() {
  // Settings writes outlive the keyed workspace shell that initiated them.
  const [preferencePersistence] = useState(createPreferencePersistence)
  const [shellPreferences] = useState(() => new ShellIntegrationPreferenceDraft(preferencePersistence))
  const [shortcutPreferences] = useState(() => new ShortcutPreferenceDraft(preferencePersistence))
  const [modelPreferences] = useState(() => new ModelPreferenceDraft(preferencePersistence))
  useEffect(() => startModelPreferenceSync(modelPreferences, window.arkdown, window), [modelPreferences])
  const [preferenceDrafts] = useState(createObservedPreferenceDrafts)
  const aiConversation = useWorkspaceAiConversationController()
  const aiConversationStore = aiConversation.store
  const {
    acceptWorkspaceAuthority,
    activateCurrentWorkspace,
    deactivateWorkspace,
    hasNonEmptyActiveConversation,
  } = aiConversation
  const businessDialogs = useBusinessDialog()
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false)
  const [rightSidebarTab, setRightSidebarTab] = useState<EditorRightSidebarTab>('ai-chat')
  const openRightSidebar = useCallback((tab: EditorRightSidebarTab) => {
    setRightSidebarTab(tab)
    setRightSidebarOpen(true)
  }, [])
  const translationHistoryStore = useTranslationHistory()
  const translationHistoryRef = useRef<TranslationHistoryWindowPort | null>(null)
  translationHistoryRef.current ??= createTranslationHistoryWindowPort(translationHistoryStore)
  const translationHistory = translationHistoryRef.current
  const untitledDocumentSequenceRef = useRef(0)
  const createUntitledDocumentKey = useCallback(() => (
    `__untitled__:${++untitledDocumentSequenceRef.current}`
  ), [])
  const translationNavigationRef = useRef<TranslationNavigationController | null>(null)
  if (!translationNavigationRef.current) {
    const delegateRef: TranslationNavigationController['delegateRef'] = { current: null }
    translationNavigationRef.current = {
      pendingRef: { current: null },
      generationRef: { current: 0 },
      delegateRef,
      navigate: (recordId, alignment) => delegateRef.current?.(recordId, alignment),
      invalidate() {
        const controller = translationNavigationRef.current
        if (!controller) return
        controller.generationRef.current += 1
        controller.pendingRef.current = null
      },
    }
  }
  const translationNavigation = translationNavigationRef.current
  const [editorZoomPercent, setEditorZoomPercent] = useState(100)
  const [windowState, setWindowState] = useState<WindowStateSnapshot>({
    maximized: false,
    fullscreen: false,
    revision: 0,
  })
  const [fullscreenHintActivation, setFullscreenHintActivation] = useState(0)
  const [fullscreenHintVisible, setFullscreenHintVisible] = useState(false)
  const windowStateControllerRef = useRef<WindowStateSnapshotController | null>(null)
  const acceptWindowState = useCallback((state: WindowStateSnapshot) => {
    windowStateControllerRef.current?.accept(state)
  }, [])
  const onEditorZoom = useCallback((action: EditorZoomAction) => {
    setEditorZoomPercent((current) => nextEditorZoom(current, action))
  }, [])
  useEffect(() => {
    const onWheel = createEditorWheelZoomHandler(onEditorZoom)
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [onEditorZoom])
  const {
    workspace,
    authorityRevision: workspaceAuthorityRevision,
    chooseWorkspace,
    adoptWorkspace,
    error,
    isChoosing,
  } = useWorkspace({ restoreOnMount: false })
  const activatedAiWorkspacePathRef = useRef<string | null>(null)
  const preacceptedAiWorkspacePathRef = useRef<string | null>(null)
  const aiWorkspaceActivationGenerationRef = useRef(0)
  const [, setAiWorkspaceBindingRevision] = useState(0)
  useLayoutEffect(() => {
    const generation = ++aiWorkspaceActivationGenerationRef.current
    if (
      workspace
      && preacceptedAiWorkspacePathRef.current
      && sameWorkspacePath(preacceptedAiWorkspacePathRef.current, workspace.absolutePath)
    ) {
      preacceptedAiWorkspacePathRef.current = null
      activatedAiWorkspacePathRef.current = workspace.absolutePath
      return
    }
    preacceptedAiWorkspacePathRef.current = null
    activatedAiWorkspacePathRef.current = null
    deactivateWorkspace()
    if (!workspace) {
      return
    }
    void activateCurrentWorkspace().then((result) => {
      if (
        generation !== aiWorkspaceActivationGenerationRef.current
        || !result.ok
      ) return
      activatedAiWorkspacePathRef.current = workspace.absolutePath
      setAiWorkspaceBindingRevision((revision) => revision + 1)
    })
  }, [
    activateCurrentWorkspace,
    deactivateWorkspace,
    workspace?.absolutePath,
    workspaceAuthorityRevision,
  ])
  const visibleAiWorkspace = workspace
    && activatedAiWorkspacePathRef.current
    && sameWorkspacePath(activatedAiWorkspacePathRef.current, workspace.absolutePath)
    ? aiConversation.activeWorkspace
    : null
  const chooseWorkspaceWithAiGate = useCallback(async () => {
    if (hasNonEmptyActiveConversation()) {
      const decision = await businessDialogs.confirm({
        ...WORKSPACE_AI_SWITCH_COPY,
      })
      if (decision !== 'confirm') return
    }
    await chooseWorkspace()
  }, [businessDialogs, chooseWorkspace, hasNonEmptyActiveConversation])
  const confirmWorkspaceSwitch = useCallback(async (
    targetWorkspaceAbsolutePath: string,
  ): Promise<boolean> => {
    if (
      !workspace
      || sameWorkspacePath(workspace.absolutePath, targetWorkspaceAbsolutePath)
      || !hasNonEmptyActiveConversation()
    ) return true
    return await businessDialogs.confirm(WORKSPACE_AI_SWITCH_COPY) === 'confirm'
  }, [businessDialogs, hasNonEmptyActiveConversation, workspace])
  const confirmSaveAsIntent = useCallback<SaveAsIntentConfirmation>(async (intent) => {
    if (!intent.changesWorkspace || !hasNonEmptyActiveConversation()) return true
    return await businessDialogs.confirm(WORKSPACE_AI_SWITCH_COPY) === 'confirm'
  }, [businessDialogs, hasNonEmptyActiveConversation])
  const [initialDocument, setInitialDocument] = useState<DocumentSnapshot | null>(null)
  // Keep a location across initial document/workspace adoption and lazy editor
  // mounting. This event never replaces the session's (possibly dirty) text.
  const [documentLocation, setDocumentLocation] = useState<DocumentLocationIntent | null>(null)
  useEffect(() => window.arkdown.onDocumentLocation?.(setDocumentLocation), [])
  const handleDocumentLocation = useCallback((intent: DocumentLocationIntent) => {
    setDocumentLocation(current => current === intent ? null : current)
  }, [])
  const [savedAsTransition, setSavedAsTransition] = useState<SavedAsTransition | null>(null)
  // A guarded drop must finish on the session that saved the draft. Publish the
  // real workspace/AI authority immediately, retaining only that shell's key.
  const [savedDropShell, setSavedDropShell] = useState<{ workspacePath: string; key: string } | null>(null)
  const workspaceShellKey = savedDropShell && savedDropShell.workspacePath === workspace?.absolutePath
    ? savedDropShell.key : workspace?.absolutePath ?? '__untitled__'
  useEffect(() => {
    if (savedDropShell && savedDropShell.workspacePath !== workspace?.absolutePath) setSavedDropShell(null)
  }, [savedDropShell, workspace?.absolutePath])
  const [initialImportedDocx, setInitialImportedDocx] = useState<ImportedDocx | null>(null)
  const [initialRecovery, setInitialRecovery] = useState<PreparedRecovery | null>(null)
  const [startupGuide, setStartupGuide] = useState(() => (
    new URLSearchParams(window.location.search).get('startup') === 'guide'
  ))
  const documentIntentGeneration = useRef(0)
  const closeHandlerRef = useRef<InstalledCloseHandler>({ handler: UNREADY_CLOSE, release: () => {}, owner: null, adopted: null, readLifecycle: () => -1 })
  const preparedCloseRef = useRef<PreparedClose | null>(null)
  const documentActivated = useCallback(() => {
    documentIntentGeneration.current += 1
    setStartupGuide(false)
  }, [])
  const acceptDroppedWorkspace = useCallback((
    nextWorkspace: WorkspaceSummary,
    document: DocumentSnapshot | null,
  ) => {
    setSavedDropShell(null)
    setSavedAsTransition(null)
    setInitialDocument(document)
    setInitialImportedDocx(null)
    adoptWorkspace(nextWorkspace)
  }, [adoptWorkspace])
  const acceptSavedAsWorkspace = useCallback((transition: SavedAsTransition, preserveSession = false) => {
    const prepared = preparedCloseRef.current
    if (transition.result.changesWorkspace && !preserveSession && prepared?.preparing
      && prepared.registration.owner === closeHandlerRef.current.owner) {
      let accept!: (next: InstalledCloseHandler | null) => void
      const ready = new Promise<InstalledCloseHandler | null>(resolve => { accept = resolve })
      prepared.handoff = { transition, ready, accept }
    }
    setInitialDocument(null)
    setInitialImportedDocx(null)
    if (!transition.result.changesWorkspace) {
      setSavedAsTransition(null)
      return
    }
    preacceptedAiWorkspacePathRef.current = transition.result.workspace.absolutePath
    activatedAiWorkspacePathRef.current = transition.result.workspace.absolutePath
    acceptWorkspaceAuthority(transition.result.aiWorkspace)
    setSavedDropShell(preserveSession ? { workspacePath: transition.result.workspace.absolutePath, key: workspaceShellKey } : null)
    // This session has already applied saved-as. A remounted ordinary Save As
    // still adopts its snapshot through initialSavedAsTransition as before.
    setSavedAsTransition(preserveSession ? null : transition)
    adoptWorkspace(transition.result.workspace)
  }, [acceptWorkspaceAuthority, adoptWorkspace, workspaceShellKey])
  const consumeSavedAsTransition = useCallback((transition: SavedAsTransition) => {
    setSavedAsTransition((current) => current === transition ? null : current)
  }, [])
  useEffect(() => window.arkdown.onOpenIntent?.((intent) => {
    const generation = ++documentIntentGeneration.current
    void (async () => {
      if (!(await confirmWorkspaceSwitch(intent.workspace.absolutePath))) return
      if (generation !== documentIntentGeneration.current) return
      translationNavigation.invalidate()
      acceptDroppedWorkspace(intent.workspace, intent.document)
    })().catch(() => undefined)
  }) ?? (() => {}), [acceptDroppedWorkspace, confirmWorkspaceSwitch, translationNavigation])
  useEffect(() => window.arkdown.onImportDocxIntent?.((intent) => {
    const generation = ++documentIntentGeneration.current
    void (async () => {
      if (!(await confirmWorkspaceSwitch(intent.workspace.absolutePath))) return
      if (generation !== documentIntentGeneration.current) return
      translationNavigation.invalidate()
      setSavedAsTransition(null)
      setInitialDocument(null)
      setInitialImportedDocx(intent.imported)
      adoptWorkspace(intent.workspace)
    })().catch(() => undefined)
  }) ?? (() => {}), [adoptWorkspace, confirmWorkspaceSwitch, translationNavigation])
  useEffect(() => window.arkdown.onRecoverDraft?.((intent) => {
    const generation = ++documentIntentGeneration.current
    let adopted = false
    void (async () => {
      let snapshot: DocumentSnapshot | null = null
      let conflict = false
      const originalPath = intent.manifest.originalAbsolutePath
      const targetWorkspacePath = intent.manifest.workspaceAbsolutePath
        ?? (originalPath ? workspacePathForDroppedInspection({
          kind: 'file',
          absolutePath: originalPath,
        }) : null)
      if (originalPath && !targetWorkspacePath) return
      if (targetWorkspacePath && !(await confirmWorkspaceSwitch(targetWorkspacePath))) return
      if (generation !== documentIntentGeneration.current) return
      translationNavigation.invalidate()
      if (originalPath) {
        const opened = await window.arkdown.openDroppedPath(originalPath)
        if (generation !== documentIntentGeneration.current) return
        if (opened.ok && opened.value.document) {
          snapshot = opened.value.document
          conflict = Boolean(
            intent.manifest.originalRevision
            && snapshot.revision !== intent.manifest.originalRevision
          )
          acceptDroppedWorkspace(opened.value.workspace, null)
        }
      }
      const claimed = await window.arkdown.claimRecoveredDraft?.(intent.draftId)
      if (generation !== documentIntentGeneration.current) return
      if (!claimed?.ok || !claimed.value) {
        await businessDialogs.alert({ title: '无法恢复草稿', description: '草稿未能认领，内容仍保留。请从“文件 → 查看保留的草稿”重试。' })
        return
      }
      setInitialRecovery({ intent: { ...claimed.value, draftId: intent.draftId }, snapshot, conflict })
      adopted = true
    })().catch(() => undefined).finally(() => {
      if (!adopted) void window.arkdown.releaseDraftRecovery?.(intent.draftId).catch(() => undefined)
    })
  }) ?? (() => {}), [acceptDroppedWorkspace, confirmWorkspaceSwitch, translationNavigation, businessDialogs])
  const recoveryHandled = useCallback(() => setInitialRecovery(null), [])
  const installCloseHandler = useCallback((handler: ClosePreparationHandler, release: () => void, owner: object, adopted: SavedAsTransition | null, readLifecycle: () => number) => {
    const registration = { handler, release, owner, adopted, readLifecycle }
    closeHandlerRef.current = registration
    const prepared = preparedCloseRef.current
    if (prepared?.preparing && prepared.handoff && owner !== prepared.registration.owner) {
      prepared.handoff.accept(adopted === prepared.handoff.transition ? registration : null)
    }
    return () => {
      if (closeHandlerRef.current === registration) closeHandlerRef.current = { handler: UNREADY_CLOSE, release: () => {}, owner: null, adopted: null, readLifecycle: () => -1 }
    }
  }, [])

  useEffect(() => {
    const prepare: ClosePreparationHandler = async context => {
      const owned: PreparedClose = { context, registration: closeHandlerRef.current, preparing: true, handoff: null }
      preparedCloseRef.current = owned
      try {
        while (preparedCloseRef.current === owned) {
          const prepared = await owned.registration.handler(context)
          if (owned.handoff) {
            const handoff = owned.handoff
            const successor = await handoff.ready
            if (!successor || preparedCloseRef.current !== owned) return { status: 'cancelled' }
            owned.registration = successor
            owned.handoff = null
            // The destination is committed. Preserve its pending/error result;
            // a remount is not permission to replay save or silently retry it.
            if (handoff.transition.result.draftEndPending) return { status: 'failed', code: 'draft-end-failed' }
            if (handoff.transition.continuation?.error) return { status: 'failed', code: 'document-save-failed' }
            continue
          }
          if (closeHandlerRef.current.owner !== owned.registration.owner) return { status: 'cancelled' }
          if (prepared.status !== 'ready') return prepared
          const lifecycle = owned.registration.readLifecycle()
          context.enter('settle-preferences')
          const persisted = await preferencePersistence.drain()
          if (preparedCloseRef.current !== owned || closeHandlerRef.current.owner !== owned.registration.owner
            || owned.registration.readLifecycle() !== lifecycle) return { status: 'cancelled' }
          return persisted.ok ? { status: 'ready' } : { status: 'failed', code: 'preferences-save-failed' }
        }
        return { status: 'cancelled' }
      } finally { owned.preparing = false }
    }
    const release = window.arkdown.onClosePreparationReleased?.(attempt => {
      const owned = preparedCloseRef.current
      if (owned?.context.attemptId !== attempt.attemptId || owned.context.generation !== attempt.generation) return
      preparedCloseRef.current = null
      owned.registration.release()
    }) ?? (() => {})
    let legacyGeneration = 0
    const unsubscribe = window.arkdown.onPrepareCloseStructured
      ? window.arkdown.onPrepareCloseStructured(prepare)
      : window.arkdown.onPrepareClose(async () => {
        const result = await prepare({ attemptId: '00000000-0000-4000-8000-000000000001',
          requestId: '00000000-0000-4000-8000-000000000002', generation: ++legacyGeneration, enter: () => {} })
        // Older embedded hosts have no recovery control channel. This adapter
        // releases only known terminal outcomes, never an outstanding save.
        if (result.status !== 'ready') preparedCloseRef.current?.registration.release()
        return result.status === 'ready'
      })
    return () => { unsubscribe(); release() }
  }, [preferencePersistence])

  useEffect(() => {
    const controller = new WindowStateSnapshotController(({ snapshot, transition }) => {
      setWindowState(snapshot)
      if (transition === 'entered-fullscreen') {
        setFullscreenHintVisible(true)
        setFullscreenHintActivation((activation) => activation + 1)
      } else if (transition === 'exited-fullscreen') {
        setFullscreenHintVisible(false)
      }
    })
    windowStateControllerRef.current = controller
    const unsubscribe = window.arkdown.onWindowStateChanged?.((state) => {
      controller.accept(state)
    }) ?? (() => undefined)
    const request = window.arkdown.getWindowState?.()
    if (request) {
      void request.then((result) => {
        if (result.ok) controller.accept(result.value)
      }, () => undefined)
    }
    return () => {
      controller.dispose()
      if (windowStateControllerRef.current === controller) {
        windowStateControllerRef.current = null
      }
      unsubscribe()
    }
  }, [])

  return <>
    <ScreenshotOcrHost />
    <WorkspaceShell
      key={workspaceShellKey}
      aiConversationStore={aiConversationStore}
      preferencePersistence={preferencePersistence}
      shellPreferences={shellPreferences}
      shortcutPreferences={shortcutPreferences}
      modelPreferences={modelPreferences}
      preferenceDrafts={preferenceDrafts}
      aiWorkspace={visibleAiWorkspace}
      rightSidebarOpen={rightSidebarOpen}
      rightSidebarTab={rightSidebarTab}
      onCloseRightSidebar={() => setRightSidebarOpen(false)}
      onOpenRightSidebar={openRightSidebar}
      onToggleRightSidebar={() => setRightSidebarOpen((open) => !open)}
      workspace={workspace}
      chooseWorkspace={chooseWorkspaceWithAiGate}
      confirmWorkspaceSwitch={confirmWorkspaceSwitch}
      confirmSaveAsIntent={confirmSaveAsIntent}
      workspaceError={error}
      isChoosing={isChoosing}
      installCloseHandler={installCloseHandler}
      initialDocument={initialDocument}
      documentLocation={documentLocation}
      onDocumentLocationHandled={handleDocumentLocation}
      initialSavedAsTransition={savedAsTransition}
      initialImportedDocx={initialImportedDocx}
      initialRecovery={initialRecovery}
      startupGuide={startupGuide}
      onDocumentActivated={documentActivated}
      editorZoomPercent={editorZoomPercent}
      onEditorZoom={onEditorZoom}
      onWindowStateChange={acceptWindowState}
      onRecoveryHandled={recoveryHandled}
      onDroppedWorkspace={acceptDroppedWorkspace}
      onSavedAsWorkspace={acceptSavedAsWorkspace}
      onSavedAsTransitionHandled={consumeSavedAsTransition}
      windowState={windowState}
      translationHistory={translationHistory}
      translationNavigation={translationNavigation}
      createUntitledDocumentKey={createUntitledDocumentKey}
    />
    <FullscreenHint
      activationKey={fullscreenHintActivation}
      visible={fullscreenHintVisible}
    />
  </>
}

export function App() {
  return (
    <BusinessDialogProvider>
      <WorkspaceAiConversationProvider>
        <ArkdownApp />
      </WorkspaceAiConversationProvider>
    </BusinessDialogProvider>
  )
}
function aiDocumentSourceFormat(fileName: string): string {
  const extension = fileName.match(/\.([^.]+)$/u)?.[1]?.toLocaleLowerCase('en-US')
  if (!extension || extension === 'md' || extension === 'markdown') return 'markdown'
  if (extension === 'txt') return 'text'
  if (extension === 'doc' || extension === 'docx') return 'word'
  if (extension === 'xls' || extension === 'xlsx') return 'excel'
  if (extension === 'ppt' || extension === 'pptx') return 'powerpoint'
  return extension
}
