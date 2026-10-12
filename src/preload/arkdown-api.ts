import { parseMermaidViewerSnapshot, type MermaidViewerSnapshot } from '../shared/mermaid-viewer'
import { parseUpdateAction, type UpdateAction } from '../shared/update-transfer'
import { parsePublicModelSettingsSnapshot, hasObservationKeys, type PublicModelSettingsSnapshot } from '../shared/settings-observation'
import { parseModelFeaturePatch, parsePublicModelMutation, parseObservedModelTestResult,
  parseObservedCodexTestResult, parseObservedCodexLoginResult, type ModelFeaturePatches } from '../shared/model-settings-commands'
import type { ModelCatalogRead } from '../main/models/transactional-model-connection-service'
import { PREFERENCE_GROUPS, parsePreferencePatchInput, parsePublicPreferenceSnapshot, parsePublicPreferenceMutation,
  type PreferenceGroup, type PreferencePatchInput, type PublicPreferenceSnapshot, type PublicPreferenceMutation } from '../shared/preference-observation'
import { parseFloatingTranslationPatch } from '../shared/large-model-settings'
import { parseCodexCliLoginResult, type CodexCliLoginResult } from '../shared/codex-cli-login'
import { isFeatureModelConnectionId } from '../shared/large-model-settings'
import { parseModelCapabilityRules, type RuleFile } from '../shared/model-capability-rules'
import { parseObservedShortcutSnapshot, parseObservedShortcutUpdate, parseObservedShortcutUpdateResult,
  type ObservedShortcutSnapshot, type ObservedShortcutUpdate, type ObservedShortcutUpdateResult } from '../shared/keyboard-shortcuts'
import { parseModelCapabilityRulesState as parseRulesState, type ModelCapabilityRulesState } from '../shared/model-capability-rules-state'
import { parseStickyNoteWallpaperAppearances, type StickyNoteWallpaperAppearances } from '../shared/sticky-note-glass-appearance'
import { parseStickyNoteMaterialEffects, type StickyNoteMaterialEffects } from '../shared/sticky-note-material-effects'
import { parseThinkingMode, parseReasoningEffort } from '../shared/large-model-settings'
import { parseShellIntegrationSnapshot, parseObservedShellIntegrationUpdate, type ShellIntegrationSnapshot, type ObservedShellIntegrationUpdate } from '../shared/shell-integration-preferences'
import {
  parseArknoteThemeColorEvent,
} from '../shared/arknote-preferences'
import { isThemeColor, normalizeThemeColor } from '../shared/theme-color'
import {
  canonicalWorkspaceColorPath,
  isWorkspaceColorId,
  parseWorkspaceColorMarksSnapshot,
  type WorkspaceColorId,
  type WorkspaceColorMarksSnapshot,
} from '../shared/workspace-color-marks'
import {
  IPC_CHANNELS,
  SCREENSHOT_OCR_MODEL_CHANNELS,
  type ApiResult,
  type BackgroundPresentationEvent,
  type ClosePreparationHeartbeat,
  type ClosePreparationResponse,
  type DocumentSnapshot,
  type DraftSummary,
  type RecoveredDraft,
  type RecoveryIntent,
  type DroppedPathResult,
  type PreparedDroppedPathResult,
  type ArkdownApi,
  type ImportedAsset,
  type ImportedDocx,
  type ExportDocxInput,
  type ExportDocxResult,
  type ExportXlsxInput,
  type ExportXlsxResult,
  type ClipboardFormatsSnapshot,
  type MermaidImageExportInput,
  type ImportDocxIntent,
  type BeginSaveDocumentAsResult,
  type CommitSaveDocumentAsResult,
  type SaveDocumentAsInput,
  type SaveDocumentInput,
  type SaveDraftInput,
  type SaveDocumentResult,
  type TreeEntry,
  type WorkspaceEntryRenameResult,
  type WorkspaceEntryProperties,
  type WorkspaceEntryTrashResult,
  type WorkspaceSummary,
  type WorkspaceFileDragInput,
  type WindowControlAction,
  type WindowStateSnapshot,
  type AiWorkspaceState,
  type AiCurrentDocumentRendererPort,
  type AiOpenDocumentRendererPort,
  type ClearAiConversationInput,
  type SetAiConversationCapabilitiesInput,
  type SubmitAiAuthorizationResultInput,
} from '../shared/contracts'
import {
  parseBackgroundSettings,
  type BackgroundPresentation,
  type BackgroundSettings,
  type BackgroundTarget,
} from '../shared/background-settings'
import { PUBLIC_ERROR_MESSAGES } from '../shared/public-errors'
import {
  DOCUMENT_VIEW_ERROR_MESSAGES, parseDocumentViewRequest, parseDocumentViewId,
  parseDocumentViewSnapshot, parseDocumentViewResult, parseDocumentViewInspection,
  parseDocumentLocationIntent, type DocumentLocationIntent, type DocumentViewRequest,
  parseLocalFileRevealRequest, type LocalFileRevealRequest,
} from '../shared/document-view'
import { parseAiMessageLinkTarget } from '../shared/link-target'
import {
  documentTypeForPath,
  isMarkItDownConversionPath,
} from '../shared/document-types'
import {
  parseConvertedDocument as parsePersistedConvertedDocument,
  parseDocumentConversionComponentState as parsePersistedDocumentConversionComponentState,
  type ConvertedDocument,
  type DocumentConversionComponentState,
} from '../shared/document-conversion'
import type {
  ApplicationMenuAction,
  ApplicationMenuItem,
  ApplicationMenuRole,
  ApplicationMenuSection,
  ApplicationMenuWindowState,
} from '../shared/application-menu-model'
import { RECENT_DOCUMENT_LIMIT } from '../shared/recent-documents'
import {
  isPrintDocumentToken,
  parsePrintDocumentInput,
  parsePrintSurfaceDocumentInput,
  type PrintDocumentInput,
  type PrintSurfaceDocumentInput,
} from '../shared/printing'
import {
  MODEL_ID_MAX_LENGTH,
  MODEL_BASE_URL_MAX_LENGTH,
  MODEL_CONNECTION_NAME_MAX_LENGTH,
  isCanonicalModelConnectionId,
  isSafeModelBaseUrl,
  parseModelCapabilityOverride,
  parseLargeModelSettings as parsePersistedLargeModelSettings,
  parseModelConnectionSummary as parsePersistedModelConnectionSummary,
  type AiConversationSettings,
  parseCodexCliConnectionTestResult as parsePersistedCodexCliConnectionTestResult,
  type CodexCliConnectionTestResult,
  type LargeModelSettings,
  type ModelConnectionSummary,
} from '../shared/large-model-settings'
import type { ModelCatalog } from '../main/models/model-catalog-client'
import { parseAiStartFailure, type AiConversationStartResult } from '../shared/ai-start-failure'
import { isMenuCommand, type MenuCommand } from '../shared/menu-commands'
import type {
  ConnectModelInput,
  FeatureSettingsInput,
  ListModelsInput,
} from '../main/models/model-connection-service'
import type { AppMenuSectionId } from '../shared/app-menu-definition'
import { parseBrowserSearchPreferences, type BrowserSearchPreferences } from '../shared/search-preferences'
import {
  parseCompleteEditorAppearancePreferences,
  type EditorAppearancePreferences,
  type EditorAppearanceSnapshot,
} from '../shared/editor-appearance-preferences'
import {
  parseCompleteLayoutPreferences,
  type LayoutPreferences,
  type LayoutPreferencesSnapshot,
} from '../shared/layout-preferences'
import {
  parseDesktopLifecyclePreferences as parsePersistedDesktopLifecyclePreferences,
  type DesktopLifecyclePreferences,
} from '../shared/desktop-lifecycle-preferences'
import { isWindowsAbsolutePath } from '../shared/local-resource-path'
import {
  isCanonicalTranslationRequestId,
  isStartTranslationInput,
  parseTranslationEvent,
  type StartTranslationInput,
  type TranslationEvent,
  type TranslationStarted,
} from '../shared/selection-translation'
import type { TargetLanguage } from '../shared/large-model-settings'
import {
  isCanonicalAiConversationId,
  isCanonicalAiConversationRequestId,
  isStartAiConversationInput,
  parseAiConversationEvent,
  type AiConversationEvent,
  type StartAiConversationInput,
} from '../shared/ai-conversation'
import {
  isCanonicalStickyNoteId,
  parseStickyNoteDocument as parsePersistedStickyNoteDocument,
  parseStickyNoteEvent,
  parseStickyNoteImportResult as parsePersistedStickyNoteImportResult,
  parseStickyNoteRecord as parsePersistedStickyNoteRecord,
  parseStickyNoteSaveState as parsePersistedStickyNoteSaveState,
  parseStickyNoteSearchResults as parsePersistedStickyNoteSearchResults,
  parseStickyNoteSummaries as parsePersistedStickyNoteSummaries,
  type CreateStickyNoteInput,
  type StickyNoteContentMeasurement,
  type StickyNoteDocument,
  type StickyNoteReadDocument,
  type StickyNoteEvent,
  type StickyNoteImportResult,
  type StickyNoteSelectionImportInput,
  type StickyNoteRecord,
  type StickyNoteSaveState,
  type StickyNoteSearchResult,
  type StickyNoteStatus,
  type StickyNoteStyleReference,
  type StickyNoteSummary,
} from '../shared/sticky-notes'
import {
  parseStickyNotePreferences as parsePersistedStickyNotePreferences,
  type StickyNotePreferences,
} from '../shared/sticky-note-preferences'
import {
  parseArknotePreferences as parsePersistedArknotePreferences,
  type ArknotePreferences,
  type ArknotePreferencesUpdate,
} from '../shared/arknote-preferences'
import {
  STICKY_NOTE_CONTEXT_MENU_CHANNELS,
  parseStickyNoteContextMenuClosed,
  parseStickyNoteContextMenuReady,
  parseStickyNoteContextMenuReset,
  parseStickyNoteContextMenuCommand,
  parseStickyNoteContextMenuOpenInput,
  parseStickyNoteContextMenuShowPayload,
  type StickyNoteContextMenuOpenInput,
  type StickyNoteContextMenuCommand,
  type StickyNoteContextMenuShowPayload,
} from '../shared/sticky-note-context-menu'
import {
  parseScreenshotCaptureCommitInput,
  parseScreenshotCaptureEvent,
  parseScreenshotCapturePointerInput,
  parseScreenshotCaptureReadyInput,
  parseScreenshotWindowHighlightResult,
  parseScreenshotSessionInput,
  parseScreenshotOcrSubmission,
  parseScreenshotOcrHostCommand,
  parseScreenshotTranslationEvent,
  parseScreenshotTranslationGenerationInput,
  type ScreenshotCaptureEvent,
  type ScreenshotTranslationEvent,
  type ScreenshotWindowHighlight,
} from '../shared/screenshot-translation'
import {
  parseScreenshotOcrModelState as parsePersistedScreenshotOcrModelState,
  parseObservedOcrPreference, parseObservedScreenshotOcrState, parseScreenshotOcrMutationResult,
  type ObservedOcrPreference,
  type ScreenshotOcrMutationResult,
  type ScreenshotOcrModelState,
} from '../shared/screenshot-ocr-models'

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

const CLOSE_PREPARATION_HEARTBEAT_INTERVAL_MS = 1_000

export interface ClosePreparationTransport {
  subscribe(listener: (payload: unknown) => void): () => void
  heartbeat(heartbeat: ClosePreparationHeartbeat): void
  respond(response: ClosePreparationResponse): void
}

export interface MenuCommandTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface ApplicationMenuChangedTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface WindowStateChangedTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface DocumentConversionComponentStateTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface EditorAppearanceChangedTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface LayoutPreferencesChangedTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface BackgroundPresentationEventTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface OpenIntentTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface RecoveryIntentTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface ImportDocxIntentTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}
export interface TranslationEventTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}
export interface AiConversationEventTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}
export interface AiRendererPortTransport {
  attachCurrentDocumentPort(port: AiCurrentDocumentRendererPort): {
    commit(): void
    rollback(): void
    detach(): void
  }
  attachOpenDocumentPort(port: AiOpenDocumentRendererPort): {
    bind(documentHandle: string): void
    detach(): void
  }
}
export interface ScreenshotCaptureEventTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}
export interface ScreenshotTranslationEventTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}
export interface ScreenshotOcrHostEventTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}
export interface ScreenshotOcrModelStateTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}
export interface StickyNoteEventTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export interface StickyNoteContextMenuTransport {
  subscribe(listener: (payload: unknown) => void): () => void
}

export type ArknoteServiceEvent =
  | { type: 'service-stopping' }
  | { type: 'service-disconnected' }

export interface ArkdownRendererApi extends ArkdownApi {
  connectArknote?(): Promise<ApiResult<null>>
  onArknoteServiceEvent?(handler: (event: ArknoteServiceEvent) => void): () => void
}

type Parsed<T> = { valid: true; value: T } | { valid: false }
type ValueParser<T> = (value: unknown) => Parsed<T>

const SAFE_ERROR_MESSAGES = Object.freeze({ ...PUBLIC_ERROR_MESSAGES, ...DOCUMENT_VIEW_ERROR_MESSAGES })

function transportFailure(): ApiResult<never> {
  return {
    ok: false,
    error: { code: 'OPERATION_FAILED', message: SAFE_ERROR_MESSAGES.OPERATION_FAILED },
  }
}

function invalid<T>(): Parsed<T> {
  return { valid: false }
}

function parsed<T>(value: T): Parsed<T> {
  return { valid: true, value }
}

function documentViewParser<T>(parse: (value: unknown) => T | undefined): ValueParser<T> {
  return value => {
    const result = parse(value)
    return result === undefined ? invalid() : parsed(result)
  }
}

function isExactOwnRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  // IPC responses have crossed structured serialization, and exposed API arguments
  // have crossed contextBridge. This checks their local data descriptors, not Proxy
  // identity; sandbox preload cannot import Node's native isProxy predicate.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    return (
      ownKeys.length === keys.length
      && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => Object.prototype.hasOwnProperty.call(descriptors, key))
      && ownKeys.every((key) => {
        if (typeof key !== 'string') return false
        const descriptor = descriptors[key]
        return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      })
    )
  } catch {
    return false
  }
}

function isExactArray(value: unknown): value is unknown[] {
  try {
    if (typeof value !== 'object' || value === null
      || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>
    const lengthDescriptor = descriptors.length
    if (!lengthDescriptor || lengthDescriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) return false
    const length = lengthDescriptor.value as number
    const ownKeys = Reflect.ownKeys(descriptors)
    if (ownKeys.length !== length + 1 || !ownKeys.includes('length')) return false
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)]
      if (descriptor?.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return false
    }
    return true
  } catch {
    return false
  }
}

function parseWorkspace(value: unknown): Parsed<WorkspaceSummary | null> {
  if (value === null) return parsed(null)
  if (!isExactOwnRecord(value, ['name', 'absolutePath'])) return invalid()
  if (typeof value.name !== 'string' || typeof value.absolutePath !== 'string') return invalid()
  return parsed({ name: value.name, absolutePath: value.absolutePath })
}

function parseNull(value: unknown): Parsed<null> {
  return value === null ? parsed(null) : invalid()
}

function parseBackgroundTarget(value: unknown): Parsed<BackgroundTarget> {
  if (isExactOwnRecord(value, ['kind']) && value.kind === 'main') return parsed({ kind: 'main' })
  if (!isExactOwnRecord(value, ['kind', 'noteId']) || value.kind !== 'sticky-note') return invalid()
  return isCanonicalStickyNoteId(value.noteId)
    ? parsed({ kind: 'sticky-note', noteId: value.noteId })
    : invalid()
}

function parseBackgroundSettingsPayload(value: unknown): Parsed<BackgroundSettings> {
  const settings = parseBackgroundSettings(value)
  return settings === undefined ? invalid() : parsed(settings)
}

function parseBackgroundPresentation(value: unknown): Parsed<BackgroundPresentation> {
  if (!isExactOwnRecord(value, ['imageUrl', 'settings'])) return invalid()
  if (!(value.imageUrl === null || typeof value.imageUrl === 'string')) return invalid()
  const settings = parseBackgroundSettings(value.settings)
  return settings === undefined
    ? invalid()
    : parsed({ imageUrl: value.imageUrl, settings })
}

function parseNullableBackgroundPresentation(value: unknown): Parsed<BackgroundPresentation | null> {
  return value === null ? parsed(null) : parseBackgroundPresentation(value)
}

function parseBackgroundApplyResult(value: unknown): Parsed<import('../shared/background-settings').BackgroundApplyResult> {
  if (isExactOwnRecord(value, ['status']) && value.status === 'conflict') return parsed({ status: 'conflict' })
  return parseBackgroundPresentation(value)
}

function parseBackgroundPresentationEvent(value: unknown): Parsed<BackgroundPresentationEvent> {
  if (!isExactOwnRecord(value, ['target', 'presentation', 'phase'])) return invalid()
  const target = parseBackgroundTarget(value.target)
  const presentation = parseBackgroundPresentation(value.presentation)
  if (!target.valid || !presentation.valid) return invalid()
  if (value.phase !== 'preview' && value.phase !== 'applied' && value.phase !== 'restore') return invalid()
  return parsed({ target: target.value, presentation: presentation.value, phase: value.phase })
}

function parseScreenshotWindowHit(value: unknown): Parsed<ScreenshotWindowHighlight | null> {
  const hit = parseScreenshotWindowHighlightResult(value)
  return hit === undefined ? invalid() : parsed(hit)
}

function parseScreenshotTranslationGenerationResult(
  value: unknown,
): Parsed<import('../shared/screenshot-translation').ScreenshotTranslationGenerationInput> {
  const valueParsed = parseScreenshotTranslationGenerationInput(value)
  return valueParsed ? parsed(valueParsed) : invalid()
}

function parseScreenshotOcrModelState(value: unknown): Parsed<ScreenshotOcrModelState> {
  const result = parsePersistedScreenshotOcrModelState(value)
  return result === undefined ? invalid() : parsed(result)
}

function invalidInputFailure(): ApiResult<never> {
  return {
    ok: false,
    error: { code: 'INVALID_INPUT', message: SAFE_ERROR_MESSAGES.INVALID_INPUT },
  }
}

function invalidResponseFailure(): ApiResult<never> {
  return {
    ok: false,
    error: {
      code: 'INVALID_RESPONSE',
      message: SAFE_ERROR_MESSAGES.INVALID_RESPONSE,
    },
  }
}

function parseVoid(value: unknown): Parsed<void> {
  return value === undefined ? parsed(undefined) : invalid()
}
function parseRecentDocumentPaths(value: unknown): Parsed<readonly string[]> {
  if (!isExactArray(value) || value.length > RECENT_DOCUMENT_LIMIT) return invalid()
  const paths: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string' || !isWindowsAbsolutePath(candidate)) return invalid()
    const definition = documentTypeForPath(candidate)
    if (!definition?.openAsDocument && !definition?.importWithPandoc) return invalid()
    paths.push(candidate)
  }
  return parsed(paths)
}

function parsePrintDocument(value: unknown): Parsed<PrintDocumentInput> {
  const input = parsePrintDocumentInput(value)
  return input ? parsed(input) : invalid()
}

function parsePrintSurfaceDocument(value: unknown): Parsed<PrintSurfaceDocumentInput> {
  const input = parsePrintSurfaceDocumentInput(value)
  return input ? parsed(input) : invalid()
}

function isExactOwnRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const ownKeys = Reflect.ownKeys(value)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  return (
    ownKeys.every((key) => typeof key === 'string' && allowed.has(key))
    && requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
}

const applicationMenuRoles = new Set<ApplicationMenuRole>([
  'undo', 'redo', 'cut', 'copy', 'paste', 'selectAll',
  'resetZoom', 'zoomIn', 'zoomOut', 'togglefullscreen',
])
const applicationMenuActions = new Set<ApplicationMenuAction>([
  'createNewWindow', 'openDocument', 'closeWindow', 'openGuide', 'openAbout',
  'beginScreenshotTranslation', 'openBackgroundSettings', 'openScreenTranslation',
  'reviewDrafts',
])

function parseApplicationMenuItem(value: unknown): ApplicationMenuItem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.kind !== 'string' || typeof candidate.id !== 'string') return null
  const optionalState = ['disabled'] as const
  const state = candidate.disabled === undefined
    ? {}
    : typeof candidate.disabled === 'boolean' ? { disabled: candidate.disabled } : null
  if (!state) return null

  if (candidate.kind === 'separator') {
    return isExactOwnRecord(candidate, ['kind', 'id'])
      ? { kind: 'separator', id: candidate.id }
      : null
  }
  if (candidate.kind === 'submenu') {
    if (
      !isExactOwnRecordWithOptional(candidate, ['kind', 'id', 'label', 'items'], optionalState)
      || typeof candidate.label !== 'string'
      || !isExactArray(candidate.items)
    ) return null
    const items = candidate.items.map(parseApplicationMenuItem)
    if (items.some((item) => item === null)) return null
    return {
      kind: 'submenu', id: candidate.id, label: candidate.label,
      items: items as ApplicationMenuItem[], ...state,
    }
  }
  if (candidate.kind === 'recent-document') {
    if (
      !isExactOwnRecordWithOptional(
        candidate, ['kind', 'id', 'label', 'absolutePath'], optionalState,
      )
      || typeof candidate.label !== 'string'
      || typeof candidate.absolutePath !== 'string'
    ) return null
    return {
      kind: 'recent-document', id: candidate.id, label: candidate.label,
      absolutePath: candidate.absolutePath, ...state,
    }
  }
  if (candidate.kind === 'radio') {
    if (
      !isExactOwnRecordWithOptional(
        candidate, ['kind', 'id', 'label', 'checked', 'command'], optionalState,
      )
      || typeof candidate.label !== 'string'
      || typeof candidate.checked !== 'boolean'
      || !isMenuCommand(candidate.command)
    ) return null
    return {
      kind: 'radio', id: candidate.id, label: candidate.label,
      checked: candidate.checked, command: candidate.command, ...state,
    }
  }
  if (candidate.kind === 'checkbox') {
    if (
      !isExactOwnRecordWithOptional(
        candidate, ['kind', 'id', 'label', 'checked', 'command'], optionalState,
      )
      || typeof candidate.label !== 'string'
      || typeof candidate.checked !== 'boolean'
      || !isMenuCommand(candidate.command)
    ) return null
    return {
      kind: 'checkbox', id: candidate.id, label: candidate.label,
      checked: candidate.checked, command: candidate.command, ...state,
    }
  }
  if (candidate.kind === 'command') {
    if (
      !isExactOwnRecordWithOptional(
        candidate, ['kind', 'id', 'label', 'command'], [...optionalState, 'accelerator'],
      )
      || typeof candidate.label !== 'string'
      || !isMenuCommand(candidate.command)
      || (candidate.accelerator !== undefined && typeof candidate.accelerator !== 'string')
    ) return null
    return {
      kind: 'command', id: candidate.id, label: candidate.label,
      command: candidate.command, ...state,
      ...(typeof candidate.accelerator === 'string' ? { accelerator: candidate.accelerator } : {}),
    }
  }
  if (candidate.kind === 'role') {
    if (
      !isExactOwnRecordWithOptional(
        candidate,
        ['kind', 'id', 'label', 'role'],
        [...optionalState, 'accelerator', 'checked'],
      )
      || typeof candidate.label !== 'string'
      || typeof candidate.role !== 'string'
      || !applicationMenuRoles.has(candidate.role as ApplicationMenuRole)
      || (candidate.accelerator !== undefined && typeof candidate.accelerator !== 'string')
      || (candidate.checked !== undefined && typeof candidate.checked !== 'boolean')
    ) return null
    return {
      kind: 'role', id: candidate.id, label: candidate.label,
      role: candidate.role as ApplicationMenuRole, ...state,
      ...(typeof candidate.accelerator === 'string' ? { accelerator: candidate.accelerator } : {}),
      ...(typeof candidate.checked === 'boolean' ? { checked: candidate.checked } : {}),
    }
  }
  if (candidate.kind === 'action') {
    if (
      !isExactOwnRecordWithOptional(
        candidate, ['kind', 'id', 'label', 'action'], [...optionalState, 'accelerator'],
      )
      || typeof candidate.label !== 'string'
      || typeof candidate.action !== 'string'
      || !applicationMenuActions.has(candidate.action as ApplicationMenuAction)
      || (candidate.accelerator !== undefined && typeof candidate.accelerator !== 'string')
    ) return null
    return {
      kind: 'action', id: candidate.id, label: candidate.label,
      action: candidate.action as ApplicationMenuAction, ...state,
      ...(typeof candidate.accelerator === 'string' ? { accelerator: candidate.accelerator } : {}),
    }
  }
  return null
}

function parseApplicationMenuModel(value: unknown): Parsed<readonly ApplicationMenuSection[]> {
  if (!isExactArray(value)) return invalid()
  const sections: ApplicationMenuSection[] = []
  const sectionIds = new Set(['file', 'edit', 'paragraph', 'format', 'view', 'theme', 'tools', 'help'])
  for (const candidate of value) {
    if (
      !isExactOwnRecord(candidate, ['id', 'label', 'items'])
      || typeof candidate.id !== 'string'
      || !sectionIds.has(candidate.id)
      || typeof candidate.label !== 'string'
      || !isExactArray(candidate.items)
    ) return invalid()
    const items = candidate.items.map(parseApplicationMenuItem)
    if (items.some((item) => item === null)) return invalid()
    sections.push({
      id: candidate.id as ApplicationMenuSection['id'],
      label: candidate.label,
      items: items as ApplicationMenuItem[],
    })
  }
  return parsed(sections)
}
function parseWindowState(value: unknown): Parsed<WindowStateSnapshot> {
  if (
    !isExactOwnRecord(value, ['maximized', 'fullscreen', 'revision'])
    || typeof value.maximized !== 'boolean'
    || typeof value.fullscreen !== 'boolean'
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
  ) {
    return invalid()
  }
  return parsed({
    maximized: value.maximized,
    fullscreen: value.fullscreen,
    revision: value.revision as number,
  })
}
function parseStickyNoteImageMarkdown(value: unknown): Parsed<string> {
  return typeof value === 'string' && /^!\[\]\(resources\/[0-9a-f-]+\.[a-z0-9]+\)$/iu.test(value) ? parsed(value) : invalid()
}
function parseNullableStickyNoteImageMarkdown(value: unknown): Parsed<string | null> {
  return value === null ? parsed(null) : parseStickyNoteImageMarkdown(value)
}
function parseNullableAbsolutePath(value: unknown): Parsed<string | null> {
  if (value === null) return parsed(null)
  return typeof value === 'string' && isWindowsAbsolutePath(value) ? parsed(value) : invalid()
}


function parseSearchPreferences(value: unknown): Parsed<BrowserSearchPreferences> {
  if (!isExactOwnRecord(value, ['provider', 'customTemplate'])) return invalid()
  const preferences = parseBrowserSearchPreferences(value)
  return preferences ? parsed(preferences) : invalid()
}

function parseEditorAppearance(value: unknown): Parsed<EditorAppearancePreferences> {
  const preferences = parseCompleteEditorAppearancePreferences(value)
  return preferences ? parsed(preferences) : invalid()
}

function parseDocumentConversionComponentState(
  value: unknown,
): Parsed<DocumentConversionComponentState> {
  const state = parsePersistedDocumentConversionComponentState(value)
  return state ? parsed({
    ...state,
    progress: state.progress ? { ...state.progress } : null,
  }) : invalid()
}

function parseConvertedDocument(value: unknown): Parsed<ConvertedDocument> {
  const document = parsePersistedConvertedDocument(value)
  return document ? parsed({
    ...document,
    source: { ...document.source },
    warnings: [...document.warnings],
  }) : invalid()
}

function isSafeDocumentConversionRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 32_767 || value.includes('\0') || value.includes(':')
    || /^[\\/]/u.test(value) || !isMarkItDownConversionPath(value)) return false
  const segments = value.split(/[\\/]/u)
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function parseEditorAppearanceSnapshot(value: unknown): Parsed<EditorAppearanceSnapshot> {
  if (!isExactOwnRecord(value, ['appearance', 'revision'])) return invalid()
  const appearance = parseEditorAppearance(value.appearance)
  if (
    !appearance.valid
    || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 0
  ) return invalid()
  return parsed({ appearance: appearance.value, revision: Number(value.revision) })
}

function parseShellIntegrationPreferences(value: unknown): Parsed<ShellIntegrationSnapshot> {
  const result = parseShellIntegrationSnapshot(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseDesktopLifecyclePreferences(value: unknown): Parsed<DesktopLifecyclePreferences> {
  const result = parsePersistedDesktopLifecyclePreferences(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseStickyNotePreferences(value: unknown): Parsed<StickyNotePreferences> {
  const result = parsePersistedStickyNotePreferences(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseWallpaperAppearances(value: unknown): Parsed<StickyNoteWallpaperAppearances> {
  const result = parseStickyNoteWallpaperAppearances(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseArknotePreferences(value: unknown): Parsed<ArknotePreferences> {
  const result = parsePersistedArknotePreferences(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseModelConnectionSummary(value: unknown): Parsed<ModelConnectionSummary> {
  const result = parsePersistedModelConnectionSummary(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseLargeModelSettings(value: unknown): Parsed<LargeModelSettings> {
  const result = parsePersistedLargeModelSettings(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseModelCatalog(value: unknown): Parsed<ModelCatalog> {
  if (!isExactOwnRecord(value, ['models', 'recommendedModelId'])) return invalid()
  if (!isExactArray(value.models) || value.models.length === 0 || value.models.length > 1000) {
    return invalid()
  }
  const models: string[] = []
  for (const candidate of value.models) {
    if (
      typeof candidate !== 'string'
      || candidate === ''
      || candidate.trim() !== candidate
      || candidate.length > MODEL_ID_MAX_LENGTH
    ) return invalid()
    models.push(candidate)
  }
  if (new Set(models).size !== models.length) return invalid()
  const recommended = value.recommendedModelId
  if (recommended !== null && (typeof recommended !== 'string' || !models.includes(recommended))) {
    return invalid()
  }
  return parsed({ models, recommendedModelId: recommended })
}

function modelResultParser<T>(parseValue: (value: unknown) => T | undefined): ValueParser<T> {
  return value => { const result = parseValue(value); return result === undefined ? invalid() : parsed(result) }
}

function parseObservedCatalog(value: unknown): Parsed<ModelCatalogRead> {
  const conflict = parsePublicModelMutation(value)
  if (conflict?.status === 'conflict') return parsed(conflict)
  if (!hasObservationKeys(value, ['status', 'catalog']) || value.status !== 'catalog') return invalid()
  const catalog = parseModelCatalog(value.catalog)
  return catalog.valid ? parsed({ status: 'catalog', catalog: catalog.value }) : invalid()
}

function observedModelInvoke<T>(invoke: Invoke, channel: string, observed: PublicModelSettingsSnapshot,
  parseValue: ValueParser<T>, input?: { input: unknown }): Promise<ApiResult<T>> {
  const observation = parsePublicModelSettingsSnapshot(observed)
  return observation ? safeModelInvoke(invoke, channel, parseValue, { observed: observation, ...input }) : Promise.resolve(invalidInputFailure())
}

const TRANSLATION_TARGET_LANGUAGES = new Set<Exclude<TargetLanguage, 'auto'>>([
  'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'ar',
])

function parseTranslationStarted(value: unknown): Parsed<TranslationStarted> {
  if (!isExactOwnRecord(value, ['requestId', 'targetLanguage', 'modelId'])) return invalid()
  if (
    typeof value.requestId !== 'string'
    || !isCanonicalTranslationRequestId(value.requestId)
    || typeof value.targetLanguage !== 'string'
    || !TRANSLATION_TARGET_LANGUAGES.has(value.targetLanguage as Exclude<TargetLanguage, 'auto'>)
    || typeof value.modelId !== 'string'
    || value.modelId === ''
    || value.modelId.trim() !== value.modelId
    || value.modelId.length > MODEL_ID_MAX_LENGTH
  ) return invalid()
  return parsed({
    requestId: value.requestId,
    targetLanguage: value.targetLanguage as Exclude<TargetLanguage, 'auto'>,
    modelId: value.modelId,
  })
}

function parseAiConversationStarted(
  value: unknown,
): Parsed<{ requestId: string; modelId: string; transcriptRevision: number }> {
  if (!isExactOwnRecord(value, ['requestId', 'modelId', 'transcriptRevision'])) return invalid()
  if (
    typeof value.requestId !== 'string'
    || !isCanonicalAiConversationRequestId(value.requestId)
    || typeof value.modelId !== 'string'
    || value.modelId === ''
    || value.modelId.trim() !== value.modelId
    || value.modelId.length > MODEL_ID_MAX_LENGTH
    || !Number.isSafeInteger(value.transcriptRevision)
    || (value.transcriptRevision as number) < 0
  ) return invalid()
  return parsed({
    requestId: value.requestId,
    modelId: value.modelId,
    transcriptRevision: value.transcriptRevision as number,
  })
}

function parseAiMessageLinkAuditTarget(value: unknown): Parsed<string | null> {
  if (value === null) return parsed(null)
  const target = parseAiMessageLinkTarget(value)
  if (!target) return invalid()
  if (target.kind === 'web') return target.url === value ? parsed(value) : invalid()
  return target.scope === 'absolute' && target.path === value ? parsed(value) : invalid()
}

function parseAiWorkspaceState(value: unknown): Parsed<AiWorkspaceState> {
  if (!isExactOwnRecord(value, ['workspaceId', 'workspaceGeneration'])
    || typeof value.workspaceId !== 'string' || value.workspaceId.length === 0
    || value.workspaceId.length > 512 || typeof value.workspaceGeneration !== 'string'
    || value.workspaceGeneration.length === 0 || value.workspaceGeneration.length > 512) return invalid()
  return parsed(Object.freeze({
    workspaceId: value.workspaceId,
    workspaceGeneration: value.workspaceGeneration,
  }))
}

function isAiWorkspaceStateInput(value: unknown): value is AiWorkspaceState {
  return parseAiWorkspaceState(value).valid
}

function isSetAiConversationCapabilitiesInput(
  value: unknown,
): value is SetAiConversationCapabilitiesInput {
  return isExactOwnRecord(value, [
    'conversationId', 'workspaceId', 'workspaceGeneration', 'capabilities',
  ]) && isCanonicalAiConversationId(value.conversationId)
    && typeof value.workspaceId === 'string' && value.workspaceId.length > 0
    && value.workspaceId.length <= 512 && typeof value.workspaceGeneration === 'string'
    && value.workspaceGeneration.length > 0 && value.workspaceGeneration.length <= 512
    && isExactOwnRecord(value.capabilities, ['currentDocument', 'workspace'])
    && typeof value.capabilities.currentDocument === 'boolean'
    && typeof value.capabilities.workspace === 'boolean'
}

function isSubmitAiAuthorizationResultInput(
  value: unknown,
): value is SubmitAiAuthorizationResultInput {
  return isExactOwnRecord(value, ['requestId', 'operationId', 'allowed'])
    && isCanonicalAiConversationRequestId(value.requestId)
    && isCanonicalAiConversationRequestId(value.operationId)
    && typeof value.allowed === 'boolean'
}

function isClearAiConversationInput(value: unknown): value is ClearAiConversationInput {
  return isExactOwnRecord(value, ['conversationId', 'workspaceId', 'workspaceGeneration'])
    && isCanonicalAiConversationId(value.conversationId)
    && typeof value.workspaceId === 'string' && value.workspaceId.length > 0
    && value.workspaceId.length <= 512 && typeof value.workspaceGeneration === 'string'
    && value.workspaceGeneration.length > 0 && value.workspaceGeneration.length <= 512
}

function isStrictStartAiConversationInput(value: unknown): value is StartAiConversationInput {
  const keys = [
    'requestId', 'conversationId', 'workspaceKey', 'acknowledgedTranscriptRevision',
    'messages', 'capabilities', 'writePolicy',
  ]
  if (typeof value === 'object' && value !== null && 'currentDocumentOnce' in value) {
    keys.push('currentDocumentOnce')
  }
  if (typeof value === 'object' && value !== null && 'expectedDocumentId' in value) {
    keys.push('expectedDocumentId')
  }
  if (typeof value === 'object' && value !== null && 'continuationOfSegmentId' in value) keys.push('continuationOfSegmentId')
  return isExactOwnRecord(value, keys) && isExactArray(value.messages) && value.messages.length === 1
    && isExactOwnRecord(value.messages[0], ['id', 'role', 'content'])
    && isExactOwnRecord(value.capabilities, ['currentDocument', 'workspace'])
    && isStartAiConversationInput(value)
}

function isCurrentDocumentRendererPort(value: unknown): value is AiCurrentDocumentRendererPort {
  return isExactOwnRecord(value, ['openSnapshot', 'readPage', 'release'])
    && typeof value.openSnapshot === 'function' && typeof value.readPage === 'function'
    && typeof value.release === 'function'
}

function isOpenDocumentRendererPort(value: unknown): value is AiOpenDocumentRendererPort {
  return isExactOwnRecord(value, [
    'captureReadSnapshot', 'planReplacement', 'applyTransaction', 'queryOutcome',
  ]) && typeof value.captureReadSnapshot === 'function'
    && typeof value.planReplacement === 'function'
    && typeof value.applyTransaction === 'function'
    && typeof value.queryOutcome === 'function'
}

function parseAiCurrentDocumentPortRegistration(value: unknown): Parsed<{ portGeneration: number }> {
  return isExactOwnRecord(value, ['portGeneration']) && Number.isSafeInteger(value.portGeneration)
    && (value.portGeneration as number) > 0
    ? parsed(Object.freeze({ portGeneration: value.portGeneration as number })) : invalid()
}

function parseAiOpenDocumentPortRegistration(value: unknown): Parsed<{ documentHandle: string }> {
  return isExactOwnRecord(value, ['documentHandle'])
    && isCanonicalAiConversationRequestId(value.documentHandle)
    ? parsed(Object.freeze({ documentHandle: value.documentHandle })) : invalid()
}

function isAiConversationSettingsInput(value: unknown): value is AiConversationSettings {
  return (
    isExactOwnRecord(value, ['connectionId', 'thinkingMode', 'reasoningEffort', 'writePolicy'])
    && (
      value.connectionId === null
      || (typeof value.connectionId === 'string'
        && isFeatureModelConnectionId(value.connectionId))
    )
    && parseThinkingMode(value.thinkingMode) !== undefined
    && parseReasoningEffort(value.reasoningEffort) !== undefined
    && typeof value.writePolicy === 'string'
    && ['ask-every-time', 'document-grant', 'workspace-grant'].includes(value.writePolicy)
  )
}

function parseLayoutPreferencesSnapshot(value: unknown): Parsed<LayoutPreferencesSnapshot> {
  if (!isExactOwnRecord(value, ['layout', 'revision'])) return invalid()
  const layout = parseCompleteLayoutPreferences(value.layout)
  if (!layout || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) return invalid()
  return parsed({ layout, revision: Number(value.revision) })
}

function parseLayoutCompareAndSetResult(value: unknown): Parsed<{
  applied: boolean
  snapshot: LayoutPreferencesSnapshot
}> {
  if (!isExactOwnRecord(value, ['applied', 'snapshot']) || typeof value.applied !== 'boolean') {
    return invalid()
  }
  const snapshot = parseLayoutPreferencesSnapshot(value.snapshot)
  return snapshot.valid ? parsed({ applied: value.applied, snapshot: snapshot.value }) : invalid()
}

const FEATURE_TARGET_LANGUAGES = new Set([
  'auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'ar',
])

function parseFeatureSettingsInput(value: unknown): FeatureSettingsInput | undefined {
  if (!isExactOwnRecord(value, ['connectionId', 'thinkingMode', 'reasoningEffort', 'targetLanguage'])) {
    return undefined
  }
  if (
    !(value.connectionId === null
      || (typeof value.connectionId === 'string'
        && isFeatureModelConnectionId(value.connectionId)))
    || parseThinkingMode(value.thinkingMode) === undefined
    || parseReasoningEffort(value.reasoningEffort) === undefined
    || typeof value.targetLanguage !== 'string'
    || !FEATURE_TARGET_LANGUAGES.has(value.targetLanguage)
  ) return undefined
  return {
    connectionId: value.connectionId as string | null,
    thinkingMode: value.thinkingMode as FeatureSettingsInput['thinkingMode'],
    reasoningEffort: value.reasoningEffort as FeatureSettingsInput['reasoningEffort'],
    targetLanguage: value.targetLanguage as FeatureSettingsInput['targetLanguage'],
  }
}

const MODEL_PROVIDERS = new Set([
  'kimi', 'deepseek', 'qwen', 'zhipu', 'doubao', 'minimax', 'xiaomi-mimo', 'hy', 'other',
])

function isConnectModelInput(value: unknown): value is ConnectModelInput {
  if (!isExactOwnRecordWithOptional(value, [
    'name', 'provider', 'accessType', 'protocol', 'baseUrl', 'modelId',
  ], ['id', 'apiKey', 'capabilityOverride'])) return false
  if (
    (value.id !== undefined
      && (typeof value.id !== 'string' || !isCanonicalModelConnectionId(value.id)))
    || typeof value.name !== 'string'
    || value.name.length === 0
    || value.name !== value.name.trim()
    || value.name.length > MODEL_CONNECTION_NAME_MAX_LENGTH
    || typeof value.provider !== 'string'
    || !MODEL_PROVIDERS.has(value.provider)
    || value.accessType !== 'standard-api'
    || (value.protocol !== 'openai' && value.protocol !== 'anthropic')
    || typeof value.baseUrl !== 'string'
    || value.baseUrl.length === 0
    || value.baseUrl !== value.baseUrl.trim()
    || value.baseUrl.length > MODEL_BASE_URL_MAX_LENGTH
    || !isSafeModelBaseUrl(value.baseUrl)
    || typeof value.modelId !== 'string'
    || value.modelId.length === 0
    || value.modelId !== value.modelId.trim()
    || value.modelId.length > MODEL_ID_MAX_LENGTH
    || (value.apiKey !== undefined
      && (typeof value.apiKey !== 'string' || value.apiKey.length === 0
        || value.apiKey.length > 16 * 1024))
    || (value.id === undefined && value.apiKey === undefined)
  ) return false
  if (Object.prototype.hasOwnProperty.call(value, 'capabilityOverride')) {
    if (
      value.capabilityOverride !== null
      && parseModelCapabilityOverride(value.capabilityOverride) === undefined
    ) return false
  }
  return true
}

function parseArknoteServiceEvent(value: unknown): ArknoteServiceEvent | undefined {
  if (!isExactOwnRecord(value, ['type'])) return undefined
  return value.type === 'service-stopping' || value.type === 'service-disconnected'
    ? { type: value.type }
    : undefined
}

function parseStickyNoteDocument(value: unknown): Parsed<StickyNoteDocument> {
  const result = parsePersistedStickyNoteDocument(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseStickyNoteReadDocument(value: unknown): Parsed<StickyNoteReadDocument> {
  if (!isExactOwnRecord(value, ['record', 'markdown', 'documentAbsolutePath'])) {
    return parseStickyNoteDocument(value)
  }
  const documentAbsolutePath = value.documentAbsolutePath
  if (!isWindowsAbsolutePath(documentAbsolutePath) || documentAbsolutePath.includes('\0')
    || !documentAbsolutePath.toLowerCase().endsWith('.md')) return invalid()
  const document = parsePersistedStickyNoteDocument({ record: value.record, markdown: value.markdown })
  return document ? parsed({ ...document, documentAbsolutePath }) : invalid()
}

function parseStickyNoteSummaries(value: unknown): Parsed<StickyNoteSummary[]> {
  const result = parsePersistedStickyNoteSummaries(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseStickyNoteSearchResults(value: unknown): Parsed<StickyNoteSearchResult[]> {
  const result = parsePersistedStickyNoteSearchResults(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseStickyNoteImportResult(value: unknown): Parsed<StickyNoteImportResult> {
  const result = parsePersistedStickyNoteImportResult(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseStickyNoteSaveState(value: unknown): Parsed<StickyNoteSaveState> {
  const result = parsePersistedStickyNoteSaveState(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseStickyNoteRecord(value: unknown): Parsed<StickyNoteRecord> {
  const result = parsePersistedStickyNoteRecord(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseSystemFonts(value: unknown): Parsed<string[]> {
  if (!isExactArray(value) || value.length > 4096) return invalid()
  if (!value.every((font) => typeof font === 'string' && font.length >= 1 && font.length <= 120)) {
    return invalid()
  }
  return parsed(value.map((font) => String(font)))
}

function parseTreeEntry(value: unknown): Parsed<TreeEntry> {
  if (!isExactOwnRecord(value, ['name', 'relativePath', 'kind'])) return invalid()
  if (
    typeof value.name !== 'string'
    || typeof value.relativePath !== 'string'
    || (value.kind !== 'directory' && value.kind !== 'document')
  ) return invalid()
  return parsed({ name: value.name, relativePath: value.relativePath, kind: value.kind })
}

function parseTreeEntries(value: unknown): Parsed<TreeEntry[]> {
  if (!isExactArray(value)) return invalid()
  const entries: TreeEntry[] = []
  for (const candidate of value) {
    const entry = parseTreeEntry(candidate)
    if (!entry.valid) return invalid()
    entries.push(entry.value)
  }
  return parsed(entries)
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
function parseWorkspaceEntryProperties(value: unknown): Parsed<WorkspaceEntryProperties> {
  const keys = [
    'name', 'relativePath', 'absolutePath', 'kind', 'size',
    'createdAt', 'modifiedAt', 'itemCount',
  ] as const
  if (!isExactOwnRecord(value, keys)) return invalid()
  if (
    typeof value.name !== 'string'
    || typeof value.relativePath !== 'string'
    || !isWindowsAbsolutePath(value.absolutePath)
    || (value.kind !== 'directory' && value.kind !== 'document')
    || !isFiniteNumber(value.size)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.modifiedAt !== 'string'
    || !Number.isFinite(Date.parse(value.modifiedAt))
    || !(value.itemCount === null || (
      Number.isSafeInteger(value.itemCount) && Number(value.itemCount) >= 0
    ))
  ) return invalid()
  return parsed({
    name: value.name,
    relativePath: value.relativePath,
    absolutePath: value.absolutePath,
    kind: value.kind,
    size: value.size,
    createdAt: value.createdAt,
    modifiedAt: value.modifiedAt,
    itemCount: value.itemCount as number | null,
  })
}


function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseDocument(value: unknown): Parsed<DocumentSnapshot> {
  if (!isExactOwnRecord(
    value,
    ['relativePath', 'markdown', 'revision', 'encoding', 'newline', 'mtimeMs'],
  )) return invalid()
  if (
    typeof value.relativePath !== 'string'
    || typeof value.markdown !== 'string'
    || !isRevision(value.revision)
    || (value.encoding !== 'utf8' && value.encoding !== 'utf8-bom')
    || (value.newline !== 'lf' && value.newline !== 'crlf')
    || !isFiniteNumber(value.mtimeMs)
  ) return invalid()
  return parsed({
    relativePath: value.relativePath,
    markdown: value.markdown,
    revision: value.revision,
    encoding: value.encoding,
    newline: value.newline,
    mtimeMs: value.mtimeMs,
  })
}

function parsePreparedDroppedPathResult(value: unknown): Parsed<PreparedDroppedPathResult> {
  if (!isExactOwnRecord(value, ['workspace', 'document', 'token'])
    || typeof value.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token)) return invalid()
  const result = parseDroppedPathResult({ workspace: value.workspace, document: value.document })
  return result.valid ? parsed({ ...result.value, token: value.token }) : invalid()
}

function parseSettledDroppedPathResult(value: unknown): Parsed<DroppedPathResult | null> {
  return value === null ? parsed(null) : parseDroppedPathResult(value)
}

function parseDroppedPathResult(value: unknown): Parsed<DroppedPathResult> {
  if (!isExactOwnRecord(value, ['workspace', 'document'])) return invalid()
  const workspace = parseWorkspace(value.workspace)
  if (!workspace.valid || workspace.value === null) return invalid()
  if (value.document === null) {
    return parsed({ workspace: workspace.value, document: null })
  }
  const document = parseDocument(value.document)
  if (!document.valid) return invalid()
  return parsed({ workspace: workspace.value, document: document.value })
}

function parseDroppedPathInspection(value: unknown): Parsed<{
  kind: 'file' | 'directory'
  absolutePath: string
}> {
  if (!isExactOwnRecord(value, ['kind', 'absolutePath'])) return invalid()
  if (
    (value.kind !== 'file' && value.kind !== 'directory')
    || typeof value.absolutePath !== 'string'
    || value.absolutePath.length === 0
    || value.absolutePath.length > 32767
  ) return invalid()
  return parsed({ kind: value.kind, absolutePath: value.absolutePath })
}

function parseImportedAsset(value: unknown): Parsed<ImportedAsset> {
  if (!isExactOwnRecord(
    value,
    ['assetId', 'category', 'fileName', 'relativePath', 'previewUrl', 'markdown'],
  )) return invalid()
  if (
    typeof value.assetId !== 'string'
    || !['image', 'audio', 'video', 'pdf', 'attachment'].includes(String(value.category))
    || typeof value.fileName !== 'string'
    || typeof value.relativePath !== 'string'
    || typeof value.previewUrl !== 'string'
    || typeof value.markdown !== 'string'
  ) return invalid()
  return parsed(value as unknown as ImportedAsset)
}

function parseImportedDocx(value: unknown): Parsed<ImportedDocx> {
  if (!isExactOwnRecord(
    value,
    ['sourceAbsolutePath', 'sourceFileName', 'markdown'],
  )) return invalid()
  if (
    !isWindowsAbsolutePath(value.sourceAbsolutePath)
    || typeof value.sourceFileName !== 'string'
    || typeof value.markdown !== 'string'
  ) return invalid()
  return parsed({
    sourceAbsolutePath: value.sourceAbsolutePath,
    sourceFileName: value.sourceFileName,
    markdown: value.markdown,
  })
}

function parseWorkspaceEntryRenameResult(value: unknown): Parsed<WorkspaceEntryRenameResult> {
  if (!isExactOwnRecord(value, ['entry', 'colorMarks'])) return invalid()
  const entry = parseTreeEntry(value.entry)
  const colorMarks = parseWorkspaceColorMarks(value.colorMarks)
  if (!entry.valid || !colorMarks.valid) return invalid()
  return parsed({ entry: entry.value, colorMarks: colorMarks.value })
}

function parseWorkspaceEntryTrashResult(value: unknown): Parsed<WorkspaceEntryTrashResult> {
  if (!isExactOwnRecord(value, ['colorMarks'])) return invalid()
  const colorMarks = parseWorkspaceColorMarks(value.colorMarks)
  return colorMarks.valid ? parsed({ colorMarks: colorMarks.value }) : invalid()
}

function parseWorkspaceColorMarks(value: unknown): Parsed<WorkspaceColorMarksSnapshot> {
  const snapshot = parseWorkspaceColorMarksSnapshot(value)
  return snapshot ? parsed(snapshot) : invalid()
}

function parseExportDocxResult(value: unknown): Parsed<ExportDocxResult | null> {
  if (value === null) return parsed(null)
  if (!isExactOwnRecord(value, ['fileName', 'reusedTarget'])) return invalid()
  if (
    typeof value.fileName !== 'string'
    || value.fileName.length === 0
    || value.fileName.length > 260
    || /[\\/]/.test(value.fileName)
    || typeof value.reusedTarget !== 'boolean'
  ) return invalid()
  return parsed({ fileName: value.fileName, reusedTarget: value.reusedTarget })
}

function parseExportXlsxResult(value: unknown): Parsed<ExportXlsxResult | null> {
  if (value === null) return parsed(null)
  if (!isExactOwnRecord(value, ['fileName'])) return invalid()
  if (
    typeof value.fileName !== 'string'
    || value.fileName.length === 0
    || value.fileName.length > 260
    || /[\\/]/.test(value.fileName)
  ) return invalid()
  return parsed({ fileName: value.fileName })
}

function parseClipboardFormats(value: unknown): Parsed<ClipboardFormatsSnapshot> {
  if (!isExactOwnRecord(value, ['plainText', 'markdown', 'html'])) return invalid()
  if (
    typeof value.plainText !== 'string'
    || value.plainText.length > 2 * 1024 * 1024
    || (value.markdown !== null && typeof value.markdown !== 'string')
    || (typeof value.markdown === 'string' && value.markdown.length > 2 * 1024 * 1024)
    || (value.html !== null && typeof value.html !== 'string')
    || (typeof value.html === 'string' && value.html.length > 2 * 1024 * 1024)
  ) return invalid()
  return parsed({
    plainText: value.plainText,
    markdown: value.markdown as string | null,
    html: value.html as string | null,
  })
}

function parseCodexCliConnectionTestResult(
  value: unknown,
): Parsed<CodexCliConnectionTestResult> {
  const result = parsePersistedCodexCliConnectionTestResult(value)
  return result === undefined ? invalid() : parsed(result)
}

function parseLoginResult(value: unknown): Parsed<CodexCliLoginResult> {
  const result = parseCodexCliLoginResult(value)
  return result === undefined ? invalid() : parsed(result)
}

function isMermaidPngDataUrl(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith('data:image/png;base64,')
    && value.length >= 'data:image/png;base64,'.length + 4
    && value.length <= 24 * 1024 * 1024
}

function parseMermaidImageExportInput(value: unknown): MermaidImageExportInput | null {
  if (!isExactOwnRecord(value, ['svgDataUrl', 'pngDataUrl'])) return null
  if (
    typeof value.svgDataUrl !== 'string'
    || !value.svgDataUrl.startsWith('data:image/svg+xml;base64,')
    || value.svgDataUrl.length < 'data:image/svg+xml;base64,'.length + 4
    || value.svgDataUrl.length > 3 * 1024 * 1024
    || !isMermaidPngDataUrl(value.pngDataUrl)
  ) return null
  return { svgDataUrl: value.svgDataUrl, pngDataUrl: value.pngDataUrl }
}

function parseBoolean(value: unknown): Parsed<boolean> {
  return typeof value === 'boolean' ? parsed(value) : invalid()
}

function parseImportDocxIntent(value: unknown): Parsed<ImportDocxIntent> {
  if (!isExactOwnRecord(value, ['workspace', 'imported'])) return invalid()
  const workspace = parseWorkspace(value.workspace)
  const imported = parseImportedDocx(value.imported)
  if (!workspace.valid || workspace.value === null || !imported.valid) return invalid()
  return parsed({
    workspace: workspace.value,
    imported: imported.value,
  })
}

function parseDraftSummary(value: unknown): Parsed<DraftSummary> {
  if (!isExactOwnRecord(value, [
    'draftId', 'originalAbsolutePath', 'workspaceAbsolutePath', 'originalRevision',
    'originalMtimeMs', 'encoding', 'newline', 'updatedAt', 'ignoredAt',
  ])) return invalid()
  if (
    typeof value.draftId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.draftId)
    || !(value.originalAbsolutePath === null || typeof value.originalAbsolutePath === 'string')
    || !(value.workspaceAbsolutePath === null || typeof value.workspaceAbsolutePath === 'string')
    || !(value.originalRevision === null || isRevision(value.originalRevision))
    || !(value.originalMtimeMs === null || isFiniteNumber(value.originalMtimeMs))
    || (value.encoding !== 'utf8' && value.encoding !== 'utf8-bom')
    || (value.newline !== 'lf' && value.newline !== 'crlf')
    || typeof value.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(value.updatedAt))
    || !(value.ignoredAt === null || (typeof value.ignoredAt === 'string' && Number.isFinite(Date.parse(value.ignoredAt))))
  ) return invalid()
  return parsed(value as unknown as DraftSummary)
}

function parseDraftSummaries(value: unknown): Parsed<DraftSummary[]> {
  if (!isExactArray(value)) return invalid()
  const summaries: DraftSummary[] = []
  for (const candidate of value) {
    const summary = parseDraftSummary(candidate)
    if (!summary.valid) return invalid()
    summaries.push(summary.value)
  }
  return parsed(summaries)
}

function parseRecoveredDraft(value: unknown): Parsed<RecoveredDraft | null> {
  if (value === null) return parsed(null)
  if (!isExactOwnRecord(value, ['manifest', 'markdown']) || typeof value.markdown !== 'string') return invalid()
  const manifest = parseDraftSummary(value.manifest)
  return manifest.valid ? parsed({ manifest: manifest.value, markdown: value.markdown }) : invalid()
}

function parseRecoveryIntent(value: unknown): Parsed<RecoveryIntent> {
  if (!isExactOwnRecord(value, ['draftId', 'manifest', 'markdown']) || typeof value.markdown !== 'string') {
    return invalid()
  }
  const manifest = parseDraftSummary(value.manifest)
  if (!manifest.valid || value.draftId !== manifest.value.draftId) return invalid()
  return parsed({ draftId: manifest.value.draftId, manifest: manifest.value, markdown: value.markdown })
}

function parseSaveAsResult(value: unknown): Parsed<DroppedPathResult | null> {
  if (value === null) return parsed(null)
  return parseDroppedPathResult(value)
}

function parseBeginSaveAsResult(value: unknown): Parsed<BeginSaveDocumentAsResult | null> {
  if (value === null) return parsed(null)
  if (!isExactOwnRecord(value, [
    'intentId', 'targetWorkspace', 'targetFileName', 'targetRelativePath', 'changesWorkspace',
  ]) || typeof value.intentId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.intentId)
    || typeof value.targetFileName !== 'string' || value.targetFileName.length === 0
    || value.targetFileName.length > 255 || typeof value.targetRelativePath !== 'string'
    || value.targetRelativePath !== value.targetFileName || typeof value.changesWorkspace !== 'boolean') {
    return invalid()
  }
  const workspace = parseWorkspace(value.targetWorkspace)
  if (!workspace.valid || workspace.value === null) return invalid()
  return parsed({
    intentId: value.intentId,
    targetWorkspace: workspace.value,
    targetFileName: value.targetFileName,
    targetRelativePath: value.targetRelativePath,
    changesWorkspace: value.changesWorkspace,
  })
}

function parseCommitSaveAsResult(value: unknown): Parsed<CommitSaveDocumentAsResult> {
  if (!isExactOwnRecordWithOptional(value, ['workspace', 'document', 'changesWorkspace', 'aiWorkspace'], ['draftEndPending'])
    || ('draftEndPending' in value && value.draftEndPending !== true)
    || typeof value.changesWorkspace !== 'boolean'
    || !isExactOwnRecord(value.aiWorkspace, ['workspaceId', 'workspaceGeneration'])
    || typeof value.aiWorkspace.workspaceId !== 'string' || value.aiWorkspace.workspaceId.length === 0
    || value.aiWorkspace.workspaceId.length > 512
    || typeof value.aiWorkspace.workspaceGeneration !== 'string'
    || value.aiWorkspace.workspaceGeneration.length === 0
    || value.aiWorkspace.workspaceGeneration.length > 512) return invalid()
  const workspace = parseWorkspace(value.workspace)
  const document = parseDocument(value.document)
  if (!workspace.valid || workspace.value === null || !document.valid) return invalid()
  return parsed({
    workspace: workspace.value,
    document: document.value,
    changesWorkspace: value.changesWorkspace,
    ...('draftEndPending' in value ? { draftEndPending: true as const } : {}),
    aiWorkspace: {
      workspaceId: value.aiWorkspace.workspaceId,
      workspaceGeneration: value.aiWorkspace.workspaceGeneration,
    },
  })
}

function parseSaveResult(value: unknown): Parsed<SaveDocumentResult> {
  if (!isExactOwnRecordWithOptional(value, ['revision', 'mtimeMs'],
    ['markdown', 'clipboardAssetsRetained', 'draftEndPending'])) return invalid()
  if (!isRevision(value.revision) || !isFiniteNumber(value.mtimeMs)) return invalid()
  if ('markdown' in value && typeof value.markdown !== 'string') return invalid()
  if ('clipboardAssetsRetained' in value && value.clipboardAssetsRetained !== true) return invalid()
  if ('draftEndPending' in value && value.draftEndPending !== true) return invalid()
  return parsed({ revision: value.revision, mtimeMs: value.mtimeMs, ...('markdown' in value ? { markdown: value.markdown as string } : {}),
    ...('clipboardAssetsRetained' in value ? { clipboardAssetsRetained: true as const } : {}),
    ...('draftEndPending' in value ? { draftEndPending: true as const } : {}),
  })
}

function parseFailure(value: Record<string, unknown>): ApiResult<never> | null {
  if (!isExactOwnRecord(value.error, ['code', 'message'])) return null
  if (typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return null
  if (!Object.prototype.hasOwnProperty.call(SAFE_ERROR_MESSAGES, value.error.code)) return null
  const code = value.error.code as keyof typeof SAFE_ERROR_MESSAGES
  return { ok: false, error: { code, message: SAFE_ERROR_MESSAGES[code] } }
}

function parseResponse<T>(value: unknown, parseValue: ValueParser<T>): ApiResult<T> | null {
  if (isExactOwnRecord(value, ['ok', 'value']) && value.ok === true) {
    const result = parseValue(value.value)
    return result.valid ? { ok: true, value: result.value } : null
  }
  if (isExactOwnRecord(value, ['ok', 'error']) && value.ok === false) return parseFailure(value)
  return null
}

async function safeInvoke<T>(
  invoke: Invoke,
  channel: string,
  parseValue: ValueParser<T>,
  ...args: unknown[]
): Promise<ApiResult<T>> {
  try {
    const result = parseResponse(await invoke(channel, ...args), parseValue)
    return result ?? transportFailure()
  } catch {
    return transportFailure()
  }
}

async function safeModelInvoke<T>(
  invoke: Invoke,
  channel: string,
  parseValue: ValueParser<T>,
  ...args: unknown[]
): Promise<ApiResult<T>> {
  try {
    const result = parseResponse(await invoke(channel, ...args), parseValue)
    return result ?? invalidResponseFailure()
  } catch {
    return transportFailure()
  }
}

import { parseUpdateSnapshot, parseUpdateAbout } from '../shared/app-update'

export function createArkdownApi(
  invoke: Invoke,
  closeTransport?: ClosePreparationTransport,
  getPathForFile: (file: File) => string = () => '',
  menuTransport?: MenuCommandTransport,
  openIntentTransport?: OpenIntentTransport,
  recoveryIntentTransport?: RecoveryIntentTransport,
  importDocxIntentTransport?: ImportDocxIntentTransport,
  translationEventTransport?: TranslationEventTransport,
  stickyNoteEventTransport?: StickyNoteEventTransport,
  arknoteServiceEventTransport?: StickyNoteEventTransport,
  stickyNoteContextMenuShowTransport?: StickyNoteContextMenuTransport,
  stickyNoteContextMenuCommandTransport?: StickyNoteContextMenuTransport,
  stickyNoteContextMenuClosedTransport?: StickyNoteContextMenuTransport,
  stickyNoteContextMenuResetTransport?: StickyNoteContextMenuTransport,
  applicationMenuChangedTransport?: ApplicationMenuChangedTransport,
  editorAppearanceChangedTransport?: EditorAppearanceChangedTransport,
  layoutPreferencesChangedTransport?: LayoutPreferencesChangedTransport,
  windowStateChangedTransport?: WindowStateChangedTransport,
  screenshotCaptureEventTransport?: ScreenshotCaptureEventTransport,
  screenshotTranslationEventTransport?: ScreenshotTranslationEventTransport,
  screenshotOcrModelStateTransport?: ScreenshotOcrModelStateTransport,
  screenshotOcrHostEventTransport?: ScreenshotOcrHostEventTransport,
  documentConversionComponentStateTransport?: DocumentConversionComponentStateTransport,
  aiConversationEventTransport?: AiConversationEventTransport,
  aiRendererPortTransport?: AiRendererPortTransport,
  backgroundPresentationEventTransport?: BackgroundPresentationEventTransport,
  stickyNoteMaterialEffectsTransport?: StickyNoteEventTransport,
  modelCapabilityRulesTransport?: StickyNoteEventTransport,
  keyboardShortcutsTransport?: ApplicationMenuChangedTransport,
  documentLocationTransport?: ApplicationMenuChangedTransport,
  structuredClose?: Pick<ArkdownApi, 'onPrepareCloseStructured' | 'onClosePreparationReleased'>,
  updateTransport?: ApplicationMenuChangedTransport,
): ArkdownRendererApi {
  let prepareCloseHandler: (() => Promise<boolean>) | null = null
  let detachCurrentDocumentPort: (() => void) | undefined
  let currentDocumentPortTransition = false
  const openDocumentPortAttachments = new Map<string, { detach(): void }>()
  closeTransport?.subscribe((payload) => {
    if (!isExactOwnRecord(payload, ['requestId']) || typeof payload.requestId !== 'string') return
    const requestId = payload.requestId
    const handler = prepareCloseHandler
    if (!handler) {
      closeTransport.respond({ requestId, ok: false })
      return
    }
    // The immediate heartbeat acknowledges that the renderer accepted the request.
    // Continued heartbeats keep user dialogs and async exports alive without masking
    // a blocked renderer event loop, whose lease still expires in the main process.
    closeTransport.heartbeat({ requestId })
    const heartbeat = setInterval(() => {
      closeTransport.heartbeat({ requestId })
    }, CLOSE_PREPARATION_HEARTBEAT_INTERVAL_MS)
    const respond = (ok: boolean) => {
      clearInterval(heartbeat)
      closeTransport.respond({ requestId, ok })
    }
    void Promise.resolve().then(handler).then(
      (ready) => respond(ready === true),
      () => respond(false),
    )
  })

  return Object.freeze({
    chooseWorkspace: () => safeInvoke(invoke, IPC_CHANNELS.chooseWorkspace, parseWorkspace),
    claimWorkspaceIntroduction: (legacySeen: boolean) => {
      if (typeof legacySeen !== 'boolean') return Promise.resolve({ ok: false as const, error: { code: 'INVALID_INPUT' as const, message: '参数无效' } })
      return safeInvoke<{ showIntroduction: boolean }>(invoke, IPC_CHANNELS.claimWorkspaceIntroduction, value =>
        isExactOwnRecord(value, ['showIntroduction']) && typeof value.showIntroduction === 'boolean'
          ? parsed({ showIntroduction: value.showIntroduction }) : invalid(), { legacySeen })
    },
    restoreWorkspace: () => safeInvoke(invoke, IPC_CHANNELS.restoreWorkspace, parseWorkspace),
    listDirectory: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.listDirectory, parseTreeEntries, { relativePath }),
    startWorkspaceFileDrag: (input: WorkspaceFileDragInput) =>
      safeInvoke(invoke, IPC_CHANNELS.startWorkspaceFileDrag, parseVoid, input),
    inspectDroppedPath: (absolutePath: string, resolveDocumentShortcut = false) =>
      safeInvoke(invoke, IPC_CHANNELS.inspectDroppedPath, parseDroppedPathInspection, {
        absolutePath, ...(resolveDocumentShortcut ? { resolveDocumentShortcut: true } : {}),
      }),
    openDroppedPath: (absolutePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.openDroppedPath, parseDroppedPathResult, { absolutePath }),
    prepareDroppedPath: (absolutePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.prepareDroppedPath, parsePreparedDroppedPathResult, { absolutePath }),
    settleDroppedPath: (token: string, accept: boolean) =>
      safeInvoke(invoke, IPC_CHANNELS.settleDroppedPath, parseSettledDroppedPathResult, { token, accept }),
    pathForDroppedFile: (file: File) => {
      try {
        return getPathForFile(file)
      } catch {
        return ''
      }
    },
    createDocument: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.createDocument, parseDocument, { relativePath }),
    readDocument: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.readDocument, parseDocument, { relativePath }),
    peekDocument: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.peekDocument, parseDocument, { relativePath }),
    saveDocument: (input: SaveDocumentInput) =>
      safeInvoke(invoke, IPC_CHANNELS.saveDocument, parseSaveResult, input),
    beginSaveDocumentAs: (input: SaveDocumentAsInput) =>
      safeInvoke(invoke, IPC_CHANNELS.beginSaveDocumentAs, parseBeginSaveAsResult, input),
    commitSaveDocumentAs: (intentId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.commitSaveDocumentAs, parseCommitSaveAsResult, { intentId }),
    abortSaveDocumentAs: (intentId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.abortSaveDocumentAs, parseNull, { intentId }),
    retryDraftFinalization: () =>
      safeInvoke(invoke, IPC_CHANNELS.retryDraftFinalization, parseNull),
    saveDraft: (input: SaveDraftInput) =>
      safeInvoke(invoke, IPC_CHANNELS.saveDraft, parseDraftSummary, input),
    listRecoverableDrafts: () =>
      safeInvoke(invoke, IPC_CHANNELS.listRecoverableDrafts, parseDraftSummaries),
    readDraft: (draftId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.readDraft, parseRecoveredDraft, { draftId }),
    claimRecoveredDraft: (draftId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.claimRecoveredDraft, parseRecoveredDraft, { draftId }),
    cleanDraft: (draftId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.cleanDraft, parseNull, { draftId }),
    releaseDraftRecovery: (draftId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.releaseDraftRecovery, parseNull, { draftId }),
    ignoreDraft: (draftId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.ignoreDraft, parseNull, { draftId }),
    discardDraft: (draftId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.discardDraft, parseNull, { draftId }),
    revealDocument: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.revealDocument, parseNull, { relativePath }),
    trashDocument: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.trashDocument, parseNull, { relativePath }),
    importDocx: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.importDocx, parseImportedDocx, { relativePath }),
    exportDocx: (input: ExportDocxInput) =>
      safeInvoke(invoke, IPC_CHANNELS.exportDocx, parseExportDocxResult, input),
    exportXlsx: (input: ExportXlsxInput) =>
      safeInvoke(invoke, IPC_CHANNELS.exportXlsx, parseExportXlsxResult, input),
    readClipboardFormats: () =>
      safeInvoke(invoke, IPC_CHANNELS.readClipboardFormats, parseClipboardFormats),
    pasteClipboardImage: (target: import('../shared/contracts').ClipboardImageTarget) => {
      const key = isExactOwnRecord(target, ['draftId']) ? 'draftId'
        : isExactOwnRecord(target, ['noteId']) ? 'noteId' : null
      if (!key) return Promise.resolve(invalidInputFailure())
      const id = (target as unknown as Record<string, unknown>)[key]
      if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)) {
        return Promise.resolve(invalidInputFailure())
      }
      return safeInvoke<string | null>(invoke, IPC_CHANNELS.pasteClipboardImage,
        (value) => value === null || (typeof value === 'string' && value.length <= 32768) ? parsed(value) : invalid(), target)
    },
    importAsset: (absolutePath: string, draftId?: string) =>
      safeInvoke(invoke, IPC_CHANNELS.importAsset, parseImportedAsset, { absolutePath, ...(draftId ? { draftId } : {}) }),
    openAsset: (url: string) =>
      safeInvoke(invoke, IPC_CHANNELS.openAsset, parseNull, { url }),
    openDocumentWindow: (absolutePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.openDocumentWindow, parseNull, { absolutePath }),
    navigateDocumentView: (input: DocumentViewRequest) => {
      const request = parseDocumentViewRequest(input)
      return request ? safeInvoke(invoke, IPC_CHANNELS.navigateDocumentView, documentViewParser(parseDocumentViewResult), request)
        : Promise.resolve(invalidInputFailure())
    },
    refreshDocumentView: (input: string) => {
      const id = parseDocumentViewId(input)
      return id ? safeInvoke(invoke, IPC_CHANNELS.refreshDocumentView, documentViewParser(parseDocumentViewSnapshot), { id })
        : Promise.resolve(invalidInputFailure())
    },
    inspectDocumentView: (input: string) => {
      const id = parseDocumentViewId(input)
      return id ? safeInvoke(invoke, IPC_CHANNELS.inspectDocumentView, documentViewParser(parseDocumentViewInspection), { id })
        : Promise.resolve(invalidInputFailure())
    },
    openDocumentView: (input: string) => {
      const id = parseDocumentViewId(input)
      return id ? safeInvoke(invoke, IPC_CHANNELS.openDocumentView, parseNull, { id })
        : Promise.resolve(invalidInputFailure())
    },
    revealLocalFileLink: (input: LocalFileRevealRequest) => {
      const request = parseLocalFileRevealRequest(input)
      return request ? safeInvoke(invoke, IPC_CHANNELS.revealLocalFileLink, parseNull, request)
        : Promise.resolve(invalidInputFailure())
    },
    controlWindow: (action: WindowControlAction) =>
      safeInvoke(invoke, IPC_CHANNELS.controlWindow, parseWindowState, { action }),
    getAppUpdateState: () => safeInvoke(invoke, IPC_CHANNELS.getAppUpdateState, documentViewParser(parseUpdateSnapshot)),
    onAppUpdateChanged: (listener: (state: import('../shared/app-update').UpdateSnapshot) => void) => updateTransport?.subscribe(payload => { const state = parseUpdateSnapshot(payload); if (state) listener(state) }) ?? (() => {}),
    notifyUpdateAbout: (input: { interactionId: string; open: boolean }) => { const parsed = parseUpdateAbout(input); return parsed ? safeInvoke(invoke, IPC_CHANNELS.notifyUpdateAbout, parseNull, parsed) : Promise.resolve(invalidInputFailure()) },
    openUpdateWebsite: () => safeInvoke(invoke, IPC_CHANNELS.openUpdateWebsite, parseBoolean),
    requestRequiredUpdateExit: () => safeInvoke(invoke, IPC_CHANNELS.requestRequiredUpdateExit, parseNull),
    protectUpdateWork: () => safeInvoke(invoke, IPC_CHANNELS.protectUpdateWork, parseNull),
    performUpdateAction: (action: UpdateAction) => { const value = parseUpdateAction(action); return value ? safeInvoke(invoke, IPC_CHANNELS.performUpdateAction, parseNull, value) : Promise.resolve(invalidInputFailure()) },
    getWindowState: () =>
      safeInvoke(invoke, IPC_CHANNELS.getWindowState, parseWindowState),
    onWindowStateChanged: (listener: (state: WindowStateSnapshot) => void) =>
      windowStateChangedTransport?.subscribe((payload) => {
        const state = parseWindowState(payload)
        if (state.valid) listener(state.value)
      }) ?? (() => undefined),
    getDocumentConversionComponentState: () => safeInvoke(
      invoke,
      IPC_CHANNELS.getDocumentConversionComponentState,
      parseDocumentConversionComponentState,
    ),
    installDocumentConversionComponent: (requestId: string) =>
      isCanonicalTranslationRequestId(requestId)
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.installDocumentConversionComponent,
            parseDocumentConversionComponentState,
            { requestId },
          )
        : Promise.resolve(invalidInputFailure()),
    cancelDocumentConversionComponentInstall: (requestId: string) =>
      isCanonicalTranslationRequestId(requestId)
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.cancelDocumentConversionComponentInstall,
            parseNull,
            { requestId },
          )
        : Promise.resolve(invalidInputFailure()),
    removeDocumentConversionComponent: () => safeInvoke(
      invoke,
      IPC_CHANNELS.removeDocumentConversionComponent,
      parseDocumentConversionComponentState,
    ),
    convertWorkspaceDocument: (relativePath: string, requestId: string) =>
      isCanonicalTranslationRequestId(requestId)
      && isSafeDocumentConversionRelativePath(relativePath)
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.convertWorkspaceDocument,
            parseConvertedDocument,
            { relativePath, requestId },
          )
        : Promise.resolve(invalidInputFailure()),
    cancelWorkspaceDocumentConversion: (requestId: string) =>
      isCanonicalTranslationRequestId(requestId)
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.cancelWorkspaceDocumentConversion,
            parseNull,
            { requestId },
          )
        : Promise.resolve(invalidInputFailure()),
    onDocumentConversionComponentState: (
      listener: (state: DocumentConversionComponentState) => void,
    ) => documentConversionComponentStateTransport?.subscribe((payload) => {
      const state = parseDocumentConversionComponentState(payload)
      if (state.valid) listener(state.value)
    }) ?? (() => undefined),
    getPreferenceSnapshot: (group: PreferenceGroup) => PREFERENCE_GROUPS.includes(group)
      ? safeInvoke<PublicPreferenceSnapshot>(invoke, IPC_CHANNELS.getPreferenceSnapshot, value => {
          const snapshot = parsePublicPreferenceSnapshot(value)
          if (!snapshot || snapshot.group !== group) return { valid: false }
          return { valid: true, value: snapshot }
        }, { group })
      : Promise.resolve(invalidInputFailure()),
    patchPreferences: (input: PreferencePatchInput) => {
      const command = parsePreferencePatchInput(input)
      return command ? safeInvoke<PublicPreferenceMutation>(invoke, IPC_CHANNELS.patchPreferences, value => {
        const result = parsePublicPreferenceMutation(value)
        if (!result || result.snapshot.group !== command.observed.group) return { valid: false }
        return { valid: true, value: result }
      }, command) : Promise.resolve(invalidInputFailure())
    },
    getSearchPreferences: () =>
      safeInvoke(invoke, IPC_CHANNELS.getSearchPreferences, parseSearchPreferences),
    getKeyboardShortcuts: () => safeInvoke<ObservedShortcutSnapshot>(invoke, IPC_CHANNELS.getKeyboardShortcuts, (value) => {
      const snapshot = parseObservedShortcutSnapshot(value)
      return snapshot ? { valid: true, value: snapshot } : { valid: false }
    }),
    updateKeyboardShortcuts: (update: ObservedShortcutUpdate) => {
      const input = parseObservedShortcutUpdate(update)
      return input ? safeInvoke<ObservedShortcutUpdateResult>(invoke, IPC_CHANNELS.updateKeyboardShortcuts, (value) => {
        const result = parseObservedShortcutUpdateResult(value)
        return result ? { valid: true, value: result } : { valid: false }
      }, input) : Promise.resolve(invalidInputFailure())
    },
    setShortcutRecording: (active: boolean) => typeof active === 'boolean'
      ? safeInvoke(invoke, IPC_CHANNELS.setShortcutRecording, parseNull, { active })
      : Promise.resolve(invalidInputFailure()),
    onKeyboardShortcutsChanged: (listener: (snapshot: ObservedShortcutSnapshot) => void) =>
      keyboardShortcutsTransport?.subscribe(payload => {
        const snapshot = parseObservedShortcutSnapshot(payload)
        if (snapshot) listener(snapshot)
      }) ?? (() => undefined),
    setSearchPreferences: (preferences: BrowserSearchPreferences) =>
      safeInvoke(invoke, IPC_CHANNELS.setSearchPreferences, parseSearchPreferences, preferences),
    getEditorAppearancePreferences: () =>
      safeInvoke(invoke, IPC_CHANNELS.getEditorAppearancePreferences, parseEditorAppearanceSnapshot),
    setEditorAppearancePreferences: (preferences: EditorAppearancePreferences) => {
      const value = parseEditorAppearance(preferences)
      return value.valid
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.setEditorAppearancePreferences,
            parseEditorAppearanceSnapshot,
            value.value,
          )
        : Promise.resolve(invalidInputFailure())
    },
    compareAndSetEditorAppearancePreferences: (
      expectedRevision: number,
      expected: EditorAppearancePreferences,
      replacement: EditorAppearancePreferences,
    ) => {
      const expectedValue = parseEditorAppearance(expected)
      const replacementValue = parseEditorAppearance(replacement)
      if (
        !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 0
        || !expectedValue.valid
        || !replacementValue.valid
      ) return Promise.resolve(invalidInputFailure())
      return safeInvoke(
        invoke,
        IPC_CHANNELS.compareAndSetEditorAppearancePreferences,
        parseEditorAppearanceSnapshot,
        {
          expectedRevision,
          expectedAppearance: expectedValue.value,
          replacement: replacementValue.value,
        },
      )
    },
    getLayoutPreferences: () =>
      safeInvoke(invoke, IPC_CHANNELS.getLayoutPreferences, parseLayoutPreferencesSnapshot),
    compareAndSetLayoutPreferences: (
      expectedRevision: number,
      expected: LayoutPreferences,
      replacement: LayoutPreferences,
    ) => {
      const expectedLayout = parseCompleteLayoutPreferences(expected)
      const replacementLayout = parseCompleteLayoutPreferences(replacement)
      if (
        !Number.isSafeInteger(expectedRevision)
        || expectedRevision < 0
        || !expectedLayout
        || !replacementLayout
      ) return Promise.resolve(invalidInputFailure())
      return safeInvoke(
        invoke,
        IPC_CHANNELS.compareAndSetLayoutPreferences,
        parseLayoutCompareAndSetResult,
        { expectedRevision, expectedLayout, replacement: replacementLayout },
      )
    },
    getStickyNotePreferences: () =>
      safeInvoke(invoke, IPC_CHANNELS.getStickyNotePreferences, parseStickyNotePreferences),
    setStickyNotePreferences: (preferences: StickyNotePreferences) =>
      safeInvoke(invoke, IPC_CHANNELS.setStickyNotePreferences, parseStickyNotePreferences, preferences),
    getDesktopLifecyclePreferences: () =>
      safeInvoke(invoke, IPC_CHANNELS.getDesktopLifecyclePreferences, parseDesktopLifecyclePreferences),
    getDefaultApplicationsStatus: () => safeInvoke(invoke, IPC_CHANNELS.getDefaultApplicationsStatus, (value): Parsed<import('../shared/default-applications').DefaultApplicationsStatus> => {
      if (!value || typeof value !== 'object') return { valid: false }
      const status = value as Record<string, unknown>
      if (typeof status.markdown !== 'boolean' || typeof status.text !== 'boolean'
        || Object.keys(status).some((key) => key !== 'markdown' && key !== 'text')) return { valid: false }
      return { valid: true, value: { markdown: status.markdown, text: status.text } }
    }),
    openDefaultApplicationsSettings: () => safeInvoke(invoke, IPC_CHANNELS.openDefaultApplicationsSettings, (value): Parsed<null> =>
      value === null ? { valid: true, value: null } : { valid: false }),
    setDefaultApplicationsEnabled: (enabled: boolean) => safeInvoke(invoke, IPC_CHANNELS.setDefaultApplicationsEnabled, (value): Parsed<import('../shared/default-applications').DefaultApplicationsStatus> => {
      if (!value || typeof value !== 'object') return { valid: false }
      const status = value as Record<string, unknown>
      if (typeof status.markdown !== 'boolean' || typeof status.text !== 'boolean'
        || Object.keys(status).some(key => key !== 'markdown' && key !== 'text')) return { valid: false }
      return { valid: true, value: { markdown: status.markdown, text: status.text } }
    }, enabled),
    getShellIntegrationPreferences: () =>
      safeInvoke(invoke, IPC_CHANNELS.getShellIntegrationPreferences, parseShellIntegrationPreferences),
    updateShellIntegrationPreference: (update: ObservedShellIntegrationUpdate) => {
      const input = parseObservedShellIntegrationUpdate(update)
      return input ? safeInvoke(invoke, IPC_CHANNELS.updateShellIntegrationPreference, parseShellIntegrationPreferences, input)
        : Promise.resolve(invalidInputFailure())
    },
    setDesktopLifecyclePreferences: (preferences: DesktopLifecyclePreferences) =>
      safeInvoke(invoke, IPC_CHANNELS.setDesktopLifecyclePreferences, parseDesktopLifecyclePreferences, preferences),
    getArknotePreferences: () =>
      safeInvoke(invoke, IPC_CHANNELS.getArknotePreferences, parseArknotePreferences),
    previewStickyNoteWallpaperAppearances: (appearances: StickyNoteWallpaperAppearances | null) =>
      safeInvoke(invoke, IPC_CHANNELS.previewStickyNoteWallpaperAppearances, parseWallpaperAppearances, appearances),
    setArknotePreferences: (preferences: ArknotePreferencesUpdate) =>
      safeInvoke(invoke, IPC_CHANNELS.setArknotePreferences, parseArknotePreferences, preferences),
    previewArknoteThemeColor: (themeColor: string) => isThemeColor(themeColor)
      ? safeInvoke(
          invoke, IPC_CHANNELS.previewArknoteThemeColor, parseNull,
          { themeColor: normalizeThemeColor(themeColor) },
        )
      : Promise.resolve(transportFailure()),
    getSystemFonts: () =>
      safeInvoke(invoke, IPC_CHANNELS.getSystemFonts, parseSystemFonts),
    getModelCapabilityRules: () => safeModelInvoke(invoke, IPC_CHANNELS.getModelCapabilityRules, parseModelCapabilityRulesState),
    setModelCapabilityRules: (rules: RuleFile | null) => rules === null || parseModelCapabilityRules(rules)
      ? safeModelInvoke(invoke, IPC_CHANNELS.setModelCapabilityRules, parseModelCapabilityRulesState, rules)
      : Promise.resolve(invalidInputFailure()),
    onModelCapabilityRulesChanged: (listener: (state: ModelCapabilityRulesState) => void) => modelCapabilityRulesTransport?.subscribe(payload => {
      const state = parseRulesState(payload)
      if (state) listener(state)
    }) ?? (() => undefined),
    getLargeModelSettings: () =>
      safeModelInvoke(invoke, IPC_CHANNELS.getLargeModelSettings, parseLargeModelSettings),
    getModelSettingsSnapshot: () => safeModelInvoke(invoke, IPC_CHANNELS.getModelSettingsSnapshot, modelResultParser(parsePublicModelSettingsSnapshot)),
    connectModel: (input: ConnectModelInput, observed: PublicModelSettingsSnapshot) => isConnectModelInput(input)
      ? observedModelInvoke(invoke, IPC_CHANNELS.connectModel, observed, modelResultParser(parsePublicModelMutation), { input })
      : Promise.resolve(invalidInputFailure()),
    listModels: (input: ListModelsInput, observed: PublicModelSettingsSnapshot) =>
      observedModelInvoke(invoke, IPC_CHANNELS.listModels, observed, parseObservedCatalog, { input }),
    testModel: (connectionId: string, observed: PublicModelSettingsSnapshot) => isCanonicalModelConnectionId(connectionId)
      ? observedModelInvoke(invoke, IPC_CHANNELS.testModel, observed, modelResultParser(parseObservedModelTestResult), { input: { connectionId } })
      : Promise.resolve(invalidInputFailure()),
    deleteModel: (connectionId: string, observed: PublicModelSettingsSnapshot) => isCanonicalModelConnectionId(connectionId)
      ? observedModelInvoke(invoke, IPC_CHANNELS.deleteModel, observed, modelResultParser(parsePublicModelMutation), { input: { connectionId } })
      : Promise.resolve(invalidInputFailure()),
    testCodexCliConnection: (observed: PublicModelSettingsSnapshot) =>
      observedModelInvoke(invoke, IPC_CHANNELS.testCodexCliConnection, observed, modelResultParser(parseObservedCodexTestResult)),
    startCodexCliLogin: (observed: PublicModelSettingsSnapshot) => observedModelInvoke(invoke, IPC_CHANNELS.startCodexCliLogin, observed, modelResultParser(parseObservedCodexLoginResult)),
    cancelCodexCliLogin: () => safeModelInvoke(invoke, IPC_CHANNELS.cancelCodexCliLogin, parseNull),
    removeCodexCliConnection: (observed: PublicModelSettingsSnapshot) =>
      observedModelInvoke(invoke, IPC_CHANNELS.removeCodexCliConnection, observed, modelResultParser(parsePublicModelMutation)),
    setAiConversationSettings: (input: ModelFeaturePatches['aiConversation'], observed: PublicModelSettingsSnapshot) => {
      const patch = parseModelFeaturePatch('aiConversation', input)
      return patch ? observedModelInvoke(invoke, IPC_CHANNELS.setAiConversationSettings, observed, modelResultParser(parsePublicModelMutation), { input: patch })
        : Promise.resolve(invalidInputFailure())
    },
    setSelectionTranslationSettings: (input: ModelFeaturePatches['selectionTranslation'], observed: PublicModelSettingsSnapshot) => {
      const patch = parseModelFeaturePatch('selectionTranslation', input)
      return patch ? observedModelInvoke(invoke, IPC_CHANNELS.setSelectionTranslationSettings, observed, modelResultParser(parsePublicModelMutation), { input: patch })
        : Promise.resolve(invalidInputFailure())
    },
    setScreenshotTranslationSettings: (input: ModelFeaturePatches['screenshotTranslation'], observed: PublicModelSettingsSnapshot) => {
      const patch = parseModelFeaturePatch('screenshotTranslation', input)
      return patch ? observedModelInvoke(invoke, IPC_CHANNELS.setScreenshotTranslationSettings, observed, modelResultParser(parsePublicModelMutation), { input: patch })
        : Promise.resolve(invalidInputFailure())
    },
    setFloatingTranslationSettings: (input: ModelFeaturePatches['floatingTranslation'], observed: PublicModelSettingsSnapshot) => {
      const patch = parseModelFeaturePatch('floatingTranslation', input)
      return patch ? observedModelInvoke(invoke, IPC_CHANNELS.setFloatingTranslationSettings, observed, modelResultParser(parsePublicModelMutation), { input: patch })
        : Promise.resolve(invalidInputFailure())
    },
    acceptTranslationPrivacyNotice: (observed: PublicModelSettingsSnapshot) =>
      observedModelInvoke(invoke, IPC_CHANNELS.acceptTranslationPrivacyNotice, observed, modelResultParser(parsePublicModelMutation)),
    startTranslation: (input: StartTranslationInput) => isStartTranslationInput(input)
      ? safeModelInvoke(invoke, IPC_CHANNELS.startTranslation, parseTranslationStarted, input)
      : Promise.resolve(invalidInputFailure()),
    cancelTranslation: (requestId: string) =>
      safeModelInvoke(invoke, IPC_CHANNELS.cancelTranslation, parseNull, { requestId }),
    startAiConversation: async (input: StartAiConversationInput): Promise<AiConversationStartResult> => {
      if (!isStrictStartAiConversationInput(input)) return invalidInputFailure()
      let raw: unknown
      try { raw = await invoke(IPC_CHANNELS.startAiConversation, input) }
      catch { return transportFailure() }
      const result = parseAiStartFailure(raw) ?? parseResponse(raw, parseAiConversationStarted) ?? invalidResponseFailure()
      if (result.ok && result.value.requestId !== input.requestId) {
        return invalidResponseFailure()
      }
      return result
    },
    cancelAiConversation: (input: { requestId: string }) =>
      isExactOwnRecord(input, ['requestId']) && isCanonicalAiConversationRequestId(input.requestId)
        ? safeModelInvoke(
            invoke,
            IPC_CHANNELS.cancelAiConversation,
            parseNull,
            { requestId: input.requestId },
          )
        : Promise.resolve(invalidInputFailure()),
    getAiWorkspaceState: () => safeModelInvoke(
      invoke, IPC_CHANNELS.getAiWorkspaceState, parseAiWorkspaceState,
    ),
    setAiConversationCapabilities: (input: SetAiConversationCapabilitiesInput) => isSetAiConversationCapabilitiesInput(input)
      ? safeModelInvoke(invoke, IPC_CHANNELS.setAiConversationCapabilities, parseNull, input)
      : Promise.resolve(invalidInputFailure()),
    submitAiAuthorizationResult: (input: SubmitAiAuthorizationResultInput) => isSubmitAiAuthorizationResultInput(input)
      ? safeModelInvoke(invoke, IPC_CHANNELS.submitAiAuthorizationResult, parseNull, input)
      : Promise.resolve(invalidInputFailure()),
    clearAiConversation: (input: ClearAiConversationInput) => isClearAiConversationInput(input)
      ? safeModelInvoke(invoke, IPC_CHANNELS.clearAiConversation, parseNull, input)
      : Promise.resolve(invalidInputFailure()),
    notifyAiCurrentDocumentChanged: (input: AiWorkspaceState) => isAiWorkspaceStateInput(input)
      ? safeModelInvoke(invoke, IPC_CHANNELS.notifyAiCurrentDocumentChanged, parseNull, input)
      : Promise.resolve(invalidInputFailure()),
    registerAiCurrentDocumentPort: async (port: AiCurrentDocumentRendererPort) => {
      if (!isCurrentDocumentRendererPort(port) || !aiRendererPortTransport) {
        return invalidInputFailure()
      }
      if (currentDocumentPortTransition) return transportFailure()
      currentDocumentPortTransition = true
      try {
        let attachment: { commit(): void; rollback(): void; detach(): void }
        try { attachment = aiRendererPortTransport.attachCurrentDocumentPort(port) } catch {
          return transportFailure()
        }
        const result = await safeModelInvoke(
          invoke,
          IPC_CHANNELS.registerAiCurrentDocumentPort,
          parseAiCurrentDocumentPortRegistration,
        )
        if (!result.ok) {
          try { attachment.rollback() } catch { /* attachment never owns failure reporting */ }
          return result
        }
        const previous = detachCurrentDocumentPort
        try { attachment.commit() } catch {
          await safeModelInvoke(
            invoke, IPC_CHANNELS.unregisterAiCurrentDocumentPort, parseNull,
          )
          try { attachment.rollback() } catch { /* main compensation remains authoritative */ }
          detachCurrentDocumentPort = undefined
          try { previous?.() } catch { /* both main and preload are now unregistered */ }
          return transportFailure()
        }
        detachCurrentDocumentPort = () => attachment.detach()
        try { previous?.() } catch { /* the new port remains authoritative */ }
        return result
      } finally {
        currentDocumentPortTransition = false
      }
    },
    unregisterAiCurrentDocumentPort: async () => {
      if (currentDocumentPortTransition) return transportFailure()
      currentDocumentPortTransition = true
      try {
        const result = await safeModelInvoke(
          invoke, IPC_CHANNELS.unregisterAiCurrentDocumentPort, parseNull,
        )
        if (result.ok) {
          const detach = detachCurrentDocumentPort
          detachCurrentDocumentPort = undefined
          try { detach?.() } catch { /* main already unregistered */ }
        }
        return result
      } finally {
        currentDocumentPortTransition = false
      }
    },
    registerAiOpenDocumentPort: async (port: AiOpenDocumentRendererPort) => {
      if (!isOpenDocumentRendererPort(port) || !aiRendererPortTransport) {
        return invalidInputFailure()
      }
      let attachment: { bind(documentHandle: string): void; detach(): void }
      try { attachment = aiRendererPortTransport.attachOpenDocumentPort(port) } catch {
        return transportFailure()
      }
      const result = await safeModelInvoke(
        invoke,
        IPC_CHANNELS.registerAiOpenDocumentPort,
        parseAiOpenDocumentPortRegistration,
      )
      if (!result.ok) {
        try { attachment.detach() } catch { /* attachment never owns failure reporting */ }
        return result
      }
      try {
        attachment.bind(result.value.documentHandle)
      } catch {
        try { attachment.detach() } catch { /* original bind failure wins */ }
        void safeModelInvoke(
          invoke,
          IPC_CHANNELS.unregisterAiOpenDocumentPort,
          parseNull,
          { documentHandle: result.value.documentHandle },
        )
        return transportFailure()
      }
      openDocumentPortAttachments.set(result.value.documentHandle, attachment)
      return result
    },
    unregisterAiOpenDocumentPort: async (documentHandle: string) => {
      if (!isCanonicalAiConversationRequestId(documentHandle)) return invalidInputFailure()
      const result = await safeModelInvoke(
        invoke,
        IPC_CHANNELS.unregisterAiOpenDocumentPort,
        parseNull,
        { documentHandle },
      )
      if (result.ok) {
        const attachment = openDocumentPortAttachments.get(documentHandle)
        openDocumentPortAttachments.delete(documentHandle)
        try { attachment?.detach() } catch { /* main already unregistered */ }
      }
      return result
    },
    openAiMessageLink: (target: string) => {
      const parsedTarget = parseAiMessageLinkTarget(target)
      if (!parsedTarget) return Promise.resolve(invalidInputFailure())
      const normalized = parsedTarget.kind === 'web' ? parsedTarget.url : parsedTarget.path
      return safeModelInvoke(
        invoke,
        IPC_CHANNELS.openAiMessageLink,
        parseAiMessageLinkAuditTarget,
        { target: normalized },
      )
    },
    updateScreenshotCapturePointer: (input: import('../shared/screenshot-translation').ScreenshotCapturePointerInput) => {
      const parsed = parseScreenshotCapturePointerInput(input)
      return parsed
        ? safeInvoke(invoke, IPC_CHANNELS.updateScreenshotCapturePointer, parseScreenshotWindowHit, parsed)
        : Promise.resolve(invalidInputFailure())
    },
    readyScreenshotCapture: (input: import('../shared/screenshot-translation').ScreenshotCaptureReadyInput) => {
      const parsed = parseScreenshotCaptureReadyInput(input)
      return parsed
        ? safeInvoke(invoke, IPC_CHANNELS.readyScreenshotCapture, parseNull, parsed)
        : Promise.resolve(invalidInputFailure())
    },
    commitScreenshotCapture: (input: import('../shared/screenshot-translation').ScreenshotCaptureCommitInput) => {
      const parsed = parseScreenshotCaptureCommitInput(input)
      return parsed ? safeInvoke(invoke, IPC_CHANNELS.commitScreenshotCapture, parseNull, parsed) : Promise.resolve(invalidInputFailure())
    },
    cancelScreenshotCapture: (input: import('../shared/screenshot-translation').ScreenshotSessionInput) => {
      const parsed = parseScreenshotSessionInput(input)
      return parsed ? safeInvoke(invoke, IPC_CHANNELS.cancelScreenshotCapture, parseNull, parsed) : Promise.resolve(invalidInputFailure())
    },
    onScreenshotCaptureEvent: (handler: (event: ScreenshotCaptureEvent) => void) =>
      screenshotCaptureEventTransport?.subscribe((payload) => {
        const event = parseScreenshotCaptureEvent(payload)
        if (event) handler(event)
      }) ?? (() => undefined),
    submitScreenshotOcr: (input: import('../shared/screenshot-translation').ScreenshotOcrSubmission) => {
      const parsed = parseScreenshotOcrSubmission(input)
      return parsed
        ? safeInvoke(invoke, IPC_CHANNELS.submitScreenshotOcr, parseNull, parsed)
        : Promise.resolve(invalidInputFailure())
    },
    settleScreenshotOcr: (input: import('../shared/screenshot-translation').ScreenshotTranslationGenerationInput) => {
      const parsed = parseScreenshotTranslationGenerationInput(input)
      return parsed
        ? safeInvoke(invoke, IPC_CHANNELS.settleScreenshotOcr, parseNull, parsed)
        : Promise.resolve(invalidInputFailure())
    },
    startScreenshotTranslation: (input: import('../shared/screenshot-translation').ScreenshotTranslationGenerationInput) => {
      const parsed = parseScreenshotTranslationGenerationInput(input)
      return parsed
        ? safeInvoke(invoke, IPC_CHANNELS.startScreenshotTranslation, parseScreenshotTranslationGenerationResult, parsed)
        : Promise.resolve(invalidInputFailure())
    },
    cancelScreenshotTranslation: (input: import('../shared/screenshot-translation').ScreenshotTranslationGenerationInput) => {
      const parsed = parseScreenshotTranslationGenerationInput(input)
      return parsed ? safeInvoke(invoke, IPC_CHANNELS.cancelScreenshotTranslation, parseNull, parsed) : Promise.resolve(invalidInputFailure())
    },
    minimizeScreenshotTranslation: (input: import('../shared/screenshot-translation').ScreenshotTranslationGenerationInput) => {
      const parsed = parseScreenshotTranslationGenerationInput(input)
      return parsed ? safeInvoke(invoke, IPC_CHANNELS.minimizeScreenshotTranslation, parseNull, parsed) : Promise.resolve(invalidInputFailure())
    },
    closeScreenshotTranslation: (input: import('../shared/screenshot-translation').ScreenshotTranslationGenerationInput) => {
      const parsed = parseScreenshotTranslationGenerationInput(input)
      return parsed ? safeInvoke(invoke, IPC_CHANNELS.closeScreenshotTranslation, parseNull, parsed) : Promise.resolve(invalidInputFailure())
    },
    openScreenshotTranslationSettings: (input: import('../shared/screenshot-translation').ScreenshotTranslationGenerationInput) => {
      const parsed = parseScreenshotTranslationGenerationInput(input)
      return parsed ? safeInvoke(invoke, IPC_CHANNELS.openScreenshotTranslationSettings, parseNull, parsed) : Promise.resolve(invalidInputFailure())
    },
    onScreenshotTranslationEvent: (handler: (event: ScreenshotTranslationEvent) => void) =>
      screenshotTranslationEventTransport?.subscribe((payload) => {
        const event = parseScreenshotTranslationEvent(payload)
        if (event) handler(event)
      }) ?? (() => undefined),
    getScreenshotOcrModelState: () =>
      safeInvoke<import('../shared/screenshot-ocr-models').ObservedScreenshotOcrState>(invoke, SCREENSHOT_OCR_MODEL_CHANNELS.getState, value => {
        const result = parseObservedScreenshotOcrState(value); return result ? parsed(result) : invalid()
      }),
    downloadScreenshotOcrMedium: (input: ObservedOcrPreference) => {
      const observed = parseObservedOcrPreference(input)
      return observed ? safeInvoke<ScreenshotOcrMutationResult>(invoke, SCREENSHOT_OCR_MODEL_CHANNELS.downloadMedium, value => {
        const result = parseScreenshotOcrMutationResult(value); return result ? parsed(result) : invalid()
      }, observed) : Promise.resolve(invalidInputFailure())
    },
    cancelScreenshotOcrMediumDownload: () =>
      safeInvoke(invoke, SCREENSHOT_OCR_MODEL_CHANNELS.cancelMediumDownload, parseScreenshotOcrModelState),
    removeScreenshotOcrMedium: (input: ObservedOcrPreference) => {
      const observed = parseObservedOcrPreference(input)
      return observed ? safeInvoke<ScreenshotOcrMutationResult>(invoke, SCREENSHOT_OCR_MODEL_CHANNELS.removeMedium, value => {
        const result = parseScreenshotOcrMutationResult(value); return result ? parsed(result) : invalid()
      }, observed) : Promise.resolve(invalidInputFailure())
    },
    onScreenshotOcrModelState: (listener: (state: ScreenshotOcrModelState) => void) =>
      screenshotOcrModelStateTransport?.subscribe((payload) => {
        const state = parseScreenshotOcrModelState(payload)
        if (state.valid) listener(state.value)
      }) ?? (() => undefined),
    onScreenshotOcrHostCommand: (listener: (command: import('../shared/screenshot-translation').ScreenshotOcrHostCommand) => void) =>
      screenshotOcrHostEventTransport?.subscribe((payload) => {
        const command = parseScreenshotOcrHostCommand(payload)
        if (command) listener(command)
      }) ?? (() => undefined),
    searchSelection: (query: string) =>
      safeInvoke(invoke, IPC_CHANNELS.searchSelection, parseNull, { query }),
    openExternal: (target: string) =>
      safeInvoke(invoke, IPC_CHANNELS.openExternal, parseNull, { target }),
    revealImage: (source: string) =>
      safeInvoke(invoke, IPC_CHANNELS.revealImage, parseNull, { source }),
    copyImage: (source: string) =>
      safeInvoke(invoke, IPC_CHANNELS.copyImage, parseNull, { source }),
    saveImageCopy: (source: string) =>
      safeInvoke(invoke, IPC_CHANNELS.saveImageCopy, parseNullableAbsolutePath, { source }),
    copyImageTo: (source: string) =>
      safeInvoke(invoke, IPC_CHANNELS.copyImageTo, parseNullableAbsolutePath, { source }),
    copyMermaidImage: (pngDataUrl: string) => (
      isMermaidPngDataUrl(pngDataUrl)
        ? safeInvoke(invoke, IPC_CHANNELS.copyMermaidImage, parseNull, { pngDataUrl })
        : Promise.resolve(invalidInputFailure())
    ),
    openMermaidViewer: (input: MermaidViewerSnapshot) => {
      const snapshot = parseMermaidViewerSnapshot(input)
      return snapshot
        ? safeInvoke(invoke, IPC_CHANNELS.openMermaidViewer, parseNull, snapshot)
        : Promise.resolve(invalidInputFailure())
    },
    getMermaidViewerSnapshot: () => safeInvoke<MermaidViewerSnapshot>(invoke, IPC_CHANNELS.getMermaidViewerSnapshot, value => {
      const snapshot = parseMermaidViewerSnapshot(value)
      return snapshot ? parsed(snapshot) : invalid()
    }),
    saveMermaidImage: (input: MermaidImageExportInput) => {
      const parsedInput = parseMermaidImageExportInput(input)
      return parsedInput
        ? safeInvoke(invoke, IPC_CHANNELS.saveMermaidImage, parseNull, parsedInput)
        : Promise.resolve(invalidInputFailure())
    },
    createWorkspaceFolder: (parentRelativePath: string, name: string) =>
      safeInvoke(invoke, IPC_CHANNELS.createWorkspaceFolder, parseTreeEntry, { parentRelativePath, name }),
    renameWorkspaceEntry: (relativePath: string, newName: string) =>
      safeInvoke(
        invoke,
        IPC_CHANNELS.renameWorkspaceEntry,
        parseWorkspaceEntryRenameResult,
        { relativePath, newName },
      ),
    duplicateWorkspaceDocument: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.duplicateWorkspaceDocument, parseTreeEntry, { relativePath }),
    trashWorkspaceEntry: (relativePath: string) =>
      safeInvoke(
        invoke,
        IPC_CHANNELS.trashWorkspaceEntry,
        parseWorkspaceEntryTrashResult,
        { relativePath },
      ),
    revealWorkspaceEntry: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.revealWorkspaceEntry, parseNull, { relativePath }),
    openWorkspaceEntryWindow: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.openWorkspaceEntryWindow, parseNull, { relativePath }),
    getWorkspaceEntryProperties: (relativePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.getWorkspaceEntryProperties, parseWorkspaceEntryProperties, { relativePath }),
    getWorkspaceRootProperties: () =>
      safeInvoke(invoke, IPC_CHANNELS.getWorkspaceRootProperties, parseWorkspaceEntryProperties),
    getWorkspaceColorMarks: () =>
      safeInvoke(invoke, IPC_CHANNELS.getWorkspaceColorMarks, parseWorkspaceColorMarks),
    setWorkspaceColorMark: (relativePath: string, color: WorkspaceColorId | null) => {
      const canonicalPath = canonicalWorkspaceColorPath(relativePath)
      return canonicalPath && (color === null || isWorkspaceColorId(color))
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.setWorkspaceColorMark,
            parseWorkspaceColorMarks,
            { relativePath: canonicalPath, color },
          )
        : Promise.resolve(invalidInputFailure())
    },
    moveWorkspaceColorMark: (fromRelativePath: string, toRelativePath: string) => {
      const from = canonicalWorkspaceColorPath(fromRelativePath)
      const to = canonicalWorkspaceColorPath(toRelativePath)
      return from && to
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.moveWorkspaceColorMark,
            parseWorkspaceColorMarks,
            { fromRelativePath: from, toRelativePath: to },
          )
        : Promise.resolve(invalidInputFailure())
    },
    deleteWorkspaceColorMarks: (relativePath: string) => {
      const canonicalPath = canonicalWorkspaceColorPath(relativePath)
      return canonicalPath
        ? safeInvoke(
            invoke,
            IPC_CHANNELS.deleteWorkspaceColorMarks,
            parseWorkspaceColorMarks,
            { relativePath: canonicalPath },
          )
        : Promise.resolve(invalidInputFailure())
    },
    openApplicationMenu: (section: AppMenuSectionId, x: number, y: number) =>
      safeInvoke(invoke, IPC_CHANNELS.openApplicationMenu, parseNull, { section, x, y }),
    executeApplicationMenuItem: (itemId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.executeApplicationMenuItem, parseNull, { itemId }),
    recordRecentDocument: (absolutePath: string) =>
      safeInvoke(
        invoke, IPC_CHANNELS.recordRecentDocument, parseRecentDocumentPaths, { absolutePath },
      ),
    updateApplicationMenuWindowState: (state: ApplicationMenuWindowState) =>
      safeInvoke(invoke, IPC_CHANNELS.updateApplicationMenuWindowState, parseVoid, state),
    onApplicationMenuChanged: (listener: (model: readonly ApplicationMenuSection[]) => void) =>
      applicationMenuChangedTransport?.subscribe((payload) => {
        const model = parseApplicationMenuModel(payload)
        if (model.valid) listener(model.value)
      }) ?? (() => undefined),
    onEditorAppearancePreferencesChanged: (
      listener: (snapshot: EditorAppearanceSnapshot) => void,
    ) => editorAppearanceChangedTransport?.subscribe((payload) => {
      const snapshot = parseEditorAppearanceSnapshot(payload)
      if (snapshot.valid) listener(snapshot.value)
    }) ?? (() => undefined),
    onLayoutPreferencesChanged: (listener: (snapshot: LayoutPreferencesSnapshot) => void) =>
      layoutPreferencesChangedTransport?.subscribe((payload) => {
        const snapshot = parseLayoutPreferencesSnapshot(payload)
        if (snapshot.valid) listener(snapshot.value)
      }) ?? (() => undefined),
    openBackgroundSettings: (target: BackgroundTarget) => {
      const parsedTarget = parseBackgroundTarget(target)
      return parsedTarget.valid
        ? safeInvoke(invoke, IPC_CHANNELS.openBackgroundSettings, parseNull, parsedTarget.value)
        : Promise.resolve(invalidInputFailure())
    },
    getBackgroundPresentation: (target: BackgroundTarget) => {
      const parsedTarget = parseBackgroundTarget(target)
      return parsedTarget.valid
        ? safeInvoke(invoke, IPC_CHANNELS.getBackgroundPresentation, parseBackgroundPresentation, parsedTarget.value)
        : Promise.resolve(invalidInputFailure())
    },
    chooseBackgroundImage: (target: BackgroundTarget) => {
      const parsedTarget = parseBackgroundTarget(target)
      return parsedTarget.valid
        ? safeInvoke(invoke, IPC_CHANNELS.chooseBackgroundImage, parseNullableBackgroundPresentation, parsedTarget.value)
        : Promise.resolve(invalidInputFailure())
    },
    removeBackgroundImage: (target: BackgroundTarget) => {
      const parsedTarget = parseBackgroundTarget(target)
      return parsedTarget.valid
        ? safeInvoke(invoke, IPC_CHANNELS.removeBackgroundImage, parseBackgroundPresentation, parsedTarget.value)
        : Promise.resolve(invalidInputFailure())
    },
    previewBackground: (target: BackgroundTarget, settings: BackgroundSettings) => {
      const parsedTarget = parseBackgroundTarget(target)
      const parsedSettings = parseBackgroundSettingsPayload(settings)
      return parsedTarget.valid && parsedSettings.valid
        ? safeInvoke(invoke, IPC_CHANNELS.previewBackground, parseNull, {
            target: parsedTarget.value,
            settings: parsedSettings.value,
          })
        : Promise.resolve(invalidInputFailure())
    },
    applyBackground: (target: BackgroundTarget, settings: BackgroundSettings) => {
      const parsedTarget = parseBackgroundTarget(target)
      const parsedSettings = parseBackgroundSettingsPayload(settings)
      return parsedTarget.valid && parsedSettings.valid
        ? safeInvoke(invoke, IPC_CHANNELS.applyBackground, parseBackgroundApplyResult, {
            target: parsedTarget.value,
            settings: parsedSettings.value,
          })
        : Promise.resolve(invalidInputFailure())
    },
    cancelBackgroundSettings: (target: BackgroundTarget) => {
      const parsedTarget = parseBackgroundTarget(target)
      return parsedTarget.valid
        ? safeInvoke(invoke, IPC_CHANNELS.cancelBackgroundSettings, parseNull, parsedTarget.value)
        : Promise.resolve(invalidInputFailure())
    },
    onBackgroundPresentation: (listener: (event: BackgroundPresentationEvent) => void) =>
      backgroundPresentationEventTransport?.subscribe((payload) => {
        const event = parseBackgroundPresentationEvent(payload)
        if (event.valid) listener(event.value)
      }) ?? (() => undefined),
    printDocument: (input: PrintDocumentInput) => {
      const parsedInput = parsePrintDocumentInput(input)
      return parsedInput
        ? safeInvoke(invoke, IPC_CHANNELS.printDocument, parseNull, parsedInput)
        : Promise.resolve(invalidInputFailure())
    },
    takePrintDocument: (token: string) => isPrintDocumentToken(token)
      ? safeInvoke(invoke, IPC_CHANNELS.takePrintDocument, parsePrintSurfaceDocument, { token })
      : Promise.resolve(invalidInputFailure()),
    readyPrintDocument: (token: string) => isPrintDocumentToken(token)
      ? safeInvoke(invoke, IPC_CHANNELS.readyPrintDocument, parseNull, { token })
      : Promise.resolve(invalidInputFailure()),
    connectArknote: () => safeInvoke(invoke, IPC_CHANNELS.connectArknote, parseNull),
    listStickyNotes: (status: StickyNoteStatus) =>
      safeInvoke(invoke, IPC_CHANNELS.listStickyNotes, parseStickyNoteSummaries, { status }),
    reorderStickyNotes: (noteIds: readonly string[]) =>
      safeInvoke(invoke, IPC_CHANNELS.reorderStickyNotes, parseStickyNoteSummaries, { noteIds }),
    searchStickyNotes: (status: StickyNoteStatus, query: string) =>
      safeInvoke(
        invoke, IPC_CHANNELS.searchStickyNotes, parseStickyNoteSearchResults, { status, query },
      ),
    readStickyNote: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.readStickyNote, parseStickyNoteReadDocument, { noteId }),
    createStickyNote: (input: CreateStickyNoteInput) =>
      safeInvoke(invoke, IPC_CHANNELS.createStickyNote, parseStickyNoteDocument, input),
    renameStickyNote: (noteId: string, name: string) =>
      safeInvoke(invoke, IPC_CHANNELS.renameStickyNote, parseStickyNoteDocument, { noteId, name }),
    archiveStickyNote: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.archiveStickyNote, parseStickyNoteDocument, { noteId }),
    restoreStickyNote: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.restoreStickyNote, parseStickyNoteDocument, { noteId }),
    restoreArchivedStickyNotes: (noteIds: readonly string[]) =>
      safeInvoke(invoke, IPC_CHANNELS.restoreArchivedStickyNotes, parseNull, { noteIds }),
    deleteStickyNote: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.deleteStickyNote, parseNull, { noteId }),
    deleteArchivedStickyNotes: (noteIds: readonly string[]) =>
      safeInvoke(invoke, IPC_CHANNELS.deleteArchivedStickyNotes, parseNull, { noteIds }),
    importStickyNote: (absolutePath: string) =>
      safeInvoke(
        invoke, IPC_CHANNELS.importStickyNote, parseStickyNoteImportResult, { absolutePath },
      ),
    importStickyNoteSelection: (input: StickyNoteSelectionImportInput) =>
      safeInvoke(
        invoke, IPC_CHANNELS.importStickyNoteSelection, parseStickyNoteImportResult, input,
      ),
    stageStickyNoteSave: (noteId: string, markdown: string) =>
      safeInvoke(invoke, IPC_CHANNELS.stageStickyNoteSave, parseNull, { noteId, markdown }),
    flushStickyNoteSave: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.flushStickyNoteSave, parseStickyNoteSaveState, { noteId }),
    openStickyNote: (noteId: string, query?: string) =>
      safeInvoke(
        invoke,
        IPC_CHANNELS.openStickyNote,
        parseNull,
        query === undefined ? { noteId } : { noteId, query },
      ),
    closeStickyNote: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.closeStickyNote, parseNull, { noteId }),
    releaseStickyNote: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.releaseStickyNote, parseNull, { noteId }),
    reclaimStickyNote: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.reclaimStickyNote, parseNull, { noteId }),
    setStickyNotePinned: (noteId: string, pinned: boolean) =>
      safeInvoke(invoke, IPC_CHANNELS.setStickyNotePinned, parseNull, { noteId, pinned }),
    setStickyNoteStyle: (noteId: string, style: StickyNoteStyleReference) =>
      safeInvoke(invoke, IPC_CHANNELS.setStickyNoteStyle, parseStickyNoteRecord, { noteId, style }),
    setStickyNoteFontSize: (noteId: string, fontSizePx: number) =>
      safeInvoke(invoke, IPC_CHANNELS.setStickyNoteFontSize, parseNull, { noteId, fontSizePx }),
    setStickyNoteLineSpacingMode: (noteId: string, lineSpacingMode: 'compact' | 'standard') =>
      safeInvoke(invoke, IPC_CHANNELS.setStickyNoteLineSpacingMode, parseNull, { noteId, lineSpacingMode }),
    chooseStickyNoteImage: (noteId: string) =>
      safeInvoke(invoke, IPC_CHANNELS.chooseStickyNoteImage, parseNullableStickyNoteImageMarkdown, { noteId }),
    copyStickyNoteImage: (noteId: string, absolutePath: string) =>
      safeInvoke(invoke, IPC_CHANNELS.copyStickyNoteImage, parseStickyNoteImageMarkdown, { noteId, absolutePath }),
    resizeStickyNoteToContent: (
      noteId: string,
      measurement: StickyNoteContentMeasurement,
    ) => safeInvoke(
      invoke, IPC_CHANNELS.resizeStickyNoteToContent, parseNull, { noteId, measurement },
    ),
    openStickyNoteContextMenu: (input: StickyNoteContextMenuOpenInput) => {
      const parsed = parseStickyNoteContextMenuOpenInput(input)
      return parsed
        ? safeInvoke(invoke, STICKY_NOTE_CONTEXT_MENU_CHANNELS.open, parseNull, parsed)
        : Promise.resolve(transportFailure())
    },
    closeStickyNoteContextMenu: (requestId: string) => {
      const parsed = parseStickyNoteContextMenuClosed({ requestId })
      return parsed
        ? safeInvoke(invoke, STICKY_NOTE_CONTEXT_MENU_CHANNELS.close, parseNull, parsed)
        : Promise.resolve(transportFailure())
    },
    readyStickyNoteContextMenu: (requestId: string) => {
      const parsed = parseStickyNoteContextMenuReady({ requestId })
      return parsed
        ? safeInvoke(invoke, STICKY_NOTE_CONTEXT_MENU_CHANNELS.ready, parseNull, parsed)
        : Promise.resolve(transportFailure())
    },
    executeStickyNoteContextMenuCommand: (command: StickyNoteContextMenuCommand) => {
      const parsed = parseStickyNoteContextMenuCommand(command)
      return parsed
        ? safeInvoke(invoke, STICKY_NOTE_CONTEXT_MENU_CHANNELS.execute, parseNull, parsed)
        : Promise.resolve(transportFailure())
    },
    onStickyNoteContextMenuShow: (handler: (payload: StickyNoteContextMenuShowPayload) => void) =>
      stickyNoteContextMenuShowTransport?.subscribe((payload) => {
        const parsed = parseStickyNoteContextMenuShowPayload(payload)
        if (parsed) handler(parsed)
      }) ?? (() => {}),
    onStickyNoteContextMenuCommand: (handler: (command: StickyNoteContextMenuCommand) => void) =>
      stickyNoteContextMenuCommandTransport?.subscribe((payload) => {
        const parsed = parseStickyNoteContextMenuCommand(payload)
        if (parsed) handler(parsed)
      }) ?? (() => {}),
    onStickyNoteContextMenuClosed: (handler: (event: { requestId: string }) => void) =>
      stickyNoteContextMenuClosedTransport?.subscribe((payload) => {
        const parsed = parseStickyNoteContextMenuClosed(payload)
        if (parsed) handler(parsed)
      }) ?? (() => {}),
    onStickyNoteContextMenuReset: (handler: (event: { requestId: string }) => void) =>
      stickyNoteContextMenuResetTransport?.subscribe((payload) => {
        const parsed = parseStickyNoteContextMenuReset(payload)
        if (parsed) handler(parsed)
      }) ?? (() => {}),
    onStickyNoteMaterialEffectsChanged: (handler: (effects: StickyNoteMaterialEffects) => void) =>
      stickyNoteMaterialEffectsTransport?.subscribe((payload) => {
        const effects = parseStickyNoteMaterialEffects(payload)
        if (effects) handler(effects)
      }) ?? (() => {}),
    onStickyNoteEvent: (handler: (event: StickyNoteEvent) => void) =>
      stickyNoteEventTransport?.subscribe((payload) => {
        const event = parseStickyNoteEvent(payload)
        if (event) handler(event)
      }) ?? (() => {}),
    onArknoteServiceEvent: (handler: (event: ArknoteServiceEvent) => void) =>
      arknoteServiceEventTransport?.subscribe((payload) => {
        const event = parseArknoteServiceEvent(payload)
        if (event) handler(event)
      }) ?? (() => {}),
    onArknoteThemeColorChanged: (handler: (themeColor: string) => void) =>
      stickyNoteEventTransport?.subscribe((payload) => {
        const event = parseArknoteThemeColorEvent(payload)
        if (event) handler(event.themeColor)
      }) ?? (() => {}),
    onDocumentLocation: (handler: (intent: DocumentLocationIntent) => void) => documentLocationTransport?.subscribe((payload) => {
      const intent = parseDocumentLocationIntent(payload)
      if (intent) handler(intent)
    }) ?? (() => {}),
    onOpenIntent: (handler: (intent: DroppedPathResult) => void) => openIntentTransport?.subscribe((payload) => {
      const parsedIntent = parseDroppedPathResult(payload)
      if (parsedIntent.valid) handler(parsedIntent.value)
    }) ?? (() => {}),
    onImportDocxIntent: (handler: (intent: ImportDocxIntent) => void) => importDocxIntentTransport?.subscribe((payload) => {
      const parsedIntent = parseImportDocxIntent(payload)
      if (parsedIntent.valid) handler(parsedIntent.value)
    }) ?? (() => {}),
    onRecoverDraft: (handler: (intent: RecoveryIntent) => void) => recoveryIntentTransport?.subscribe((payload) => {
      const parsedIntent = parseRecoveryIntent(payload)
      if (parsedIntent.valid) handler(parsedIntent.value)
    }) ?? (() => {}),
    onMenuCommand: (handler: (command: MenuCommand) => void) => menuTransport?.subscribe((payload) => {
      if (isMenuCommand(payload)) handler(payload)
    }) ?? (() => {}),
    onTranslationEvent: (handler: (event: TranslationEvent) => void) =>
      translationEventTransport?.subscribe((payload) => {
        const event = parseTranslationEvent(payload)
        if (event) handler(event)
      }) ?? (() => {}),
    onAiConversationEvent: (handler: (event: AiConversationEvent) => void) =>
      aiConversationEventTransport?.subscribe((payload) => {
        const event = parseAiConversationEvent(payload)
        if (event) handler(event)
      }) ?? (() => {}),
    onPrepareClose: (handler: () => Promise<boolean>) => {
      prepareCloseHandler = handler
      return () => {
        if (prepareCloseHandler === handler) prepareCloseHandler = null
      }
    },
    ...(structuredClose ?? {}),
  })
}

function parseModelCapabilityRulesState(value: unknown): Parsed<ModelCapabilityRulesState> {
  const result = parseRulesState(value)
  return result ? parsed(result) : invalid()
}
