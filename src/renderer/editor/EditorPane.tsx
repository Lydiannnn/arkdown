import type { ModelPreferenceDraft } from '../settings/model-preference-draft'
import type { PublicModelSettingsSnapshot } from '../../shared/settings-observation'
import { areModelRulesReady, useModelRulesReady, useModelRulesRevision } from '../settings/model-rules-runtime'
import { featureModelConnections } from '../../shared/large-model-settings'
import { DocumentOutline } from './DocumentOutline'
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type {
  SelectionAnchorRect,
  TranslationEvent,
  TranslationPresentation,
  TranslationSelection,
  TranslationSelectionGeometry,
  TranslationStarted,
} from '../../shared/selection-translation'
import {
  isPublicErrorCode,
  PUBLIC_ERROR_MESSAGES,
  type PublicErrorCode,
} from '../../shared/public-errors'
import {
  translationEventUtf8ByteLength,
} from '../../shared/selection-translation'
import type { AiWritePolicy, LargeModelSettings } from '../../shared/large-model-settings'
import { resolveModelCapabilityProfile } from '../../shared/model-capability-profiles'
import type { ModelThinkingPreference } from '../../shared/model-thinking'
import { normalizeReasoningEffort } from '../../shared/model-provider-presets'
import type {
  AiWorkspaceState,
} from '../../shared/contracts'
import {
  DEFAULT_EDITOR_THEME,
  type EditorTheme,
} from '../../shared/editor-appearance-preferences'
import { DocumentFindBar } from './DocumentFindBar'
import { SourceEditor, type SourceEditorHandle } from './SourceEditor'
import { isCodeDocumentPath } from '../../shared/document-types'
import { parseDocumentViewLink } from '../../shared/document-view-link'
import { documentHeadingAnchor } from '../../shared/document-heading-anchor'
import type { DocumentLocationIntent, DocumentViewApi } from '../../shared/document-view'
import { useDocumentView } from '../document-view/use-document-view'
import {
  VisualEditor,
  type VisualEditorHandle,
} from './VisualEditor'
import type { CodeExplanationRequestDetail } from './mermaid/adaptive-code-block-view'
import type { MermaidAppearance } from './mermaid/mermaid-types'
import { TranslationPopover } from './TranslationPopover'
import {
  TranslationSidebar,
  type TranslationSidebarView,
} from './TranslationSidebar'
import {
  EditorRightSidebar,
  type EditorRightSidebarState,
  type EditorRightSidebarTab,
} from './EditorRightSidebar'
import { AiConversationSidebar } from './AiConversationSidebar'
import type { AiMessageLinkTarget } from './ai-message-links'
import {
  useAiConversation,
  type AiConversationStore,
} from './use-ai-conversation'
import { useOptionalWorkspaceAiConversationController } from './WorkspaceAiConversationProvider'
import {
  reduceTranslationUiState,
  type TranslationUiStatus,
} from './translation-ui-state'
import {
  DOCUMENT_FIND_SNAPSHOT_EVENT,
  EMPTY_DOCUMENT_FIND_SNAPSHOT,
  dispatchDocumentFind,
  readDocumentFindSnapshot,
  type DocumentFindAction,
} from './document-find-events'
import { createStickyNoteFromSelection } from '../sticky-notes/sticky-note-selection-command'
import { useOptionalBusinessDialog } from '../modal/BusinessDialogProvider'
import type { StickyNoteSelectionExport } from '../sticky-notes/sticky-note-selection-export'
import type {
  TranslationHistoryAnchor,
  TranslationHistoryAnchorUpdate,
  TranslationHistoryEditorHandle,
  TranslationHistoryRevealAlignment,
  TranslationHistoryEditorPort,
  TranslationHistoryRecord,
  TranslationHistoryStore,
} from './translation-history'
import type { EditIndicatorModel } from './edit-indicators/use-edit-indicator-model'
import { TranslationHistoryRail } from './TranslationHistoryRail'
import type {
  DroppedLinkInsertion,
  DroppedMarkdownInsertion,
} from './dropped-link-insertion'
import type { EditorModePosition } from './editor-mode-position'
import {
  createMarginSelectionController,
  type EditorMarginSelectionPort,
  type MarginSelectionController,
} from './editor-margin-selection'

export type EditorMode = 'visual' | 'source'

const DocumentViewPanel = lazy(() => import('../document-view/DocumentViewPanel').then(
  (module) => ({ default: module.DocumentViewPanel }),
))

function revealVisualAnchor(root: HTMLElement | null, anchor: string): boolean {
  const headings = root?.querySelectorAll<HTMLElement>('.ProseMirror :is(h1,h2,h3,h4,h5,h6)')
  const counts = new Map<string, number>()
  const target = Array.from(headings ?? []).find((heading) => {
    const base = documentHeadingAnchor(heading.textContent ?? '')
    const count = counts.get(base) ?? 0
    counts.set(base, count + 1)
    return heading.id === anchor || (count ? `${base}-${count}` : base) === anchor
  })
  target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return Boolean(target)
}

export interface EditorFindRequest {
  id: number
  documentKey: string
  query: string
  isCurrent(): boolean
}

export interface EditorPaneProps {
  interactionLocked?: boolean
  findRequest?: EditorFindRequest | null
  readClipboardImage?: () => Promise<string | null>
  modelPreferences?: ModelPreferenceDraft
  aiConversationStore?: AiConversationStore
  aiWorkspace?: AiWorkspaceState | null
  onWorkspaceFilesChanged?: (workspace: AiWorkspaceState) => void
  documentKey: string
  documentAbsolutePath?: string | null
  documentLocation?: DocumentLocationIntent | null
  onDocumentLocationHandled?(intent: DocumentLocationIntent): void
  documentDisplayName?: string
  documentSourceFormat?: string
  documentDirty?: boolean
  markdown: string
  spellCheckEnabled?: boolean
  editIndicatorModel?: EditIndicatorModel
  showEditIndicators?: boolean
  editorTheme?: EditorTheme
  mermaidAppearance?: MermaidAppearance
  zoomPercent?: number
  onChange: (markdown: string) => void
  onModeChange?: (mode: EditorMode) => void
  onOpenLargeModelSettings(): void
  translationHistory?: Pick<
    TranslationHistoryStore,
    'selectedRecordId' | 'finalize' | 'selectById' | 'updateAnchor'
  >
  translationHistoryRecords?: readonly TranslationHistoryRecord[]
  translationHistoryIdentity?: {
    workspaceAbsolutePath: string | null
    documentRelativePath: string | null
    documentRevision: string | null
  }
  initialMode?: EditorMode
  initialTranslationHistoryRecordId?: string | null
  onNavigateTranslationHistoryRecord?(
    recordId: string,
    alignment?: TranslationHistoryRevealAlignment,
  ): void
  onTranslationHistoryReady?(documentKey: string, mode: EditorMode): void
  translationSettingsRevision?: number
  rightSidebarState?: EditorRightSidebarState
  rightSidebarWidth?: number
  onOpenRightSidebar?(tab: EditorRightSidebarTab): void
  onCloseRightSidebar?(): void
  onRightSidebarWidthChange?(width: number): void
}

export interface EditorPaneHandle extends TranslationHistoryEditorHandle {
  flush(): string | null
  insertDroppedLink(input: DroppedLinkInsertion): boolean
  insertDroppedMarkdown(input: DroppedMarkdownInsertion): boolean
}

interface ModeBoundary {
  mode: EditorMode
  checkpoint: string
  generation: number
  position: EditorModePosition | null
}

interface PendingCodeExplanation {
  documentKey: string
  detail: CodeExplanationRequestDetail
}

interface TranslationControllerState {
  selection: TranslationSelection | null
  presentation: TranslationPresentation | null
  requestId: string | null
  status: TranslationUiStatus
  output: string
  errorCode: PublicErrorCode | null
  error: string | null
}

function hasConfiguredSelectionTranslationModel(settings: LargeModelSettings): boolean {
  const connectionId = settings.selectionTranslation.connectionId
  return connectionId !== null
    && featureModelConnections(settings).some(({ id }) => id === connectionId)
}

function hasConfiguredAiConversationModel(settings: LargeModelSettings): boolean {
  const connectionId = settings.aiConversation.connectionId
  return connectionId !== null && featureModelConnections(settings).some(({ id }) => id === connectionId)
}

function aiConversationProfileFingerprint(settings: LargeModelSettings): string | null {
  const connectionId = settings.aiConversation.connectionId
  if (!connectionId) return null
  const connection = featureModelConnections(settings).find(({ id }) => id === connectionId)
  if (!connection) return null
  return JSON.stringify([
    connection.id,
    connection.provider,
    connection.protocol,
    connection.baseUrl,
    connection.modelId,
    connection.capabilityOverride,
    settings.aiConversation.thinkingMode,
    settings.aiConversation.reasoningEffort,
  ])
}

function displayNameFromDocumentKey(documentKey: string): string {
  return documentKey.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) || '未命名文档'
}

function sourceFormatFromDisplayName(displayName: string): string {
  const extension = displayName.match(/\.([^.]+)$/u)?.[1]?.toLocaleLowerCase('en-US')
  return extension || 'markdown'
}

interface RetainedTranslationSelection {
  documentKey: string
  markdown: string
  documentRevision: string | null
  selection: TranslationSelection
  requestedTargetLanguage: LargeModelSettings['selectionTranslation']['targetLanguage'] | null
  pendingAnchorKey: string
  historyEditor: TranslationHistoryEditorHandle | null
  anchorSettled: boolean
  awaitingSettings: boolean
  invalidated: boolean
}

interface PendingTranslationStart {
  generation: number
  invalidated: boolean
  overflowed: boolean
  byteLength: number
  events: TranslationEvent[]
  pendingAnchorKey: string
  historyEditor: TranslationHistoryEditorHandle | null
  anchorSettled: boolean
}

const EMPTY_EDIT_INDICATOR_MODEL: EditIndicatorModel = Object.freeze({
  lineStates: Object.freeze([]),
  status: 'idle',
  markdownVersion: 0,
  modelVersion: 0,
})

interface ActiveTranslationRequest {
  requestId: string
  cancelIssued: boolean
  source: TranslationSelection['content']
  mode: TranslationSelection['mode']
  modelId: string
  targetLanguage: TranslationStarted['targetLanguage']
  fallbackAnchor: TranslationHistoryAnchor
  historyEditor: TranslationHistoryEditorHandle | null
  anchorSettled: boolean
}

function discardPendingStartAnchor(pending: Pick<
  PendingTranslationStart, 'anchorSettled' | 'historyEditor' | 'pendingAnchorKey'
>): void {
  if (pending.anchorSettled) return
  pending.anchorSettled = true
  pending.historyEditor?.discardPendingTranslationAnchor(pending.pendingAnchorKey)
}

function discardActiveTranslationAnchor(active: ActiveTranslationRequest): void {
  if (active.anchorSettled) return
  active.anchorSettled = true
  active.historyEditor?.discardPendingTranslationAnchor(active.requestId)
}

function promoteActiveTranslationAnchor(
  active: ActiveTranslationRequest,
): TranslationHistoryAnchor | null {
  if (active.anchorSettled) return null
  active.anchorSettled = true
  return active.historyEditor?.promotePendingTranslationAnchor(active.requestId)
    ?? active.fallbackAnchor
}

interface SidebarMeasurements {
  containerWidth: number
  surfaceWidth: number
  selectionTop: number
  surfaceTop: number
  alignmentHeight: number
  resultHeight: number
}

const INITIAL_TRANSLATION_STATE: TranslationControllerState = {
  selection: null,
  presentation: null,
  requestId: null,
  status: 'ready',
  output: '',
  errorCode: null,
  error: null,
}

const INITIAL_SIDEBAR_MEASUREMENTS: SidebarMeasurements = {
  containerWidth: 0,
  surfaceWidth: 0,
  selectionTop: 0,
  surfaceTop: 0,
  alignmentHeight: 0,
  resultHeight: 0,
}

const PENDING_TRANSLATION_EVENT_LIMIT = 128
const PENDING_TRANSLATION_BYTE_LIMIT = 1024 * 1024
const GENERIC_OPERATION_ERROR = '操作未能完成，请重试。'
const GENERIC_OPERATION_ERROR_CODE: PublicErrorCode = 'OPERATION_FAILED'

function translationErrorCode(code: string): PublicErrorCode {
  return isPublicErrorCode(code) ? code : GENERIC_OPERATION_ERROR_CODE
}

function unresolvedTranslationAnchor(selection: TranslationSelection): TranslationHistoryAnchor {
  const fingerprint = {
    before: '',
    selected: selection.content.plainText,
    after: '',
  }
  return selection.mode === 'source'
    ? {
        mode: 'source',
        from: 0,
        to: selection.content.markdown.length,
        lineStart: 0,
        fingerprint,
        status: 'location-changed',
      }
    : {
        mode: 'visual',
        from: 0,
        to: selection.content.markdown.length,
        blockStart: 0,
        fingerprint,
        status: 'location-changed',
      }
}

function isRestorableFocusTarget(target: HTMLElement | null): target is HTMLElement {
  if (!target?.isConnected || target.tabIndex < 0 || target.closest('[hidden], [inert]')) {
    return false
  }
  return !(target instanceof HTMLButtonElement && target.disabled)
}

function sameTranslationDocumentKey(left: string, right: string): boolean {
  if (left.startsWith('__untitled__:') || right.startsWith('__untitled__:')) return left === right
  return left.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
    === right.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
}

export const EditorPane = forwardRef<EditorPaneHandle, EditorPaneProps>(
  function EditorPane({
    interactionLocked = false,
    readClipboardImage,
    aiConversationStore,
    modelPreferences,
    aiWorkspace = null,
    onWorkspaceFilesChanged,
    documentAbsolutePath = null,
    documentLocation = null,
    onDocumentLocationHandled,
    documentDisplayName,
    documentSourceFormat,
    documentDirty = false,
    documentKey,
    findRequest = null,
    markdown,
    spellCheckEnabled = false,
    editIndicatorModel = EMPTY_EDIT_INDICATOR_MODEL,
    showEditIndicators = false,
    editorTheme = DEFAULT_EDITOR_THEME,
    mermaidAppearance,
    zoomPercent = 100,
    onChange,
    onModeChange,
    onOpenLargeModelSettings,
    translationHistory,
    translationHistoryRecords = [],
    translationHistoryIdentity = {
      workspaceAbsolutePath: null,
      documentRelativePath: null,
      documentRevision: null,
    },
    initialMode = 'visual',
    initialTranslationHistoryRecordId = null,
    onNavigateTranslationHistoryRecord,
    onTranslationHistoryReady,
    translationSettingsRevision = 0,
    rightSidebarState,
    rightSidebarWidth,
    onOpenRightSidebar,
    onCloseRightSidebar,
    onRightSidebarWidthChange,
  }, ref) {
    const codeDocument = isCodeDocumentPath(documentAbsolutePath ?? documentDisplayName ?? '')
    const effectiveInitialMode = codeDocument ? 'source' : initialMode
    const businessDialogs = useOptionalBusinessDialog()
    const [boundary, setBoundary] = useState<ModeBoundary>({
      mode: effectiveInitialMode,
      checkpoint: markdown,
      generation: 0,
      position: null,
    })
    const [findOpen, setFindOpen] = useState(false)
    const [findQuery, setFindQuery] = useState('')
    const [findFocusRequest, setFindFocusRequest] = useState(0)
    const [findSnapshot, setFindSnapshot] = useState(EMPTY_DOCUMENT_FIND_SNAPSHOT)
    // A loaded session can still be mounting its editor (or replacing a mode).
    const findIdentity = `${documentKey}:${boundary.mode}:${boundary.generation}`
    const findIdentityRef = useRef(findIdentity)
    findIdentityRef.current = findIdentity
    const [findReadyIdentity, setFindReadyIdentity] = useState<string | null>(null)
    const consumedFindRequestRef = useRef<number | null>(null)
    const reportFindReady = useCallback(() => {
      if (findIdentityRef.current === findIdentity) setFindReadyIdentity(findIdentity)
    }, [findIdentity])
    const findQueryRef = useRef('')
    const [translation, setTranslationState] = useState<TranslationControllerState>(
      INITIAL_TRANSLATION_STATE,
    )
    const [directSidebarModelState, setDirectSidebarModelState] = useState<
      'idle' | 'checking' | 'configured' | 'unconfigured'
    >('idle')
    const [aiSidebarModelState, setAiSidebarModelState] = useState<
      'checking' | 'configured' | 'unconfigured' | 'error'
    >('checking')
    const [aiConfigurationRefreshRequest, setAiConfigurationRefreshRequest] = useState(0)
    const workspaceAiController = useOptionalWorkspaceAiConversationController()
    const setGlobalAiWritePolicy = workspaceAiController?.setGlobalWritePolicy
    const [standaloneAiWritePolicy, setStandaloneAiWritePolicy] =
      useState<AiWritePolicy | undefined>()
    const [aiContextWindowTokens, setAiContextWindowTokens] = useState<number | null>(null)
    const modelRulesReady = useModelRulesReady()
    const modelRulesRevision = useModelRulesRevision()
    const [aiProfileFingerprint, setAiProfileFingerprint] = useState<string | null | undefined>()
    const [aiModelSettings, setAiModelSettings] = useState<LargeModelSettings | null>(null)
    const modelObservationRef = useRef<PublicModelSettingsSnapshot | undefined>(undefined)
    const applyConfirmedAiConfiguration = useCallback((confirmed: LargeModelSettings) => {
      setAiSidebarModelState(hasConfiguredAiConversationModel(confirmed) ? 'configured' : 'unconfigured')
      setAiProfileFingerprint(aiConversationProfileFingerprint(confirmed))
      if (setGlobalAiWritePolicy) setGlobalAiWritePolicy(confirmed.aiConversation.writePolicy)
      else setStandaloneAiWritePolicy(confirmed.aiConversation.writePolicy)
      const selected = featureModelConnections(confirmed).find(({ id }) => id === confirmed.aiConversation.connectionId)
      setAiContextWindowTokens(selected ? resolveModelCapabilityProfile(selected, {
        requestedOutputTokens: 1,
        thinkingMode: confirmed.aiConversation.thinkingMode,
        reasoningEffort: confirmed.aiConversation.reasoningEffort,
      })?.contextWindowTokens ?? null : null)
    }, [setGlobalAiWritePolicy, modelRulesRevision])
    useEffect(() => {
      if (!modelPreferences) return
      const sync = () => {
        const view = modelPreferences.getSnapshot()
        modelObservationRef.current = view.observed
        if (view.settings) { setAiModelSettings(view.settings); setTranslationModelSettings(view.settings) }
        // Retained unsaved choices may be displayed, but only confirmed settings
        // can select the execution profile, capability budget and write policy.
        if (view.observed && modelRulesReady) applyConfirmedAiConfiguration(view.observed.settings)
        setAiModelSwitchError(view.failedKeys.some(key => key.startsWith('feature.aiConversation.')) ? view.error : null)
        setTranslationSettingsError(view.failedKeys.some(key => key.startsWith('feature.selectionTranslation.')) ? view.error : null)
        const aiPending = view.loading || view.pendingKeys.some(key => key.startsWith('feature.aiConversation.'))
        const translationPending = view.loading || view.pendingKeys.some(key => key.startsWith('feature.selectionTranslation.'))
        aiModelSwitchPendingRef.current = aiPending; setAiModelSwitchPending(aiPending)
        translationSettingsPendingRef.current = translationPending; setTranslationSettingsPending(translationPending)
      }
      sync()
      return modelPreferences.subscribe(sync)
    }, [modelPreferences, modelRulesReady, applyConfirmedAiConfiguration])
    const [aiModelSwitchPending, setAiModelSwitchPending] = useState(false)
    const aiModelSwitchPendingRef = useRef(false)
    const [aiModelSwitchError, setAiModelSwitchError] = useState<string | null>(null)
    const aiSettingsReadEpoch = useRef(0)
    const [translationModelSettings, setTranslationModelSettings] = useState<LargeModelSettings | null>(null)
    const [translationSettingsPending, setTranslationSettingsPending] = useState(false)
    const translationSettingsPendingRef = useRef(false)
    const translationSettingsReadEpoch = useRef(0)
    const [translationSettingsError, setTranslationSettingsError] = useState<string | null>(null)
    const [pendingCodeExplanation, setPendingCodeExplanation] =
      useState<PendingCodeExplanation | null>(null)
    const [translationSidebarOpenRequest, setTranslationSidebarOpenRequest] = useState(false)
    const [sidebarView, setSidebarView] = useState<TranslationSidebarView>(
      initialTranslationHistoryRecordId
        ? { kind: 'history', recordId: initialTranslationHistoryRecordId }
        : { kind: 'live' },
    )
    const [sidebarMeasurements, setSidebarMeasurements] =
      useState<SidebarMeasurements>(INITIAL_SIDEBAR_MEASUREMENTS)
    const [translationHistoryRailCenterRequest, setTranslationHistoryRailCenterRequest] = useState<{
      recordId: string
      token: number
    } | null>(null)
    const paneRef = useRef<HTMLElement>(null)
    const surfaceRef = useRef<HTMLDivElement>(null)
    const interactionLockedRef = useRef(interactionLocked)
    useLayoutEffect(() => { interactionLockedRef.current = interactionLocked }, [interactionLocked])
    const visualEditorRef = useRef<VisualEditorHandle>(null)
    const sourceEditorRef = useRef<SourceEditorHandle>(null)
    const consumedDocumentLocation = useRef<DocumentLocationIntent | null>(null)
    useEffect(() => {
      if (!documentLocation || consumedDocumentLocation.current === documentLocation
        || !documentAbsolutePath || findReadyIdentity !== findIdentity
        || !sameTranslationDocumentKey(documentLocation.absolutePath, documentAbsolutePath)) return
      consumedDocumentLocation.current = documentLocation
      surfaceRef.current?.querySelector<HTMLElement>('.ProseMirror, .cm-content, textarea')?.focus({ preventScroll: true })
      if (documentLocation.line) sourceEditorRef.current?.revealLine?.(documentLocation.line)
      if (documentLocation.anchor) {
        if (boundary.mode === 'source') sourceEditorRef.current?.revealAnchor?.(documentLocation.anchor)
        else revealVisualAnchor(surfaceRef.current, documentLocation.anchor)
      }
      onDocumentLocationHandled?.(documentLocation)
    }, [documentLocation, documentAbsolutePath, findReadyIdentity, findIdentity, boundary.mode, onDocumentLocationHandled])
    const documentViewApi = useMemo((): DocumentViewApi | undefined => {
      const api = window.arkdown
      if (!api?.navigateDocumentView || !api.refreshDocumentView || !api.inspectDocumentView || !api.openDocumentView) return undefined
      return {
        navigateDocumentView: api.navigateDocumentView,
        refreshDocumentView: api.refreshDocumentView,
        inspectDocumentView: api.inspectDocumentView,
        openDocumentView: api.openDocumentView,
      }
    }, [])
    const documentView = useDocumentView({
      api: documentViewApi,
      sourceKey: documentKey,
      sourcePath: documentAbsolutePath,
      sourceName: documentDisplayName ?? documentAbsolutePath?.split(/[\\/]/).at(-1) ?? '当前文档',
      onOpenView: () => onOpenRightSidebar?.('document-view'),
      onReturnToSource: (location): void => {
        surfaceRef.current?.querySelector<HTMLElement>('.ProseMirror, .cm-content, textarea')?.focus({ preventScroll: true })
        if (location?.line) sourceEditorRef.current?.revealLine?.(location.line)
        const anchorFound = !location?.anchor || (boundary.mode === 'source'
          ? sourceEditorRef.current?.revealAnchor?.(location.anchor)
          : revealVisualAnchor(surfaceRef.current, location.anchor))
        if (!anchorFound) {
          documentView.reportError('未找到链接指定的章节，已返回原文档')
        }
      },
    })
    const openDocumentLink = useCallback(async (href: string) => {
      const parsed = parseDocumentViewLink(href)
      if (parsed?.kind === 'anchor') {
        if (!revealVisualAnchor(surfaceRef.current, parsed.anchor)) throw new Error('未找到链接指定的章节')
        return
      }
      await documentView.navigate(href)
    }, [documentView.navigate])
    const aiOpenPortQueueRef = useRef<Promise<void>>(Promise.resolve())
    const marginSelectionControllerRef = useRef<MarginSelectionController | null>(null)
    const stickyNoteSelectionRef = useRef<StickyNoteSelectionExport | null>(null)
    const latestMarkdownRef = useRef(markdown)
    const lastParentMarkdownRef = useRef(markdown)
    const pendingParentReplacementRef = useRef(false)
    const onChangeRef = useRef(onChange)
    const onModeChangeRef = useRef(onModeChange)
    const initialModeReportedRef = useRef(false)
    const translationRef = useRef(translation)
    const mountedRef = useRef(true)
    const documentKeyRef = useRef(documentKey)
    const documentAbsolutePathRef = useRef(documentAbsolutePath)
    const translationHistoryIdentityRef = useRef(translationHistoryIdentity)
    const activeModeRef = useRef<EditorMode>(boundary.mode)
    const lifecycleGenerationRef = useRef(0)
    const activeRequestRef = useRef<ActiveTranslationRequest | null>(null)
    const pendingStartRef = useRef<PendingTranslationStart | null>(null)
    const retainedSelectionRef = useRef<RetainedTranslationSelection | null>(null)
    const cancellationBarrierRef = useRef<Promise<void>>(Promise.resolve())
    const historyFocusInitiatorRef = useRef<HTMLElement | null>(null)
    const restoreHistoryFocusRef = useRef(false)
    const rightSidebarOpenIntentRef = useRef<'history' | 'live' | null>(null)
    const previousRightSidebarOpenRef = useRef(false)
    const selectionContentTopRef = useRef(0)
    const previousDocumentKeyRef = useRef(documentKey)
    const translationHistoryRailCenterTokenRef = useRef(0)
    onChangeRef.current = onChange
    onModeChangeRef.current = onModeChange
    translationRef.current = translation
    documentKeyRef.current = documentKey
    documentAbsolutePathRef.current = documentAbsolutePath
    translationHistoryIdentityRef.current = translationHistoryIdentity
    activeModeRef.current = boundary.mode
    if (markdown !== lastParentMarkdownRef.current) {
      // Local edit echoes must keep the live editor and its undo/selection.
      // A session replacement (e.g. discard) must also replace the visual
      // surface, which consumes its markdown only when it is mounted.
      pendingParentReplacementRef.current = markdown !== latestMarkdownRef.current
      lastParentMarkdownRef.current = markdown
      latestMarkdownRef.current = markdown
    }

    const resolvedDocumentDisplayName = documentDisplayName
      ?? displayNameFromDocumentKey(documentKey)
    const localSourceIds = useRef(new Map<string, string>())
    const sourceIds = workspaceAiController?.activeSession?.documentSourceIds
      ?? aiConversationStore?.sessions.get(aiConversationStore.activeWorkspaceId ?? '')?.documentSourceIds
      ?? localSourceIds.current
    if (!sourceIds.has(documentKey)) sourceIds.set(documentKey, crypto.randomUUID())
    const aiDocumentSourceId = sourceIds.get(documentKey)!
    const selectionRevision = useRef({ markdown, revision: 0 })
    if (selectionRevision.current.markdown !== markdown) {
      selectionRevision.current = { markdown, revision: selectionRevision.current.revision + 1 }
    }
    const resolvedDocumentSourceFormat = documentSourceFormat
      ?? sourceFormatFromDisplayName(resolvedDocumentDisplayName)
    const readAiDocumentSnapshot = useCallback(() => {
      let hasPendingVisualChange = false
      if (activeModeRef.current === 'visual') {
        const markdownBeforeFlush = latestMarkdownRef.current
        const flushedMarkdown = visualEditorRef.current?.flush()
        if (flushedMarkdown !== null && flushedMarkdown !== undefined) {
          hasPendingVisualChange = flushedMarkdown !== markdownBeforeFlush
          latestMarkdownRef.current = flushedMarkdown
        }
      }
      return {
        sourceId: aiDocumentSourceId,
        markdown: latestMarkdownRef.current,
        displayName: resolvedDocumentDisplayName,
        sourceFormat: resolvedDocumentSourceFormat,
        dirty: documentDirty || hasPendingVisualChange,
      }
    }, [aiDocumentSourceId, documentDirty, resolvedDocumentDisplayName, resolvedDocumentSourceFormat])
    const readAiDocumentSnapshotRef = useRef(readAiDocumentSnapshot)
    readAiDocumentSnapshotRef.current = readAiDocumentSnapshot
    const bindCurrentDocumentSource = workspaceAiController?.bindCurrentDocumentSource
    useLayoutEffect(() => {
      if (!aiWorkspace || !bindCurrentDocumentSource) return
      return bindCurrentDocumentSource(
        () => readAiDocumentSnapshotRef.current(),
        aiWorkspace,
        aiDocumentSourceId,
      )
    }, [
      aiWorkspace?.workspaceGeneration,
      aiWorkspace?.workspaceId,
      bindCurrentDocumentSource,
      aiDocumentSourceId,
      documentKey,
    ])
    const aiWritePolicy = workspaceAiController?.globalWritePolicy ?? standaloneAiWritePolicy
    const aiConversation = useAiConversation({
      store: aiConversationStore,
      workspace: workspaceAiController ? aiWorkspace : aiWorkspace ?? undefined,
      onWorkspaceFilesChanged,
      writePolicy: aiWritePolicy,
      contextWindowTokens: aiContextWindowTokens,
      profileFingerprint: aiProfileFingerprint,
    })
    useEffect(() => {
      if (!aiWorkspace || !documentAbsolutePath) return
      let disposed = false
      let documentHandle: string | null = null
      aiOpenPortQueueRef.current = aiOpenPortQueueRef.current.then(async () => {
        if (disposed) return
        const editor = activeModeRef.current === 'source'
          ? sourceEditorRef.current
          : visualEditorRef.current
        let port
        try { port = editor?.createWorkspaceAiEditorPort?.() } catch { return }
        if (!port || disposed) return
        try {
          const result = await window.arkdown.registerAiOpenDocumentPort(port)
          if (result.ok) documentHandle = result.value.documentHandle
        } catch {
          documentHandle = null
        }
      })
      return () => {
        disposed = true
        aiOpenPortQueueRef.current = aiOpenPortQueueRef.current.then(async () => {
          const handle = documentHandle
          documentHandle = null
          if (!handle) return
          try { await window.arkdown.unregisterAiOpenDocumentPort(handle) } catch { /* best effort */ }
        })
      }
    }, [
      aiWorkspace?.workspaceGeneration,
      aiWorkspace?.workspaceId,
      boundary.generation,
      boundary.mode,
      documentAbsolutePath,
      documentKey,
    ])
    const sendAiMessage = aiConversation.sendMessage
    const requestCodeExplanation = useCallback((detail: CodeExplanationRequestDetail) => {
      setAiSidebarModelState('checking')
      setPendingCodeExplanation({ documentKey, detail })
      setAiConfigurationRefreshRequest((request) => request + 1)
      onOpenRightSidebar?.('ai-chat')
    }, [documentKey, onOpenRightSidebar])
    const retryAiConfiguration = useCallback(() => {
      setAiSidebarModelState('checking')
      setAiConfigurationRefreshRequest((request) => request + 1)
    }, [])

    useEffect(() => {
      setPendingCodeExplanation((pending) => (
        pending?.documentKey === documentKey ? pending : null
      ))
    }, [documentKey])

    const activeMarginSelectionPort = useCallback((): EditorMarginSelectionPort | null => (
      activeModeRef.current === 'source'
        ? sourceEditorRef.current?.marginSelectionPort?.() ?? null
        : visualEditorRef.current?.marginSelectionPort?.() ?? null
    ), [])

    useEffect(() => {
      const controller = createMarginSelectionController({
        getPort: activeMarginSelectionPort,
      })
      marginSelectionControllerRef.current = controller
      return () => {
        if (marginSelectionControllerRef.current === controller) {
          marginSelectionControllerRef.current = null
        }
        controller.dispose()
      }
    }, [activeMarginSelectionPort])

    useLayoutEffect(() => {
      marginSelectionControllerRef.current?.cancel()
    }, [boundary.mode, documentKey, rightSidebarState?.activeTab, rightSidebarState?.open, zoomPercent])

    useEffect(() => {
      const pane = paneRef.current
      if (!pane) return
      const cancel = () => marginSelectionControllerRef.current?.cancel()
      window.addEventListener('resize', cancel)
      const mutationObserver = typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
          if (records.some((record) => (
            (
              record.type === 'childList'
              && [...record.addedNodes, ...record.removedNodes].some((node) => (
                node instanceof Element
                && (
                  node.matches('.editor-right-sidebar-motion-track')
                  || Boolean(node.querySelector('.editor-right-sidebar-motion-track'))
                )
              ))
            )
            || (
              record.type === 'attributes'
              && record.target instanceof Element
              && record.target.classList.contains('editor-right-sidebar-motion-track')
            )
          ))) cancel()
        })
      mutationObserver?.observe(pane, {
        attributeFilter: ['data-phase'],
        attributes: true,
        childList: true,
        subtree: true,
      })
      return () => {
        window.removeEventListener('resize', cancel)
        mutationObserver?.disconnect()
      }
    }, [])

    useLayoutEffect(() => {
      if (initialModeReportedRef.current) return
      initialModeReportedRef.current = true
      onModeChangeRef.current?.(effectiveInitialMode)
    }, [])

    const updateTranslation = useCallback((
      updater: TranslationControllerState
        | ((current: TranslationControllerState) => TranslationControllerState),
    ) => {
      const current = translationRef.current
      const next = typeof updater === 'function' ? updater(current) : updater
      translationRef.current = next
      setTranslationState(next)
    }, [])

    const enqueueCancellation = useCallback((requestId: string): Promise<void> => {
      let cancellation: Promise<unknown>
      try {
        cancellation = Promise.resolve(window.arkdown.cancelTranslation(requestId))
      } catch {
        cancellation = Promise.resolve()
      }
      const settled = cancellation.catch(() => undefined)
      const previous = cancellationBarrierRef.current
      cancellationBarrierRef.current = Promise.all([previous, settled]).then(() => undefined)
      return settled.then(() => undefined)
    }, [])

    const activeHistoryEditor = useCallback((): TranslationHistoryEditorHandle | null => (
      activeModeRef.current === 'source'
        ? sourceEditorRef.current
        : visualEditorRef.current
    ), [])

    const reportTranslationHistoryReady = useCallback((
      readyDocumentKey: string,
      readyMode: EditorMode,
    ) => {
      if (
        !mountedRef.current
        || documentKeyRef.current !== readyDocumentKey
        || activeModeRef.current !== readyMode
      ) return
      onTranslationHistoryReady?.(readyDocumentKey, readyMode)
    }, [onTranslationHistoryReady])

    const invalidateTranslationLifecycle = useCallback((preserveSelection = false): number => {
      if (!preserveSelection && retainedSelectionRef.current) {
        discardPendingStartAnchor(retainedSelectionRef.current)
        retainedSelectionRef.current = null
      }
      const generation = lifecycleGenerationRef.current + 1
      lifecycleGenerationRef.current = generation

      const pending = pendingStartRef.current
      if (pending) {
        pending.invalidated = true
        discardPendingStartAnchor(pending)
        pendingStartRef.current = null
      }

      const active = activeRequestRef.current
      activeRequestRef.current = null
      if (active) {
        discardActiveTranslationAnchor(active)
        if (!active.cancelIssued) {
          active.cancelIssued = true
          enqueueCancellation(active.requestId)
        }
      }
      return generation
    }, [activeHistoryEditor, enqueueCancellation])

    const finalizeTranslation = useCallback((
      active: ActiveTranslationRequest,
      terminal: 'completed' | 'stopped' | 'timeout-partial',
      output: string,
    ) => {
      if (terminal !== 'completed' && output.length === 0) {
        discardActiveTranslationAnchor(active)
        return
      }
      const anchor = promoteActiveTranslationAnchor(active)
      if (!anchor) return
      if (!translationHistory) return
      const identity = translationHistoryIdentityRef.current
      translationHistory.finalize({
        requestId: active.requestId,
        documentKey: documentKeyRef.current,
        workspaceAbsolutePath: identity.workspaceAbsolutePath,
        documentRelativePath: identity.documentRelativePath,
        documentAbsolutePath: documentAbsolutePathRef.current,
        documentRevision: identity.documentRevision,
        mode: active.mode,
        source: active.source,
        translatedMarkdown: output,
        modelId: active.modelId,
        targetLanguage: active.targetLanguage,
        terminal,
        anchor,
      })
    }, [translationHistory])

    const applyTranslationEvent = useCallback((event: TranslationEvent) => {
      const active = activeRequestRef.current
      if (!active || active.requestId !== event.requestId) return
      const currentOutput = translationRef.current.output

      switch (event.type) {
        case 'started':
          updateTranslation((current) => ({
            ...current,
            requestId: event.requestId,
            status: 'starting',
            errorCode: null,
            error: null,
          }))
          break
        case 'delta':
          updateTranslation((current) => ({
            ...current,
            requestId: event.requestId,
            status: 'streaming',
            output: current.output + event.delta,
            errorCode: null,
            error: null,
          }))
          break
        case 'completed':
          finalizeTranslation(active, 'completed', currentOutput)
          activeRequestRef.current = null
          updateTranslation((current) => ({
            ...current,
            ...reduceTranslationUiState(current, { type: 'completed' }),
          }))
          break
        case 'stopped':
          finalizeTranslation(active, 'stopped', currentOutput)
          activeRequestRef.current = null
          updateTranslation((current) => ({
            ...current,
            ...reduceTranslationUiState(current, { type: 'stopped' }),
          }))
          break
        case 'failed':
          if (event.code === 'MODEL_TIMEOUT') {
            finalizeTranslation(active, 'timeout-partial', currentOutput)
          } else {
            discardActiveTranslationAnchor(active)
          }
          activeRequestRef.current = null
          updateTranslation((current) => ({
            ...current,
            requestId: null,
            status: 'failed',
            errorCode: event.code,
            error: event.message,
          }))
          break
      }
    }, [finalizeTranslation, updateTranslation])

    const receiveTranslationEvent = useCallback((event: TranslationEvent) => {
      if (activeRequestRef.current?.requestId === event.requestId) {
        applyTranslationEvent(event)
        return
      }

      const pending = pendingStartRef.current
      if (!pending || pending.invalidated || pending.overflowed) return
      const eventBytes = translationEventUtf8ByteLength(event)
      if (
        pending.events.length >= PENDING_TRANSLATION_EVENT_LIMIT
        || pending.byteLength + eventBytes > PENDING_TRANSLATION_BYTE_LIMIT
      ) {
        pending.events = []
        pending.byteLength = 0
        pending.overflowed = true
        return
      }
      pending.events.push(event)
      pending.byteLength += eventBytes
    }, [applyTranslationEvent])

    useEffect(() => {
      mountedRef.current = true
      const unsubscribe = window.arkdown.onTranslationEvent(receiveTranslationEvent)
      return () => {
        unsubscribe()
        mountedRef.current = false
        invalidateTranslationLifecycle()
      }
    }, [invalidateTranslationLifecycle, receiveTranslationEvent])

    const changeMarkdown = useCallback((nextMarkdown: string) => {
      latestMarkdownRef.current = nextMarkdown
      onChangeRef.current(nextMarkdown)
    }, [])

    const flush = useCallback((): string | null => {
      if (boundary.mode !== 'visual') return null
      const checkpoint = visualEditorRef.current?.flush() ?? null
      if (checkpoint !== null) latestMarkdownRef.current = checkpoint
      return checkpoint
    }, [boundary.mode])

    const capturePendingTranslationAnchor = useCallback((pendingKey: string): boolean => {
      return activeHistoryEditor()?.capturePendingTranslationAnchor(pendingKey) ?? false
    }, [activeHistoryEditor])

    const bindPendingTranslationAnchor = useCallback((pendingKey: string, requestId: string) => {
      activeHistoryEditor()?.bindPendingTranslationAnchor(pendingKey, requestId)
    }, [activeHistoryEditor])

    const promotePendingTranslationAnchor = useCallback((requestId: string) => {
      return activeHistoryEditor()?.promotePendingTranslationAnchor(requestId) ?? null
    }, [activeHistoryEditor])

    const discardPendingTranslationAnchor = useCallback((key: string) => {
      activeHistoryEditor()?.discardPendingTranslationAnchor(key)
    }, [activeHistoryEditor])

    const revealTranslationHistoryRecord = useCallback((
      recordId: string,
      alignment: TranslationHistoryRevealAlignment = 'nearest',
    ): boolean => {
      const record = translationHistoryRecords.find(({ id, documentKey: key }) => (
        id === recordId && sameTranslationDocumentKey(key, documentKey)
      ))
      if (!record) return false
      translationHistory?.selectById(recordId)
      rightSidebarOpenIntentRef.current = 'history'
      setSidebarView({ kind: 'history', recordId })
      if (record.anchor.status !== 'valid') return false
      return activeHistoryEditor()?.revealTranslationHistoryRecord(recordId, alignment) ?? false
    }, [activeHistoryEditor, documentKey, translationHistory, translationHistoryRecords])

    const flushTranslationHistoryAnchors = useCallback(
      (): readonly TranslationHistoryAnchorUpdate[] => (
        activeHistoryEditor()?.flushTranslationHistoryAnchors() ?? []
      ),
      [activeHistoryEditor],
    )

    useImperativeHandle(ref, () => ({
      flush,
      insertDroppedLink: (input) => activeModeRef.current === 'source'
        ? sourceEditorRef.current?.insertDroppedLink(input) ?? false
        : visualEditorRef.current?.insertDroppedLink?.(input) ?? false,
      insertDroppedMarkdown: (input) => activeModeRef.current === 'source'
        ? sourceEditorRef.current?.insertDroppedMarkdown(input) ?? false
        : visualEditorRef.current?.insertDroppedMarkdown?.(input) ?? false,
      revealTranslationHistoryRecord,
      flushTranslationHistoryAnchors,
      capturePendingTranslationAnchor,
      bindPendingTranslationAnchor,
      promotePendingTranslationAnchor,
      discardPendingTranslationAnchor,
    }), [
      bindPendingTranslationAnchor,
      capturePendingTranslationAnchor,
      discardPendingTranslationAnchor,
      flush,
      flushTranslationHistoryAnchors,
      promotePendingTranslationAnchor,
      revealTranslationHistoryRecord,
    ])

    const clearTranslation = useCallback(() => {
      historyFocusInitiatorRef.current = null
      restoreHistoryFocusRef.current = false
      setTranslationSidebarOpenRequest(false)
      updateTranslation(INITIAL_TRANSLATION_STATE)
      setSidebarView({ kind: 'live' })
      setSidebarMeasurements((current) => ({
        ...INITIAL_SIDEBAR_MEASUREMENTS,
        containerWidth: current.containerWidth,
        surfaceWidth: current.surfaceWidth,
      }))
    }, [updateTranslation])

    const switchMode = useCallback(() => {
      if (interactionLockedRef.current || codeDocument) return
      invalidateTranslationLifecycle()
      clearTranslation()
      const currentMode = activeModeRef.current
      const nextMode: EditorMode = currentMode === 'visual' ? 'source' : 'visual'
      let visualSnapshot: ReturnType<NonNullable<VisualEditorHandle['captureModeSwitch']>> = null
      if (currentMode === 'visual') {
        try {
          visualSnapshot = visualEditorRef.current?.captureModeSwitch?.(
            latestMarkdownRef.current,
          ) ?? null
        } catch {
          visualSnapshot = null
        }
      }
      const checkpoint = currentMode === 'visual'
        ? visualSnapshot?.checkpoint
          ?? visualEditorRef.current?.flush()
          ?? latestMarkdownRef.current
        : latestMarkdownRef.current
      const position = currentMode === 'visual'
        ? visualSnapshot
          ? visualSnapshot.position
          : visualEditorRef.current?.captureModePosition?.(checkpoint) ?? null
        : sourceEditorRef.current?.captureModePosition?.() ?? null
      activeModeRef.current = nextMode
      setBoundary((current) => ({
        mode: nextMode,
        checkpoint,
        generation: current.generation + 1,
        position,
      }))
      onModeChangeRef.current?.(nextMode)
    }, [clearTranslation, invalidateTranslationLifecycle, codeDocument])

    const sendFindAction = useCallback((action: DocumentFindAction) => {
      dispatchDocumentFind(action)
    }, [])

    const closeFind = useCallback(() => {
      findQueryRef.current = ''
      sendFindAction({ type: 'close' })
      setFindOpen(false)
      setFindQuery('')
      setFindSnapshot(EMPTY_DOCUMENT_FIND_SNAPSHOT)
    }, [sendFindAction])

    useEffect(() => {
      const onSnapshot = (event: Event) => {
        const snapshot = readDocumentFindSnapshot(event)
        if (!snapshot || snapshot.query !== findQueryRef.current) return
        setFindSnapshot(snapshot)
      }
      window.addEventListener(DOCUMENT_FIND_SNAPSHOT_EVENT, onSnapshot)
      return () => window.removeEventListener(DOCUMENT_FIND_SNAPSHOT_EVENT, onSnapshot)
    }, [])

    useEffect(() => {
      if (!findOpen) return
      const closeFindOnEscape = (event: KeyboardEvent) => {
        if (
          event.key !== 'Escape'
          || event.defaultPrevented
          || document.querySelector([
            '[aria-modal="true"]',
            '[role="menu"]',
            '.workspace-search',
            '.preferences-page',
            '[role="listbox"]',
            '[role="tooltip"]',
          ].join(', '))
        ) return

        const active = document.activeElement instanceof HTMLElement
          && document.activeElement !== document.body
          && !document.activeElement.closest('.document-find-bar')
          ? document.activeElement
          : null
        event.preventDefault()
        closeFind()
        queueMicrotask(() => {
          if (active?.isConnected) {
            active.focus({ preventScroll: true })
            return
          }
          paneRef.current?.querySelector<HTMLElement>(
            '.ProseMirror, .cm-content, textarea, [contenteditable="true"]',
          )?.focus({ preventScroll: true })
        })
      }
      window.addEventListener('keydown', closeFindOnEscape)
      return () => window.removeEventListener('keydown', closeFindOnEscape)
    }, [closeFind, findOpen])

    const changeFindQuery = useCallback((query: string) => {
      findQueryRef.current = query
      setFindQuery(query)
      setFindSnapshot({ query, current: 0, total: 0, revision: 0 })
      sendFindAction({ type: 'query', query })
    }, [sendFindAction])

    const navigateFind = useCallback((direction: 'next' | 'previous') => {
      sendFindAction({ type: direction })
    }, [sendFindAction])

    const clearUnstartedTranslation = useCallback(() => {
      const current = translationRef.current
      if (sidebarView.kind === 'history' && !current.selection) return
      if (current.status !== 'ready' || activeRequestRef.current || pendingStartRef.current) return
      invalidateTranslationLifecycle()
      clearTranslation()
    }, [clearTranslation, invalidateTranslationLifecycle, sidebarView.kind])

    useEffect(() => {
      const onEditorCommand = (event: Event) => {
        if (document.activeElement?.closest('.document-view-panel')) return
        const command = (event as CustomEvent<unknown>).detail
        if (command === 'toggle-source-mode') switchMode()
        if (command === 'find-in-document') {
          clearUnstartedTranslation()
          setFindOpen(true)
          setFindFocusRequest((value) => value + 1)
        }
        if (command === 'toggle-document-find') {
          clearUnstartedTranslation()
          if (findOpen) {
            closeFind()
          } else {
            setFindFocusRequest((value) => value + 1)
            setFindOpen(true)
          }
        }
      }
      window.addEventListener('arkdown:editor-command', onEditorCommand)
      return () => window.removeEventListener('arkdown:editor-command', onEditorCommand)
    }, [clearUnstartedTranslation, closeFind, findOpen, switchMode])

    useEffect(() => {
      findQueryRef.current = ''
      setFindOpen(false)
      setFindQuery('')
      setFindSnapshot(EMPTY_DOCUMENT_FIND_SNAPSHOT)
      sendFindAction({ type: 'close' })
    }, [documentKey, sendFindAction])

    useLayoutEffect(() => {
      const documentChanged = previousDocumentKeyRef.current !== documentKey
      const replaceVisual = pendingParentReplacementRef.current && activeModeRef.current === 'visual'
      pendingParentReplacementRef.current = false
      if (!documentChanged && !replaceVisual) return
      previousDocumentKeyRef.current = documentKey
      setTranslationHistoryRailCenterRequest(null)
      if (!documentChanged && retainedSelectionRef.current?.awaitingSettings) {
        // Keep the retained source so its existing validator can explain that
        // the user must reselect; it must never resume on the replaced text.
        invalidateTranslationLifecycle(true)
      } else {
        invalidateTranslationLifecycle()
        clearTranslation()
      }
      activeModeRef.current = 'visual'
      setBoundary((current) => ({
        mode: 'visual',
        checkpoint: latestMarkdownRef.current,
        generation: current.generation + 1,
        position: null,
      }))
      onModeChangeRef.current?.('visual')
    }, [clearTranslation, documentKey, invalidateTranslationLifecycle, markdown])

    useEffect(() => {
      if (!findOpen) return
      queueMicrotask(() => sendFindAction({ type: 'query', query: findQuery }))
    }, [boundary.generation])

    useEffect(() => {
      if (!findRequest || consumedFindRequestRef.current === findRequest.id
        || findRequest.documentKey !== documentKey
        || findReadyIdentity !== findIdentity || !findRequest.isCurrent()) return
      consumedFindRequestRef.current = findRequest.id
      clearUnstartedTranslation()
      setFindOpen(true)
      setFindFocusRequest((value) => value + 1)
      changeFindQuery(findRequest.query)
    }, [changeFindQuery, clearUnstartedTranslation, documentKey, findIdentity, findReadyIdentity, findRequest])

    const isCurrentTranslationIntent = useCallback((
      selection: TranslationSelection,
      generation: number,
    ): boolean => {
      const currentSelection = translationRef.current.selection
      return mountedRef.current
        && lifecycleGenerationRef.current === generation
        && currentSelection !== null
        && currentSelection.mode === selection.mode
        && documentKeyRef.current === documentKey
        && activeModeRef.current === selection.mode
    }, [documentKey])

    const validateRetainedSelection = useCallback((): boolean => {
      const retained = retainedSelectionRef.current
      if (!retained) return true
      if (
        !retained.invalidated
        && retained.documentKey === documentKeyRef.current
        && retained.selection.mode === activeModeRef.current
        && retained.markdown === latestMarkdownRef.current
        && (retained.selection.mode !== 'visual'
          || (visualEditorRef.current?.flush() ?? retained.markdown) === retained.markdown)
        && retained.documentRevision === translationHistoryIdentityRef.current.documentRevision
      ) return true
      retained.invalidated = true
      discardPendingStartAnchor(retained)
      invalidateTranslationLifecycle(true)
      updateTranslation((current) => ({
        ...current,
        presentation: 'sidebar',
        requestId: null,
        status: 'failed',
        output: '',
        errorCode: GENERIC_OPERATION_ERROR_CODE,
        error: '原文已发生变化，请重新选择要翻译的内容。',
      }))
      return false
    }, [invalidateTranslationLifecycle, updateTranslation])

    const startRetainedSelection = useCallback(async (
      selection: TranslationSelection,
      presentation: TranslationPresentation,
      generation: number,
    ) => {
      if (!areModelRulesReady() || modelPreferences?.hasUnsettledFeature('selectionTranslation')) return
      if (!isCurrentTranslationIntent(selection, generation)) return
      updateTranslation((current) => ({
        ...current,
        presentation,
        requestId: null,
        status: 'starting',
        output: '',
        errorCode: null,
        error: null,
      }))

      const precedingBarrier = cancellationBarrierRef.current
      await precedingBarrier
      if (!areModelRulesReady()) return
      if (!isCurrentTranslationIntent(selection, generation)) return
      if (modelPreferences?.hasUnsettledFeature('selectionTranslation')) {
        updateTranslation(current => ({ ...current, status: 'failed', errorCode: GENERIC_OPERATION_ERROR_CODE,
          error: '翻译设置尚未保存，请重试保存或重新加载设置。' }))
        return
      }

      let releaseAttempt!: () => void
      const attemptSettlement = new Promise<void>((resolve) => {
        releaseAttempt = resolve
      })
      cancellationBarrierRef.current = Promise.all([
        cancellationBarrierRef.current,
        attemptSettlement,
      ]).then(() => undefined)

      if (!validateRetainedSelection()) {
        releaseAttempt()
        return
      }
      const retained = retainedSelectionRef.current
      const pendingAnchorKey = retained?.pendingAnchorKey ?? `translation-${generation}`
      const historyEditor = retained?.historyEditor ?? activeHistoryEditor()
      const pending: PendingTranslationStart = {
        generation,
        invalidated: false,
        overflowed: false,
        byteLength: 0,
        events: [],
        pendingAnchorKey,
        historyEditor,
        anchorSettled: false,
      }
      if (!retained) historyEditor?.capturePendingTranslationAnchor(pendingAnchorKey)
      retainedSelectionRef.current = null
      pendingStartRef.current = pending

      try {
        let result: Awaited<ReturnType<typeof window.arkdown.startTranslation>>
        try {
          result = await window.arkdown.startTranslation({
            documentKey,
            content: selection.content,
            mode: selection.mode,
          })
        } catch {
          discardPendingStartAnchor(pending)
          if (isCurrentTranslationIntent(selection, generation)) {
            updateTranslation((current) => ({
              ...current,
              requestId: null,
              status: 'failed',
              errorCode: GENERIC_OPERATION_ERROR_CODE,
              error: GENERIC_OPERATION_ERROR,
            }))
          }
          return
        }

        if (
          pending.invalidated
          || pendingStartRef.current !== pending
          || !isCurrentTranslationIntent(selection, generation)
        ) {
          discardPendingStartAnchor(pending)
          if (result.ok) await enqueueCancellation(result.value.requestId)
          return
        }

        if (!result.ok) {
          if (result.error.code === 'MODEL_NOT_CONFIGURED' && retained) {
            retainedSelectionRef.current = retained
            pending.anchorSettled = true // Ownership returns to the retained selection.
          } else {
            discardPendingStartAnchor(pending)
          }
          updateTranslation((current) => ({
            ...current,
            requestId: null,
            status: 'failed',
            errorCode: translationErrorCode(result.error.code),
            error: result.error.message,
          }))
          return
        }

        if (pending.overflowed) {
          discardPendingStartAnchor(pending)
          await enqueueCancellation(result.value.requestId)
          if (
            pending.invalidated
            || pendingStartRef.current !== pending
            || !isCurrentTranslationIntent(selection, generation)
          ) {
            return
          }
          updateTranslation((current) => ({
            ...current,
            requestId: null,
            status: 'failed',
            errorCode: GENERIC_OPERATION_ERROR_CODE,
            error: GENERIC_OPERATION_ERROR,
          }))
          return
        }

        if (!pending.anchorSettled) {
          historyEditor?.bindPendingTranslationAnchor(pendingAnchorKey, result.value.requestId)
          pending.anchorSettled = true
        }
        activeRequestRef.current = {
          requestId: result.value.requestId,
          cancelIssued: false,
          source: selection.content,
          mode: selection.mode,
          modelId: result.value.modelId,
          targetLanguage: result.value.targetLanguage,
          fallbackAnchor: unresolvedTranslationAnchor(selection),
          historyEditor,
          anchorSettled: false,
        }
        updateTranslation((current) => ({
          ...current,
          requestId: result.value.requestId,
          status: 'starting',
          errorCode: null,
          error: null,
        }))
        for (const event of pending.events) {
          if (event.requestId === result.value.requestId) applyTranslationEvent(event)
        }
      } finally {
        if (pendingStartRef.current === pending) pendingStartRef.current = null
        releaseAttempt()
      }
    }, [
      applyTranslationEvent,
      activeHistoryEditor,
      documentKey,
      enqueueCancellation,
      modelPreferences,
      isCurrentTranslationIntent,
      updateTranslation,
      validateRetainedSelection,
    ])

    const beginTranslation = useCallback(() => {
      if (!areModelRulesReady() || translationSettingsPendingRef.current || modelPreferences?.hasUnsettledFeature('selectionTranslation')) return
      const selection = translationRef.current.selection
      if (!selection || selection.mode !== activeModeRef.current) return
      if (!validateRetainedSelection()) return
      const generation = invalidateTranslationLifecycle(true)
      if (!retainedSelectionRef.current) {
        if (selection.mode === 'visual') {
          const flushedMarkdown = visualEditorRef.current?.flush()
          if (flushedMarkdown !== null && flushedMarkdown !== undefined) {
            latestMarkdownRef.current = flushedMarkdown
          }
        }
        const historyEditor = activeHistoryEditor()
        const pendingAnchorKey = `translation-${generation}`
        historyEditor?.capturePendingTranslationAnchor(pendingAnchorKey)
        retainedSelectionRef.current = {
          documentKey,
          markdown: latestMarkdownRef.current,
          documentRevision: translationHistoryIdentityRef.current.documentRevision,
          selection,
          requestedTargetLanguage: null,
          pendingAnchorKey,
          historyEditor,
          anchorSettled: false,
          awaitingSettings: false,
          invalidated: false,
        }
      }
      const openSidebar = () => {
        updateTranslation((current) => ({
          ...current,
          presentation: 'sidebar',
          requestId: null,
          output: '',
          errorCode: null,
          error: null,
        }))
        rightSidebarOpenIntentRef.current = 'live'
        setTranslationSidebarOpenRequest(true)
        setSidebarView({ kind: 'live' })
        onOpenRightSidebar?.('translation')
      }
      void window.arkdown.getLargeModelSettings().then((result) => {
        if (!isCurrentTranslationIntent(selection, generation)) return
        if (result.ok && retainedSelectionRef.current?.requestedTargetLanguage === null) {
          retainedSelectionRef.current.requestedTargetLanguage = result.value.selectionTranslation.targetLanguage
        }
        if (result.ok && !hasConfiguredSelectionTranslationModel(result.value)) {
          openSidebar()
          updateTranslation((current) => ({
            ...current,
            presentation: 'sidebar',
            requestId: null,
            status: 'failed',
            output: '',
            errorCode: 'MODEL_NOT_CONFIGURED',
            error: PUBLIC_ERROR_MESSAGES.MODEL_NOT_CONFIGURED,
          }))
          return
        }
        openSidebar()
        void startRetainedSelection(selection, 'sidebar', generation)
      }).catch(() => {
        if (isCurrentTranslationIntent(selection, generation)) {
          openSidebar()
          void startRetainedSelection(selection, 'sidebar', generation)
        }
      })
    }, [
      activeHistoryEditor,
      documentKey,
      invalidateTranslationLifecycle,
      isCurrentTranslationIntent,
      onOpenRightSidebar,
      modelPreferences,
      startRetainedSelection,
      updateTranslation,
      validateRetainedSelection,
    ])

    const getTranslationScrollRoot = useCallback((mode: EditorMode): HTMLElement | null => {
      const surface = surfaceRef.current
      if (!surface) return null
      if (mode === 'source') {
        return surface.querySelector<HTMLElement>('.source-editor .cm-scroller') ?? surface
      }
      return surface
    }, [])

    const reportTranslationSelection = useCallback((
      selection: TranslationSelection | null,
    ) => {
      if (!selection) {
        if (retainedSelectionRef.current?.awaitingSettings) return
        const current = translationRef.current
        if (current.status === 'ready' && current.selection) {
          invalidateTranslationLifecycle()
          clearTranslation()
        }
        return
      }
      if (selection.mode !== activeModeRef.current) return

      selection = { ...selection, content: Object.freeze({ ...selection.content }),
        ...(selection.range ? { range: Object.freeze({ ...selection.range }) } : {}),
        source: Object.freeze({ id: aiDocumentSourceId, displayName: resolvedDocumentDisplayName,
          revision: selectionRevision.current.revision }) }
      invalidateTranslationLifecycle()
      setTranslationSidebarOpenRequest(false)
      const scrollRoot = getTranslationScrollRoot(selection.mode)
      if (scrollRoot) {
        const scrollRootRect = scrollRoot.getBoundingClientRect()
        selectionContentTopRef.current =
          selection.focusRect.top - scrollRootRect.top + scrollRoot.scrollTop
      } else {
        selectionContentTopRef.current = selection.focusRect.top
      }
      updateTranslation({
        selection,
        presentation: 'popover',
        requestId: null,
        status: 'ready',
        output: '',
        errorCode: null,
        error: null,
      })
      setSidebarView({ kind: 'live' })
    }, [
      clearTranslation,
      getTranslationScrollRoot,
      invalidateTranslationLifecycle,
      updateTranslation,
      aiDocumentSourceId,
      resolvedDocumentDisplayName,
    ])

    const quoteSelectionToAi = () => {
      const selection = translationRef.current.selection
      if (!selection?.source || !selection.range) return
      aiConversation.addQuote({ sourceId: selection.source.id,
        documentName: selection.source.displayName.split(/[\\/]/u).pop() || '未命名文档',
        revision: selection.source.revision,
        range: { ...selection.range, mode: selection.mode },
        content: selection.content.markdown, plainText: selection.content.plainText })
      closeTranslation()
      onOpenRightSidebar?.('ai-chat')
    }

    const reportTranslationAnchor = useCallback((
      mode: EditorMode,
      geometry: TranslationSelectionGeometry | null,
    ) => {
      if (!geometry) return
      const { anchorRect, focusRect } = geometry
      const currentSelection = translationRef.current.selection
      if (!currentSelection || currentSelection.mode !== mode) return
      const scrollRoot = getTranslationScrollRoot(mode)
      if (scrollRoot) {
        const scrollRootRect = scrollRoot.getBoundingClientRect()
        selectionContentTopRef.current =
          focusRect.top - scrollRootRect.top + scrollRoot.scrollTop
      } else {
        selectionContentTopRef.current = focusRect.top
      }
      updateTranslation((current) => {
        const selection = current.selection
        if (!selection || selection.mode !== mode) return current
        const previous = selection.anchorRect
        if (
          previous.left === anchorRect.left
          && previous.top === anchorRect.top
          && previous.right === anchorRect.right
          && previous.bottom === anchorRect.bottom
          && previous.width === anchorRect.width
          && previous.height === anchorRect.height
          && selection.focusRect.left === focusRect.left
          && selection.focusRect.top === focusRect.top
          && selection.focusRect.right === focusRect.right
          && selection.focusRect.bottom === focusRect.bottom
          && selection.focusRect.width === focusRect.width
          && selection.focusRect.height === focusRect.height
        ) return current
        return {
          ...current,
          selection: {
            ...selection,
            anchorRect,
            focusRect,
            releaseRect: {
              ...selection.releaseRect,
              left: selection.releaseRect.left + anchorRect.left - previous.left,
              right: selection.releaseRect.right + anchorRect.left - previous.left,
              top: selection.releaseRect.top + anchorRect.top - previous.top,
              bottom: selection.releaseRect.bottom + anchorRect.top - previous.top,
            },
          },
        }
      })
    }, [getTranslationScrollRoot, updateTranslation])

    const stopTranslation = useCallback(() => {
      const active = activeRequestRef.current
      if (active) finalizeTranslation(active, 'stopped', translationRef.current.output)
      invalidateTranslationLifecycle()
      updateTranslation((current) => ({
        ...current,
        requestId: null,
        status: 'stopped',
        errorCode: null,
        error: null,
      }))
    }, [finalizeTranslation, invalidateTranslationLifecycle, updateTranslation])

    const closeTranslation = useCallback(() => {
      invalidateTranslationLifecycle()
      clearTranslation()
    }, [clearTranslation, invalidateTranslationLifecycle])

    const returnToLiveTranslation = useCallback(() => {
      restoreHistoryFocusRef.current = true
      setSidebarView({ kind: 'live' })
    }, [])

    const closeHistoryView = useCallback(() => {
      if (translationRef.current.selection) {
        returnToLiveTranslation()
        return
      }
      restoreHistoryFocusRef.current = false
      historyFocusInitiatorRef.current = null
      setSidebarView({ kind: 'live' })
      onCloseRightSidebar?.()
    }, [onCloseRightSidebar, returnToLiveTranslation])

    const inferredRightSidebarOpen = sidebarView.kind === 'history'
      || Boolean(translation.selection && translation.presentation === 'sidebar')
    const rightSidebarOpen = translationSidebarOpenRequest
      || (rightSidebarState?.open ?? inferredRightSidebarOpen)
    const rightSidebarTab = rightSidebarState?.activeTab ?? 'translation'
    const documentHistoryRecords = useMemo(() => translationHistoryRecords.filter(
      ({ documentKey: key }) => sameTranslationDocumentKey(key, documentKey),
    ), [documentKey, translationHistoryRecords])

    useLayoutEffect(() => {
      if (rightSidebarState?.open) setTranslationSidebarOpenRequest(false)
    }, [rightSidebarState?.open])

    useEffect(() => {
      if (rightSidebarOpen && rightSidebarTab === 'ai-chat') return
      setPendingCodeExplanation(null)
    }, [rightSidebarOpen, rightSidebarTab])

    useEffect(() => {
      if (
        !rightSidebarOpen
        || rightSidebarTab !== 'translation'
        || translation.selection
        || documentHistoryRecords.length > 0
      ) {
        setDirectSidebarModelState('idle')
        return
      }

      let current = true
      setDirectSidebarModelState('checking')
      void window.arkdown.getLargeModelSettings().then((result) => {
        if (!current) return
        if (!result.ok) {
          setDirectSidebarModelState('idle')
          return
        }
        const configured = hasConfiguredSelectionTranslationModel(result.value)
        setDirectSidebarModelState(configured ? 'configured' : 'unconfigured')
        setSidebarView(configured
          ? { kind: 'history', recordId: '' }
          : { kind: 'live' })
      }).catch(() => {
        if (current) setDirectSidebarModelState('idle')
      })
      return () => {
        current = false
      }
    }, [
      rightSidebarOpen,
      rightSidebarTab,
      documentHistoryRecords.length,
      translation.selection,
      translationSettingsRevision,
    ])

    useEffect(() => {
      if (!rightSidebarOpen || rightSidebarTab !== 'ai-chat' || aiModelSwitchPendingRef.current) return
      if (!modelRulesReady) { setAiSidebarModelState('checking'); return }
      const readEpoch = ++aiSettingsReadEpoch.current
      let current = true
      const configurationDocumentKey = documentKey
      setAiSidebarModelState('checking')
      void window.arkdown.getModelSettingsSnapshot().then((result) => {
        if (!current || readEpoch !== aiSettingsReadEpoch.current || documentKeyRef.current !== configurationDocumentKey) return
        if (!result.ok) {
          setAiSidebarModelState('error')
          setAiContextWindowTokens(null)
          return
        }
        modelPreferences?.accept(result.value)
        const view = modelPreferences?.getSnapshot()
        const confirmed = view?.observed ?? result.value
        modelObservationRef.current = confirmed
        const displayed = view?.settings ?? confirmed.settings
        setAiModelSettings(displayed)
        applyConfirmedAiConfiguration(confirmed.settings)
      }).catch(() => {
        if (current && readEpoch === aiSettingsReadEpoch.current && documentKeyRef.current === configurationDocumentKey) {
          setAiSidebarModelState('error')
          setAiContextWindowTokens(null)
        }
      })
      return () => {
        current = false
      }
    }, [
      aiConfigurationRefreshRequest,
      modelRulesReady,
      modelRulesRevision,
      documentKey,
      rightSidebarOpen,
      rightSidebarTab,
      translationSettingsRevision,
      setGlobalAiWritePolicy,
      modelPreferences,
      applyConfirmedAiConfiguration,
    ])

    useEffect(() => {
      if (!rightSidebarOpen || rightSidebarTab !== 'translation' || translationSettingsPendingRef.current) return
      let current = true
      const readEpoch = ++translationSettingsReadEpoch.current
      void window.arkdown.getModelSettingsSnapshot().then((result) => {
        if (!current || readEpoch !== translationSettingsReadEpoch.current) return
        if (!result.ok) throw new Error(result.error.message)
        modelObservationRef.current = result.value
        modelPreferences?.accept(result.value)
        setTranslationModelSettings(modelPreferences?.getSnapshot().settings ?? result.value.settings)
        setTranslationSettingsError(modelPreferences?.getSnapshot().failedKeys.some(key => key.startsWith('feature.selectionTranslation.')) ? modelPreferences.getSnapshot().error : null)
      }).catch((error: unknown) => {
        if (current && readEpoch === translationSettingsReadEpoch.current) {
          setTranslationModelSettings(null)
          setTranslationSettingsError(error instanceof Error ? error.message : '无法读取翻译设置')
        }
      })
      return () => { current = false }
    }, [rightSidebarOpen, rightSidebarTab, translationSettingsRevision, modelPreferences])

    const saveTranslationSettings = async (change: Partial<ModelThinkingPreference>) => {
      if (!areModelRulesReady()) return
      if (translationSettingsPendingRef.current || translationRef.current.status === 'starting' || translationRef.current.status === 'streaming') return
      const observed = modelObservationRef.current
      if (!observed || !modelPreferences) return
      translationSettingsPendingRef.current = true
      translationSettingsReadEpoch.current += 1
      setTranslationSettingsPending(true)
      setTranslationSettingsError(null)
      try {
        const key = `feature.selectionTranslation.${Object.keys(change)[0]}` as const
        const result = await modelPreferences.mutate(key, observed,
          original => window.arkdown.setSelectionTranslationSettings(change, original),
          { feature: 'selectionTranslation', patch: change })
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.status === 'conflict') throw new Error('大模型设置已在其他窗口更改。你的修改仍保留，可以重试保存，或打开设置重新加载。')
      } catch (error) {
        setTranslationSettingsError(error instanceof Error ? error.message : '翻译设置保存失败')
      } finally {
        translationSettingsPendingRef.current = false
        setTranslationSettingsPending(false)
      }
    }

    const saveAiSettings = async (change: Partial<LargeModelSettings['aiConversation']>) => {
      if (!areModelRulesReady()) return
      if (aiModelSwitchPendingRef.current) return
      const changesInference = change.connectionId !== undefined || change.thinkingMode !== undefined || change.reasoningEffort !== undefined
      if (changesInference && (aiConversation.status === 'starting' || aiConversation.status === 'streaming')) return
      const observed = modelObservationRef.current
      if (!observed || !modelPreferences) return
      aiModelSwitchPendingRef.current = true
      aiSettingsReadEpoch.current += 1
      setAiModelSwitchPending(true)
      setAiModelSwitchError(null)
      try {
        const patch = { ...change }
        if (change.connectionId) {
          const connection = featureModelConnections(observed.settings).find(({ id }) => id === change.connectionId)
          if (!connection) throw new Error('模型已不可用，请重新选择')
          patch.reasoningEffort = normalizeReasoningEffort(connection, observed.settings.aiConversation.reasoningEffort)
        }
        const key = `feature.aiConversation.${Object.keys(change)[0]}` as const
        const result = await modelPreferences.mutate(key, observed,
          original => window.arkdown.setAiConversationSettings(patch, original),
          { feature: 'aiConversation', patch })
        if (!result.ok) throw new Error(result.error.message)
        if (result.value.status === 'conflict') throw new Error('大模型设置已在其他窗口更改。你的修改仍保留，可以重试保存，或打开设置重新加载。')
        const confirmed = result.value.snapshot.settings
        setAiProfileFingerprint(aiConversationProfileFingerprint(confirmed))
        if (setGlobalAiWritePolicy) setGlobalAiWritePolicy(confirmed.aiConversation.writePolicy)
        else setStandaloneAiWritePolicy(confirmed.aiConversation.writePolicy)
        setAiConfigurationRefreshRequest((value) => value + 1)
      } catch (error) {
        setAiModelSwitchError(error instanceof Error ? error.message : 'AI 对话设置保存失败')
        // The save invalidated any older configuration refresh. If it fails,
        // finish that pending check with the existing retryable error state.
        setAiSidebarModelState((state) => state === 'checking' ? 'error' : state)
      } finally {
        aiModelSwitchPendingRef.current = false
        setAiModelSwitchPending(false)
      }
    }

    const retryFeatureSettings = async (feature: 'aiConversation' | 'selectionTranslation') => {
      if (!modelPreferences || !areModelRulesReady()) return
      if (feature === 'aiConversation') {
        if (aiModelSwitchPendingRef.current || aiConversation.status === 'starting' || aiConversation.status === 'streaming') return
        aiSettingsReadEpoch.current += 1
      } else {
        if (translationSettingsPendingRef.current || translationRef.current.status === 'starting' || translationRef.current.status === 'streaming') return
        translationSettingsReadEpoch.current += 1
      }
      const saved = await modelPreferences.retryFeature(feature)
      if (saved && feature === 'aiConversation') {
        const confirmed = modelPreferences.getSnapshot().observed?.settings
        if (confirmed) {
          setAiProfileFingerprint(aiConversationProfileFingerprint(confirmed))
          if (setGlobalAiWritePolicy) setGlobalAiWritePolicy(confirmed.aiConversation.writePolicy)
          else setStandaloneAiWritePolicy(confirmed.aiConversation.writePolicy)
        }
        setAiConfigurationRefreshRequest(value => value + 1)
      }
    }

    useEffect(() => {
      if (!pendingCodeExplanation || aiSidebarModelState === 'checking' || aiModelSwitchPending
        || modelPreferences?.hasUnsettledFeature('aiConversation')) return
      if (aiSidebarModelState !== 'configured') return
      if (pendingCodeExplanation.documentKey !== documentKeyRef.current) {
        setPendingCodeExplanation(null)
        return
      }
      let current = true
      const pending = pendingCodeExplanation
      const language = pending.detail.language.trim()
      const fenceLanguage = language.replaceAll('`', '')
      const description = language ? `${language} 代码` : '代码'
      void sendAiMessage([
        `请解读以下${description}，说明它的用途、关键逻辑和需要注意的地方：`,
        '',
        `\`\`\`${fenceLanguage}`,
        pending.detail.code,
        '\`\`\`',
      ].join('\n')).then(() => {
        if (!current || documentKeyRef.current !== pending.documentKey) return
        setPendingCodeExplanation((currentPending) => (
          currentPending === pending ? null : currentPending
        ))
      })
      return () => {
        current = false
      }
    }, [aiSidebarModelState, aiModelSwitchPending, aiModelSwitchError, modelPreferences, pendingCodeExplanation, sendAiMessage])

    useEffect(() => {
      if (
        !rightSidebarOpen
        && !translation.selection
        && sidebarView.kind !== 'history'
      ) return
      const closeTranslationOnEscape = (event: KeyboardEvent) => {
        if (
          event.key !== 'Escape'
          || event.defaultPrevented
          || document.querySelector(
            [
              '[aria-modal="true"]',
              '[role="menu"]',
              '.document-find-bar',
              '.workspace-search',
              '.preferences-page',
              '[role="listbox"]',
              '[role="tooltip"]',
            ].join(', '),
          )
        ) return
        event.preventDefault()
        if (rightSidebarOpen && rightSidebarTab === 'document-view') {
          onCloseRightSidebar?.()
          return
        }
        if (sidebarView.kind === 'history') {
          closeHistoryView()
        } else {
          closeTranslation()
          if (rightSidebarOpen) onCloseRightSidebar?.()
        }
      }
      window.addEventListener('keydown', closeTranslationOnEscape)
      return () => window.removeEventListener('keydown', closeTranslationOnEscape)
    }, [
      closeTranslation,
      closeHistoryView,
      onCloseRightSidebar,
      rightSidebarOpen,
      rightSidebarTab,
      sidebarView.kind,
      translation.selection,
    ])

    const copyTranslation = useCallback((output: string) => (
      navigator.clipboard.writeText(output)
    ), [])

    const openTranslationHistory = useCallback((
      recordId: string,
      initiator?: HTMLElement,
    ) => {
      if (!translationHistoryRecords.some(({ id, documentKey: key }) => (
        id === recordId && sameTranslationDocumentKey(key, documentKey)
      ))) return
      if (
        rightSidebarOpen
        && rightSidebarTab === 'translation'
        && sidebarView.kind === 'history'
        && sidebarView.recordId === recordId
      ) {
        historyFocusInitiatorRef.current = initiator ?? null
        restoreHistoryFocusRef.current = true
        setSidebarView({ kind: 'live' })
        onCloseRightSidebar?.()
        return
      }
      translationHistory?.selectById(recordId)
      historyFocusInitiatorRef.current = initiator ?? null
      restoreHistoryFocusRef.current = false
      setSidebarView({ kind: 'history', recordId })
      rightSidebarOpenIntentRef.current = 'history'
      onOpenRightSidebar?.('translation')
      onNavigateTranslationHistoryRecord?.(recordId)
    }, [
      onCloseRightSidebar,
      onNavigateTranslationHistoryRecord,
      onOpenRightSidebar,
      rightSidebarOpen,
      rightSidebarTab,
      sidebarView,
      documentKey,
      translationHistory,
      translationHistoryRecords,
    ])

    const selectTranslationHistory = useCallback((
      recordId: string,
      alignment: TranslationHistoryRevealAlignment = 'nearest',
    ) => {
      if (!translationHistoryRecords.some(({ id, documentKey: key }) => (
        id === recordId && sameTranslationDocumentKey(key, documentKey)
      ))) return
      translationHistory?.selectById(recordId)
      setSidebarView({ kind: 'history', recordId })
      if (alignment === 'center') {
        setTranslationHistoryRailCenterRequest({
          recordId,
          token: translationHistoryRailCenterTokenRef.current + 1,
        })
        translationHistoryRailCenterTokenRef.current += 1
      }
      onNavigateTranslationHistoryRecord?.(recordId, alignment)
    }, [documentKey, onNavigateTranslationHistoryRecord, translationHistory, translationHistoryRecords])

    useLayoutEffect(() => {
      if (sidebarView.kind !== 'live' || !restoreHistoryFocusRef.current) return
      restoreHistoryFocusRef.current = false
      const target = historyFocusInitiatorRef.current
      historyFocusInitiatorRef.current = null
      if (isRestorableFocusTarget(target)) {
        target.focus()
        return
      }
      surfaceRef.current?.querySelector<HTMLElement>(
        '.ProseMirror, .cm-content, textarea, [contenteditable="true"]',
      )?.focus({ preventScroll: true })
    }, [sidebarView])

    const openTranslationSettings = useCallback(() => {
      invalidateTranslationLifecycle(true)
      if (retainedSelectionRef.current) retainedSelectionRef.current.awaitingSettings = true
      onOpenLargeModelSettings()
    }, [invalidateTranslationLifecycle, onOpenLargeModelSettings])

    useEffect(() => {
      const retained = retainedSelectionRef.current
      if (!retained?.awaitingSettings || !validateRetainedSelection()) return
      let current = true
      const generation = lifecycleGenerationRef.current
      void window.arkdown.getLargeModelSettings().then((result) => {
        if (
          !current || !result.ok
          || retainedSelectionRef.current !== retained
          || lifecycleGenerationRef.current !== generation
          || !validateRetainedSelection()
        ) return
        // Main reads the latest target setting when the user explicitly continues.
        // The original language intent is retained for context, never written back.
        const configured = hasConfiguredSelectionTranslationModel(result.value)
        updateTranslation((state) => ({
          ...state,
          status: configured ? 'ready' : 'failed',
          errorCode: configured ? null : 'MODEL_NOT_CONFIGURED',
          error: configured ? null : PUBLIC_ERROR_MESSAGES.MODEL_NOT_CONFIGURED,
        }))
      }).catch(() => undefined)
      return () => { current = false }
    }, [
      translationSettingsRevision,
      markdown,
      translationHistoryIdentity.documentRevision,
      validateRetainedSelection,
      updateTranslation,
    ])

    const measureSidebarContainer = useCallback(() => {
      const pane = paneRef.current
      const surface = surfaceRef.current
      if (!pane || !surface) return
      const paneRect = pane.getBoundingClientRect()
      const surfaceRect = surface.getBoundingClientRect()
      const containerWidth = paneRect.width || surfaceRect.width
      const surfaceWidth = surfaceRect.width
      setSidebarMeasurements((current) => (
        current.containerWidth === containerWidth
        && current.surfaceWidth === surfaceWidth
          ? current
          : { ...current, containerWidth, surfaceWidth }
      ))
    }, [])

    useLayoutEffect(() => {
      if (!rightSidebarOpen || rightSidebarTab !== 'translation') return
      const pane = paneRef.current
      const surface = surfaceRef.current
      if (!pane || !surface) return
      measureSidebarContainer()
      const observer = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measureSidebarContainer)
      observer?.observe(pane)
      observer?.observe(surface)
      return () => observer?.disconnect()
    }, [measureSidebarContainer, rightSidebarOpen, rightSidebarTab])

    const measureSidebar = useCallback(() => {
      const pane = paneRef.current
      const surface = surfaceRef.current
      const selection = translationRef.current.selection
      const scrollRoot = selection && getTranslationScrollRoot(selection.mode)
      if (!pane || !surface || !scrollRoot) return
      const result = pane.querySelector<HTMLElement>('.translation-sidebar-result')
      const paneRect = pane.getBoundingClientRect()
      const surfaceRect = surface.getBoundingClientRect()
      const scrollRootRect = scrollRoot.getBoundingClientRect()
      const next: SidebarMeasurements = {
        containerWidth: paneRect.width || surfaceRect.width,
        surfaceWidth: surfaceRect.width,
        selectionTop:
          scrollRootRect.top + selectionContentTopRef.current - scrollRoot.scrollTop,
        surfaceTop: scrollRootRect.top,
        alignmentHeight: scrollRoot.clientHeight,
        resultHeight: result?.getBoundingClientRect().height ?? 0,
      }
      setSidebarMeasurements((current) => (
        current.containerWidth === next.containerWidth
        && current.surfaceWidth === next.surfaceWidth
        && current.selectionTop === next.selectionTop
        && current.surfaceTop === next.surfaceTop
        && current.alignmentHeight === next.alignmentHeight
        && current.resultHeight === next.resultHeight
          ? current
          : next
      ))
    }, [getTranslationScrollRoot])

    useLayoutEffect(() => {
      if (
        (
          translation.presentation !== 'sidebar'
          && sidebarView.kind !== 'history'
          && !(rightSidebarOpen && rightSidebarTab === 'translation')
        )
        || !translation.selection
      ) return
      const pane = paneRef.current
      const surface = surfaceRef.current
      const scrollRoot = getTranslationScrollRoot(translation.selection.mode)
      if (!pane || !surface || !scrollRoot) return
      const result = pane.querySelector<HTMLElement>('.translation-sidebar-result')
      const onScroll = () => measureSidebar()
      scrollRoot.addEventListener('scroll', onScroll, { passive: true })
      measureSidebar()

      const observer = typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => measureSidebar())
      observer?.observe(pane)
      if (surface !== scrollRoot) observer?.observe(surface)
      observer?.observe(scrollRoot)
      if (result) observer?.observe(result)

      const frame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => measureSidebar())
        : null
      return () => {
        scrollRoot.removeEventListener('scroll', onScroll)
        observer?.disconnect()
        if (frame !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(frame)
        }
      }
    }, [
      getTranslationScrollRoot,
      measureSidebar,
      rightSidebarOpen,
      rightSidebarTab,
      sidebarView.kind,
      translation.presentation,
      translation.selection,
    ])

    const reportStickyNoteSelection = useCallback((
      selection: StickyNoteSelectionExport | null,
    ) => {
      stickyNoteSelectionRef.current = selection
    }, [])

    const createSelectionStickyNote = useCallback(async () => {
      const snapshot = stickyNoteSelectionRef.current
      const importSelection = window.arkdown.importStickyNoteSelection
      if (!snapshot || !importSelection) {
        await businessDialogs?.alert({ title: '请先选择要建立便签的内容。' })
        return
      }
      const result = await createStickyNoteFromSelection({
        api: {
          importStickyNoteSelection: (input) => importSelection(input),
          releaseStickyNote: (noteId) => window.arkdown.releaseStickyNote(noteId),
        },
        snapshot,
      })
      if (!result.ok) {
        await businessDialogs?.alert({ title: result.error.message })
        return
      }
      const warningCount = snapshot.warnings.length + result.value.warnings.length
      if (warningCount > 0) {
        await businessDialogs?.alert({
          title: '便签已创建，但有 ' + warningCount + ' 项内容未能完整导入，原引用已保留。',
        })
      }
      stickyNoteSelectionRef.current = null
    }, [businessDialogs])
    const openAiMessageLink = useCallback((target: AiMessageLinkTarget) => {
      void window.arkdown.openAiMessageLink(target.target)
    }, [])
    const sourceMode = boundary.mode === 'source'
    const activeHistoryRecords = useMemo(() => documentHistoryRecords.filter((record) => (
      record.mode === boundary.mode
      && record.anchor.mode === boundary.mode
      && record.anchor.status === 'valid'
    )), [boundary.mode, documentHistoryRecords])
    const hasSourceTranslationRail = sourceMode && activeHistoryRecords.length > 0
    const hasVisualTranslationRail = !sourceMode && activeHistoryRecords.length > 0
    const historyRecordId = documentHistoryRecords.at(-1)?.id ?? null
    const visibleHistoryRecordIds = new Set(documentHistoryRecords.map(({ id }) => id))
    const translationHistoryEditorPort: TranslationHistoryEditorPort | undefined = translationHistory
      ? {
          recordsForDocument: (key) => sameTranslationDocumentKey(key, documentKey)
            ? documentHistoryRecords
            : [],
          onAnchorsChanged: (key, updates) => {
            if (key !== documentKey) return
            for (const update of updates) {
              if (visibleHistoryRecordIds.has(update.recordId)) {
                translationHistory.updateAnchor(update.recordId, update.anchor)
              }
            }
          },
          onOpenRecord: (recordId) => openTranslationHistory(recordId),
        }
      : undefined
    const translationUiState = {
      requestId: translation.requestId,
      status: translation.status,
      output: translation.output,
      errorCode: translation.errorCode,
      error: translation.error,
    }
    const sidebarTranslationUiState = directSidebarModelState === 'unconfigured'
      && !translation.selection
      && documentHistoryRecords.length === 0
      ? {
          requestId: null,
          status: 'failed' as const,
          output: '',
          errorCode: 'MODEL_NOT_CONFIGURED' as const,
          error: PUBLIC_ERROR_MESSAGES.MODEL_NOT_CONFIGURED,
        }
      : translationUiState
    const restoreActiveEditorFocus = useCallback((restore: boolean) => {
      if (!restore) return
      paneRef.current?.querySelector<HTMLElement>(
        boundary.mode === 'visual'
          ? '.ProseMirror, [contenteditable="true"]'
          : '.cm-content, textarea',
      )?.focus({ preventScroll: true })
    }, [boundary.mode])
    useEffect(() => {
      const wasOpen = previousRightSidebarOpenRef.current
      previousRightSidebarOpenRef.current = rightSidebarOpen
      if (!rightSidebarOpen || wasOpen || rightSidebarTab !== 'translation') return
      const intent = rightSidebarOpenIntentRef.current
      rightSidebarOpenIntentRef.current = null
      if (intent === 'history') return
      if (intent === 'live' || translationRef.current.selection) {
        setSidebarView((current) => current.kind === 'live' ? current : { kind: 'live' })
        return
      }
      if (
        sidebarView.kind === 'history'
        && documentHistoryRecords.some(({ id }) => id === sidebarView.recordId)
      ) return
      const fallback = documentHistoryRecords.at(-1)
      if (!fallback) {
        setSidebarView({ kind: 'history', recordId: '' })
        return
      }
      translationHistory?.selectById(fallback.id)
      setSidebarView({ kind: 'history', recordId: fallback.id })
    }, [
      documentHistoryRecords,
      rightSidebarOpen,
      rightSidebarTab,
      sidebarView,
      translationHistory,
    ])

    return (
      <section
        aria-label="Markdown editor"
        className="editor-pane"
        data-editor-theme={editorTheme}
        data-editor-zoom-percent={zoomPercent}
        ref={paneRef}
        style={{ '--editor-zoom-factor': zoomPercent / 100 } as CSSProperties}
      >
        {findOpen && (
          <DocumentFindBar
            current={findSnapshot.current}
            focusRequest={findFocusRequest}
            onClose={closeFind}
            onNavigate={navigateFind}
            onQuery={changeFindQuery}
            query={findQuery}
            total={findSnapshot.total}
          />
        )}
        {!codeDocument && <DocumentOutline markdown={markdown} documentKey={documentKey} />}
        <div
          className={`editor-surface${hasSourceTranslationRail ? ' has-source-translation-history-rail' : ''}${hasVisualTranslationRail ? ' has-visual-translation-history-rail' : ''}`}
          onPointerDown={(event) => {
            marginSelectionControllerRef.current?.pointerDown(
              event.nativeEvent,
              event.currentTarget,
            )
          }}
          ref={surfaceRef}
        >
          {sourceMode
            ? (
              <SourceEditor
                colorScheme={editorTheme === 'dark' ? 'dark' : 'light'}
                readClipboardImage={readClipboardImage}
                interactionLocked={interactionLocked}
                ref={sourceEditorRef}
                key={documentKey + ':source:' + boundary.generation}
                documentKey={documentKey}
                documentPath={documentAbsolutePath ?? documentDisplayName}
                plainText={codeDocument}
                dirty={documentDirty}
                initialModePosition={boundary.position}
                lineIndicators={editIndicatorModel.lineStates}
                markdown={latestMarkdownRef.current}
                showEditIndicators={showEditIndicators}
                spellCheckEnabled={spellCheckEnabled}
                zoomPercent={zoomPercent}
                onChange={changeMarkdown}
                onTranslationSelection={reportTranslationSelection}
                onTranslationAnchorChange={(geometry) => {
                  reportTranslationAnchor('source', geometry)
                }}
                translationAnchorRefreshKey={
                  translation.selection?.mode === 'source'
                    ? `${zoomPercent}:${sidebarMeasurements.surfaceWidth}`
                    : undefined
                }
                onStickyNoteSelection={reportStickyNoteSelection}
                onCreateStickyNote={createSelectionStickyNote}
                translationHistory={translationHistoryEditorPort}
                onTranslationHistoryReady={(key) => reportTranslationHistoryReady(key, 'source')}
                onFindReady={reportFindReady}
              />
            )
            : (
              <>
                <VisualEditor
                  readClipboardImage={readClipboardImage}
                  interactionLocked={interactionLocked}
                  ref={visualEditorRef}
                  key={documentKey + ':visual:' + boundary.generation}
                  documentKey={documentKey}
                  dirty={documentDirty}
                  initialModePosition={boundary.position}
                  editorTheme={editorTheme}
                  mermaidAppearance={mermaidAppearance}
                  markdown={boundary.checkpoint}
                  spellCheckEnabled={spellCheckEnabled}
                  documentAbsolutePath={documentAbsolutePath}
                  onDocumentLink={openDocumentLink}
                  onChange={changeMarkdown}
                  onTranslationSelection={reportTranslationSelection}
                  onTranslationAnchorChange={(geometry) => {
                    reportTranslationAnchor('visual', geometry)
                  }}
                  translationAnchorRefreshKey={
                    translation.selection?.mode === 'visual'
                      ? `${zoomPercent}:${sidebarMeasurements.surfaceWidth}`
                      : undefined
                  }
                  onStickyNoteSelection={reportStickyNoteSelection}
                  onCreateStickyNote={createSelectionStickyNote}
                  onCodeExplanationRequest={requestCodeExplanation}
                  translationHistory={translationHistoryEditorPort}
                  onTranslationHistoryReady={(key) => reportTranslationHistoryReady(key, 'visual')}
                  onFindReady={reportFindReady}
                />
              </>
            )}
          {activeHistoryRecords.length > 0 && <TranslationHistoryRail
            centerRequest={translationHistoryRailCenterRequest}
            mode={boundary.mode}
            onOpenRecord={(recordId, initiator) => openTranslationHistory(recordId, initiator)}
            records={activeHistoryRecords}
            refreshKey={`${boundary.generation}:${zoomPercent}:${rightSidebarOpen}:${rightSidebarTab}`}
            surfaceRef={surfaceRef}
          />}
        </div>
        {translation.selection && translation.presentation === 'popover' && (
          <TranslationPopover
            anchorRect={translation.selection.releaseRect}
            selectionScope={translation.selection.scope}
            state={translationUiState}
            onTranslate={beginTranslation}
            onQuoteToAi={translation.selection.range ? quoteSelectionToAi : undefined}
            onStop={stopTranslation}
            onCopy={copyTranslation}
            onClose={closeTranslation}
            onOpenSettings={openTranslationSettings}
            hidden={sidebarView.kind === 'history'
              || (rightSidebarOpen && rightSidebarTab === 'translation')}
            historyRecordId={historyRecordId}
            onOpenHistory={openTranslationHistory}
            onRetry={beginTranslation}
          />
        )}
        <EditorRightSidebar
          activeTab={rightSidebarTab}
          containerWidth={sidebarMeasurements.containerWidth}
          initialWidth={rightSidebarWidth}
          onActiveTabChange={(tab) => onOpenRightSidebar?.(tab)}
          onExitComplete={restoreActiveEditorFocus}
          onWidthChange={onRightSidebarWidthChange}
          open={rightSidebarOpen}
          panels={{
            'document-view': <Suspense fallback={<p className="hint">正在打开文档查看…</p>}>
              <DocumentViewPanel controller={documentView} openExternal={window.arkdown.openExternal} />
            </Suspense>,
            translation: <TranslationSidebar
              thinkingConnection={(translationModelSettings ? featureModelConnections(translationModelSettings) : []).find(({ id }) => id === translationModelSettings?.selectionTranslation.connectionId)}
              thinkingPreference={translationModelSettings?.selectionTranslation}
              thinkingPending={translationSettingsPending || !modelRulesReady}
              settingsError={translationSettingsError}
              onRetrySettings={modelPreferences?.getSnapshot().failedKeys.some(key => key.startsWith('feature.selectionTranslation.'))
                ? () => { void retryFeatureSettings('selectionTranslation') } : undefined}
              onThinkingChange={(change) => { void saveTranslationSettings(change) }}
              state={sidebarTranslationUiState}
              mode={translation.selection?.mode ?? boundary.mode}
              selectionTop={sidebarMeasurements.selectionTop}
              surfaceTop={sidebarMeasurements.surfaceTop}
              alignmentHeight={sidebarMeasurements.alignmentHeight}
              resultHeight={sidebarMeasurements.resultHeight}
              hasSelection={Boolean(translation.selection) && !retainedSelectionRef.current?.invalidated}
              onTranslate={beginTranslation}
              onStop={stopTranslation}
              onCopy={copyTranslation}
              onClose={() => {
                closeTranslation()
                onCloseRightSidebar?.()
              }}
              onOpenSettings={openTranslationSettings}
              onRetry={retainedSelectionRef.current?.invalidated ? undefined : beginTranslation}
              view={sidebarView}
              historyRecords={documentHistoryRecords}
              historyRecordId={historyRecordId}
              onOpenHistory={openTranslationHistory}
              onReturnToLive={closeHistoryView}
              onSelectHistory={selectTranslationHistory}
              canReturnToLive={Boolean(translation.selection)}
            />,
            'ai-chat': <AiConversationSidebar
              draft={aiConversation.draft}
              viewport={aiConversation.viewport}
              modelConnections={aiModelSettings ? featureModelConnections(aiModelSettings) : []}
              selectedModelId={aiModelSettings?.aiConversation.connectionId}
              modelSwitchPending={aiModelSwitchPending || !modelRulesReady}
              thinkingConnection={(aiModelSettings ? featureModelConnections(aiModelSettings) : []).find(({ id }) => id === aiModelSettings?.aiConversation.connectionId)}
              thinkingPreference={aiModelSettings?.aiConversation}
              onThinkingChange={(change) => { void saveAiSettings(change) }}
              onModelChange={(connectionId) => { void saveAiSettings({ connectionId }) }}
              configurationState={modelRulesReady ? aiSidebarModelState : 'checking'}
              capabilities={aiConversation.capabilities}
              writePolicy={aiModelSettings?.aiConversation.writePolicy ?? aiConversation.writePolicy}
              pendingAuthorization={aiConversation.pendingAuthorization}
              authorizationRecords={aiConversation.authorizationRecords}
              auditRecords={aiConversation.auditRecords}
              error={aiModelSwitchError ?? aiConversation.error}
              onRetrySettings={modelPreferences?.getSnapshot().failedKeys.some(key => key.startsWith('feature.aiConversation.'))
                ? () => { void retryFeatureSettings('aiConversation') } : undefined}
              messages={aiConversation.messages}
              activeAssistantMessageId={aiConversation.activeAssistantMessageId}
              timeline={aiConversation.timeline}
              status={aiConversation.status}
              continueRequestId={aiConversation.continueRequestId}
              onContinueAnalysis={(requestId) => aiModelSwitchPendingRef.current || modelPreferences?.hasUnsettledFeature('aiConversation') ? Promise.resolve(false) : aiConversation.continueAnalysis(requestId, aiDocumentSourceId)}
              contextUsage={aiConversation.contextUsage}
              onOpenLink={openAiMessageLink}
              onClear={() => {
                void aiConversation.clearConversation()
              }}
              onClose={() => onCloseRightSidebar?.()}
              onOpenSettings={onOpenLargeModelSettings}
              onRetryConfiguration={retryAiConfiguration}
              onSend={(content, expectedDocumentId) => aiModelSwitchPendingRef.current || modelPreferences?.hasUnsettledFeature('aiConversation') ? Promise.resolve(false) : aiConversation.sendMessage(content,
                expectedDocumentId === undefined ? aiDocumentSourceId : expectedDocumentId)}
              onStop={() => {
                void aiConversation.stopConversation()
              }}
              onCurrentDocumentAccessChange={(enabled) => {
                void aiConversation.setCurrentDocumentAccess(enabled)
              }}
              onWorkspaceAccessChange={(enabled) => {
                void aiConversation.setWorkspaceAccess(enabled)
              }}
              onWritePolicyChange={(writePolicy) => { void saveAiSettings({ writePolicy }) }}
              onAuthorizationDecision={(allowed) => {
                void aiConversation.answerAuthorization(allowed)
              }}
            />,
          }}
        />
      </section>
    )
  },
)
