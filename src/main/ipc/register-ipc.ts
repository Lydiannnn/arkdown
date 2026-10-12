import { parseFloatingTranslationPatch } from '../../shared/large-model-settings'
import { parseUpdateAction } from '../../shared/update-transfer'
import { parseModelFeaturePatch, parseModelObservationRequest, parseObservedModelCommand } from '../../shared/model-settings-commands'
import type { TransactionalModelConnectionService } from '../models/transactional-model-connection-service'
import type { TransactionalCodexConnectionService } from '../codex/transactional-codex-connection-service'
import { PREFERENCE_GROUPS, parsePreferencePatchInput } from '../../shared/preference-observation'
import type { SettingsPreferenceService } from '../settings/settings-preference-service'
import { isFeatureModelConnectionId, featureModelConnections } from '../../shared/large-model-settings'
import type { ModelCapabilityRulesStore } from '../models/model-capability-rules-store'
import { parseObservedShortcutSnapshot, parseObservedShortcutUpdate, parseObservedShortcutUpdateResult,
  type ObservedShortcutSnapshot, type ObservedShortcutUpdate, type ObservedShortcutUpdateResult } from '../../shared/keyboard-shortcuts'
import { parseModelCapabilityRules, parseModelThinkingCapability } from '../../shared/model-capability-rules'
import { parseStickyNoteWallpaperAppearances, type StickyNoteWallpaperAppearances } from '../../shared/sticky-note-glass-appearance'
import { parseObservedShellIntegrationUpdate, parseShellIntegrationSnapshot } from '../../shared/shell-integration-preferences'
import type { ShellIntegrationService } from '../shell-integration/service'
import type { DefaultApplicationsService } from '../default-applications/service'
import path from 'node:path'
import { workspacePickerDefaultPath } from '../workspace/workspace-picker-state'
import type { WorkspaceFileDrag } from '../workspace/workspace-file-drag'
import { createHash, randomUUID } from 'node:crypto'
import { isProxy } from 'node:util/types'
import { z } from 'zod'
import {
  IPC_CHANNELS,
  DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
  DOCUMENT_CONVERSION_IPC_CHANNELS,
  SCREENSHOT_OCR_MODEL_CHANNELS,
  type ApiResult,
  type ClipboardFormatsSnapshot,
  type DocumentSnapshot,
  type SaveDocumentAsInput,
  type SaveDocumentInput,
  type SaveDocumentResult,
  type SaveDraftInput,
  type WindowControlAction,
  type WindowStateSnapshot,
} from '../../shared/contracts'
import type { ApplicationMenuWindowState } from '../../shared/application-menu-model'
import {
  isPrintDocumentToken,
  parsePrintDocumentInput,
  type PrintDocumentInput,
  type PrintSurfaceDocumentInput,
} from '../../shared/printing'
import {
  isCanonicalModelConnectionId,
  isSafeModelBaseUrl,
  MODEL_BASE_URL_MAX_LENGTH,
  MODEL_CONNECTION_NAME_MAX_LENGTH,
  MODEL_ID_MAX_LENGTH,
  parseModelCapabilityOverride,
  type AiConversationSettings,
  type LargeModelSettings,
  type ModelCapabilityOverride,
} from '../../shared/large-model-settings'
import type {
  ConnectModelInput,
  FeatureSettingsInput,
  ListModelsInput,
  ModelConnectionService,
} from '../models/model-connection-service'
import type { CodexCliConnectionService } from '../codex/codex-cli-connection-service'
import type { CodexCliLoginOutcome } from '../../shared/codex-cli-login'
import { ModelProtocolError } from '../models/model-errors'
import { ModelSecretVaultError } from '../models/model-secret-vault'
import type { TranslationSessionService } from '../models/translation-session-service'
import type {
  AiConversationSessionService,
  AiWorkspaceSwitchTicket,
} from '../models/ai-conversation-session-service'
import {
  isCanonicalAiConversationId,
  isCanonicalAiConversationRequestId,
  isStartAiConversationInput,
  type StartAiConversationInput,
} from '../../shared/ai-conversation'
import type {
  RendererCurrentDocumentPort,
  RendererCurrentDocumentPortRegistration,
  WindowAiWorkspaceAuthority,
} from '../documents/window-ai-current-document-broker'
import type {
  OpenDocumentAuthority,
  OpenDocumentDestinationGuard,
  OpenDocumentEditorPort,
  OpenDocumentRegistration,
  OpenDocumentRegistry,
} from '../documents/open-document-registry'
import type { CanonicalFileIdentity } from '../documents/document-identity'
import type {
  WorkspaceAiEditorTarget,
} from '../documents/workspace-ai-editor-boundary'
import {
  isCanonicalTranslationRequestId,
  isStartTranslationInput,
  type StartTranslationInput,
} from '../../shared/selection-translation'
import {
  parseScreenshotCaptureCommitInput,
  parseScreenshotCapturePointerInput,
  parseScreenshotCaptureReadyInput,
  parseScreenshotSessionInput,
  parseScreenshotOcrSubmission,
  parseScreenshotTranslationGenerationInput,
} from '../../shared/screenshot-translation'
import type { ScreenshotCaptureCoordinator } from '../screenshot-translation/screenshot-capture-coordinator'
import type { ScreenshotResultOperations } from '../screenshot-translation/screenshot-translation-coordinator'
import type { ScreenshotOcrModelManager } from '../screenshot-translation/screenshot-ocr-model-manager'
import { parseObservedOcrPreference, OcrPreferenceConflictError } from '../../shared/screenshot-ocr-models'
import { isSafeCustomSearchTemplate, type BrowserSearchPreferences } from '../../shared/search-preferences'
import {
  EDITOR_THEMES,
  isSafeFontFamilyName,
  type EditorAppearancePreferences,
  type EditorAppearanceSnapshot,
} from '../../shared/editor-appearance-preferences'
import { type LayoutPreferences, type LayoutPreferencesSnapshot } from '../../shared/layout-preferences'
import { isThemeColor, normalizeThemeColor } from '../../shared/theme-color'
import {
  canonicalWorkspaceColorPath,
  isWorkspaceColorId,
  type WorkspaceColorId,
  type WorkspaceColorMarksSnapshot,
} from '../../shared/workspace-color-marks'
import {
  parseDesktopLifecyclePreferences,
  type DesktopLifecyclePreferences,
} from '../../shared/desktop-lifecycle-preferences'
import {
  parseBackgroundSettings,
  type BackgroundPresentation,
  type BackgroundSettings,
  type BackgroundTarget,
} from '../../shared/background-settings'
import { listSystemFontFamilies } from '../settings/system-fonts'
import { parseUpdateAbout } from '../../shared/app-update'
import { appError, PUBLIC_ERROR_MESSAGES, PublicError, type PublicErrorCode } from '../../shared/public-errors'
import { documentTypeForPath } from '../../shared/document-types'
import { isEditableDocumentPath, isMarkItDownConversionPath, isCodeDocumentPath } from '../../shared/document-types'
import { createDocumentViewService, DocumentViewError } from '../documents/document-view-service'
import { DOCUMENT_VIEW_ERROR_MESSAGES, parseDocumentViewId, parseDocumentViewRequest, parseLocalFileRevealRequest, type DocumentViewLocation } from '../../shared/document-view'
import {
  parseConvertedDocument,
  parseDocumentConversionComponentState,
  type ConvertedDocument,
  type DocumentConversionComponentState,
} from '../../shared/document-conversion'
import type { DocumentConversionComponentManager } from '../document-conversion/component-manager'
import type { DocumentConversionService } from '../document-conversion/document-conversion-service'
import {
  LINK_TARGET_MAX_LENGTH,
  parseAiMessageLinkTarget,
  parseLinkTarget,
} from '../../shared/link-target'
import {
  resolveAiMessageLocalTarget,
  type AiMessageLinkIo,
} from './ai-message-link'
import {
  DocumentRollbackIncompleteError,
  type DocumentService,
} from '../documents/document-service'
import type { AssetService } from '../assets/asset-service'
import type { ImageContextService } from '../assets/image-context-service'
import type { MermaidImageExportService } from '../assets/mermaid-image-export-service'
import { parseMermaidViewerSnapshot, type MermaidViewerSnapshot } from '../../shared/mermaid-viewer'
import type { DocxOperations } from '../docx/docx-owner'
import type { XlsxExportService } from '../xlsx/xlsx-export-service'
import type { DraftService } from '../drafts/draft-service'
import type { WorkspaceEntryService } from '../workspace/workspace-entry-service'
import type {
  ResolvedConvertibleDocument,
  WorkspaceService,
} from '../workspace/workspace-service'
import { inspectDroppedPath } from '../dropped-path-inspector'
import { stickyNotePaths } from '../sticky-notes/sticky-note-paths'
import type { AppMenuSectionId } from '../../shared/app-menu-definition'
import {
  isCanonicalStickyNoteId,
  parseStickyNoteDocument,
  parseStickyNoteImportResult,
  parseStickyNoteRecord,
  parseStickyNoteSaveState,
  parseStickyNoteSearchResults,
  parseStickyNoteSummaries,
  type CreateStickyNoteInput,
  type StickyNoteContentMeasurement,
  type StickyNoteDocument,
  type StickyNoteImportResult,
  type StickyNoteSelectionImportInput,
  type StickyNoteRecord,
  type StickyNoteSaveState,
  type StickyNoteSearchInput,
  type StickyNoteSearchResult,
  type StickyNoteStatus,
  type StickyNoteStyleReference,
  type StickyNoteSummary,
  type StickyNoteLineSpacingMode,
} from '../../shared/sticky-notes'
import {
  parseStickyNotePreferences,
  parseStickyNoteStyleReference,
  type StickyNotePreferences,
} from '../../shared/sticky-note-preferences'
import {
  parseArknotePreferencesUpdate,
  type ArknotePreferences,
  type ArknotePreferencesUpdate,
} from '../../shared/arknote-preferences'
import { validateStickyNoteName } from '../sticky-notes/sticky-note-name'
import type { ArknoteCommand } from '../../shared/arknote-protocol'
import { parseStickyNoteContentMeasurement } from '../sticky-notes/sticky-note-window-sizing'
import {
  importStickyNoteSchema,
  importStickyNoteSelectionSchema,
  deleteArchivedStickyNotesSchema,
  restoreArchivedStickyNotesSchema,
  openStickyNoteSchema,
  stickyNoteIdSchema,
  stickyNoteForegroundSourceIdSchema,
  stickyNoteMarkdownSchema,
  stickyNoteReferenceSchema,
  stickyNoteSearchSchema,
  stickyNoteStatusSchema,
  setStickyNoteLineSpacingModeSchema,
} from './sticky-note-schemas'

const relativePathSchema = z.object({
  relativePath: z.string().max(32767),
}).strict()

const noInputSchema = z.undefined()

const connectionIdSchema = z.string().refine(isCanonicalModelConnectionId)

const capabilityOverrideSchema = z.custom<ModelCapabilityOverride>((value) => (
  parseModelCapabilityOverride(value) !== undefined
)).transform((value) => parseModelCapabilityOverride(value)!)

const connectModelSchema = z.object({
  id: connectionIdSchema.optional(),
  name: z.string().trim().min(1).max(MODEL_CONNECTION_NAME_MAX_LENGTH),
  provider: z.enum([
    'kimi', 'deepseek', 'qwen', 'zhipu', 'doubao', 'minimax', 'xiaomi-mimo', 'hy', 'other',
  ]),
  accessType: z.literal('standard-api'),
  protocol: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().trim().min(1).max(MODEL_BASE_URL_MAX_LENGTH).refine(isSafeModelBaseUrl),
  modelId: z.string().trim().min(1).max(MODEL_ID_MAX_LENGTH),
  apiKey: z.string().min(1).max(16 * 1024).optional(),
  capabilityOverride: capabilityOverrideSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if (value.capabilityOverride?.thinking && !parseModelThinkingCapability(value.capabilityOverride.thinking, value.protocol)) {
    context.addIssue({ code: 'custom', message: 'Thinking parameters do not match protocol' })
  }
  if (value.id === undefined && value.apiKey === undefined) {
    context.addIssue({ code: 'custom', message: 'API key is required for a new connection' })
  }
})

const listModelsSchema = z.object({
  id: connectionIdSchema.optional(),
  provider: z.enum([
    'kimi', 'deepseek', 'qwen', 'zhipu', 'doubao', 'minimax', 'xiaomi-mimo', 'hy', 'other',
  ]),
  protocol: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().trim().min(1).max(MODEL_BASE_URL_MAX_LENGTH).refine(isSafeModelBaseUrl),
  apiKey: z.string().min(1).max(16 * 1024).optional(),
}).strict().superRefine((value, context) => {
  if (value.id === undefined && value.apiKey === undefined) {
    context.addIssue({ code: 'custom', message: 'API key is required for a new connection' })
  }
})

const connectionReferenceSchema = z.object({
  connectionId: connectionIdSchema,
}).strict()

const featureSettingsSchema = z.object({
  connectionId: z.string().refine(isFeatureModelConnectionId).nullable(),
  thinkingMode: z.enum(['default', 'enabled', 'disabled']),
  reasoningEffort: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  targetLanguage: z.enum([
    'auto', 'zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'pt', 'ru', 'it', 'ar',
  ]),
}).strict()

const aiConversationSettingsSchema = z.object({
  connectionId: z.string().refine(isFeatureModelConnectionId).nullable(),
  thinkingMode: z.enum(['default', 'enabled', 'disabled']),
  reasoningEffort: z.enum(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  writePolicy: z.enum(['ask-every-time', 'document-grant', 'workspace-grant']),
}).strict()

function isExactOwnInput(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys])
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(descriptors)
  return (
    ownKeys.every((key) => typeof key === 'string' && allowedKeys.has(key))
    && requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && ownKeys.every((key) => {
      if (typeof key !== 'string') return false
      const descriptor = descriptors[key]
      return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    })
  )
}

function isStrictDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isExactOwnInput(value, keys, []) && Reflect.ownKeys(value).length === keys.length
}

function isStrictDataArray(value: unknown): value is unknown[] {
  if (typeof value !== 'object' || value === null || isProxy(value)
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
}

function parseExactOwnInput<T>(
  input: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  schema: z.ZodType<T>,
): T {
  if (!isExactOwnInput(input, requiredKeys, optionalKeys)) {
    throw new PublicError('INVALID_INPUT')
  }
  return schema.parse(input)
}

function parseConnectModelInput(input: unknown): ConnectModelInput {
  return parseExactOwnInput(
    input,
    ['name', 'provider', 'accessType', 'protocol', 'baseUrl', 'modelId'],
    ['id', 'apiKey', 'capabilityOverride'],
    connectModelSchema,
  )
}

function parseListModelsInput(input: unknown): ListModelsInput {
  return parseExactOwnInput(
    input,
    ['provider', 'protocol', 'baseUrl'],
    ['id', 'apiKey'],
    listModelsSchema,
  )
}

function parseConnectionReference(input: unknown): { connectionId: string } {
  return parseExactOwnInput(
    input,
    ['connectionId'],
    [],
    connectionReferenceSchema,
  )
}

function parseFeatureSettingsInput(input: unknown): FeatureSettingsInput {
  return parseExactOwnInput(
    input,
    ['connectionId', 'thinkingMode', 'reasoningEffort', 'targetLanguage'],
    [],
    featureSettingsSchema,
  )
}

function parseAiConversationSettingsInput(input: unknown): AiConversationSettings {
  return parseExactOwnInput(
    input,
    ['connectionId', 'thinkingMode', 'reasoningEffort', 'writePolicy'],
    [],
    aiConversationSettingsSchema,
  )
}

const cancelTranslationSchema = z.object({
  requestId: z.string().refine(isCanonicalTranslationRequestId),
}).strict()

const cancelAiConversationSchema = z.object({
  requestId: z.string().refine(isCanonicalAiConversationRequestId),
}).strict()

const startAiConversationSchema = z.custom<StartAiConversationInput>(
  isStartAiConversationInput,
)
function parseStartTranslationInput(input: unknown): StartTranslationInput {
  if (!isStartTranslationInput(input)) throw new PublicError('INVALID_INPUT')
  return input
}

function parseCancelTranslationInput(input: unknown): { requestId: string } {
  return parseExactOwnInput(
    input, ['requestId'], [], cancelTranslationSchema,
  )
}

function parseStartAiConversationInput(input: unknown): StartAiConversationInput {
  const keys = [
    'requestId', 'conversationId', 'workspaceKey', 'acknowledgedTranscriptRevision',
    'messages', 'capabilities', 'writePolicy',
  ]
  if (typeof input === 'object' && input !== null && 'currentDocumentOnce' in input) {
    keys.push('currentDocumentOnce')
  }
  if (typeof input === 'object' && input !== null && 'expectedDocumentId' in input) {
    keys.push('expectedDocumentId')
  }
  if (typeof input === 'object' && input !== null && 'continuationOfSegmentId' in input) keys.push('continuationOfSegmentId')
  if (!isStrictDataRecord(input, keys) || !isStrictDataArray(input.messages) || input.messages.length !== 1
    || !isStrictDataRecord(input.messages[0], ['id', 'role', 'content'])
    || !isStrictDataRecord(input.capabilities, ['currentDocument', 'workspace'])) {
    throw new PublicError('INVALID_INPUT')
  }
  return startAiConversationSchema.parse(input)
}

function parseCancelAiConversationInput(input: unknown): { requestId: string } {
  return parseExactOwnInput(input, ['requestId'], [], cancelAiConversationSchema)
}

const droppedPathSchema = z.object({
  absolutePath: z.string().max(32767).refine((value) => path.isAbsolute(value)),
}).strict()

const droppedPathInspectionSchema = droppedPathSchema.extend({
  resolveDocumentShortcut: z.boolean().optional(),
})

const assetImportSchema = z.object({
  absolutePath: z.string().max(32767).refine((value) => path.isAbsolute(value)),
  draftId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).optional(),
}).strict()

const docxExportSchema = z.object({
  documentSessionId: z.string().uuid(),
  markdown: z.string().max(16 * 1024 * 1024),
  mode: z.enum(['choose', 'reuse']),
  suggestedBaseName: z.string().min(1).max(200)
    .refine((value) => value !== '.' && value !== '..' && !/[\\/]/u.test(value)),
}).strict()

const xlsxExportSchema = z.object({
  markdown: z.string().max(16 * 1024 * 1024),
  suggestedBaseName: z.string().min(1).max(200)
    .refine((value) => value !== '.' && value !== '..' && !/[\\/]/u.test(value)),
}).strict()

const clipboardFormatsSchema = z.object({
  plainText: z.string().max(2 * 1024 * 1024),
  markdown: z.string().max(2 * 1024 * 1024).nullable(),
  html: z.string().max(2 * 1024 * 1024).nullable(),
}).strict()

function isUnavailableExportTargetError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return ['EACCES', 'EPERM', 'ENOENT', 'EISDIR', 'ENOTDIR'].includes(String(error.code))
}

const searchPreferencesSchema = z.object({
  provider: z.enum(['bing', 'baidu', 'google', 'custom']),
  customTemplate: z.string().max(2000),
}).strict().superRefine((value, context) => {
  if (value.provider === 'custom' && !isSafeCustomSearchTemplate(value.customTemplate)) {
    context.addIssue({ code: 'custom', message: 'Unsafe custom search template' })
  }
  if (value.provider !== 'custom' && value.customTemplate !== '') {
    context.addIssue({ code: 'custom', message: 'Built-in providers do not use a custom template' })
  }
})
const windowControlSchema = z.object({
  action: z.enum([
    'minimize', 'toggle-maximize', 'toggle-fullscreen', 'exit-fullscreen', 'close',
  ]),
}).strict()

const applicationMenuWindowStateSchema = z.object({
  editorTheme: z.enum(EDITOR_THEMES).optional(),
  hasPrintableDocument: z.boolean(),
  spellCheckEnabled: z.boolean(),
  showEditIndicators: z.boolean(),
  editorZoomPercent: z.number().int().min(70).max(200),
  fullscreen: z.boolean(),
}).strict()

const printTokenSchema = z.object({
  token: z.string().refine(isPrintDocumentToken),
}).strict()

const fontFamilySchema = z.string().min(1).max(120).refine(isSafeFontFamilyName)

const editorAppearancePreferencesSchema = z.object({
  minimumContentMarginPx: z.number().int().min(30).max(150),
  maximumContentWidthPx: z.number().int().min(600).max(1200),
  preserveSingleLineBreaks: z.boolean(),
  spellCheckEnabled: z.boolean(),
  showEditIndicators: z.boolean(),
  editorTheme: z.enum(EDITOR_THEMES),
  headingLatinFont: fontFamilySchema,
  headingCjkFont: fontFamilySchema,
  bodyLatinFont: fontFamilySchema,
  bodyCjkFont: fontFamilySchema,
  themeColor: z.string().refine(isThemeColor),
  micaOpacityPercent: z.literal(0),
}).strict()
const compareAndSetEditorAppearancePreferencesSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedAppearance: editorAppearancePreferencesSchema,
  replacement: editorAppearancePreferencesSchema,
}).strict()
const layoutPreferencesSchema = z.object({
  leftSidebarWidth: z.number().int().min(180).max(600),
  rightSidebarWidth: z.number().int().min(240).max(1800),
}).strict()
const compareAndSetLayoutPreferencesSchema = z.object({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedLayout: layoutPreferencesSchema,
  replacement: layoutPreferencesSchema,
}).strict()

const searchQuerySchema = z.object({
  query: z.string().trim().min(1).refine((value) => [...value].length <= 1000),
}).strict()

const externalTargetSchema = z.object({
  target: z.string().max(LINK_TARGET_MAX_LENGTH),
}).strict()

const assetUrlSchema = z.object({
  url: z.string().max(32767).refine((value) => path.isAbsolute(value)),
}).strict()
const imageSourceSchema = z.object({
  source: z.string().max(32767)
    .refine((value) => path.isAbsolute(value) && documentTypeForPath(value)?.category === 'image'),
}).strict()
const mermaidPngDataUrlSchema = z.string()
  .min('data:image/png;base64,'.length + 4)
  .max(24 * 1024 * 1024)
  .startsWith('data:image/png;base64,')
const mermaidSvgDataUrlSchema = z.string()
  .min('data:image/svg+xml;base64,'.length + 4)
  .max(3 * 1024 * 1024)
  .startsWith('data:image/svg+xml;base64,')
const mermaidImageCopySchema = z.object({
  pngDataUrl: mermaidPngDataUrlSchema,
}).strict()
const mermaidImageSaveSchema = z.object({
  svgDataUrl: mermaidSvgDataUrlSchema,
  pngDataUrl: mermaidPngDataUrlSchema,
}).strict()

const workspaceRelativePathSchema = z.string().max(32767).refine((value) => (
  !path.isAbsolute(value) && !value.includes('\0')
))

const workspaceEntrySchema = z.object({
  relativePath: workspaceRelativePathSchema,
}).strict()
const workspaceColorPathSchema = z.string().refine((value) => canonicalWorkspaceColorPath(value) === value)
const workspaceColorSetSchema = z.object({
  relativePath: workspaceColorPathSchema,
  color: z.union([z.string().refine(isWorkspaceColorId), z.null()]),
}).strict()
const workspaceColorMoveSchema = z.object({
  fromRelativePath: workspaceColorPathSchema,
  toRelativePath: workspaceColorPathSchema,
}).strict()

const createFolderSchema = z.object({
  parentRelativePath: workspaceRelativePathSchema,
  name: z.string().min(1).max(255).refine((value) => (
    !/[<>:"/\\|?*\u0000-\u001f]/.test(value)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)
    && !/[ .]$/.test(value)
  )),
}).strict()

const renameEntrySchema = z.object({
  relativePath: workspaceRelativePathSchema,
  newName: createFolderSchema.shape.name,
}).strict()

const applicationMenuSchema = z.object({
  section: z.enum(['file', 'edit', 'paragraph', 'format', 'view', 'theme', 'tools', 'help']),
  x: z.number().int().min(0).max(32767),
  y: z.number().int().min(0).max(32767),
}).strict()
const applicationMenuItemSchema = z.object({
  itemId: z.string().min(1).max(100).regex(/^[a-z0-9.-]+$/),
}).strict()

function parseBackgroundTarget(input: unknown): BackgroundTarget {
  if (isExactOwnInput(input, ['kind']) && input.kind === 'main') return { kind: 'main' }
  if (
    !isExactOwnInput(input, ['kind', 'noteId'])
    || input.kind !== 'sticky-note'
    || typeof input.noteId !== 'string'
    || !isCanonicalStickyNoteId(input.noteId)
  ) throw new PublicError('INVALID_INPUT')
  return { kind: 'sticky-note', noteId: input.noteId }
}

function parseBackgroundMutation(input: unknown): {
  target: BackgroundTarget
  settings: BackgroundSettings
} {
  if (!isExactOwnInput(input, ['target', 'settings'])) throw new PublicError('INVALID_INPUT')
  const target = parseBackgroundTarget(input.target)
  const settings = parseBackgroundSettings(input.settings)
  if (settings === undefined) throw new PublicError('INVALID_INPUT')
  return { target, settings }
}


const draftIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const markdownSchema = z.string().max(16 * 1024 * 1024)

const draftReferenceSchema = z.object({ draftId: draftIdSchema }).strict()

const saveDraftSchema = z.object({
  draftId: draftIdSchema,
  markdown: markdownSchema,
  expectedOriginalRevision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  encoding: z.enum(['utf8', 'utf8-bom']),
  newline: z.enum(['lf', 'crlf']),
}).strict()

const saveDocumentAsSchema = z.object({
  draftId: draftIdSchema,
  markdown: markdownSchema,
  encoding: z.enum(['utf8', 'utf8-bom']),
  newline: z.enum(['lf', 'crlf']),
  suggestedFileName: createFolderSchema.shape.name.optional(),
}).strict()

const saveDocumentAsIntentSchema = z.object({
  intentId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
}).strict()

const saveDocumentSchema = z.object({
  relativePath: z.string().max(32767),
  markdown: z.string(),
  expectedRevision: z.string().regex(/^[0-9a-f]{64}$/),
  encoding: z.enum(['utf8', 'utf8-bom']),
  newline: z.enum(['lf', 'crlf']),
}).strict()

const reorderStickyNotesSchema = z.object({
  noteIds: z.array(stickyNoteIdSchema).max(35).refine((value) => new Set(value).size === value.length),
}).strict()

const createStickyNoteSchema = z.object({
  name: z.string(),
  markdown: stickyNoteMarkdownSchema.optional(),
  style: z.unknown().optional(),
}).strict()
const renameStickyNoteSchema = z.object({
  noteId: stickyNoteIdSchema,
  name: z.string(),
}).strict()
const stageStickyNoteSaveSchema = z.object({
  noteId: stickyNoteIdSchema,
  markdown: stickyNoteMarkdownSchema,
}).strict()
const setStickyNotePinnedSchema = z.object({
  noteId: stickyNoteIdSchema,
  pinned: z.boolean(),
}).strict()
const setStickyNoteStyleSchema = z.object({
  noteId: stickyNoteIdSchema,
  style: z.unknown(),
}).strict()
const setStickyNoteFontSizeSchema = z.object({
  noteId: stickyNoteIdSchema,
  fontSizePx: z.number().int().min(11).max(20),
}).strict()
const copyStickyNoteImageSchema = z.object({
  noteId: stickyNoteIdSchema,
  absolutePath: z.string().max(32767).refine((value) => path.isAbsolute(value) && documentTypeForPath(value)?.category === 'image'),
}).strict()

function requireValidStickyNoteName(value: string): string {
  const result = validateStickyNoteName(value, [])
  if (!result.ok) throw new PublicError('INVALID_INPUT')
  return result.name
}

function parseStickyNoteReference(input: unknown): { noteId: string } {
  return parseExactOwnInput(input, ['noteId'], [], stickyNoteReferenceSchema)
}

function parseResizeStickyNoteInput(input: unknown): {
  noteId: string
  measurement: StickyNoteContentMeasurement
} {
  if (!isExactOwnInput(input, ['noteId', 'measurement'])) {
    throw new PublicError('INVALID_INPUT')
  }
  const noteId = input.noteId
  const measurement = parseStickyNoteContentMeasurement(input.measurement)
  if (!isCanonicalStickyNoteId(noteId) || !measurement) {
    throw new PublicError('INVALID_INPUT')
  }
  return { noteId, measurement }
}

function parseCreateStickyNoteInput(input: unknown): CreateStickyNoteInput {
  const value = parseExactOwnInput(
    input, ['name'], ['markdown', 'style'], createStickyNoteSchema,
  )
  const result: CreateStickyNoteInput = { name: requireValidStickyNoteName(value.name) }
  if (value.markdown !== undefined) result.markdown = value.markdown
  if (Object.prototype.hasOwnProperty.call(value, 'style')) {
    const style = parseStickyNoteStyleReference(value.style)
    if (!style) throw new PublicError('INVALID_INPUT')
    result.style = style
  }
  return result
}

function parseRenameStickyNoteInput(input: unknown): { noteId: string; name: string } {
  const value = parseExactOwnInput(
    input, ['noteId', 'name'], [], renameStickyNoteSchema,
  )
  return { noteId: value.noteId, name: requireValidStickyNoteName(value.name) }
}

function parseSetStickyNoteStyleInput(input: unknown): {
  noteId: string
  style: StickyNoteStyleReference
} {
  const value = parseExactOwnInput(
    input, ['noteId', 'style'], [], setStickyNoteStyleSchema,
  )
  const style = parseStickyNoteStyleReference(value.style)
  if (!style) throw new PublicError('INVALID_INPUT')
  return { noteId: value.noteId, style }
}

function failure(code: PublicErrorCode): ApiResult<never> {
  return { ok: false, error: { code, message: PUBLIC_ERROR_MESSAGES[code] } }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}

const MODEL_PROTOCOL_PUBLIC_CODES = {
  'authentication-failed': 'MODEL_AUTHENTICATION_FAILED',
  'model-not-found': 'MODEL_NOT_FOUND',
  'invalid-endpoint': 'MODEL_INVALID_ENDPOINT',
  timeout: 'MODEL_TIMEOUT',
  'rate-limited': 'MODEL_RATE_LIMITED',
  'quota-exceeded': 'MODEL_QUOTA_EXCEEDED',
  'incompatible-response': 'MODEL_INCOMPATIBLE_RESPONSE',
} as const satisfies Record<ModelProtocolError['status'], PublicErrorCode>

function modelPublicErrorCode(error: unknown): PublicErrorCode | undefined {
  if (error instanceof ModelProtocolError) {
    return MODEL_PROTOCOL_PUBLIC_CODES[error.status]
  }
  if (!(error instanceof ModelSecretVaultError)) return undefined
  switch (error.code) {
    case 'INVALID_CONNECTION_ID':
      return 'INVALID_INPUT'
    case 'ENCRYPTION_UNAVAILABLE':
      return 'MODEL_ENCRYPTION_UNAVAILABLE'
    case 'DECRYPTION_FAILED':
      return 'MODEL_SECRET_UNAVAILABLE'
    case 'VAULT_MALFORMED':
    case 'VAULT_READ_FAILED':
    case 'VAULT_WRITE_FAILED':
      return 'MODEL_SECRET_STORAGE_FAILED'
  }
}

export function ipcFailure(error: unknown): ApiResult<never> {
  if (error instanceof DocumentViewError) return { ok: false, error: { code: error.code, message: DOCUMENT_VIEW_ERROR_MESSAGES[error.code] } }
  if (error instanceof z.ZodError) return failure('INVALID_INPUT')
  if (error instanceof PublicError) return failure(error.code)
  const modelCode = modelPublicErrorCode(error)
  if (modelCode !== undefined) return failure(modelCode)
  const code = errorCode(error)
  if (code === 'DOCUMENT_CONFLICT') return failure('DOCUMENT_CONFLICT')
  if (code === 'DOCUMENT_ROLLBACK_INCOMPLETE') return failure('DOCUMENT_ROLLBACK_INCOMPLETE')
  if (code === 'DOCUMENT_ENCODING_UNSUPPORTED') return failure('DOCUMENT_ENCODING_UNSUPPORTED')
  if (code === 'DOCUMENT_BINARY') return failure('DOCUMENT_BINARY')
  if (code === 'DOCUMENT_TEXT_TOO_LARGE') return failure('DOCUMENT_TEXT_TOO_LARGE')
  if (code === 'ENOENT') return failure('FILE_NOT_FOUND')
  if (code === 'EACCES' || code === 'EPERM') return failure('PERMISSION_DENIED')
  return failure('OPERATION_FAILED')
}

export interface StickyNoteIpcService {
  ensureAvailable?(): Promise<void>
  list(status: StickyNoteStatus): Promise<StickyNoteSummary[]>
  reorder?(noteIds: readonly string[]): Promise<StickyNoteSummary[]>
  search(input: StickyNoteSearchInput): Promise<StickyNoteSearchResult[]>
  read(noteId: string): Promise<StickyNoteDocument>
  create(input: CreateStickyNoteInput): Promise<StickyNoteDocument>
  rename(noteId: string, name: string): Promise<StickyNoteDocument>
  archive(noteId: string): Promise<StickyNoteDocument>
  restore(noteId: string): Promise<StickyNoteDocument>
  restoreArchived?(noteIds: readonly string[]): Promise<void>
  delete(noteId: string): Promise<void>
  deleteArchived?(noteIds: readonly string[]): Promise<void>
  importFile(absolutePath: string): Promise<StickyNoteImportResult>
  importSelection?(input: StickyNoteSelectionImportInput): Promise<StickyNoteImportResult>
  stageSave(noteId: string, markdown: string): Promise<void> | void
  flushSave(noteId: string): Promise<StickyNoteSaveState>
  open(noteId: string, findQuery?: string, foregroundSourceId?: string): Promise<void>
  close(noteId: string): Promise<void>
  release(noteId: string): Promise<void>
  reclaim(noteId: string): Promise<void>
  setPinned(noteId: string, pinned: boolean): Promise<void>
  setStyle(noteId: string, style: StickyNoteStyleReference): Promise<StickyNoteRecord>
  setFontSize?(noteId: string, fontSizePx: number): Promise<void>
  setLineSpacingMode?(noteId: string, lineSpacingMode: StickyNoteLineSpacingMode): Promise<void>
  copyImage?(noteId: string, absolutePath: string): Promise<string>
  resizeToContent(noteId: string, measurement: StickyNoteContentMeasurement): Promise<void>
}

export interface ArknoteIpcClient {
  openBox?(): Promise<void>
  request<T>(
    command: ArknoteCommand,
    payload: unknown,
    parser: (value: unknown) => T | undefined,
  ): Promise<T>
}

function parseNullResponse(value: unknown): null | undefined {
  return value === null ? null : undefined
}

export function createArknoteStickyNoteIpcService(
  client: ArknoteIpcClient,
): StickyNoteIpcService {
  const requestNull = async (command: ArknoteCommand, payload: unknown): Promise<void> => {
    await client.request(command, payload, parseNullResponse)
  }
  return {
    ensureAvailable: () => client.openBox?.() ?? Promise.reject(new Error('Arknote unavailable')),
    list: (status) => client.request('note.list', { status }, parseStickyNoteSummaries),
    reorder: (noteIds) => client.request('note.reorder', { noteIds }, parseStickyNoteSummaries),
    search: (input) => client.request('note.search', input, parseStickyNoteSearchResults),
    read: (noteId) => client.request('note.read', { noteId }, parseStickyNoteDocument),
    create: (input) => client.request('note.create', input, parseStickyNoteDocument),
    rename: (noteId, name) => client.request(
      'note.rename', { noteId, name }, parseStickyNoteDocument,
    ),
    archive: (noteId) => client.request('note.archive', { noteId }, parseStickyNoteDocument),
    restore: (noteId) => client.request('note.restore', { noteId }, parseStickyNoteDocument),
    restoreArchived: (noteIds) => requestNull('note.restore-archived-batch', { noteIds }),
    delete: (noteId) => requestNull('note.delete', { noteId }),
    deleteArchived: (noteIds) => requestNull('note.delete-archived-batch', { noteIds }),
    importFile: (absolutePath) => client.request(
      'note.import-file', { absolutePath }, parseStickyNoteImportResult,
    ),
    importSelection: (input) => client.request(
      'note.import-selection', input, parseStickyNoteImportResult,
    ),
    stageSave: (noteId, markdown) => requestNull('note.stage-save', { noteId, markdown }),
    flushSave: (noteId) => client.request(
      'note.flush-save', { noteId }, parseStickyNoteSaveState,
    ),
    open: (noteId, findQuery, foregroundSourceId) => requestNull('note.open', {
      noteId,
      ...(findQuery === undefined ? {} : { findQuery }),
      ...(foregroundSourceId === undefined ? {} : { foregroundSourceId }),
    }),
    close: (noteId) => requestNull('note.close', { noteId }),
    release: (noteId) => requestNull('note.release', { noteId }),
    reclaim: (noteId) => requestNull('note.reclaim', { noteId }),
    setPinned: (noteId, pinned) => requestNull('note.pin', { noteId, pinned }),
    setStyle: (noteId, style) => client.request(
      'note.style', { noteId, style }, parseStickyNoteRecord,
    ),
    setLineSpacingMode: (noteId, lineSpacingMode) => requestNull(
      'note.line-spacing', { noteId, lineSpacingMode },
    ),
    resizeToContent: (noteId, measurement) => requestNull(
      'note.resize', { noteId, measurement },
    ),
  }
}

export class SerialOperationQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

const AI_RENDERER_PORT_TIMEOUT_MS = 15_000
const AI_RENDERER_PORT_TEXT_LIMIT = 48_000
const AI_RENDERER_PORT_PENDING_LIMIT = 32
const AI_RENDERER_PORT_SEEN_LIMIT = 2048
const AI_OPEN_DOCUMENT_LIMIT = 32
const AI_OPEN_DOCUMENT_TEXT_LIMIT = 32 * 1024 * 1024
const AI_IPC_OWNERSHIP_HISTORY_LIMIT = 4096
const SAVE_AS_INTENT_LIMIT = 32
const SAVE_AS_INTENT_TTL_MS = 5 * 60_000

function rememberBounded(set: Set<string>, value: string, limit: number): void {
  set.add(value)
  while (set.size > limit) {
    const oldest = set.values().next().value as string | undefined
    if (oldest === undefined) return
    set.delete(oldest)
  }
}

interface DesktopAiIpcAuthority {
  readonly ownerId: number
  getWorkspaceAuthority(): Promise<WindowAiWorkspaceAuthority | null>
  registerCurrentDocumentPort(
    port: RendererCurrentDocumentPort,
  ): Promise<RendererCurrentDocumentPortRegistration>
  registerTransportLifecycle?(lifecycle: {
    pauseAndDrain(): void | Promise<void>
    unregister(): void | Promise<void>
  }): () => void
  prepareWorkspaceSwitch?(): Promise<AiWorkspaceSwitchTicket>
  activateWorkspace?(ticket: AiWorkspaceSwitchTicket): Promise<void>
  abortWorkspaceSwitch?(ticket: AiWorkspaceSwitchTicket): Promise<void>
}

interface AiRendererPortWindow {
  isDestroyed(): boolean
  webContents: {
    readonly id: number
    readonly mainFrame: unknown
    send(channel: string, payload: unknown): void
    isDestroyed(): boolean
  }
}

type CurrentDocumentMethod = 'openSnapshot' | 'readPage' | 'release'
type OpenDocumentMethod = 'captureReadSnapshot' | 'planReplacement' | 'applyTransaction' | 'queryOutcome'
type AiRendererPortMethod = CurrentDocumentMethod | OpenDocumentMethod

interface PendingAiRendererRequest {
  readonly method: AiRendererPortMethod
  readonly payload: Readonly<object>
  readonly documentHandle?: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly signal?: AbortSignal
  readonly abort?: () => void
}

export interface AiRendererPortBridge {
  registerCurrentDocumentPort(): Promise<{ portGeneration: number }>
  unregisterCurrentDocumentPort(): Promise<void>
  submitCurrentDocumentResponse(input: unknown): Promise<void>
  registerOpenDocument(
    registry: OpenDocumentRegistry,
    target: WorkspaceAiEditorTarget,
  ): Promise<{ documentHandle: string }>
  beginOpenDocumentTransfer(
    registry: OpenDocumentRegistry,
    source: WorkspaceAiEditorTarget,
    successorAuthority: OpenDocumentAuthority,
  ): Promise<AiOpenDocumentTransfer | null>
  unregisterOpenDocument(documentHandle: string): Promise<void>
  submitOpenDocumentResponse(input: unknown): Promise<void>
  quiesceForClose(): Promise<void>
  resumeAfterClose(beforeAdmission?: () => void | Promise<void>): Promise<void>
  pauseAndDrain(): Promise<void>
  resume(): void
  dispose(): Promise<void>
  pendingCount(): number
}

export interface AiOpenDocumentTransfer {
  guardDestination(identity: CanonicalFileIdentity): Promise<void>
  handoffDestination(identity: CanonicalFileIdentity): Promise<void>
  commit(successorIdentity: CanonicalFileIdentity): Promise<void>
  rollback(
    restoredSourceIdentity?: CanonicalFileIdentity,
    restoredDestinationIdentity?: CanonicalFileIdentity,
  ): Promise<void>
}

function rendererPortError(name: 'AbortError' | 'TimeoutError' | 'InvalidStateError'): DOMException {
  const message = name === 'AbortError'
    ? 'AI renderer request aborted'
    : name === 'TimeoutError' ? 'AI renderer request timed out' : 'AI renderer port is unavailable'
  return new DOMException(message, name)
}

function currentDocumentRendererResult(
  method: CurrentDocumentMethod,
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (method === 'release') {
    return isStrictDataRecord(value, ['status']) && value.status === 'released'
      ? Object.freeze({ status: 'released' }) : undefined
  }
  if (isStrictDataRecord(value, ['status']) && value.status === 'unavailable') {
    return Object.freeze({ status: 'unavailable' })
  }
  const keys = method === 'openSnapshot'
    ? ['status', 'snapshotId', 'displayName', 'sourceFormat', 'dirty', 'content', 'nextCursor', 'hasMore', 'totalChars']
    : ['status', 'displayName', 'sourceFormat', 'dirty', 'content', 'nextCursor', 'hasMore', 'totalChars']
  if (!isStrictDataRecord(value, keys) || value.status !== 'captured'
    || (method === 'openSnapshot' && (typeof value.snapshotId !== 'string'
      || value.snapshotId.length === 0 || value.snapshotId.length > 512))
    || typeof value.displayName !== 'string' || value.displayName.length === 0
    || value.displayName.length > 255 || typeof value.sourceFormat !== 'string'
    || value.sourceFormat.length === 0 || value.sourceFormat.length > 64
    || typeof value.dirty !== 'boolean' || typeof value.content !== 'string'
    || value.content.length > AI_RENDERER_PORT_TEXT_LIMIT
    || !(value.nextCursor === null || (Number.isSafeInteger(value.nextCursor) && (value.nextCursor as number) >= 0))
    || typeof value.hasMore !== 'boolean' || !Number.isSafeInteger(value.totalChars)
    || (value.totalChars as number) < 0) return undefined
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])))
}

function openDocumentRendererResult(
  method: OpenDocumentMethod,
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (isStrictDataRecord(value, ['status'])) {
    const allowed = method === 'captureReadSnapshot' || method === 'planReplacement'
      ? ['stale', 'unavailable']
      : method === 'applyTransaction' ? ['stale', 'unknown']
        : ['not-applied', 'unknown', 'unavailable', 'stale']
    return typeof value.status === 'string' && allowed.includes(value.status)
      ? Object.freeze({ status: value.status }) : undefined
  }
  if (method === 'captureReadSnapshot') {
    if (!isStrictDataRecord(value, ['status', 'editorRevision', 'contentHash', 'markdown', 'dirty'])
      || value.status !== 'captured' || !Number.isSafeInteger(value.editorRevision)
      || (value.editorRevision as number) < 0 || typeof value.contentHash !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.contentHash) || typeof value.markdown !== 'string'
      || Buffer.byteLength(value.markdown, 'utf8') > AI_OPEN_DOCUMENT_TEXT_LIMIT
      || createHash('sha256').update(value.markdown).digest('hex') !== value.contentHash
      || typeof value.dirty !== 'boolean') return undefined
    return Object.freeze({
      status: value.status, editorRevision: value.editorRevision, contentHash: value.contentHash,
      markdown: value.markdown, dirty: value.dirty,
    })
  }
  if (method === 'planReplacement') {
    if (!isStrictDataRecord(value, ['status', 'editorRevision', 'contentHash'])
      || value.status !== 'planned' || !Number.isSafeInteger(value.editorRevision)
      || (value.editorRevision as number) < 0 || typeof value.contentHash !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.contentHash)) return undefined
    return Object.freeze({
      status: value.status, editorRevision: value.editorRevision, contentHash: value.contentHash,
    })
  }
  if (!isStrictDataRecord(value, ['status', 'editorRevision', 'contentHash', 'dirty'])
    || value.status !== 'applied' || !Number.isSafeInteger(value.editorRevision)
    || (value.editorRevision as number) < 0 || typeof value.contentHash !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.contentHash) || typeof value.dirty !== 'boolean') return undefined
  return Object.freeze({
    status: value.status, editorRevision: value.editorRevision,
    contentHash: value.contentHash, dirty: value.dirty,
  })
}

function openDocumentRendererResponse(
  request: PendingAiRendererRequest,
  parsed: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (parsed.status !== 'captured' && parsed.status !== 'planned' && parsed.status !== 'applied') {
    return parsed
  }
  const payload = request.payload as Record<string, unknown>
  const binding = {
    registrationToken: payload.registrationToken,
    registrationRevision: payload.registrationRevision,
    bindingToken: payload.bindingToken,
    bindingRevision: payload.bindingRevision,
  }
  return Object.freeze(parsed.status === 'captured'
    ? { ...binding, ...parsed }
    : { ...binding, operationId: payload.operationId, ...parsed })
}

export function createAiRendererPortBridge(options: {
  readonly window: AiRendererPortWindow
  readonly desktopAi: DesktopAiIpcAuthority
  readonly timeoutMs?: number
  readonly createTransportRequestId?: () => string
}): AiRendererPortBridge {
  const timeoutMs = options.timeoutMs ?? AI_RENDERER_PORT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > AI_RENDERER_PORT_TIMEOUT_MS) {
    throw new Error('Invalid AI renderer port timeout')
  }
  if (!Number.isSafeInteger(options.desktopAi.ownerId) || options.desktopAi.ownerId <= 0
    || options.window.webContents.id !== options.desktopAi.ownerId) {
    throw new Error('AI renderer port owner mismatch')
  }
  const createTransportRequestId = options.createTransportRequestId ?? randomUUID
  const pending = new Map<string, PendingAiRendererRequest>()
  const seenTransportRequestIds = new Set<string>()
  const openDocuments = new Map<string, {
    readonly registry: OpenDocumentRegistry
    registration: OpenDocumentRegistration
    readonly port: OpenDocumentEditorPort
    readonly frame: unknown
  }>()
  const seenDocumentHandles = new Set<string>()
  const pendingDocumentTargets = new Set<string>()
  const unregisteringDocumentHandles = new Set<string>()
  const inFlightRegistrations = new Set<Promise<void>>()
  let currentRegistration: RendererCurrentDocumentPortRegistration | undefined
  let currentRegistrationFrame: unknown
  let accepting = true
  let disposed = false
  let drainCompleted = false
  let drainPromise: Promise<void> | undefined
  let lifecycleGeneration = 0
  let currentRegistrationAttempt = 0
  let registrationCleanupFailed = false
  const pendingDrainWaiters = new Set<() => void>()
  interface CloseQuiescenceState {
    frame: unknown
    generation: number
    current: RendererCurrentDocumentPortRegistration | undefined
    open: Map<string, OpenDocumentRegistration>
    authority?: WindowAiWorkspaceAuthority | null
    completion: Promise<void>
  }
  let closeQuiescence: CloseQuiescenceState | undefined

  const terminal = (id: string, request: PendingAiRendererRequest): void => {
    if (pending.get(id) !== request) return
    pending.delete(id)
    clearTimeout(request.timer)
    if (request.signal && request.abort) request.signal.removeEventListener('abort', request.abort)
    if (pending.size === 0) {
      for (const resolve of pendingDrainWaiters) resolve()
      pendingDrainWaiters.clear()
    }
  }
  const rejectAll = (error: Error): void => {
    for (const [id, request] of [...pending]) {
      terminal(id, request)
      request.reject(error)
    }
  }
  const rejectMatching = (
    predicate: (request: PendingAiRendererRequest) => boolean,
    error: Error,
  ): void => {
    for (const [id, request] of [...pending]) {
      if (!predicate(request)) continue
      terminal(id, request)
      request.reject(error)
    }
  }
  const usable = (): boolean => accepting && !disposed && !registrationCleanupFailed
    && !options.window.isDestroyed() && !options.window.webContents.isDestroyed()
  const trackRegistration = <T>(operation: () => Promise<T>): Promise<T> => {
    let complete!: () => void
    const completion = new Promise<void>((resolve) => { complete = resolve })
    inFlightRegistrations.add(completion)
    return operation().finally(() => {
      complete()
      inFlightRegistrations.delete(completion)
    })
  }
  const revokeRegistration = async (revoke: () => Promise<void>): Promise<void> => {
    try { await revoke() } catch (error) {
      // A failed revocation leaves ownership uncertain. No later close/generic
      // resume may expose an unacknowledged registration through this bridge.
      registrationCleanupFailed = true
      accepting = false
      throw error
    }
  }

  const requestRenderer = (
    method: AiRendererPortMethod,
    payload: Readonly<object>,
    signal?: AbortSignal,
    documentHandle?: string,
  ): Promise<unknown> => {
    if (!usable() || signal?.aborted || pending.size >= AI_RENDERER_PORT_PENDING_LIMIT) {
      return Promise.reject(signal?.aborted ? rendererPortError('AbortError') : rendererPortError('InvalidStateError'))
    }
    let transportRequestId: string
    try { transportRequestId = createTransportRequestId() } catch {
      return Promise.reject(rendererPortError('InvalidStateError'))
    }
    if (!isCanonicalAiConversationRequestId(transportRequestId)
      || seenTransportRequestIds.has(transportRequestId)) {
      return Promise.reject(rendererPortError('InvalidStateError'))
    }
    rememberBounded(seenTransportRequestIds, transportRequestId, AI_RENDERER_PORT_SEEN_LIMIT)
    return new Promise<unknown>((resolve, reject) => {
      let request!: PendingAiRendererRequest
      const fail = (error: Error) => {
        terminal(transportRequestId, request)
        reject(error)
      }
      const timer = setTimeout(() => fail(rendererPortError('TimeoutError')), timeoutMs)
      const abort = signal ? () => fail(rendererPortError('AbortError')) : undefined
      request = {
        method, payload, resolve, reject, timer,
        ...(documentHandle ? { documentHandle } : {}),
        ...(signal ? { signal, abort } : {}),
      }
      pending.set(transportRequestId, request)
      signal?.addEventListener('abort', abort!, { once: true })
      if (signal?.aborted) {
        abort!()
        return
      }
      try {
        options.window.webContents.send(IPC_CHANNELS.aiRendererPortRequest, Object.freeze({
          transportRequestId,
          ...(documentHandle ? { documentHandle } : {}),
          method,
          payload: Object.freeze({ ...payload }),
        }))
      } catch {
        fail(rendererPortError('InvalidStateError'))
      }
    })
  }

  const port: RendererCurrentDocumentPort = Object.freeze({
    openSnapshot: (
      request: Parameters<RendererCurrentDocumentPort['openSnapshot']>[0],
      signal: AbortSignal,
    ) => requestRenderer('openSnapshot', request, signal),
    readPage: (
      request: Parameters<RendererCurrentDocumentPort['readPage']>[0],
      signal: AbortSignal,
    ) => requestRenderer('readPage', request, signal),
    release: async (request: Parameters<RendererCurrentDocumentPort['release']>[0]) => {
      const result = await requestRenderer('release', request)
      if (!isStrictDataRecord(result, ['status']) || result.status !== 'released') {
        throw rendererPortError('InvalidStateError')
      }
    },
  })

  const createOpenDocumentPort = (documentHandle: string): OpenDocumentEditorPort => Object.freeze({
    captureReadSnapshot: (
      request: Parameters<OpenDocumentEditorPort['captureReadSnapshot']>[0],
      signal: AbortSignal,
    ) => requestRenderer(
      'captureReadSnapshot', request, signal, documentHandle,
    ) as ReturnType<OpenDocumentEditorPort['captureReadSnapshot']>,
    planReplacement: (
      request: Parameters<OpenDocumentEditorPort['planReplacement']>[0],
      signal: AbortSignal,
    ) => requestRenderer(
      'planReplacement', request, signal, documentHandle,
    ) as ReturnType<OpenDocumentEditorPort['planReplacement']>,
    applyTransaction: (request: Parameters<OpenDocumentEditorPort['applyTransaction']>[0]) => requestRenderer(
      'applyTransaction', request, undefined, documentHandle,
    ) as ReturnType<OpenDocumentEditorPort['applyTransaction']>,
    queryOutcome: (request: Parameters<OpenDocumentEditorPort['queryOutcome']>[0]) => requestRenderer(
      'queryOutcome', request, undefined, documentHandle,
    ) as ReturnType<OpenDocumentEditorPort['queryOutcome']>,
  })

  const unregisterCurrentDocumentPort = async (): Promise<void> => {
    const registration = currentRegistration
    currentRegistration = undefined
    rejectMatching((request) => request.documentHandle === undefined, rendererPortError('AbortError'))
    if (registration) await revokeRegistration(() => registration.unregister())
  }
  const registerCurrentDocumentPort = (): Promise<{ portGeneration: number }> => trackRegistration(async () => {
    if (!usable()) throw new PublicError('OPERATION_FAILED')
    const lifecycleAtStart = lifecycleGeneration
    const frameAtStart = options.window.webContents.mainFrame
    const attempt = ++currentRegistrationAttempt
    const registration = await options.desktopAi.registerCurrentDocumentPort(port)
    if (!registration || typeof registration !== 'object'
      || !Number.isSafeInteger(registration.portGeneration) || registration.portGeneration <= 0
      || typeof registration.unregister !== 'function') {
      if (registration && typeof registration.unregister === 'function') {
        try { await revokeRegistration(() => registration.unregister()) } catch { /* original invalid response wins */ }
      }
      throw new PublicError('INVALID_RESPONSE')
    }
    if (!usable() || lifecycleGeneration !== lifecycleAtStart || options.window.webContents.mainFrame !== frameAtStart
      || currentRegistrationAttempt !== attempt) {
      try { await revokeRegistration(() => registration.unregister()) } catch { /* bridge remains fail-closed */ }
      throw new PublicError('OPERATION_FAILED')
    }
    const previous = currentRegistration
    currentRegistration = registration
    currentRegistrationFrame = frameAtStart
    if (previous) {
      try {
        await revokeRegistration(() => previous.unregister())
      } catch {
        if (currentRegistration === registration) currentRegistration = undefined
        rejectMatching(
          (request) => request.documentHandle === undefined,
          rendererPortError('AbortError'),
        )
        try { await revokeRegistration(() => registration.unregister()) } catch { /* both registrations remain fail-closed */ }
        throw new PublicError('OPERATION_FAILED')
      }
    }
    if (!usable() || lifecycleGeneration !== lifecycleAtStart || options.window.webContents.mainFrame !== frameAtStart
      || currentRegistration !== registration) {
      if (currentRegistration === registration) currentRegistration = undefined
      try { await revokeRegistration(() => registration.unregister()) } catch { /* bridge remains fail-closed */ }
      throw new PublicError('OPERATION_FAILED')
    }
    return Object.freeze({ portGeneration: registration.portGeneration })
  })
  const submitCurrentDocumentResponse = async (input: unknown): Promise<void> => {
    if (!isStrictDataRecord(input, ['transportRequestId', 'method', 'result'])
      || !isCanonicalAiConversationRequestId(input.transportRequestId)
      || (input.method !== 'openSnapshot' && input.method !== 'readPage' && input.method !== 'release')) {
      throw new PublicError('INVALID_INPUT')
    }
    const request = pending.get(input.transportRequestId)
    if (!request || request.method !== input.method) throw new PublicError('INVALID_INPUT')
    const parsed = currentDocumentRendererResult(request.method, input.result)
    if (!parsed) throw new PublicError('INVALID_INPUT')
    terminal(input.transportRequestId, request)
    request.resolve(Object.freeze({ ...request.payload, ...parsed }))
  }
  const registerOpenDocument = (
    registry: OpenDocumentRegistry,
    target: WorkspaceAiEditorTarget,
  ): Promise<{ documentHandle: string }> => trackRegistration(async () => {
    if (!usable() || target.windowId !== options.desktopAi.ownerId) {
      throw new PublicError('INVALID_INPUT')
    }
    const targetKey = `${target.windowId}\0${target.workspaceId}\0${target.generation}\0${target.fileIdentity}`
    if (openDocuments.size + pendingDocumentTargets.size >= AI_OPEN_DOCUMENT_LIMIT
      || pendingDocumentTargets.has(targetKey)
      || [...openDocuments.values()].some(({ registration }) => (
      registration.target.windowId === target.windowId
      && registration.target.workspaceId === target.workspaceId
      && registration.target.generation === target.generation
      && registration.target.fileIdentity === target.fileIdentity
    ))) throw new PublicError('INVALID_INPUT')
    pendingDocumentTargets.add(targetKey)
    try {
      const lifecycleAtStart = lifecycleGeneration
      const frameAtStart = options.window.webContents.mainFrame
      const authority = await options.desktopAi.getWorkspaceAuthority()
      if (!usable() || lifecycleGeneration !== lifecycleAtStart || options.window.webContents.mainFrame !== frameAtStart
        || !authority || authority.workspaceId !== target.workspaceId
        || authority.workspaceGeneration !== target.generation) throw new PublicError('INVALID_INPUT')
      let documentHandle: string
      try { documentHandle = randomUUID() } catch { throw new PublicError('OPERATION_FAILED') }
      if (!isCanonicalAiConversationRequestId(documentHandle) || seenDocumentHandles.has(documentHandle)) {
        throw new PublicError('OPERATION_FAILED')
      }
      rememberBounded(seenDocumentHandles, documentHandle, AI_RENDERER_PORT_SEEN_LIMIT)
      const reservation = await registry.reserve(target)
      if (!usable() || lifecycleGeneration !== lifecycleAtStart || options.window.webContents.mainFrame !== frameAtStart) {
        try { await revokeRegistration(() => registry.cancelReservation(reservation)) } catch { /* bridge remains fail-closed */ }
        throw new PublicError('OPERATION_FAILED')
      }
      const port = createOpenDocumentPort(documentHandle)
      let registration: OpenDocumentRegistration
      try {
        registration = await registry.register(reservation, port)
      } catch (error) {
        try { await revokeRegistration(() => registry.cancelReservation(reservation)) } catch { /* original failure wins */ }
        throw error
      }
      if (!usable() || lifecycleGeneration !== lifecycleAtStart || options.window.webContents.mainFrame !== frameAtStart) {
        try { await revokeRegistration(() => registry.unregister(registration)) } catch { /* bridge remains fail-closed */ }
        throw new PublicError('OPERATION_FAILED')
      }
      openDocuments.set(documentHandle, { registry, registration, port, frame: frameAtStart })
      return Object.freeze({ documentHandle })
    } finally {
      pendingDocumentTargets.delete(targetKey)
    }
  })
  const unregisterOpenDocument = async (documentHandle: string): Promise<void> => {
    if (!isCanonicalAiConversationRequestId(documentHandle)) throw new PublicError('INVALID_INPUT')
    const tracked = openDocuments.get(documentHandle)
    if (!tracked || unregisteringDocumentHandles.has(documentHandle)) {
      throw new PublicError('INVALID_INPUT')
    }
    unregisteringDocumentHandles.add(documentHandle)
    rejectMatching((request) => request.documentHandle === documentHandle, rendererPortError('AbortError'))
    try {
      await revokeRegistration(() => tracked.registry.unregister(tracked.registration))
      openDocuments.delete(documentHandle)
    } finally {
      unregisteringDocumentHandles.delete(documentHandle)
    }
  }
  const beginOpenDocumentTransfer = async (
    registry: OpenDocumentRegistry,
    source: WorkspaceAiEditorTarget,
    successorAuthority: OpenDocumentAuthority,
  ): Promise<AiOpenDocumentTransfer | null> => {
    if (!usable() || source.windowId !== options.desktopAi.ownerId
      || successorAuthority.windowId !== source.windowId) throw new PublicError('INVALID_INPUT')
    const matches = [...openDocuments.entries()].filter(([, tracked]) => (
      tracked.registry === registry
      && tracked.registration.target.windowId === source.windowId
      && tracked.registration.target.workspaceId === source.workspaceId
      && tracked.registration.target.generation === source.generation
      && tracked.registration.target.fileIdentity === source.fileIdentity
    ))
    if (matches.length === 0) return null
    if (matches.length !== 1) throw new PublicError('OPERATION_FAILED')
    const [documentHandle, tracked] = matches[0]!
    if (unregisteringDocumentHandles.has(documentHandle)) throw new PublicError('OPERATION_FAILED')
    const sourceRegistration = tracked.registration
    const rebind = source.workspaceId === successorAuthority.workspaceId
      && source.generation === successorAuthority.generation
      ? await registry.beginRebind(sourceRegistration)
      : await registry.beginAuthorityTransfer(sourceRegistration, successorAuthority)
    let phase: 'prepared' | 'published' | 'complete' = 'prepared'
    let destinationGuarded = false
    return Object.freeze({
      guardDestination: async (identity: CanonicalFileIdentity): Promise<void> => {
        if (phase !== 'prepared') throw new PublicError('INVALID_INPUT')
        await rebind.guardDestination(Object.freeze({
          windowId: successorAuthority.windowId,
          workspaceId: successorAuthority.workspaceId,
          generation: successorAuthority.generation,
          fileIdentity: identity,
        }))
        destinationGuarded = true
      },
      handoffDestination: async (identity: CanonicalFileIdentity): Promise<void> => {
        if (phase !== 'prepared' || !destinationGuarded) throw new PublicError('INVALID_INPUT')
        await rebind.handoffDestination(Object.freeze({
          windowId: successorAuthority.windowId,
          workspaceId: successorAuthority.workspaceId,
          generation: successorAuthority.generation,
          fileIdentity: identity,
        }))
      },
      commit: async (successorIdentity: CanonicalFileIdentity): Promise<void> => {
        if (phase !== 'prepared') throw new PublicError('INVALID_INPUT')
        const successor = await rebind.commit(successorIdentity, {
          target: Object.freeze({
            windowId: successorAuthority.windowId,
            workspaceId: successorAuthority.workspaceId,
            generation: successorAuthority.generation,
            fileIdentity: successorIdentity,
          }),
          port: tracked.port,
        })
        tracked.registration = successor
        phase = 'published'
        destinationGuarded = false
      },
      rollback: async (
        restoredSourceIdentity: CanonicalFileIdentity = source.fileIdentity as CanonicalFileIdentity,
        restoredDestinationIdentity?: CanonicalFileIdentity,
      ): Promise<void> => {
        if (phase === 'complete') throw new PublicError('INVALID_INPUT')
        if (phase === 'prepared') {
          if (restoredDestinationIdentity) {
            const restoredDestination = Object.freeze({
              ...successorAuthority,
              fileIdentity: restoredDestinationIdentity,
            })
            if (destinationGuarded) {
              await rebind.handoffDestination(restoredDestination)
            } else {
              await rebind.guardDestination(restoredDestination)
              destinationGuarded = true
            }
            tracked.registration = await rebind.rollback()
            phase = 'complete'
            return
          }
          if (restoredSourceIdentity !== source.fileIdentity) {
            if (successorAuthority.workspaceId !== source.workspaceId
              || successorAuthority.generation !== source.generation) {
              throw new PublicError('OPERATION_FAILED')
            }
            const restoredTarget = Object.freeze({
              ...source,
              fileIdentity: restoredSourceIdentity,
            })
            if (destinationGuarded) {
              await rebind.handoffDestination(restoredTarget)
            } else {
              await rebind.guardDestination(restoredTarget)
              destinationGuarded = true
            }
            tracked.registration = await rebind.commit(restoredSourceIdentity, {
              target: restoredTarget,
              port: tracked.port,
            })
            phase = 'complete'
            return
          }
          tracked.registration = await rebind.rollback()
          phase = 'complete'
          return
        }
        const published = tracked.registration
        const restoredTarget = Object.freeze({
          ...source,
          fileIdentity: restoredSourceIdentity,
        })
        const restoredDestinationGuard = restoredDestinationIdentity
          ? await registry.guardDestination(Object.freeze({
              ...successorAuthority,
              fileIdentity: restoredDestinationIdentity,
            }))
          : null
        try {
          const reverse = published.target.workspaceId === source.workspaceId
            && published.target.generation === source.generation
            ? await registry.beginRebindGuardingDestination(published, restoredTarget)
            : await registry.beginAuthorityTransferGuardingDestination(
                published,
                source,
                restoredTarget,
              )
          tracked.registration = await reverse.commit(restoredSourceIdentity, {
            target: restoredTarget,
            port: tracked.port,
          })
          phase = 'complete'
        } finally {
          await restoredDestinationGuard?.release()
        }
      },
    })
  }
  const submitOpenDocumentResponse = async (input: unknown): Promise<void> => {
    if (!isStrictDataRecord(input, [
      'transportRequestId', 'documentHandle', 'method', 'result',
    ]) || !isCanonicalAiConversationRequestId(input.transportRequestId)
      || !isCanonicalAiConversationRequestId(input.documentHandle)
      || (input.method !== 'captureReadSnapshot' && input.method !== 'planReplacement'
        && input.method !== 'applyTransaction' && input.method !== 'queryOutcome')) {
      throw new PublicError('INVALID_INPUT')
    }
    const request = pending.get(input.transportRequestId)
    if (!request || request.method !== input.method
      || request.documentHandle !== input.documentHandle
      || !openDocuments.has(input.documentHandle)) throw new PublicError('INVALID_INPUT')
    const parsed = openDocumentRendererResult(input.method, input.result)
    if (!parsed) throw new PublicError('INVALID_INPUT')
    terminal(input.transportRequestId, request)
    request.resolve(openDocumentRendererResponse(request, parsed))
  }
  const validCloseOwner = (state: CloseQuiescenceState): boolean =>
    closeQuiescence === state && !disposed && !drainPromise && !registrationCleanupFailed
    && lifecycleGeneration === state.generation
    && !options.window.isDestroyed() && !options.window.webContents.isDestroyed()
    && options.window.webContents.mainFrame === state.frame
    && currentRegistration === state.current
    && (!currentRegistration || currentRegistrationFrame === state.frame)
    && openDocuments.size === state.open.size
    && [...openDocuments].every(([handle, tracked]) => tracked.frame === state.frame
      && state.open.get(handle) === tracked.registration)

  // Close recovery retains only already-committed handles owned by this exact
  // renderer lifetime. Ordinary pause/dispose remains destructive.
  const quiesceForClose = (): Promise<void> => {
    if (closeQuiescence) return closeQuiescence.completion
    accepting = false
    const state: CloseQuiescenceState = {
      frame: options.window.webContents.mainFrame, generation: lifecycleGeneration,
      current: currentRegistration,
      open: new Map([...openDocuments].map(([handle, tracked]) => [handle, tracked.registration])),
      completion: Promise.resolve(),
    }
    closeQuiescence = state
    state.completion = (async () => {
      await Promise.allSettled([...inFlightRegistrations])
      if (pending.size) await new Promise<void>(resolve => pendingDrainWaiters.add(resolve))
      const authority = await options.desktopAi.getWorkspaceAuthority()
      if (!validCloseOwner(state) || [...openDocuments.values()].some(({ registration }) =>
        !authority || registration.target.workspaceId !== authority.workspaceId
        || registration.target.generation !== authority.workspaceGeneration)) throw new PublicError('OPERATION_FAILED')
      state.authority = authority ? { ...authority } : null
    })()
    return state.completion
  }
  const resumeAfterClose = async (beforeAdmission?: () => void | Promise<void>): Promise<void> => {
    const state = closeQuiescence
    if (!state) throw new PublicError('OPERATION_FAILED')
    await state.completion
    const verify = async (): Promise<void> => {
      const authority = await options.desktopAi.getWorkspaceAuthority()
      if (!validCloseOwner(state) || authority?.workspaceId !== state.authority?.workspaceId
        || authority?.workspaceGeneration !== state.authority?.workspaceGeneration) throw new PublicError('OPERATION_FAILED')
    }
    await verify()
    if (beforeAdmission) {
      await beforeAdmission()
      await verify()
    }
    closeQuiescence = undefined
    accepting = true
  }
  const pauseAndDrain = (): Promise<void> => {
    if (drainPromise) return drainPromise
    accepting = false
    drainCompleted = false
    lifecycleGeneration += 1
    currentRegistrationAttempt += 1
    rejectAll(rendererPortError('AbortError'))
    drainPromise = (async () => {
      await Promise.allSettled([...inFlightRegistrations])
      const registrations = [...openDocuments.entries()]
      openDocuments.clear()
      const results = await Promise.allSettled([
        unregisterCurrentDocumentPort(),
        ...registrations.map(([, tracked]) => revokeRegistration(() => tracked.registry.unregister(tracked.registration))),
      ])
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'AI renderer registration cleanup failed')
      if (registrationCleanupFailed) throw new PublicError('OPERATION_FAILED')
      drainCompleted = true
    })()
    return drainPromise
  }
  const resume = (): void => {
    if (closeQuiescence || disposed || registrationCleanupFailed || !drainCompleted || options.window.isDestroyed()
      || options.window.webContents.isDestroyed()) return
    accepting = true
    drainCompleted = false
    drainPromise = undefined
  }
  const dispose = (): Promise<void> => {
    disposed = true
    return pauseAndDrain()
  }
  return Object.freeze({
    registerCurrentDocumentPort,
    unregisterCurrentDocumentPort,
    submitCurrentDocumentResponse,
    registerOpenDocument,
    beginOpenDocumentTransfer,
    unregisterOpenDocument,
    submitOpenDocumentResponse,
    quiesceForClose,
    resumeAfterClose,
    pauseAndDrain,
    resume,
    dispose,
    pendingCount: () => pending.size,
  })
}

export interface BackgroundIpcService {
  open(target: BackgroundTarget): Promise<void>
  get(target: BackgroundTarget): Promise<BackgroundPresentation>
  choose(target: BackgroundTarget): Promise<BackgroundPresentation | null>
  remove(target: BackgroundTarget): Promise<BackgroundPresentation>
  preview(target: BackgroundTarget, settings: BackgroundSettings): Promise<void>
  apply(target: BackgroundTarget, settings: BackgroundSettings): Promise<import('../../shared/background-settings').BackgroundApplyResult>
  cancel(target: BackgroundTarget): Promise<void>
}

function sameWindowsFilesystemPath(first: string, second: string): boolean {
  return path.win32.normalize(first).toLocaleLowerCase('en-US')
    === path.win32.normalize(second).toLocaleLowerCase('en-US')
}

function canonicalWorkspacePathSegments(value: string): string[] | null {
  if (
    value.includes('\0')
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || path.posix.isAbsolute(value)
  ) return null
  const segments = value.split(/[\\/]+/u).filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
    return null
  }
  return segments.map((segment) => segment.toLocaleLowerCase('en-US'))
}

function relativeWorkspacePathContains(parent: string, candidate: string): boolean {
  const parentSegments = canonicalWorkspacePathSegments(parent)
  const candidateSegments = canonicalWorkspacePathSegments(candidate)
  return parentSegments !== null
    && candidateSegments !== null
    && parentSegments.length <= candidateSegments.length
    && parentSegments.every((segment, index) => candidateSegments[index] === segment)
}

export function createIpcOperations(deps: {
  updates?: import('../updates/update-ipc').UpdateWindowPort

  workspaceFileDrag?: Pick<WorkspaceFileDrag, 'start'>
  claimWorkspaceIntroduction?(legacySeen: boolean): Promise<{ showIntroduction: boolean }>
  settingsPreferences?: Pick<SettingsPreferenceService, 'read' | 'patch'>
  chooseDirectory: () => Promise<string | null>
  chooseStickyNoteImage?: (noteId: string) => Promise<string | null>
  inspectDroppedPath?: typeof inspectDroppedPath
  getStickyNoteForegroundSourceId?: () => string | undefined
  workspace: WorkspaceService
  documents: DocumentService
  stickyNotes?: StickyNoteIpcService
  backgrounds?: BackgroundIpcService
  arknote?: ArknoteIpcClient
  drafts?: DraftService
  imageContext?: Pick<ImageContextService, 'reveal' | 'copyToClipboard' | 'saveCopy' | 'copyTo'>
  mermaidImageExport?: Pick<MermaidImageExportService, 'copyPng' | 'save'>
  openMermaidViewer?: (input: MermaidViewerSnapshot) => Promise<void>
  getMermaidViewerSnapshot?: () => MermaidViewerSnapshot
  workspaceEntries?: Pick<WorkspaceEntryService, 'createFolder' | 'renameEntry' | 'duplicateDocument' | 'trashEntry' | 'revealEntry' | 'openEntryWindow' | 'properties' | 'rootProperties'>
  workspaceColors?: {
    get(): Promise<WorkspaceColorMarksSnapshot>
    set(relativePath: string, color: WorkspaceColorId | null): Promise<WorkspaceColorMarksSnapshot>
    move(fromRelativePath: string, toRelativePath: string): Promise<WorkspaceColorMarksSnapshot>
    delete(relativePath: string): Promise<WorkspaceColorMarksSnapshot>
  }
  chooseSavePath?: (suggestedFileName?: string) => Promise<string | null>
  assets?: AssetService
  clipboardNoteId?: string
  stickyNoteDataRoot?: string
  docx?: DocxOperations
  chooseDocxExportPath?: (suggestedBaseName: string) => Promise<string | null>
  xlsx?: Pick<XlsxExportService, 'export'>
  chooseXlsxExportPath?: (suggestedBaseName: string) => Promise<string | null>
  readClipboardFormats?: () => ClipboardFormatsSnapshot
  onDocumentSourceChanged?: (sourceDocxPath: string | null) => void
  openAsset?: (url: string) => Promise<void>
  openDocumentWindow?: (absolutePath: string, location?: DocumentViewLocation) => Promise<void>
  getSearchPreferences?: () => BrowserSearchPreferences
  getKeyboardShortcuts?: () => Promise<ObservedShortcutSnapshot>
  updateKeyboardShortcuts?: (update: ObservedShortcutUpdate) => Promise<ObservedShortcutUpdateResult>
  setShortcutRecording?: (active: boolean) => void
  setSearchPreferences?: (preferences: BrowserSearchPreferences) => Promise<void>
  getEditorAppearancePreferences?: () => EditorAppearanceSnapshot
  setEditorAppearancePreferences?: (
    preferences: EditorAppearancePreferences,
  ) => Promise<EditorAppearanceSnapshot>
  compareAndSetEditorAppearancePreferences?: (
    expectedRevision: number,
    expected: EditorAppearancePreferences,
    replacement: EditorAppearancePreferences,
  ) => Promise<EditorAppearanceSnapshot>
  getLayoutPreferences?: () => LayoutPreferencesSnapshot
  compareAndSetLayoutPreferences?: (
    expectedRevision: number,
    expected: LayoutPreferences,
    replacement: LayoutPreferences,
  ) => Promise<{ applied: boolean; snapshot: LayoutPreferencesSnapshot }>
  getStickyNotePreferences?: () => StickyNotePreferences
  setStickyNotePreferences?: (preferences: StickyNotePreferences) => Promise<void>
  shellIntegration?: Pick<ShellIntegrationService, 'readObserved' | 'updateObserved'>
  defaultApplications?: Pick<DefaultApplicationsService, 'getStatus' | 'openSettings' | 'setEnabled'>
  getDesktopLifecyclePreferences?: () => DesktopLifecyclePreferences
  setDesktopLifecyclePreferences?: (preferences: DesktopLifecyclePreferences) => Promise<void>
  getArknotePreferences?: () => ArknotePreferences | Promise<ArknotePreferences>
  setArknotePreferences?: (preferences: ArknotePreferencesUpdate) => Promise<ArknotePreferences>
  previewStickyNoteWallpaperAppearances?: (appearances: StickyNoteWallpaperAppearances | null) => Promise<StickyNoteWallpaperAppearances>
  previewArknoteThemeColor?: (themeColor: string) => Promise<void>
  getSystemFonts?: () => Promise<string[]>
  modelCapabilityRules?: Pick<ModelCapabilityRulesStore, 'getState' | 'update'>
  observedModelConnections?: Pick<TransactionalModelConnectionService,
    'getSettings' | 'connect' | 'listModels' | 'test' | 'delete' | 'setFeature' | 'acceptTranslationPrivacyNotice'>
  observedCodexCliConnections?: Pick<TransactionalCodexConnectionService, 'test' | 'remove'>
  modelConnections?: Pick<
    ModelConnectionService,
    'getSettings' | 'connect' | 'listModels' | 'test' | 'delete'
      | 'setSelectionTranslation' | 'setScreenshotTranslation' | 'setFloatingTranslation' | 'acceptTranslationPrivacyNotice'
  > & {
    setAiConversation?(input: AiConversationSettings): Promise<LargeModelSettings>
  }
  codexCliConnections?: Pick<CodexCliConnectionService, 'test' | 'remove'>
  ensureCodexCli?(signal?: AbortSignal): Promise<boolean>
  startCodexCliLogin?(): Promise<CodexCliLoginOutcome>
  cancelCodexCliLogin?(): Promise<void>
  translations?: Pick<TranslationSessionService, 'start' | 'cancel'>
  aiConversations?: Pick<
    AiConversationSessionService,
    'start' | 'cancel' | 'submitAuthorizationResult' | 'setCapabilities'
      | 'clearConversation' | 'notifyCurrentDocumentChanged'
  >
  desktopAi?: Pick<DesktopAiIpcAuthority,
    'ownerId' | 'getWorkspaceAuthority' | 'prepareWorkspaceSwitch'
      | 'activateWorkspace' | 'abortWorkspaceSwitch'>
  aiRendererPorts?: AiRendererPortBridge
  openDocumentRegistry?: OpenDocumentRegistry
  screenshots?: Pick<ScreenshotCaptureCoordinator, 'updatePointer' | 'ready' | 'commit' | 'cancel'>
  screenshotResults?: ScreenshotResultOperations
  screenshotOcrHost?: Pick<ScreenshotResultOperations, 'submit' | 'settleOcr'>
  screenshotOcrModels?: Pick<ScreenshotOcrModelManager, 'getState' | 'getObservedState' | 'downloadMedium' | 'cancelMediumDownload' | 'removeMedium'> & { initialize?(): Promise<void> }
  searchSelection?: (query: string) => Promise<void>
  openExternal?: (target: string) => Promise<void>
  aiMessageLinkIo?: AiMessageLinkIo
  openApplicationMenu?: (section: AppMenuSectionId, x: number, y: number) => void
  executeApplicationMenuItem?: (itemId: string) => void
  recordRecentDocument?: (absolutePath: string) => Promise<readonly string[]>
  updateApplicationMenuWindowState?: (state: ApplicationMenuWindowState) => void
  printDocument?: (input: PrintDocumentInput) => Promise<void>
  takePrintDocument?: (token: string) => PrintSurfaceDocumentInput
  readyPrintDocument?: (token: string) => void
  controlWindow?: (action: WindowControlAction) => WindowStateSnapshot
  getWindowState?: () => WindowStateSnapshot
  getLastWorkspace: () => string | null
  setLastWorkspace: (root: string | null) => Promise<void> | void
  getLastFolderPickerPath?: () => string | null
  setLastFolderPickerPath?: (root: string | null) => Promise<void> | void
  reportError: (error: unknown) => void
  showItemInFolder?: (absolutePath: string) => void
  trashItem?: (absolutePath: string) => Promise<void>
  createSaveAsIntentId?: () => string
  now?: () => number
}) {
  let ownedDocument: DocumentSnapshot | null = null
  let ownedAbsolutePath: string | null = null
  let ownedDraftId: string | null = null
  const draftOwner = {}
  let recoveryGrant: string | null = null
  let claimedRecoveryId: string | null = null
  let savedDraftId: string | null = null
  let attemptedDraftId: string | null = null
  let ownedDocumentSession = 0
  const documentView = createDocumentViewService({
    getSource: () => ownedAbsolutePath ? { absolutePath: ownedAbsolutePath, session: ownedDocumentSession } : null,
    openDocument: async (absolutePath, location) => {
      if (!deps.openDocumentWindow) throw new PublicError('OPERATION_FAILED')
      if (location) await deps.openDocumentWindow(absolutePath, location)
      else await deps.openDocumentWindow(absolutePath)
    },
    openExternalPath: async absolutePath => {
      if (!deps.openExternal) throw new PublicError('OPERATION_FAILED')
      await deps.openExternal(absolutePath)
    },
    revealPath: absolutePath => {
      if (!deps.showItemInFolder) throw new PublicError('OPERATION_FAILED')
      deps.showItemInFolder(absolutePath)
    },
  })
  const documentViewId = (input: unknown): string => {
    if (!isExactOwnInput(input, ['id'])) throw new PublicError('INVALID_INPUT')
    const id = parseDocumentViewId(input.id)
    if (!id) throw new PublicError('INVALID_INPUT')
    return id
  }
  let ownedDraftMutationRevision = 0
  let activeQueuedSaveOwner: { session: number; relativePath: string | null } | null = null
  let pendingDroppedPath: {
    token: string
    expiresAt: number
    dropped: Awaited<ReturnType<WorkspaceService['validateDroppedPath']>>
    document: DocumentSnapshot
    sourceDocument: DocumentSnapshot | null
    sourceSession: number
    sourceDraftRevision: number
    sourceRoot: string | null
    sourceEpoch: number | null
  } | null = null
  let activeQueuedAutosaveDraftId: string | null = null
  let draftTerminalEpoch = 0
  let activeQueuedDraftEpoch = 0
  const draftTerminalEpochs = new Map<string, number>()
  const recordDraftTerminal = (draftId: string): void => {
    draftTerminalEpochs.set(draftId, ++draftTerminalEpoch)
  }
  let notifyingDocumentSource = false
  const authorityQueue = new SerialOperationQueue()
  const docxExportTargets = new Map<string, string>()
  const ownedAiRequestIds = new Set<string>()
  const retainedClipboardDrafts = new Set<string>()
  const releaseClipboardResources = (): Promise<void> => {
    const retained = [...retainedClipboardDrafts]
    return enqueueAuthorityOperation(async () => {
      for (const draftId of retained) {
        await deps.drafts?.releaseSavedClipboardHistory(draftId)
        retainedClipboardDrafts.delete(draftId)
      }
    })
  }
  const migrateOwnedAssets = (draftId: string | null, markdown: string, target: string) => (
    typeof deps.assets!.migrateOwnedDraftAssets === 'function'
      ? deps.assets!.migrateOwnedDraftAssets([...new Set([...(draftId ? [draftId] : []), ...retainedClipboardDrafts])], markdown, target)
      : draftId ? deps.assets!.migrateDraftAssets(draftId, markdown, target)
        : Promise.resolve({ markdown, rollback: async () => undefined })
  )
  const settledAiAuthorizationKeys = new Set<string>()
  type SaveAsIntent = Readonly<{
    intentId: string
    input: SaveDocumentAsInput
    ownerId: number
    documentSession: number
    draftMutationRevision: number
    sourceRoot: string | null
    sourceEpoch: number
    sourceAuthority: WindowAiWorkspaceAuthority | null
    targetRoot: string
    targetWorkspace: Readonly<{ name: string; absolutePath: string }>
    targetRelativePath: string
    changesWorkspace: boolean
    expiresAt: number
  }>
  const saveAsIntents = new Map<string, SaveAsIntent>()
  const seenSaveAsIntentIds = new Set<string>()
  const now = deps.now ?? Date.now
  const createSaveAsIntentId = deps.createSaveAsIntentId ?? randomUUID

  const rememberDocxExportTarget = (
    documentSessionId: string,
    absolutePath: string,
  ): void => {
    docxExportTargets.delete(documentSessionId)
    docxExportTargets.set(documentSessionId, absolutePath)
    while (docxExportTargets.size > 64) {
      const oldest = docxExportTargets.keys().next().value as string | undefined
      if (!oldest) break
      docxExportTargets.delete(oldest)
    }
  }

  const requireModelConnections = () => {
    if (!deps.observedModelConnections) throw new Error('Model settings authority is unavailable')
    return deps.observedModelConnections
  }

  const requireCodexCliConnections = () => {
    if (!deps.observedCodexCliConnections) throw new Error('Codex settings authority is unavailable')
    return deps.observedCodexCliConnections
  }
  let codexLoginAttempt: AbortController | undefined
  let codexLoginCancellation: Promise<void> | undefined

  const requireTranslations = () => {
    if (!deps.translations) throw new Error('Translation sessions are unavailable')
    return deps.translations
  }

  const requireAiConversations = () => {
    if (!deps.aiConversations) throw new Error('AI conversation sessions are unavailable')
    return deps.aiConversations
  }

  const requireDesktopAi = () => {
    if (!deps.desktopAi) throw new PublicError('OPERATION_FAILED')
    return deps.desktopAi
  }

  const currentAiWorkspaceAuthority = async (): Promise<WindowAiWorkspaceAuthority> => {
    const authority = await requireDesktopAi().getWorkspaceAuthority()
    if (!authority || typeof authority.workspaceId !== 'string'
      || typeof authority.workspaceGeneration !== 'string'
      || authority.workspaceId.length === 0 || authority.workspaceId.length > 512
      || authority.workspaceGeneration.length === 0 || authority.workspaceGeneration.length > 512) {
      throw new PublicError('OPERATION_FAILED')
    }
    return Object.freeze({
      workspaceId: authority.workspaceId,
      workspaceGeneration: authority.workspaceGeneration,
    })
  }

  const saveAsSourceAuthority = async (root: string | null): Promise<WindowAiWorkspaceAuthority | null> => {
    if (root !== null) return await currentAiWorkspaceAuthority()
    // Empty source is permitted only for an unnamed document, never as a fallback
    // after a real workspace's validation or AI authority lookup failed.
    if (ownedDocument !== null || await requireDesktopAi().getWorkspaceAuthority() !== null) {
      throw new PublicError('INVALID_INPUT')
    }
    return null
  }

  const saveDocumentPreservingEditor = async (input: SaveDocumentInput): Promise<SaveDocumentResult> => {
    if (!deps.desktopAi || !deps.aiRendererPorts || !deps.openDocumentRegistry) {
      return await deps.documents.save(input)
    }
    const authority = await currentAiWorkspaceAuthority()
    const owner = Object.freeze({
      windowId: deps.desktopAi.ownerId,
      workspaceId: authority.workspaceId,
      generation: authority.workspaceGeneration,
    })
    const handoff: {
      transfer: AiOpenDocumentTransfer | null
      sourceIdentity?: CanonicalFileIdentity
      successorIdentity?: CanonicalFileIdentity
    } = { transfer: null }
    try {
      const saved = await deps.documents.saveForMain(input, async (successor) => {
        // Publication remains after replacement; the pre-replace guard already
        // prevents the newly visible identity from being mistaken for closed.
        await handoff.transfer?.handoffDestination(successor.identity)
      }, async (replacement) => {
        handoff.sourceIdentity = replacement.sourceIdentity
        handoff.successorIdentity = replacement.successorIdentity
        handoff.transfer = await deps.aiRendererPorts!.beginOpenDocumentTransfer(
          deps.openDocumentRegistry!,
          Object.freeze({ ...owner, fileIdentity: replacement.sourceIdentity }),
          owner,
        )
        await handoff.transfer?.guardDestination(replacement.successorIdentity)
      })
      await handoff.transfer?.commit(saved.identity)
      return { ...saved.result }
    } catch (error) {
      if (handoff.transfer) {
        try {
          // A failed rename/verification may already have replaced the file.
          // Restore the binding only to an identity verified at its real path.
          const actual = await deps.documents.readForMain(input.relativePath)
          if (actual.identity !== handoff.sourceIdentity && actual.identity !== handoff.successorIdentity) {
            throw new PublicError('DOCUMENT_CONFLICT')
          }
          await handoff.transfer.rollback(actual.identity)
        } catch (rollbackError) {
          // Keep the transfer guarded when its physical outcome is uncertain.
          throw new DocumentRollbackIncompleteError(error, rollbackError)
        }
      }
      throw error
    }
  }

  const assertAiAuthority = async (input: Record<string, unknown>): Promise<WindowAiWorkspaceAuthority> => {
    const authority = await currentAiWorkspaceAuthority()
    if (input.workspaceId !== authority.workspaceId
      || input.workspaceGeneration !== authority.workspaceGeneration) {
      throw new PublicError('INVALID_INPUT')
    }
    return authority
  }

  const requireScreenshotOcrModels = () => {
    if (!deps.screenshotOcrModels) throw new Error('Screenshot OCR models are unavailable')
    return deps.screenshotOcrModels
  }

  const proxyStickyNotes = deps.arknote
    ? createArknoteStickyNoteIpcService(deps.arknote)
    : undefined
  const requireStickyNotes = () => {
    const service = deps.stickyNotes ?? proxyStickyNotes
    if (!service) throw new Error('Sticky notes are unavailable')
    return service
  }

  type PreparedDocumentOwnership = {
    snapshot: DocumentSnapshot
    absolutePath: string
  }

  const enqueueAuthorityOperation = <T>(operation: () => Promise<T>): Promise<T> => {
    return authorityQueue.run(operation)
  }

  const reportErrorWithoutThrow = (error: unknown): void => {
    try {
      deps.reportError(error)
    } catch {
      // Error reporting must never change document authority.
    }
  }

  const reportFixedError = (code: string, message: string): void => {
    reportErrorWithoutThrow(Object.assign(new Error(message), { code }))
  }

  const notifyDocumentSourceChanged = (sourceAbsolutePath: string | null): void => {
    if (notifyingDocumentSource) return
    notifyingDocumentSource = true
    try {
      deps.onDocumentSourceChanged?.(sourceAbsolutePath)
    } catch {
      reportFixedError(
        'DOCUMENT_SOURCE_NOTIFICATION_FAILED',
        'Document source notification did not complete',
      )
    } finally {
      notifyingDocumentSource = false
    }
  }

  const currentWorkspaceRootOrNull = (): string | null => {
    try {
      return deps.workspace.getRoot()
    } catch {
      return null
    }
  }

  const prepareDocumentOwnership = async (
    snapshot: DocumentSnapshot,
  ): Promise<PreparedDocumentOwnership> => ({
    snapshot,
    absolutePath: await deps.workspace.resolveExistingDocument(snapshot.relativePath),
  })

  const commitDocumentOwnership = (
    prepared: PreparedDocumentOwnership,
    preserveAssetHistory = false,
  ): DocumentSnapshot => {
    if (!preserveAssetHistory) void releaseClipboardResources().catch(reportErrorWithoutThrow)
    ownedDocumentSession += 1
    ownedDocument = prepared.snapshot
    ownedAbsolutePath = prepared.absolutePath
    ownedDraftId = null
    attemptedDraftId = null
    notifyDocumentSourceChanged(null)
    return prepared.snapshot
  }

  const ownDocument = async (
    snapshot: DocumentSnapshot,
  ): Promise<DocumentSnapshot> => (
    commitDocumentOwnership(await prepareDocumentOwnership(snapshot))
  )

  const clearOwnedDocument = (
    sourceAbsolutePath: string | null = null,
    preserveAssetHistory = false,
  ): void => {
    if (!preserveAssetHistory) void releaseClipboardResources().catch(reportErrorWithoutThrow)
    ownedDocumentSession += 1
    ownedDocument = null
    ownedAbsolutePath = null
    ownedDraftId = null
    attemptedDraftId = null
    notifyDocumentSourceChanged(sourceAbsolutePath)
  }

  const seedStartupDocumentOwnership = (
    snapshot: DocumentSnapshot,
  ): Promise<void> => enqueueAuthorityOperation(async () => {
    if (
      ownedDocumentSession !== 0
      || ownedDocument !== null
      || ownedAbsolutePath !== null
      || ownedDraftId !== null
    ) throw new PublicError('INVALID_INPUT')
    await ownDocument(snapshot)
  })

  const failAfterWorkspaceActivation = async (input: {
    cause: unknown
    message: string
    previousRoot: string | null
    rootChanged: boolean
    previousWorkspace: string | null
    lastWorkspaceChanged: boolean
    previousFolderPickerPath?: string | null
    folderPickerPathChanged?: boolean
    beforeRootRestore?: () => Promise<void>
  }): Promise<never> => {
    const rollbackErrors: unknown[] = []
    if (input.beforeRootRestore) {
      try {
        await input.beforeRootRestore()
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (input.rootChanged) {
      let previousRootRestored = false
      try {
        await deps.workspace.restoreCanonicalRoot(input.previousRoot)
        previousRootRestored = true
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
      if (!previousRootRestored) {
        try {
          await deps.workspace.restoreCanonicalRoot(null)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
        clearOwnedDocument()
      }
      if (deps.assets) {
        try {
          await deps.assets.allowWorkspaceRoot()
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    if (input.lastWorkspaceChanged) {
      try {
        await deps.setLastWorkspace(input.previousWorkspace)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (
      input.folderPickerPathChanged
      && deps.setLastFolderPickerPath
    ) {
      try {
        await deps.setLastFolderPickerPath(input.previousFolderPickerPath ?? null)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      const aggregate = new AggregateError([input.cause, ...rollbackErrors], input.message)
      reportErrorWithoutThrow(aggregate)
      throw aggregate
    }
    throw input.cause
  }

  const requireOwnedDraft = (draftId: string): void => {
    if (ownedDraftId !== draftId) throw new PublicError('INVALID_INPUT')
  }

  // Main-only authorization, called only for a draft selected by recovery.
  // Merely knowing a UUID or receiving a renderer path confers no ownership.
  const authorizeDraftRecovery = (draftId: string): Promise<void> => enqueueAuthorityOperation(async () => {
    if (!deps.drafts || recoveryGrant || ownedDraftId) throw new PublicError('INVALID_INPUT')
    if (!await deps.drafts.read(draftId)) throw new PublicError('INVALID_INPUT')
    deps.drafts.claim(draftId, draftOwner)
    recoveryGrant = draftId
  })

  type DraftFinalizeTransaction = Readonly<{
    retainsAssets?: true
    commit(): Promise<void>
    rollback(): Promise<void>
  }>
  type TransactionalDraftService = DraftService & {
    beginFinalizeSaved(draftId: string, options?: { retainAssetHistory?: boolean }): Promise<DraftFinalizeTransaction>
  }
  // Save As may have published the target and consumed the AI switch ticket
  // before durable draft completion fails. Retain only that final step;
  // replaying the document write or independently rolling it back is unsafe.
  let pendingDraftFinalization: { draftId: string; transaction: DraftFinalizeTransaction } | null = null
  type RollbackDocumentService = DocumentService & {
    removeCreatedForRollback(
      relativePath: string,
      identity: CanonicalFileIdentity,
      revision: string,
    ): Promise<void>
  }

  const purgeExpiredSaveAsIntents = (): void => {
    const current = now()
    if (!Number.isFinite(current)) throw new PublicError('OPERATION_FAILED')
    for (const [intentId, intent] of saveAsIntents) {
      if (intent.expiresAt <= current) saveAsIntents.delete(intentId)
    }
  }

  const sameWorkspaceAuthority = (
    left: WindowAiWorkspaceAuthority,
    right: WindowAiWorkspaceAuthority,
  ): boolean => left.workspaceId === right.workspaceId
    && left.workspaceGeneration === right.workspaceGeneration

  const rollbackSaveAsTarget = async (written: Readonly<{
    relativePath: string
    identity: CanonicalFileIdentity
    document: DocumentSnapshot
    previous: DocumentSnapshot | null
    previousIdentity: CanonicalFileIdentity | null
  }>, publish?: Parameters<DocumentService['saveForMain']>[1]): Promise<CanonicalFileIdentity | null> => {
    if (written.previous === null) {
      await (deps.documents as RollbackDocumentService).removeCreatedForRollback(
        written.relativePath,
        written.identity,
        written.document.revision,
      )
      return null
    }
    const restored = await deps.documents.saveForMain({
      relativePath: written.relativePath,
      markdown: written.previous.markdown,
      expectedRevision: written.document.revision,
      encoding: written.previous.encoding,
      newline: written.previous.newline,
    }, publish)
    return restored.identity
  }

  const updates = () => { if (!deps.updates?.isAlive()) throw new PublicError('OPERATION_FAILED'); return deps.updates }
  const updateAction = async <T>(input: unknown, action: () => T | Promise<T>) => {
    try { noInputSchema.parse(input); return { ok: true as const, value: await action() } } catch (error) { return ipcFailure(error) }
  }
  const operations = {
    getAppUpdateState: (input?: unknown) => updateAction(input, () => updates().getState()),
    openUpdateWebsite: (input?: unknown) => updateAction(input, () => updates().openWebsite()),
    requestRequiredUpdateExit: (input?: unknown) => updateAction(input, () => { updates().requestExit(); return null }),
    protectUpdateWork: (input?: unknown) => updateAction(input, () => { updates().protect(); return null }),
    performUpdateAction: async (input?: unknown) => {
      try {
        const action = parseUpdateAction(input)
        if (!action) throw new PublicError('INVALID_INPUT')
        const port = updates()
        if (!port.action) throw new PublicError('OPERATION_FAILED')
        await port.action(action); return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    notifyUpdateAbout: async (input?: unknown) => {
      try { const parsed = parseUpdateAbout(input); if (!parsed) throw new PublicError('INVALID_INPUT'); updates().about(parsed); return { ok: true as const, value: null } } catch (error) { return ipcFailure(error) }
    },
    claimWorkspaceIntroduction: async (input?: unknown) => {
      try {
        if (!isStrictDataRecord(input, ['legacySeen']) || typeof input.legacySeen !== 'boolean') throw new PublicError('INVALID_INPUT')
        if (!deps.claimWorkspaceIntroduction) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value: await deps.claimWorkspaceIntroduction(input.legacySeen) }
      } catch (error) { return ipcFailure(error) }
    },
    chooseWorkspace: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        const root = await deps.chooseDirectory()
        if (!root) return { ok: true as const, value: null }
        const previousWorkspace = deps.getLastWorkspace()
        const previousFolderPickerPath = deps.getLastFolderPickerPath?.() ?? null
        const activation = await deps.workspace.validateRoot(root)
        try {
          await deps.setLastWorkspace(activation.summary.absolutePath)
          await deps.setLastFolderPickerPath?.(activation.summary.absolutePath)
          const workspace = await activation.commit()
          await deps.assets?.allowWorkspaceRoot()
          clearOwnedDocument()
          return { ok: true as const, value: workspace }
        } catch (activationError) {
          try {
            await deps.setLastWorkspace(previousWorkspace)
            await deps.setLastFolderPickerPath?.(previousFolderPickerPath)
          } catch (rollbackError) {
            deps.reportError(new AggregateError(
              [activationError, rollbackError],
              'Workspace activation and settings rollback failed',
            ))
          }
          throw activationError
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    restoreWorkspace: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        const root = deps.getLastWorkspace()
        const workspace = root ? await deps.workspace.restoreCanonicalRoot(root) : null
        if (workspace) {
          await deps.assets?.allowWorkspaceRoot()
          clearOwnedDocument()
        }
        return { ok: true as const, value: workspace }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    startWorkspaceFileDrag: async (input?: unknown, accepting: () => boolean = () => false) => {
      try {
        if (!deps.workspaceFileDrag) throw new PublicError('OPERATION_FAILED')
        await deps.workspaceFileDrag.start(input, accepting)
        return { ok: true as const, value: undefined }
      } catch (error) { return ipcFailure(error) }
    },
    listDirectory: async (input?: unknown) => {
      try {
        const { relativePath } = relativePathSchema.parse(input)
        return { ok: true as const, value: await deps.workspace.listDirectory(relativePath) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    inspectDroppedPath: async (input?: unknown) => {
      try {
        const { absolutePath, resolveDocumentShortcut } = droppedPathInspectionSchema.parse(input)
        const inspect = deps.inspectDroppedPath ?? inspectDroppedPath
        return {
          ok: true as const,
          value: await (resolveDocumentShortcut ? inspect(absolutePath, true) : inspect(absolutePath)),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    prepareDroppedPath: async (input?: unknown) => {
      try {
        pendingDroppedPath = null
        const { absolutePath } = droppedPathSchema.parse(input)
        const dropped = await deps.workspace.validateDroppedPath(absolutePath)
        if (!dropped.documentPath) throw new PublicError('INVALID_INPUT')
        const read = await deps.documents.readFromValidatedRootForMain(
          dropped.activation.summary.absolutePath, dropped.documentPath,
        )
        const token = randomUUID()
        const sourceRoot = currentWorkspaceRootOrNull()
        pendingDroppedPath = {
          token, expiresAt: now() + 60_000, dropped, document: { ...read.document },
          sourceDocument: ownedDocument, sourceSession: ownedDocumentSession,
          sourceDraftRevision: ownedDraftMutationRevision, sourceRoot,
          sourceEpoch: sourceRoot ? deps.workspace.getActivationSnapshot().epoch : null,
        }
        return { ok: true as const, value: {
          workspace: dropped.activation.summary, document: { ...read.document }, token,
        } }
      } catch (error) { return ipcFailure(error) }
    },
    settleDroppedPath: async (input?: unknown) => {
      try {
        const { token, accept } = z.object({ token: z.string().uuid(), accept: z.boolean() }).strict().parse(input)
        const pending = pendingDroppedPath
        if (!pending || pending.token !== token) throw new PublicError('INVALID_INPUT')
        pendingDroppedPath = null // one-shot; an old token can never clear a newer preparation
        if (!accept) return { ok: true as const, value: null }
        const previousRoot = currentWorkspaceRootOrNull()
        if (now() > pending.expiresAt || ownedDocumentSession !== pending.sourceSession
          || ownedDocument !== pending.sourceDocument || ownedDraftMutationRevision !== pending.sourceDraftRevision
          || previousRoot !== pending.sourceRoot
          || (previousRoot ? deps.workspace.getActivationSnapshot().epoch : null) !== pending.sourceEpoch
        ) throw new PublicError('INVALID_INPUT')
        const previousWorkspace = deps.getLastWorkspace()
        let rootChanged = false
        let lastWorkspaceChanged = false
        try {
          // Recheck the target before committing authority; preflight never owns it.
          const read = await deps.documents.readFromValidatedRootForMain(
            pending.dropped.activation.summary.absolutePath, pending.dropped.documentPath!,
          )
          if (read.document.revision !== pending.document.revision) throw new PublicError('DOCUMENT_CONFLICT')
          lastWorkspaceChanged = pending.dropped.activation.summary.absolutePath !== previousWorkspace
          await deps.setLastWorkspace(pending.dropped.activation.summary.absolutePath)
          const workspace = await pending.dropped.activation.commit()
          rootChanged = true
          await deps.assets?.allowWorkspaceRoot()
          const prepared = await prepareDocumentOwnership({ ...read.document })
          // Publish ownership and release old clipboard resources only after all fallible work.
          const document = commitDocumentOwnership(prepared)
          return { ok: true as const, value: { workspace, document } }
        } catch (cause) {
          return await failAfterWorkspaceActivation({ cause,
            message: 'Guarded dropped path activation and workspace rollback failed',
            previousRoot, previousWorkspace, rootChanged, lastWorkspaceChanged })
        }
      } catch (error) { return ipcFailure(error) }
    },
    openDroppedPath: async (input?: unknown) => {
      try {
        const { absolutePath } = droppedPathSchema.parse(input)
        const previousRoot = currentWorkspaceRootOrNull()
        const previousWorkspace = deps.getLastWorkspace()
        const dropped = await deps.workspace.validateDroppedPath(absolutePath)
        let rootChanged = false
        let lastWorkspaceChanged = false
        try {
          lastWorkspaceChanged = dropped.activation.summary.absolutePath !== previousWorkspace
          await deps.setLastWorkspace(dropped.activation.summary.absolutePath)
          const workspace = await dropped.activation.commit()
          rootChanged = true
          await deps.assets?.allowWorkspaceRoot()
          const document = dropped.documentPath
            ? await ownDocument(await deps.documents.read(dropped.documentPath))
            : null
          if (!document) clearOwnedDocument()
          return { ok: true as const, value: { workspace, document } }
        } catch (activationError) {
          return await failAfterWorkspaceActivation({
            cause: activationError,
            message: 'Dropped path activation and workspace rollback failed',
            previousRoot,
            rootChanged,
            previousWorkspace,
            lastWorkspaceChanged,
          })
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    importDocx: async (input?: unknown) => {
      try {
        const { relativePath } = relativePathSchema.parse(input)
        if (!deps.docx) throw new Error('DOCX import is unavailable')
        const sourcePath = await deps.workspace.resolveExistingPandocDocument(relativePath)
        const imported = await deps.docx.import(sourcePath)
        clearOwnedDocument(imported.sourceAbsolutePath)
        return { ok: true as const, value: imported }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    exportDocx: async (input?: unknown) => {
      try {
        const value = docxExportSchema.parse(input)
        if (!deps.docx || !deps.chooseDocxExportPath) {
          throw new Error('DOCX export is unavailable')
        }

        const remembered = value.mode === 'reuse'
          ? docxExportTargets.get(value.documentSessionId)
          : undefined
        let targetPath: string | null = null
        let reusedTarget = false
        if (
          remembered
          && await deps.docx.canReuseTarget(remembered)
        ) {
          targetPath = remembered
          reusedTarget = true
        } else {
          targetPath = await deps.chooseDocxExportPath(value.suggestedBaseName)
        }
        if (!targetPath) return { ok: true as const, value: null }
        try {
          await deps.docx.exportDocx(value.markdown, targetPath)
        } catch (error) {
          if (!reusedTarget || !isUnavailableExportTargetError(error)) throw error
          docxExportTargets.delete(value.documentSessionId)
          targetPath = await deps.chooseDocxExportPath(value.suggestedBaseName)
          if (!targetPath) return { ok: true as const, value: null }
          reusedTarget = false
          await deps.docx.exportDocx(value.markdown, targetPath)
        }
        rememberDocxExportTarget(value.documentSessionId, targetPath)
        return {
          ok: true as const,
          value: { fileName: path.basename(targetPath), reusedTarget },
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    exportXlsx: async (input?: unknown) => {
      try {
        const { markdown, suggestedBaseName } = xlsxExportSchema.parse(input)
        if (!deps.xlsx || !deps.chooseXlsxExportPath) {
          throw new Error('XLSX export is unavailable')
        }
        const targetPath = await deps.chooseXlsxExportPath(suggestedBaseName)
        if (!targetPath) return { ok: true as const, value: null }
        await deps.xlsx.export(markdown, targetPath)
        return { ok: true as const, value: { fileName: path.basename(targetPath) } }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    pasteClipboardImage: async (input?: unknown) => {
      try {
        if (!deps.assets) throw new PublicError('OPERATION_FAILED')
        if (deps.clipboardNoteId) {
          const { noteId } = parseStickyNoteReference(input)
          if (noteId !== deps.clipboardNoteId) throw new PublicError('INVALID_INPUT')
          const service = requireStickyNotes()
          if (!service.copyImage) throw new PublicError('OPERATION_FAILED')
          return { ok: true as const, value: await deps.assets.pasteClipboardImageToNote(noteId, (id, source) => service.copyImage!(id, source)) }
        }
        const { draftId } = parseExactOwnInput(input, ['draftId'], [], draftReferenceSchema)
        requireOwnedDraft(draftId)
        const staged = await deps.assets.stageClipboardImage(draftId)
        return { ok: true as const, value: staged?.markdown ?? null }
      } catch (error) { return ipcFailure(error) }
    },
    readClipboardFormats: async (input?: unknown) => {
      try {
        z.undefined().parse(input)
        if (!deps.readClipboardFormats) throw new Error('Clipboard formats are unavailable')
        return {
          ok: true as const,
          value: clipboardFormatsSchema.parse(deps.readClipboardFormats()),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    importAsset: async (input?: unknown) => {
      try {
        const { absolutePath, draftId } = assetImportSchema.parse(input)
        if (!deps.assets) throw new Error('Asset import is unavailable')
        return { ok: true as const, value: await deps.assets.import(absolutePath, draftId) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openAsset: async (input?: unknown) => {
      try {
        const { url } = assetUrlSchema.parse(input)
        if (!deps.openAsset) throw new Error('Asset open is unavailable')
        await deps.openAsset(url)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    revealImage: async (input?: unknown) => {
      try {
        const { source } = imageSourceSchema.parse(input)
        if (!deps.imageContext) throw new Error('Image context actions are unavailable')
        await deps.imageContext.reveal(source)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    copyImage: async (input?: unknown) => {
      try {
        const { source } = imageSourceSchema.parse(input)
        if (!deps.imageContext) throw new Error('Image context actions are unavailable')
        await deps.imageContext.copyToClipboard(source)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    saveImageCopy: async (input?: unknown) => {
      try {
        const { source } = imageSourceSchema.parse(input)
        if (!deps.imageContext) throw new Error('Image context actions are unavailable')
        return { ok: true as const, value: await deps.imageContext.saveCopy(source) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    copyImageTo: async (input?: unknown) => {
      try {
        const { source } = imageSourceSchema.parse(input)
        if (!deps.imageContext) throw new Error('Image context actions are unavailable')
        return { ok: true as const, value: await deps.imageContext.copyTo(source) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    copyMermaidImage: async (input?: unknown) => {
      try {
        const { pngDataUrl } = mermaidImageCopySchema.parse(input)
        if (!deps.mermaidImageExport) throw new Error('Mermaid image export is unavailable')
        await deps.mermaidImageExport.copyPng(pngDataUrl)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openMermaidViewer: async (input?: unknown) => {
      try {
        const snapshot = parseMermaidViewerSnapshot(input)
        if (!snapshot) throw appError('INVALID_INPUT')
        if (!deps.openMermaidViewer) throw appError('OPERATION_FAILED')
        await deps.openMermaidViewer(snapshot)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    getMermaidViewerSnapshot: async (input?: unknown) => {
      try {
        if (input !== undefined) throw appError('INVALID_INPUT')
        const snapshot = parseMermaidViewerSnapshot(deps.getMermaidViewerSnapshot?.())
        if (!snapshot) throw appError('OPERATION_FAILED')
        return { ok: true as const, value: snapshot }
      } catch (error) { return ipcFailure(error) }
    },
    saveMermaidImage: async (input?: unknown) => {
      try {
        const payload = mermaidImageSaveSchema.parse(input)
        if (!deps.mermaidImageExport) throw new Error('Mermaid image export is unavailable')
        await deps.mermaidImageExport.save(payload)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    createWorkspaceFolder: async (input?: unknown) => {
      try {
        const { parentRelativePath, name } = createFolderSchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        return { ok: true as const, value: await deps.workspaceEntries.createFolder(parentRelativePath, name) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    renameWorkspaceEntry: async (input?: unknown) => {
      try {
        const { relativePath, newName } = renameEntrySchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        const renamed = await deps.workspaceEntries.renameEntry(relativePath, newName)
        if (ownedDocument?.relativePath === relativePath) {
          ownedDocument = { ...ownedDocument, relativePath: renamed.entry.relativePath }
          ownedAbsolutePath = renamed.absolutePath
        }
        return {
          ok: true as const,
          value: { entry: renamed.entry, colorMarks: renamed.colorMarks },
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    duplicateWorkspaceDocument: async (input?: unknown) => {
      try {
        const { relativePath } = workspaceEntrySchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        return { ok: true as const, value: await deps.workspaceEntries.duplicateDocument(relativePath) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    trashWorkspaceEntry: async (input?: unknown) => {
      try {
        const { relativePath } = workspaceEntrySchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        const trashed = await deps.workspaceEntries.trashEntry(relativePath)
        if (
          ownedDocument
          && relativeWorkspacePathContains(relativePath, ownedDocument.relativePath)
        ) clearOwnedDocument()
        return { ok: true as const, value: { colorMarks: trashed.colorMarks } }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    revealWorkspaceEntry: async (input?: unknown) => {
      try {
        const { relativePath } = workspaceEntrySchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        await deps.workspaceEntries.revealEntry(relativePath)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openWorkspaceEntryWindow: async (input?: unknown) => {
      try {
        const { relativePath } = workspaceEntrySchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        await deps.workspaceEntries.openEntryWindow(relativePath)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getWorkspaceEntryProperties: async (input?: unknown) => {
      try {
        const { relativePath } = workspaceEntrySchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        return { ok: true as const, value: await deps.workspaceEntries.properties(relativePath) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getWorkspaceRootProperties: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.workspaceEntries) throw new Error('Workspace entry actions are unavailable')
        return { ok: true as const, value: await deps.workspaceEntries.rootProperties() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getWorkspaceColorMarks: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.workspaceColors) throw new Error('Workspace colors are unavailable')
        return { ok: true as const, value: await deps.workspaceColors.get() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setWorkspaceColorMark: async (input?: unknown) => {
      try {
        const parsed = workspaceColorSetSchema.parse(input)
        if (!deps.workspaceColors) throw new Error('Workspace colors are unavailable')
        return {
          ok: true as const,
          value: await deps.workspaceColors.set(
            parsed.relativePath,
            parsed.color as WorkspaceColorId | null,
          ),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    moveWorkspaceColorMark: async (input?: unknown) => {
      try {
        const parsed = workspaceColorMoveSchema.parse(input)
        if (!deps.workspaceColors) throw new Error('Workspace colors are unavailable')
        return {
          ok: true as const,
          value: await deps.workspaceColors.move(parsed.fromRelativePath, parsed.toRelativePath),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    deleteWorkspaceColorMarks: async (input?: unknown) => {
      try {
        const { relativePath } = workspaceEntrySchema.parse(input)
        if (!deps.workspaceColors) throw new Error('Workspace colors are unavailable')
        return { ok: true as const, value: await deps.workspaceColors.delete(relativePath) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getPreferenceSnapshot: async (input?: unknown) => {
      try {
        const { group } = z.object({ group: z.enum(PREFERENCE_GROUPS) }).strict().parse(input)
        if (!deps.settingsPreferences) throw new Error('Preference transactions are unavailable')
        return { ok: true as const, value: await deps.settingsPreferences.read(group) }
      } catch (error) { return ipcFailure(error) }
    },
    patchPreferences: async (input?: unknown) => {
      try {
        const command = parsePreferencePatchInput(input)
        if (!command) throw new PublicError('INVALID_INPUT')
        if (!deps.settingsPreferences) throw new Error('Preference transactions are unavailable')
        return { ok: true as const, value: await deps.settingsPreferences.patch(command.observed, command.changes) }
      } catch (error) { return ipcFailure(error) }
    },
    getSearchPreferences: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getSearchPreferences) throw new Error('Search preferences are unavailable')
        return { ok: true as const, value: deps.getSearchPreferences() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getKeyboardShortcuts: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getKeyboardShortcuts) throw new Error('Keyboard shortcuts are unavailable')
        const value = parseObservedShortcutSnapshot(await deps.getKeyboardShortcuts())
        if (!value) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value }
      } catch (error) { return ipcFailure(error) }
    },
    updateKeyboardShortcuts: async (input?: unknown) => {
      try {
        const update = parseObservedShortcutUpdate(input)
        if (!update || !deps.updateKeyboardShortcuts) throw new Error('Invalid shortcut update')
        const value = parseObservedShortcutUpdateResult(await deps.updateKeyboardShortcuts(update))
        if (!value) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value }
      } catch (error) { return ipcFailure(error) }
    },
    setShortcutRecording: async (input?: unknown) => {
      try {
        const { active } = z.object({ active: z.boolean() }).strict().parse(input)
        if (!deps.setShortcutRecording) throw new Error('Shortcut recording is unavailable')
        deps.setShortcutRecording(active)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    setSearchPreferences: async (input?: unknown) => {
      try {
        const value = searchPreferencesSchema.parse(input) as BrowserSearchPreferences
        if (!deps.setSearchPreferences) throw new Error('Search preferences are unavailable')
        await deps.setSearchPreferences(value)
        return { ok: true as const, value }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getEditorAppearancePreferences: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getEditorAppearancePreferences) {
          throw new Error('Editor appearance preferences are unavailable')
        }
        return { ok: true as const, value: deps.getEditorAppearancePreferences() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setEditorAppearancePreferences: async (input?: unknown) => {
      try {
        const value = editorAppearancePreferencesSchema.parse(input) as EditorAppearancePreferences
        if (!deps.setEditorAppearancePreferences) {
          throw new Error('Editor appearance preferences are unavailable')
        }
        const snapshot = await deps.setEditorAppearancePreferences(value)
        return { ok: true as const, value: snapshot }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getLayoutPreferences: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getLayoutPreferences) throw new Error('Layout preferences are unavailable')
        return { ok: true as const, value: deps.getLayoutPreferences() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    compareAndSetLayoutPreferences: async (input?: unknown) => {
      try {
        const value = compareAndSetLayoutPreferencesSchema.parse(input) as {
          expectedRevision: number
          expectedLayout: LayoutPreferences
          replacement: LayoutPreferences
        }
        if (!deps.compareAndSetLayoutPreferences) {
          throw new Error('Layout preferences are unavailable')
        }
        return {
          ok: true as const,
          value: await deps.compareAndSetLayoutPreferences(
            value.expectedRevision,
            value.expectedLayout,
            value.replacement,
          ),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getStickyNotePreferences: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getStickyNotePreferences) throw new Error('Sticky note preferences are unavailable')
        return { ok: true as const, value: deps.getStickyNotePreferences() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setStickyNotePreferences: async (input?: unknown) => {
      try {
        const value = parseStickyNotePreferences(input)
        if (!value) throw new PublicError('INVALID_INPUT')
        if (!deps.setStickyNotePreferences) throw new Error('Sticky note preferences are unavailable')
        await deps.setStickyNotePreferences(value)
        return { ok: true as const, value }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getDefaultApplicationsStatus: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.defaultApplications) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value: await deps.defaultApplications.getStatus() }
      } catch (error) { return ipcFailure(error) }
    },
    openDefaultApplicationsSettings: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.defaultApplications) throw new PublicError('OPERATION_FAILED')
        await deps.defaultApplications.openSettings()
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    setDefaultApplicationsEnabled: async (input?: unknown) => {
      try {
        if (typeof input !== 'boolean') throw new PublicError('INVALID_INPUT')
        if (!deps.defaultApplications) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value: await deps.defaultApplications.setEnabled(input) }
      } catch (error) { return ipcFailure(error) }
    },
    getShellIntegrationPreferences: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.shellIntegration) throw new PublicError('OPERATION_FAILED')
        const value = parseShellIntegrationSnapshot(await deps.shellIntegration.readObserved())
        if (!value) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value }
      } catch (error) { return ipcFailure(error) }
    },
    updateShellIntegrationPreference: async (input?: unknown) => {
      try {
        const update = parseObservedShellIntegrationUpdate(input)
        if (!update) throw new PublicError('INVALID_INPUT')
        if (!deps.shellIntegration) throw new PublicError('OPERATION_FAILED')
        const value = parseShellIntegrationSnapshot(await deps.shellIntegration.updateObserved(update))
        if (!value) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value }
      } catch (error) { return ipcFailure(error) }
    },
    getDesktopLifecyclePreferences: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getDesktopLifecyclePreferences) {
          throw new Error('Desktop lifecycle preferences are unavailable')
        }
        return { ok: true as const, value: deps.getDesktopLifecyclePreferences() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setDesktopLifecyclePreferences: async (input?: unknown) => {
      try {
        const value = parseDesktopLifecyclePreferences(input)
        if (!value) throw new PublicError('INVALID_INPUT')
        if (!deps.setDesktopLifecyclePreferences) {
          throw new Error('Desktop lifecycle preferences are unavailable')
        }
        await deps.setDesktopLifecyclePreferences(value)
        return { ok: true as const, value }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getArknotePreferences: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getArknotePreferences) throw new Error('Arknote preferences are unavailable')
        return { ok: true as const, value: await deps.getArknotePreferences() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    previewStickyNoteWallpaperAppearances: async (input?: unknown) => {
      try {
        const value = input === null ? null : parseStickyNoteWallpaperAppearances(input)
        if (value === undefined) throw new PublicError('INVALID_INPUT')
        if (!deps.previewStickyNoteWallpaperAppearances) throw new Error('Wallpaper preview is unavailable')
        return { ok: true as const, value: await deps.previewStickyNoteWallpaperAppearances(value) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setArknotePreferences: async (input?: unknown) => {
      try {
        const value = parseArknotePreferencesUpdate(input)
        if (!value) throw new PublicError('INVALID_INPUT')
        if (!deps.setArknotePreferences) throw new Error('Arknote preferences are unavailable')
        return { ok: true as const, value: await deps.setArknotePreferences(value) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    previewArknoteThemeColor: async (input?: unknown) => {
      try {
        const parsed = z.object({ themeColor: z.string() }).strict().safeParse(input)
        if (!parsed.success || !isThemeColor(parsed.data.themeColor)) {
          throw new PublicError('INVALID_INPUT')
        }
        if (!deps.previewArknoteThemeColor) {
          throw new Error('Arknote theme preview is unavailable')
        }
        await deps.previewArknoteThemeColor(normalizeThemeColor(parsed.data.themeColor))
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getSystemFonts: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getSystemFonts) throw new Error('System font discovery is unavailable')
        return { ok: true as const, value: await deps.getSystemFonts() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getModelCapabilityRules: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.modelCapabilityRules) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value: deps.modelCapabilityRules.getState() }
      } catch (error) { return ipcFailure(error) }
    },
    setModelCapabilityRules: async (input?: unknown) => {
      try {
        const rules = input === null ? null : parseModelCapabilityRules(input)
        if (rules === undefined) throw new PublicError('INVALID_INPUT')
        if (!deps.modelCapabilityRules) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value: await deps.modelCapabilityRules.update(rules) }
      } catch (error) { return ipcFailure(error) }
    },
    getLargeModelSettings: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        return { ok: true as const, value: (await requireModelConnections().getSettings()).settings }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getModelSettingsSnapshot: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        return { ok: true as const, value: await requireModelConnections().getSettings() }
      } catch (error) { return ipcFailure(error) }
    },
    connectModel: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, parseConnectModelInput)
        if (!value) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireModelConnections().connect(value.observed, value.input) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    listModels: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, parseListModelsInput)
        if (!value) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireModelConnections().listModels(value.observed, value.input) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    testModel: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, parseConnectionReference)
        if (!value) throw new PublicError('INVALID_INPUT')
        const result = await requireModelConnections().test(value.observed, value.input.connectionId)
        const failure = result.failure ? ipcFailure(result.failure) : undefined
        return { ok: true as const, value: { mutation: result.mutation, error: failure && !failure.ok ? failure.error.message : null } }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    deleteModel: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, parseConnectionReference)
        if (!value) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireModelConnections().delete(value.observed, value.input.connectionId) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setAiConversationSettings: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, input => parseModelFeaturePatch('aiConversation', input))
        if (!value) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireModelConnections().setFeature(value.observed, 'aiConversation', value.input) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    testCodexCliConnection: async (input?: unknown) => {
      try {
        const observed = parseModelObservationRequest(input)
        if (!observed) throw new PublicError('INVALID_INPUT')
        if (deps.ensureCodexCli && !await deps.ensureCodexCli()) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value: await requireCodexCliConnections().test(observed) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    startCodexCliLogin: async (input?: unknown) => {
      let attempt: AbortController | undefined
      try {
        const observed = parseModelObservationRequest(input)
        if (!observed) throw new PublicError('INVALID_INPUT')
        if (!deps.startCodexCliLogin) throw new PublicError('OPERATION_FAILED')
        if (codexLoginAttempt) return { ok: true as const, value: { status: 'failed' as const } }
        attempt = new AbortController()
        codexLoginAttempt = attempt
        if (codexLoginCancellation) await codexLoginCancellation
        if (attempt.signal.aborted) return { ok: true as const, value: { status: 'cancelled' as const } }
        if (deps.ensureCodexCli && !await deps.ensureCodexCli(attempt.signal) || attempt.signal.aborted) return { ok: true as const, value: { status: 'cancelled' as const } }
        const outcome = await deps.startCodexCliLogin()
        if (attempt.signal.aborted) return { ok: true as const, value: { status: 'cancelled' as const } }
        if (outcome.status === 'completed') {
          const connection = await requireCodexCliConnections().test(observed)
          return attempt.signal.aborted ? { ok: true as const, value: { status: 'cancelled' as const } }
            : { ok: true as const, value: { status: 'completed' as const, connection } }
        }
        return { ok: true as const, value: outcome }
      } catch (error) { return ipcFailure(error) }
      finally { if (attempt && codexLoginAttempt === attempt) codexLoginAttempt = undefined }
    },
    cancelCodexCliLogin: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        codexLoginAttempt?.abort()
        codexLoginAttempt = undefined
        const cancellation = codexLoginCancellation ??= Promise.resolve().then(() => deps.cancelCodexCliLogin?.())
        try { await cancellation }
        finally { if (codexLoginCancellation === cancellation) codexLoginCancellation = undefined }
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    removeCodexCliConnection: async (input?: unknown) => {
      try {
        const observed = parseModelObservationRequest(input)
        if (!observed) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireCodexCliConnections().remove(observed) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setSelectionTranslationSettings: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, input => parseModelFeaturePatch('selectionTranslation', input))
        if (!value) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireModelConnections().setFeature(value.observed, 'selectionTranslation', value.input) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getScreenshotOcrModelState: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        const models = requireScreenshotOcrModels()
        await models.initialize?.()
        return { ok: true as const, value: await models.getObservedState() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    downloadScreenshotOcrMedium: async (input?: unknown) => {
      try {
        const observed = parseObservedOcrPreference(input)
        if (!observed) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireScreenshotOcrModels().downloadMedium(observed) }
      } catch (error) {
        if (error instanceof OcrPreferenceConflictError) return { ok: true as const, value: { status: 'conflict' as const } }
        return ipcFailure(error)
      }
    },
    cancelScreenshotOcrMediumDownload: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        return { ok: true as const, value: await requireScreenshotOcrModels().cancelMediumDownload() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    removeScreenshotOcrMedium: async (input?: unknown) => {
      try {
        const observed = parseObservedOcrPreference(input)
        if (!observed) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireScreenshotOcrModels().removeMedium(observed) }
      } catch (error) {
        if (error instanceof OcrPreferenceConflictError) return { ok: true as const, value: { status: 'conflict' as const } }
        return ipcFailure(error)
      }
    },
    setScreenshotTranslationSettings: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, input => parseModelFeaturePatch('screenshotTranslation', input))
        if (!value) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireModelConnections().setFeature(value.observed, 'screenshotTranslation', value.input) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setFloatingTranslationSettings: async (input?: unknown) => {
      try {
        const value = parseObservedModelCommand(input, input => parseModelFeaturePatch('floatingTranslation', input))
        if (!value) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await requireModelConnections().setFeature(value.observed, 'floatingTranslation', value.input) }
      } catch (error) { return ipcFailure(error) }
    },
    acceptTranslationPrivacyNotice: async (input?: unknown) => {
      try {
        const observed = parseModelObservationRequest(input)
        if (!observed) throw new PublicError('INVALID_INPUT')
        return {
          ok: true as const,
          value: await requireModelConnections().acceptTranslationPrivacyNotice(observed),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    searchSelection: async (input?: unknown) => {
      try {
        const { query } = searchQuerySchema.parse(input)
        if (!deps.searchSelection) throw new Error('Browser search is unavailable')
        await deps.searchSelection(query)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openExternal: async (input?: unknown) => {
      try {
        const { target } = externalTargetSchema.parse(input)
        const parsedTarget = parseLinkTarget(target)
        if (!parsedTarget) throw new PublicError('INVALID_INPUT')
        if (!deps.openExternal) throw new Error('External open is unavailable')
        await deps.openExternal(
          parsedTarget.kind === 'web' ? parsedTarget.url : parsedTarget.path,
        )
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    navigateDocumentView: async (input?: unknown) => {
      try {
        const request = parseDocumentViewRequest(input)
        if (!request) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await documentView.navigate(request) }
      } catch (error) { return ipcFailure(error) }
    },
    revealLocalFileLink: async (input?: unknown) => {
      try {
        const request = parseLocalFileRevealRequest(input)
        if (!request) throw new PublicError('INVALID_INPUT')
        await documentView.revealLink(request)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    refreshDocumentView: async (input?: unknown) => {
      try { return { ok: true as const, value: await documentView.refresh(documentViewId(input)) } }
      catch (error) { return ipcFailure(error) }
    },
    inspectDocumentView: async (input?: unknown) => {
      try { return { ok: true as const, value: await documentView.inspect(documentViewId(input)) } }
      catch (error) { return ipcFailure(error) }
    },
    openDocumentView: async (input?: unknown) => {
      try {
        await documentView.open(documentViewId(input))
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    openDocumentWindow: async (input?: unknown) => {
      try {
        const { absolutePath } = droppedPathSchema.parse(input)
        if (!deps.openDocumentWindow) throw new Error('New window is unavailable')
        await deps.openDocumentWindow(absolutePath)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    createDocument: async (input?: unknown) => {
      try {
        const { relativePath } = relativePathSchema.parse(input)
        return {
          ok: true as const,
          value: await ownDocument(await deps.documents.create(relativePath, '')),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    readDocument: async (input?: unknown) => {
      try {
        const { relativePath } = relativePathSchema.parse(input)
        return {
          ok: true as const,
          value: await ownDocument(await deps.documents.read(relativePath)),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    peekDocument: async (input?: unknown) => {
      try {
        const { relativePath } = relativePathSchema.parse(input)
        return { ok: true as const, value: await deps.documents.read(relativePath) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    saveDocument: async (input?: unknown) => {
      try {
        const value = saveDocumentSchema.parse(input) as SaveDocumentInput
        const saveOwner = activeQueuedSaveOwner
        if (
          !saveOwner
          || saveOwner.relativePath === null
          || saveOwner.session !== ownedDocumentSession
        ) throw new PublicError('INVALID_INPUT')
        if (!ownedDocument || saveOwner.relativePath !== value.relativePath) {
          throw new PublicError('INVALID_INPUT')
        }
        // A successor backup may have failed before it acquired an active id.
        // Its live history still owns image references which must be migrated
        // (or fail explicitly) before committing the document body.
        const migration = deps.assets && !isCodeDocumentPath(ownedDocument.relativePath)
          ? await migrateOwnedAssets(ownedDraftId ?? attemptedDraftId, value.markdown, ownedAbsolutePath!)
          : { markdown: value.markdown, rollback: async () => undefined }
        let saved: SaveDocumentResult
        try {
          saved = await saveDocumentPreservingEditor({ ...value, markdown: migration.markdown, relativePath: ownedDocument.relativePath })
        } catch (error) {
          // Only remove copies when disk proves the previous document survived.
          // A failed replacement/publication can leave the new target in place.
          const actual = await deps.documents.read(ownedDocument.relativePath).catch(() => null)
          if (actual?.markdown === ownedDocument.markdown) await migration.rollback()
          throw error
        }
        if (saveOwner.session !== ownedDocumentSession) {
          throw new PublicError('INVALID_INPUT')
        }
        if (!ownedDocument) throw new PublicError('INVALID_INPUT')
        ownedDocument = {
          ...ownedDocument,
          markdown: migration.markdown,
          revision: saved.revision,
          mtimeMs: saved.mtimeMs,
        }
        savedDraftId = ownedDraftId ?? attemptedDraftId
        let clipboardAssetsRetained = false
        let draftEndPending = false
        try {
          clipboardAssetsRetained = Boolean(ownedDraftId && await deps.drafts?.retainClipboardHistoryAfterSave?.(ownedDraftId))
        } catch {
          // The document has already committed. Return its new revision even
          // when the separate draft terminal commit must be retried.
          draftEndPending = true
        }
        if (clipboardAssetsRetained) retainedClipboardDrafts.add(ownedDraftId!)
        if (clipboardAssetsRetained) recordDraftTerminal(ownedDraftId!)
        return { ok: true as const, value: { ...saved, ...(migration.markdown !== value.markdown ? { markdown: migration.markdown } : {}),
          ...(clipboardAssetsRetained ? { clipboardAssetsRetained: true as const } : {}),
          ...(draftEndPending ? { draftEndPending: true as const } : {}),
        } }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    saveDraft: async (input?: unknown) => {
      try {
        const value = saveDraftSchema.parse(input) as SaveDraftInput
        if (!deps.drafts) throw new Error('Draft storage is unavailable')
        if (pendingDraftFinalization && (value.draftId === pendingDraftFinalization.draftId
          || !ownedDocument || value.expectedOriginalRevision !== ownedDocument.revision)) {
          throw new PublicError('INVALID_INPUT')
        }
        if ((draftTerminalEpochs.get(value.draftId) ?? 0) > activeQueuedDraftEpoch) throw new PublicError('INVALID_INPUT')
        if (
          activeQueuedAutosaveDraftId !== null
          && activeQueuedAutosaveDraftId === value.draftId
          && ownedDraftId !== activeQueuedAutosaveDraftId
        ) throw new PublicError('INVALID_INPUT')
        if (ownedDraftId !== null && ownedDraftId !== value.draftId) throw new PublicError('INVALID_INPUT')
        if (ownedDraftId === null && attemptedDraftId !== value.draftId && await deps.drafts.read(value.draftId)) throw new PublicError('INVALID_INPUT')
        const createsUntitledOwnership = ownedDraftId === null && value.expectedOriginalRevision === null
        if (
          !createsUntitledOwnership
          && ownedDocument
          && value.expectedOriginalRevision !== ownedDocument.revision
        ) {
          throw new PublicError('INVALID_INPUT')
        }
        if (
          !createsUntitledOwnership
          && !ownedDocument
          && value.expectedOriginalRevision !== null
        ) throw new PublicError('INVALID_INPUT')
        deps.drafts.claim?.(value.draftId, draftOwner)
        attemptedDraftId = value.draftId
        const backupMarkdown = deps.assets?.rebindDraftAssets && !isCodeDocumentPath(ownedDocument?.relativePath ?? '')
          ? await deps.assets.rebindDraftAssets(value.draftId, value.markdown, [...retainedClipboardDrafts])
          : value.markdown
        const savedDraft = await deps.drafts.write({
          draftId: value.draftId,
          markdown: backupMarkdown,
          encoding: value.encoding,
          newline: value.newline,
          originalAbsolutePath: createsUntitledOwnership ? null : ownedAbsolutePath,
          workspaceAbsolutePath: createsUntitledOwnership
            ? null
            : ownedDocument ? deps.workspace.getRoot() : null,
          originalRevision: createsUntitledOwnership ? null : ownedDocument?.revision ?? null,
          originalMtimeMs: createsUntitledOwnership ? null : ownedDocument?.mtimeMs ?? null,
        })
        if (createsUntitledOwnership) clearOwnedDocument(null, ownedDocument === null)
        ownedDraftId = value.draftId
        attemptedDraftId = null
        claimedRecoveryId = null
        savedDraftId = null
        ownedDraftMutationRevision += 1
        return {
          ok: true as const,
          value: savedDraft,
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    listRecoverableDrafts: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.drafts) throw new Error('Draft storage is unavailable')
        return { ok: true as const, value: await deps.drafts.listRecoverable() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    readDraft: async (input?: unknown) => {
      try {
        const { draftId } = draftReferenceSchema.parse(input)
        requireOwnedDraft(draftId)
        if (!deps.drafts) throw new Error('Draft storage is unavailable')
        return { ok: true as const, value: await deps.drafts.read(draftId) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    claimRecoveredDraft: async (input?: unknown) => {
      try {
        const { draftId } = draftReferenceSchema.parse(input)
        if (!deps.drafts || recoveryGrant !== draftId || ownedDraftId !== null) throw new PublicError('INVALID_INPUT')
        const draft = await deps.drafts.read(draftId)
        if (!draft) throw new PublicError('INVALID_INPUT')
        if (ownedAbsolutePath !== null && (draft.manifest.originalAbsolutePath === null
          || !sameWindowsFilesystemPath(draft.manifest.originalAbsolutePath, ownedAbsolutePath))) throw new PublicError('INVALID_INPUT')
        if (draft.manifest.originalAbsolutePath === null && ownedDocument !== null) throw new PublicError('INVALID_INPUT')
        deps.drafts.claim(draftId, draftOwner)
        ownedDraftId = draftId
        claimedRecoveryId = draftId
        ownedDraftMutationRevision += 1
        recoveryGrant = null
        return { ok: true as const, value: draft }
      } catch (error) { return ipcFailure(error) }
    },
    releaseDraftRecovery: async (input?: unknown) => {
      try {
        const { draftId } = draftReferenceSchema.parse(input)
        if (recoveryGrant !== draftId && claimedRecoveryId !== draftId) throw new PublicError('INVALID_INPUT')
        if (recoveryGrant === draftId) recoveryGrant = null
        if (claimedRecoveryId === draftId) {
          claimedRecoveryId = null
          if (ownedDraftId === draftId) ownedDraftId = null
        }
        deps.drafts?.releaseClaim(draftId, draftOwner)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    cleanDraft: async (input?: unknown) => {
      try {
        const { draftId } = draftReferenceSchema.parse(input)
        if (ownedDraftId !== draftId && attemptedDraftId !== draftId) throw new PublicError('INVALID_INPUT')
        if (!deps.drafts) throw new Error('Draft storage is unavailable')
        await deps.drafts.markClean(draftId)
        recordDraftTerminal(draftId)
        retainedClipboardDrafts.add(draftId)
        claimedRecoveryId = null
        ownedDraftMutationRevision += 1
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    ignoreDraft: async (input?: unknown) => {
      try {
        const { draftId } = draftReferenceSchema.parse(input)
        requireOwnedDraft(draftId)
        if (!deps.drafts) throw new Error('Draft storage is unavailable')
        await deps.drafts.markIgnored(draftId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    discardDraft: async (input?: unknown) => {
      try {
        const { draftId } = draftReferenceSchema.parse(input)
        if (ownedDraftId !== draftId && attemptedDraftId !== draftId) throw new PublicError('INVALID_INPUT')
        if (!deps.drafts) throw new Error('Draft storage is unavailable')
        const retained = await deps.drafts.discard(draftId, savedDraftId === draftId ? 'saved' : 'discarded', true)
        if (retained) retainedClipboardDrafts.add(draftId)
        else retainedClipboardDrafts.delete(draftId)
        recordDraftTerminal(draftId)
        ownedDraftId = null
        attemptedDraftId = null
        savedDraftId = null
        claimedRecoveryId = null
        ownedDraftMutationRevision += 1
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    beginSaveDocumentAs: async (input?: unknown) => {
      try {
        const value = saveDocumentAsSchema.parse(input) as SaveDocumentAsInput
        requireOwnedDraft(value.draftId)
        if (!deps.chooseSavePath || !deps.drafts) throw new PublicError('OPERATION_FAILED')
        purgeExpiredSaveAsIntents()
        if (saveAsIntents.size >= SAVE_AS_INTENT_LIMIT) throw new PublicError('OPERATION_FAILED')
        const source = await deps.workspace.getSaveAsActivationSnapshot()
        const sourceAuthority = await saveAsSourceAuthority(source.root)
        const selected = await deps.chooseSavePath(value.suggestedFileName)
        if (selected === null) return { ok: true as const, value: null }
        if (!path.isAbsolute(selected) || selected.includes('\0')) throw new PublicError('INVALID_INPUT')
        const targetRelativePath = path.basename(selected)
        if (!isEditableDocumentPath(targetRelativePath)) throw new PublicError('INVALID_INPUT')
        const targetActivation = await deps.workspace.validateRoot(path.dirname(selected))
        const targetWorkspace = Object.freeze({ ...targetActivation.summary })
        const changesWorkspace = source.root === null || !sameWindowsFilesystemPath(source.root, targetWorkspace.absolutePath)
        const createdAt = now()
        if (!Number.isFinite(createdAt) || createdAt > Number.MAX_SAFE_INTEGER - SAVE_AS_INTENT_TTL_MS) {
          throw new PublicError('OPERATION_FAILED')
        }
        const intentId = createSaveAsIntentId()
        if (!isCanonicalAiConversationRequestId(intentId) || seenSaveAsIntentIds.has(intentId)) {
          throw new PublicError('OPERATION_FAILED')
        }
        rememberBounded(seenSaveAsIntentIds, intentId, AI_IPC_OWNERSHIP_HISTORY_LIMIT)
        const intent: SaveAsIntent = Object.freeze({
          intentId,
          input: Object.freeze({ ...value }),
          ownerId: requireDesktopAi().ownerId,
          documentSession: ownedDocumentSession,
          draftMutationRevision: ownedDraftMutationRevision,
          sourceRoot: source.root,
          sourceEpoch: source.epoch,
          sourceAuthority: sourceAuthority ? Object.freeze({ ...sourceAuthority }) : null,
          targetRoot: targetWorkspace.absolutePath,
          targetWorkspace,
          targetRelativePath,
          changesWorkspace,
          expiresAt: createdAt + SAVE_AS_INTENT_TTL_MS,
        })
        saveAsIntents.set(intentId, intent)
        return {
          ok: true as const,
          value: Object.freeze({
            intentId,
            targetWorkspace,
            targetFileName: targetRelativePath,
            targetRelativePath,
            changesWorkspace,
          }),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    abortSaveDocumentAs: async (input?: unknown) => {
      try {
        const { intentId } = saveDocumentAsIntentSchema.parse(input)
        purgeExpiredSaveAsIntents()
        if (!saveAsIntents.delete(intentId)) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    commitSaveDocumentAs: async (input?: unknown) => {
      try {
        const { intentId } = saveDocumentAsIntentSchema.parse(input)
        purgeExpiredSaveAsIntents()
        const intent = saveAsIntents.get(intentId)
        if (!intent) throw new PublicError('INVALID_INPUT')
        saveAsIntents.delete(intentId)
        if (intent.ownerId !== requireDesktopAi().ownerId
          || intent.documentSession !== ownedDocumentSession
          || intent.draftMutationRevision !== ownedDraftMutationRevision
          || intent.input.draftId !== ownedDraftId) throw new PublicError('INVALID_INPUT')
        if (!deps.aiRendererPorts || !deps.openDocumentRegistry
          || typeof (deps.drafts as TransactionalDraftService | undefined)?.beginFinalizeSaved
            !== 'function') {
          throw new PublicError('OPERATION_FAILED')
        }
        const previousWorkspace = deps.getLastWorkspace()
        let workspaceCommitted = false
        let lastWorkspaceChanged = false
        let switchTicket: AiWorkspaceSwitchTicket | null = null
        let targetAuthority: WindowAiWorkspaceAuthority
        let sourceRead: Awaited<ReturnType<DocumentService['readForMain']>> | null = null
        let transfer: AiOpenDocumentTransfer | null = null
        let destinationGuard: OpenDocumentDestinationGuard | null = null
        let migration: { markdown: string; rollback(): Promise<void> } | null = null
        let written: Readonly<{
          relativePath: string
          identity: CanonicalFileIdentity
          document: DocumentSnapshot
          previous: DocumentSnapshot | null
          previousIdentity: CanonicalFileIdentity | null
        }> | null = null
        let targetRollbackSafe = false
        let finalize: DraftFinalizeTransaction | null = null
        let preparedOwnership: PreparedDocumentOwnership | null = null
        try {
          const desktopAi = requireDesktopAi()
          if (!desktopAi.prepareWorkspaceSwitch || !desktopAi.activateWorkspace
            || !desktopAi.abortWorkspaceSwitch) throw new PublicError('OPERATION_FAILED')
          switchTicket = await desktopAi.prepareWorkspaceSwitch()
          const source = await deps.workspace.getSaveAsActivationSnapshot()
          const sourceAuthority = await saveAsSourceAuthority(source.root)
          if (source.epoch !== intent.sourceEpoch
            || (source.root === null || intent.sourceRoot === null
              ? source.root !== intent.sourceRoot
              : !sameWindowsFilesystemPath(source.root, intent.sourceRoot))
            || (sourceAuthority === null || intent.sourceAuthority === null
              ? sourceAuthority !== intent.sourceAuthority
              : !sameWorkspaceAuthority(sourceAuthority, intent.sourceAuthority))) {
            throw new PublicError('INVALID_INPUT')
          }
          const targetActivation = await deps.workspace.validateRoot(intent.targetRoot)
          if (!sameWindowsFilesystemPath(
            targetActivation.summary.absolutePath,
            intent.targetWorkspace.absolutePath,
          )) throw new PublicError('INVALID_INPUT')
          const currentDocument = ownedDocument
          sourceRead = currentDocument
            ? await deps.documents.readForMain(currentDocument.relativePath)
            : null
          if (currentDocument && (sourceRead!.document.relativePath !== currentDocument.relativePath
            || sourceRead!.document.revision !== currentDocument.revision)) {
            throw new PublicError('INVALID_INPUT')
          }
          if (intent.changesWorkspace) {
            const workspace = await targetActivation.commit()
            workspaceCommitted = true
            if (!sameWindowsFilesystemPath(workspace.absolutePath, intent.targetRoot)) {
              throw new PublicError('INVALID_INPUT')
            }
            await deps.assets?.allowWorkspaceRoot()
            lastWorkspaceChanged = !sameWindowsFilesystemPath(previousWorkspace ?? '', workspace.absolutePath)
            await deps.setLastWorkspace(workspace.absolutePath)
          }
          targetAuthority = await currentAiWorkspaceAuthority()
          if (sourceRead && deps.aiRendererPorts && deps.openDocumentRegistry) {
            if (!intent.sourceAuthority) throw new PublicError('INVALID_INPUT')
            transfer = await deps.aiRendererPorts.beginOpenDocumentTransfer(
              deps.openDocumentRegistry,
              Object.freeze({
                windowId: intent.ownerId,
                workspaceId: intent.sourceAuthority.workspaceId,
                generation: intent.sourceAuthority.workspaceGeneration,
                fileIdentity: sourceRead.identity,
              }),
              Object.freeze({
                windowId: intent.ownerId,
                workspaceId: targetAuthority.workspaceId,
                generation: targetAuthority.workspaceGeneration,
              }),
            )
          }
          migration = deps.assets && !isCodeDocumentPath(intent.targetRelativePath) && !isCodeDocumentPath(ownedAbsolutePath ?? '')
            ? await migrateOwnedAssets(intent.input.draftId, intent.input.markdown, path.join(intent.targetRoot, intent.targetRelativePath))
            : { markdown: intent.input.markdown, rollback: async () => undefined }
          let previousRead: Awaited<ReturnType<DocumentService['readForMain']>> | null = null
          try {
            previousRead = await deps.documents.readForMain(intent.targetRelativePath)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          if (previousRead) {
            if (transfer) {
              await transfer.guardDestination(previousRead.identity)
            } else if (deps.openDocumentRegistry) {
              destinationGuard = await deps.openDocumentRegistry.guardDestination(Object.freeze({
                windowId: intent.ownerId,
                workspaceId: targetAuthority.workspaceId,
                generation: targetAuthority.workspaceGeneration,
                fileIdentity: previousRead.identity,
              }))
            }
          }
          const previous = previousRead?.document ?? null
          let document: DocumentSnapshot
          let identity: CanonicalFileIdentity
          if (previous) {
            const saved = await deps.documents.saveForMain({
              relativePath: intent.targetRelativePath,
              markdown: migration.markdown,
              expectedRevision: previous.revision,
              encoding: intent.input.encoding,
              newline: intent.input.newline,
            }, async (successor) => {
              const provisionalDocument = {
                ...previous,
                markdown: migration!.markdown,
                encoding: intent.input.encoding,
                newline: intent.input.newline,
                ...successor.result,
              }
              written = Object.freeze({
                relativePath: intent.targetRelativePath,
                identity: successor.identity,
                document: provisionalDocument,
                previous,
                previousIdentity: previousRead!.identity,
              })
              if (transfer) {
                await transfer.handoffDestination(successor.identity)
              } else if (destinationGuard) {
                await destinationGuard.handoff(Object.freeze({
                  windowId: intent.ownerId,
                  workspaceId: targetAuthority.workspaceId,
                  generation: targetAuthority.workspaceGeneration,
                  fileIdentity: successor.identity,
                }))
              } else {
                throw new PublicError('OPERATION_FAILED')
              }
              targetRollbackSafe = true
            })
            document = {
              ...previous,
              markdown: migration.markdown,
              encoding: intent.input.encoding,
              newline: intent.input.newline,
              ...saved.result,
            }
            identity = saved.identity
          } else {
            const created = await deps.documents.createForMain(
              intent.targetRelativePath,
              migration.markdown,
              {
              encoding: intent.input.encoding,
              newline: intent.input.newline,
              },
              async (createdTarget) => {
                if (transfer) {
                  await transfer.guardDestination(createdTarget.identity)
                } else {
                  destinationGuard = await deps.openDocumentRegistry!.guardDestination(Object.freeze({
                    windowId: intent.ownerId,
                    workspaceId: targetAuthority.workspaceId,
                    generation: targetAuthority.workspaceGeneration,
                    fileIdentity: createdTarget.identity,
                  }))
                }
              },
            )
            document = { ...created.document }
            identity = created.identity
            targetRollbackSafe = true
          }
          written = Object.freeze({
            relativePath: intent.targetRelativePath,
            identity,
            document,
            previous,
            previousIdentity: previousRead?.identity ?? null,
          })
          preparedOwnership = await prepareDocumentOwnership(document)
          const transactionalDrafts = deps.drafts as TransactionalDraftService
          if (typeof transactionalDrafts.beginFinalizeSaved !== 'function') {
            throw new PublicError('OPERATION_FAILED')
          }
          finalize = await transactionalDrafts.beginFinalizeSaved(intent.input.draftId, { retainAssetHistory: true })
          await transfer?.commit(identity)
          if (destinationGuard) {
            await destinationGuard.release()
            destinationGuard = null
          }
          if (intent.changesWorkspace) {
            await requireDesktopAi().activateWorkspace!(switchTicket)
          } else {
            await requireDesktopAi().abortWorkspaceSwitch!(switchTicket)
          }
          switchTicket = null
          if (finalize.retainsAssets) retainedClipboardDrafts.add(intent.input.draftId)
          else retainedClipboardDrafts.delete(intent.input.draftId)
          let draftEndPending = false
          try {
            await finalize.commit()
            recordDraftTerminal(intent.input.draftId)
          } catch (error) {
            pendingDraftFinalization = { draftId: intent.input.draftId, transaction: finalize }
            draftEndPending = true
            reportErrorWithoutThrow(error)
          }
          ownedDraftMutationRevision += 1
          commitDocumentOwnership(preparedOwnership, true)
          return {
            ok: true as const,
            value: Object.freeze({
              workspace: intent.targetWorkspace,
              document,
              changesWorkspace: intent.changesWorkspace,
              ...(draftEndPending ? { draftEndPending: true as const } : {}),
              aiWorkspace: Object.freeze({ ...targetAuthority }),
            }),
          }
        } catch (cause) {
          const rollbackErrors: unknown[] = []
          const attempt = async (operation: (() => Promise<void>) | undefined): Promise<void> => {
            if (!operation) return
            try { await operation() } catch (error) { rollbackErrors.push(error) }
          }
          await attempt(finalize ? () => finalize!.rollback() : undefined)
          const overwroteSource = sourceRead !== null && written !== null
            && written.previousIdentity === sourceRead.identity
          let transferRollbackCompleted = false
          let restoredTargetIdentity: CanonicalFileIdentity | null = null
          let targetRollbackFailed = false
          if (written && targetRollbackSafe) {
            try {
              restoredTargetIdentity = await rollbackSaveAsTarget(
                written,
                written.previous ? async (restored) => {
                  if (transfer) {
                    await transfer.rollback(
                      overwroteSource ? restored.identity : undefined,
                      overwroteSource ? undefined : restored.identity,
                    )
                    transferRollbackCompleted = true
                    return
                  }
                  if (!destinationGuard) throw new PublicError('OPERATION_FAILED')
                  await destinationGuard.handoff(Object.freeze({
                    windowId: intent.ownerId,
                    workspaceId: targetAuthority.workspaceId,
                    generation: targetAuthority.workspaceGeneration,
                    fileIdentity: restored.identity,
                  }))
                } : undefined,
              )
            } catch (error) {
              targetRollbackFailed = true
              rollbackErrors.push(error)
            }
          } else if (written) {
            targetRollbackFailed = true
            rollbackErrors.push(new Error(
              'Save As successor identity was not guarded; target was retained',
            ))
          }
          await attempt(destinationGuard ? () => destinationGuard!.release() : undefined)
          destinationGuard = null
          if (transfer && !transferRollbackCompleted
            && !(overwroteSource && targetRollbackFailed)) {
            await attempt(() => transfer!.rollback(
              overwroteSource && restoredTargetIdentity ? restoredTargetIdentity : undefined,
            ))
          }
          if (!targetRollbackFailed && !(cause instanceof DocumentRollbackIncompleteError)) {
            await attempt(migration ? () => migration!.rollback() : undefined)
          }
          if (workspaceCommitted) {
            await attempt(async () => { await deps.workspace.restoreCanonicalRoot(intent.sourceRoot) })
            await attempt(deps.assets && intent.sourceRoot !== null ? async () => { await deps.assets!.allowWorkspaceRoot() } : undefined)
          }
          if (lastWorkspaceChanged) {
            await attempt(async () => { await deps.setLastWorkspace(previousWorkspace) })
          }
          if (switchTicket) {
            await attempt(async () => { await requireDesktopAi().abortWorkspaceSwitch!(switchTicket!) })
          }
          if (rollbackErrors.length > 0) {
            const rollbackFailure = rollbackErrors.length === 1
              ? rollbackErrors[0]
              : new AggregateError(rollbackErrors, 'Save As rollback failures')
            const aggregate = new DocumentRollbackIncompleteError(cause, rollbackFailure)
            reportErrorWithoutThrow(aggregate)
            throw aggregate
          }
          throw cause
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    retryDraftFinalization: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (pendingDraftFinalization) {
          const pending = pendingDraftFinalization
          await pending.transaction.commit()
          recordDraftTerminal(pending.draftId)
          ownedDraftMutationRevision += 1
          pendingDraftFinalization = null
        }
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    saveDocumentAs: async (input?: unknown) => {
      try {
        const value = saveDocumentAsSchema.parse(input) as SaveDocumentAsInput
        const canUseTwoPhaseSaveAs = Boolean(
          deps.desktopAi?.prepareWorkspaceSwitch && deps.desktopAi.activateWorkspace
          && deps.desktopAi.abortWorkspaceSwitch && deps.aiRendererPorts
          && deps.openDocumentRegistry
          && typeof (deps.drafts as TransactionalDraftService | undefined)?.beginFinalizeSaved === 'function',
        )
        if (deps.desktopAi && !canUseTwoPhaseSaveAs) {
          throw new PublicError('OPERATION_FAILED')
        }
        if (canUseTwoPhaseSaveAs) {
          const begun = await operations.beginSaveDocumentAs(value)
          if (!begun.ok || begun.value === null) return begun
          if (begun.value.changesWorkspace) {
            await operations.abortSaveDocumentAs({ intentId: begun.value.intentId })
            throw new PublicError('OPERATION_FAILED')
          }
          const committed = await operations.commitSaveDocumentAs({ intentId: begun.value.intentId })
          return committed.ok
            ? {
                ok: true as const,
                value: {
                  workspace: committed.value.workspace,
                  document: committed.value.document,
                  ...(committed.value.draftEndPending ? { draftEndPending: true as const } : {}),
                },
              }
            : committed
        }
        requireOwnedDraft(value.draftId)
        if (!deps.chooseSavePath || !deps.drafts) throw new Error('Save As is unavailable')
        const selected = await deps.chooseSavePath(value.suggestedFileName)
        if (!selected) return { ok: true as const, value: null }
        const safeLegacySource = await deps.workspace.getValidatedActivationSnapshot()
        const safeLegacyActivation = await deps.workspace.validateRoot(path.dirname(selected))
        if (!sameWindowsFilesystemPath(
          safeLegacySource.root,
          safeLegacyActivation.summary.absolutePath,
        )) throw new PublicError('OPERATION_FAILED')
        const previousWorkspaceRoot = currentWorkspaceRootOrNull()
        const previousWorkspace = deps.getLastWorkspace()
        const previousFolderPickerPath = deps.getLastFolderPickerPath?.() ?? null
        let workspaceActivated = false
        let lastWorkspaceChanged = false
        const folderPickerPathChanged = false
        let migration: { markdown: string; rollback(): Promise<void> } | null = null
        let documentWritten = false
        const completedSave = await (async () => {
          try {
            const workspace = safeLegacyActivation.summary
            const relativePath = path.basename(selected)
            migration = deps.assets && !isCodeDocumentPath(relativePath) && !isCodeDocumentPath(ownedAbsolutePath ?? '')
              ? await migrateOwnedAssets(value.draftId, value.markdown, selected)
              : { markdown: value.markdown, rollback: async () => undefined }
            let document: DocumentSnapshot
            try {
              const existing = await deps.documents.read(relativePath)
              const saved = await deps.documents.save({
                relativePath,
                markdown: migration.markdown,
                expectedRevision: existing.revision,
                encoding: value.encoding,
                newline: value.newline,
              })
              document = {
                ...existing,
                markdown: migration.markdown,
                encoding: value.encoding,
                newline: value.newline,
                ...saved,
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              document = await deps.documents.create(relativePath, migration.markdown, {
                encoding: value.encoding,
                newline: value.newline,
              })
            }
            documentWritten = true
            return {
              workspace,
              document,
              preparedOwnership: await prepareDocumentOwnership(document),
            }
          } catch (error) {
            return await failAfterWorkspaceActivation({
              cause: error,
              message: 'Save As failed and workspace rollback was incomplete',
              previousRoot: previousWorkspaceRoot,
              rootChanged: workspaceActivated,
              previousWorkspace,
              lastWorkspaceChanged,
              previousFolderPickerPath,
              folderPickerPathChanged,
              beforeRootRestore: migration && !documentWritten && !(error instanceof DocumentRollbackIncompleteError) ? () => migration!.rollback() : undefined,
            })
          }
        })()
        await deps.drafts.finalizeSaved(value.draftId)
        commitDocumentOwnership(completedSave.preparedOwnership)
        return {
          ok: true as const,
          value: { workspace: completedSave.workspace, document: completedSave.document },
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    revealDocument: async (input?: unknown) => {
      try {
        const { relativePath } = relativePathSchema.parse(input)
        const target = await deps.workspace.resolveExistingDocument(relativePath)
        if (!deps.showItemInFolder) throw new Error('Reveal is unavailable')
        deps.showItemInFolder(target)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    startTranslation: async (input?: unknown) => {
      try {
        const value = parseStartTranslationInput(input)
        return {
          ok: true as const,
          value: await requireTranslations().start(value),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    startAiConversation: async (input?: unknown) => {
      try {
        const value = parseStartAiConversationInput(input)
        const authority = await currentAiWorkspaceAuthority()
        if (value.workspaceKey !== authority.workspaceId) throw new PublicError('INVALID_INPUT')
        const started = await requireAiConversations().start(value)
        if (!isStrictDataRecord(started, ['requestId', 'modelId', 'transcriptRevision'])
          || started.requestId !== value.requestId || typeof started.modelId !== 'string'
          || started.modelId.length === 0 || started.modelId.length > MODEL_ID_MAX_LENGTH
          || !Number.isSafeInteger(started.transcriptRevision) || started.transcriptRevision < 0) {
          throw new PublicError('INVALID_RESPONSE')
        }
        rememberBounded(ownedAiRequestIds, value.requestId, AI_IPC_OWNERSHIP_HISTORY_LIMIT)
        return {
          ok: true as const,
          value: Object.freeze({
            requestId: started.requestId,
            modelId: started.modelId,
            transcriptRevision: started.transcriptRevision,
          }),
        }
      } catch (error) {
        const failed = ipcFailure(error)
        return error instanceof ModelProtocolError && !failed.ok
          ? { ok: false as const, error: { ...failed.error, detail: error.detail } }
          : failed
      }
    },
    cancelAiConversation: async (input?: unknown) => {
      try {
        const { requestId } = parseCancelAiConversationInput(input)
        if (!ownedAiRequestIds.has(requestId)) throw new PublicError('INVALID_INPUT')
        await requireAiConversations().cancel(requestId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getAiWorkspaceState: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        return { ok: true as const, value: await currentAiWorkspaceAuthority() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setAiConversationCapabilities: async (input?: unknown) => {
      try {
        if (!isStrictDataRecord(input, [
          'conversationId', 'workspaceId', 'workspaceGeneration', 'capabilities',
        ]) || !isCanonicalAiConversationId(input.conversationId)
          || !isStrictDataRecord(input.capabilities, ['currentDocument', 'workspace'])
          || typeof input.capabilities.currentDocument !== 'boolean'
          || typeof input.capabilities.workspace !== 'boolean') throw new PublicError('INVALID_INPUT')
        const authority = await assertAiAuthority(input)
        requireAiConversations().setCapabilities({
          ownerId: requireDesktopAi().ownerId,
          workspaceId: authority.workspaceId,
          workspaceGeneration: authority.workspaceGeneration,
          conversationId: input.conversationId,
          capabilities: Object.freeze({
            currentDocument: input.capabilities.currentDocument,
            workspace: input.capabilities.workspace,
          }),
        })
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    submitAiAuthorizationResult: async (input?: unknown) => {
      try {
        if (!isStrictDataRecord(input, ['requestId', 'operationId', 'allowed'])
          || !isCanonicalAiConversationRequestId(input.requestId)
          || !isCanonicalAiConversationRequestId(input.operationId)
          || typeof input.allowed !== 'boolean' || !ownedAiRequestIds.has(input.requestId)) {
          throw new PublicError('INVALID_INPUT')
        }
        const key = `${input.requestId}\0${input.operationId}`
        if (settledAiAuthorizationKeys.has(key)) throw new PublicError('INVALID_INPUT')
        rememberBounded(
          settledAiAuthorizationKeys,
          key,
          AI_IPC_OWNERSHIP_HISTORY_LIMIT,
        )
        await requireAiConversations().submitAuthorizationResult({
          requestId: input.requestId,
          operationId: input.operationId,
          allowed: input.allowed,
        })
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    clearAiConversation: async (input?: unknown) => {
      try {
        if (!isStrictDataRecord(input, ['conversationId', 'workspaceId', 'workspaceGeneration'])
          || !isCanonicalAiConversationId(input.conversationId)) throw new PublicError('INVALID_INPUT')
        const authority = await assertAiAuthority(input)
        await requireAiConversations().clearConversation(authority.workspaceId, input.conversationId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    notifyAiCurrentDocumentChanged: async (input?: unknown) => {
      try {
        if (!isStrictDataRecord(input, ['workspaceId', 'workspaceGeneration'])) {
          throw new PublicError('INVALID_INPUT')
        }
        await assertAiAuthority(input)
        await requireAiConversations().notifyCurrentDocumentChanged()
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    registerAiCurrentDocumentPort: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.aiRendererPorts) throw new PublicError('OPERATION_FAILED')
        return { ok: true as const, value: await deps.aiRendererPorts.registerCurrentDocumentPort() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    unregisterAiCurrentDocumentPort: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.aiRendererPorts) throw new PublicError('OPERATION_FAILED')
        await deps.aiRendererPorts.unregisterCurrentDocumentPort()
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    submitAiCurrentDocumentPortResponse: async (input?: unknown) => {
      try {
        if (!deps.aiRendererPorts) throw new PublicError('OPERATION_FAILED')
        await deps.aiRendererPorts.submitCurrentDocumentResponse(input)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    registerAiOpenDocumentPort: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.aiRendererPorts || !deps.openDocumentRegistry || !ownedDocument) {
          throw new PublicError('OPERATION_FAILED')
        }
        const ownershipSession = ownedDocumentSession
        const document = ownedDocument
        const authority = await currentAiWorkspaceAuthority()
        const mainRead = await deps.documents.readForMain(document.relativePath)
        if (ownershipSession !== ownedDocumentSession || ownedDocument !== document
          || mainRead.document.relativePath !== document.relativePath
          || mainRead.document.revision !== document.revision) {
          throw new PublicError('INVALID_INPUT')
        }
        const value = await deps.aiRendererPorts.registerOpenDocument(
          deps.openDocumentRegistry,
          Object.freeze({
            windowId: requireDesktopAi().ownerId,
            workspaceId: authority.workspaceId,
            generation: authority.workspaceGeneration,
            fileIdentity: mainRead.identity,
          }),
        )
        return { ok: true as const, value }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    unregisterAiOpenDocumentPort: async (input?: unknown) => {
      try {
        if (!isStrictDataRecord(input, ['documentHandle'])
          || !isCanonicalAiConversationRequestId(input.documentHandle)
          || !deps.aiRendererPorts) throw new PublicError('INVALID_INPUT')
        await deps.aiRendererPorts.unregisterOpenDocument(input.documentHandle)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    submitAiOpenDocumentPortResponse: async (input?: unknown) => {
      try {
        if (!deps.aiRendererPorts) throw new PublicError('OPERATION_FAILED')
        await deps.aiRendererPorts.submitOpenDocumentResponse(input)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openAiMessageLink: async (input?: unknown) => {
      try {
        if (!isStrictDataRecord(input, ['target']) || typeof input.target !== 'string') {
          throw new PublicError('INVALID_INPUT')
        }
        const target = parseAiMessageLinkTarget(input.target)
        if (!target) throw new PublicError('INVALID_INPUT')
        if (target.kind === 'web') {
          if (!deps.openExternal) throw new PublicError('OPERATION_FAILED')
          await deps.openExternal(target.url)
          return { ok: true as const, value: target.url }
        }

        const authorityBefore = await currentAiWorkspaceAuthority()
        const activationBefore = await deps.workspace.getValidatedActivationSnapshot()
        const resolved = await resolveAiMessageLocalTarget(
          target,
          activationBefore.root,
          deps.aiMessageLinkIo,
        )
        const activationAfter = await deps.workspace.getValidatedActivationSnapshot()
        const authorityAfter = await currentAiWorkspaceAuthority()
        if (authorityBefore.workspaceId !== authorityAfter.workspaceId
          || authorityBefore.workspaceGeneration !== authorityAfter.workspaceGeneration
          || activationBefore.epoch !== activationAfter.epoch
          || !sameWindowsFilesystemPath(activationBefore.root, activationAfter.root)) {
          throw new PublicError('INVALID_INPUT')
        }

        if (!deps.showItemInFolder) throw new PublicError('OPERATION_FAILED')
        deps.showItemInFolder(resolved.absolutePath)
        return { ok: true as const, value: resolved.absolutePath }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    cancelTranslation: async (input?: unknown) => {
      try {
        const { requestId } = parseCancelTranslationInput(input)
        await requireTranslations().cancel(requestId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    updateScreenshotCapturePointer: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotCapturePointerInput(input)
        if (!parsed || !deps.screenshots) throw new PublicError('INVALID_INPUT')
        const hit = await deps.screenshots.updatePointer(parsed)
        return { ok: true as const, value: hit ?? null }
      } catch (error) { return ipcFailure(error) }
    },
    readyScreenshotCapture: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotCaptureReadyInput(input)
        if (!parsed || !deps.screenshots) throw new PublicError('INVALID_INPUT')
        await deps.screenshots.ready(parsed)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    commitScreenshotCapture: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotCaptureCommitInput(input)
        if (!parsed || !deps.screenshots) throw new PublicError('INVALID_INPUT')
        await deps.screenshots.commit(parsed)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    cancelScreenshotCapture: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotSessionInput(input)
        if (!parsed || !deps.screenshots) throw new PublicError('INVALID_INPUT')
        await deps.screenshots.cancel(parsed)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    submitScreenshotOcr: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotOcrSubmission(input)
        const target = deps.screenshotResults ?? deps.screenshotOcrHost
        if (!parsed || !target || !target.submit(parsed)) {
          throw new PublicError('INVALID_INPUT')
        }
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    settleScreenshotOcr: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotTranslationGenerationInput(input)
        const target = deps.screenshotResults ?? deps.screenshotOcrHost
        if (!parsed || !target || !target.settleOcr(parsed)) {
          throw new PublicError('INVALID_INPUT')
        }
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    startScreenshotTranslation: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotTranslationGenerationInput(input)
        if (!parsed || !deps.screenshotResults) throw new PublicError('INVALID_INPUT')
        const accepted = await deps.screenshotResults.start(parsed)
        if (!accepted
          || accepted.sessionId !== parsed.sessionId
          || accepted.generation !== parsed.generation + 1) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: accepted }
      } catch (error) { return ipcFailure(error) }
    },
    cancelScreenshotTranslation: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotTranslationGenerationInput(input)
        if (!parsed || !deps.screenshotResults) throw new PublicError('INVALID_INPUT')
        if (!deps.screenshotResults.cancel(parsed)) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    minimizeScreenshotTranslation: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotTranslationGenerationInput(input)
        if (!parsed || !deps.screenshotResults) throw new PublicError('INVALID_INPUT')
        if (!deps.screenshotResults.minimize(parsed)) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    closeScreenshotTranslation: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotTranslationGenerationInput(input)
        if (!parsed || !deps.screenshotResults) throw new PublicError('INVALID_INPUT')
        if (!await deps.screenshotResults.close(parsed)) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    openScreenshotTranslationSettings: async (input?: unknown) => {
      try {
        const parsed = parseScreenshotTranslationGenerationInput(input)
        if (!parsed || !deps.screenshotResults) throw new PublicError('INVALID_INPUT')
        if (!deps.screenshotResults.openSettings(parsed)) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    trashDocument: async (input?: unknown) => {
      try {
        const { relativePath } = relativePathSchema.parse(input)
        const target = await deps.workspace.resolveExistingDocument(relativePath)
        if (!deps.trashItem) throw new Error('Trash is unavailable')
        await deps.trashItem(target)
        if (ownedAbsolutePath && sameWindowsFilesystemPath(target, ownedAbsolutePath)) {
          clearOwnedDocument()
        }
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openApplicationMenu: async (input?: unknown) => {
      try {
        const { section, x, y } = applicationMenuSchema.parse(input)
        if (!deps.openApplicationMenu) throw new Error('Application menu is unavailable')
        deps.openApplicationMenu(section, x, y)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    executeApplicationMenuItem: async (input?: unknown) => {
      try {
        const { itemId } = applicationMenuItemSchema.parse(input)
        if (!deps.executeApplicationMenuItem) {
          throw new Error('Application menu item execution is unavailable')
        }
        deps.executeApplicationMenuItem(itemId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openBackgroundSettings: async (input?: unknown) => {
      try {
        const target = parseBackgroundTarget(input)
        if (!deps.backgrounds) throw new Error('Background settings are unavailable')
        await deps.backgrounds.open(target)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getBackgroundPresentation: async (input?: unknown) => {
      try {
        const target = parseBackgroundTarget(input)
        if (!deps.backgrounds) throw new Error('Background settings are unavailable')
        return { ok: true as const, value: await deps.backgrounds.get(target) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    chooseBackgroundImage: async (input?: unknown) => {
      try {
        const target = parseBackgroundTarget(input)
        if (!deps.backgrounds) throw new Error('Background settings are unavailable')
        return { ok: true as const, value: await deps.backgrounds.choose(target) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    removeBackgroundImage: async (input?: unknown) => {
      try {
        const target = parseBackgroundTarget(input)
        if (!deps.backgrounds) throw new Error('Background settings are unavailable')
        return { ok: true as const, value: await deps.backgrounds.remove(target) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    previewBackground: async (input?: unknown) => {
      try {
        const { target, settings } = parseBackgroundMutation(input)
        if (!deps.backgrounds) throw new Error('Background settings are unavailable')
        await deps.backgrounds.preview(target, settings)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    applyBackground: async (input?: unknown) => {
      try {
        const { target, settings } = parseBackgroundMutation(input)
        if (!deps.backgrounds) throw new Error('Background settings are unavailable')
        return { ok: true as const, value: await deps.backgrounds.apply(target, settings) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    cancelBackgroundSettings: async (input?: unknown) => {
      try {
        const target = parseBackgroundTarget(input)
        if (!deps.backgrounds) throw new Error('Background settings are unavailable')
        await deps.backgrounds.cancel(target)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    compareAndSetEditorAppearancePreferences: async (input?: unknown) => {
      try {
        const value = compareAndSetEditorAppearancePreferencesSchema.parse(input)
        if (!deps.compareAndSetEditorAppearancePreferences) {
          throw new Error('Editor appearance preferences are unavailable')
        }
        const current = await deps.compareAndSetEditorAppearancePreferences(
          value.expectedRevision,
          value.expectedAppearance,
          value.replacement,
        )
        return { ok: true as const, value: current }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    recordRecentDocument: async (input?: unknown) => {
      try {
        const { absolutePath } = droppedPathSchema.parse(input)
        if (!deps.recordRecentDocument) throw new Error('Recent documents are unavailable')
        return { ok: true as const, value: await deps.recordRecentDocument(absolutePath) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    updateApplicationMenuWindowState: async (input?: unknown) => {
      try {
        const state = applicationMenuWindowStateSchema.parse(input)
        if (!deps.updateApplicationMenuWindowState) {
          throw new Error('Application menu synchronization is unavailable')
        }
        deps.updateApplicationMenuWindowState(state)
        return { ok: true as const, value: undefined }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    printDocument: async (input?: unknown) => {
      try {
        const value = parsePrintDocumentInput(input)
        if (!value) throw new PublicError('INVALID_INPUT')
        if (!deps.printDocument) throw new Error('Document printing is unavailable')
        await deps.printDocument(value)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    takePrintDocument: async (input?: unknown) => {
      try {
        const { token } = printTokenSchema.parse(input)
        if (!deps.takePrintDocument) throw new Error('Print surface is unavailable')
        return { ok: true as const, value: deps.takePrintDocument(token) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    readyPrintDocument: async (input?: unknown) => {
      try {
        const { token } = printTokenSchema.parse(input)
        if (!deps.readyPrintDocument) throw new Error('Print surface is unavailable')
        deps.readyPrintDocument(token)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    controlWindow: async (input?: unknown) => {
      try {
        const { action } = windowControlSchema.parse(input)
        if (!deps.controlWindow) throw new Error('Window controls are unavailable')
        return { ok: true as const, value: deps.controlWindow(action) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    getWindowState: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        if (!deps.getWindowState) throw new Error('Window state is unavailable')
        return { ok: true as const, value: deps.getWindowState() }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    connectArknote: async (input?: unknown) => {
      try {
        noInputSchema.parse(input)
        const service = requireStickyNotes()
        if (!service.ensureAvailable) throw new Error('Arknote unavailable')
        await service.ensureAvailable()
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    listStickyNotes: async (input?: unknown) => {
      try {
        const { status } = parseExactOwnInput(
          input, ['status'], [], stickyNoteStatusSchema,
        )
        return { ok: true as const, value: await requireStickyNotes().list(status) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    reorderStickyNotes: async (input?: unknown) => {
      try {
        const { noteIds } = reorderStickyNotesSchema.parse(input)
        const service = requireStickyNotes()
        if (!service.reorder) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: await service.reorder(noteIds) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    searchStickyNotes: async (input?: unknown) => {
      try {
        const value = parseExactOwnInput(
          input, ['status', 'query'], [], stickyNoteSearchSchema,
        )
        return { ok: true as const, value: await requireStickyNotes().search(value) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    readStickyNote: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        if (deps.stickyNoteDataRoot !== undefined && noteId !== deps.clipboardNoteId) {
          throw new PublicError('INVALID_INPUT')
        }
        const note = await requireStickyNotes().read(noteId)
        if (deps.stickyNoteDataRoot === undefined) return { ok: true as const, value: note }
        const record = parseStickyNoteRecord(note.record)
        if (!record || record.id !== noteId) throw new PublicError('INVALID_INPUT')
        return { ok: true as const, value: {
          ...note,
          documentAbsolutePath: stickyNotePaths(deps.stickyNoteDataRoot, record).markdown,
        } }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    createStickyNote: async (input?: unknown) => {
      try {
        const value = parseCreateStickyNoteInput(input)
        return { ok: true as const, value: await requireStickyNotes().create(value) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    renameStickyNote: async (input?: unknown) => {
      try {
        const { noteId, name } = parseRenameStickyNoteInput(input)
        return { ok: true as const, value: await requireStickyNotes().rename(noteId, name) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    archiveStickyNote: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        return { ok: true as const, value: await requireStickyNotes().archive(noteId) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    restoreStickyNote: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        return { ok: true as const, value: await requireStickyNotes().restore(noteId) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    restoreArchivedStickyNotes: async (input?: unknown) => {
      try {
        const { noteIds } = parseExactOwnInput(
          input, ['noteIds'], [], restoreArchivedStickyNotesSchema,
        )
        const service = requireStickyNotes()
        if (!service.restoreArchived) throw new PublicError('INVALID_INPUT')
        await service.restoreArchived(noteIds)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    deleteStickyNote: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        await requireStickyNotes().delete(noteId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    deleteArchivedStickyNotes: async (input?: unknown) => {
      try {
        const { noteIds } = parseExactOwnInput(
          input, ['noteIds'], [], deleteArchivedStickyNotesSchema,
        )
        const service = requireStickyNotes()
        if (!service.deleteArchived) throw new PublicError('INVALID_INPUT')
        await service.deleteArchived(noteIds)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    importStickyNote: async (input?: unknown) => {
      try {
        const { absolutePath } = parseExactOwnInput(
          input, ['absolutePath'], [], importStickyNoteSchema,
        )
        return {
          ok: true as const,
          value: await requireStickyNotes().importFile(absolutePath),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    importStickyNoteSelection: async (input?: unknown) => {
      try {
        const parsed = parseExactOwnInput(
          input, ['markdown', 'localResources'], [], importStickyNoteSelectionSchema,
        )
        return {
          ok: true as const,
          value: await (() => {
            const service = requireStickyNotes()
            if (!service.importSelection) throw new PublicError('INVALID_INPUT')
            return service.importSelection(parsed)
          })(),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    stageStickyNoteSave: async (input?: unknown) => {
      try {
        const { noteId, markdown } = parseExactOwnInput(
          input, ['noteId', 'markdown'], [], stageStickyNoteSaveSchema,
        )
        await requireStickyNotes().stageSave(noteId, markdown)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    flushStickyNoteSave: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        return { ok: true as const, value: await requireStickyNotes().flushSave(noteId) }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    openStickyNote: async (input?: unknown) => {
      try {
        const { noteId, query } = parseExactOwnInput(
          input, ['noteId'], ['query'], openStickyNoteSchema,
        )
        const foregroundSourceId = deps.getStickyNoteForegroundSourceId?.()
        if (foregroundSourceId === undefined) await requireStickyNotes().open(noteId, query)
        else {
          stickyNoteForegroundSourceIdSchema.parse(foregroundSourceId)
          await requireStickyNotes().open(noteId, query, foregroundSourceId)
        }
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    closeStickyNote: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        await requireStickyNotes().close(noteId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    releaseStickyNote: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        await requireStickyNotes().release(noteId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    reclaimStickyNote: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        await requireStickyNotes().reclaim(noteId)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setStickyNotePinned: async (input?: unknown) => {
      try {
        const { noteId, pinned } = parseExactOwnInput(
          input, ['noteId', 'pinned'], [], setStickyNotePinnedSchema,
        )
        await requireStickyNotes().setPinned(noteId, pinned)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setStickyNoteStyle: async (input?: unknown) => {
      try {
        const { noteId, style } = parseSetStickyNoteStyleInput(input)
        return {
          ok: true as const,
          value: await requireStickyNotes().setStyle(noteId, style),
        }
      } catch (error) {
        return ipcFailure(error)
      }
    },
    setStickyNoteLineSpacingMode: async (input?: unknown) => {
      try {
        const { noteId, lineSpacingMode } = parseExactOwnInput(
          input, ['noteId', 'lineSpacingMode'], [], setStickyNoteLineSpacingModeSchema,
        )
        const service = requireStickyNotes()
        if (!service.setLineSpacingMode) throw new Error('Line spacing control unavailable')
        await service.setLineSpacingMode(noteId, lineSpacingMode)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    setStickyNoteFontSize: async (input?: unknown) => {
      try {
        const { noteId, fontSizePx } = parseExactOwnInput(input, ['noteId', 'fontSizePx'], [], setStickyNoteFontSizeSchema)
        const service = requireStickyNotes()
        if (!service.setFontSize) throw new Error('字号控制不可用')
        await service.setFontSize(noteId, fontSizePx)
        return { ok: true as const, value: null }
      } catch (error) { return ipcFailure(error) }
    },
    chooseStickyNoteImage: async (input?: unknown) => {
      try {
        const { noteId } = parseStickyNoteReference(input)
        if (!deps.chooseStickyNoteImage) throw new Error('便签图片选择不可用')
        return { ok: true as const, value: await deps.chooseStickyNoteImage(noteId) }
      } catch (error) { return ipcFailure(error) }
    },
    copyStickyNoteImage: async (input?: unknown) => {
      try {
        const { noteId, absolutePath } = parseExactOwnInput(input, ['noteId', 'absolutePath'], [], copyStickyNoteImageSchema)
        const service = requireStickyNotes()
        if (!service.copyImage) throw new Error('图片导入不可用')
        return { ok: true as const, value: await service.copyImage(noteId, absolutePath) }
      } catch (error) { return ipcFailure(error) }
    },
    resizeStickyNoteToContent: async (input?: unknown) => {
      try {
        const { noteId, measurement } = parseResizeStickyNoteInput(input)
        await requireStickyNotes().resizeToContent(noteId, measurement)
        return { ok: true as const, value: null }
      } catch (error) {
        return ipcFailure(error)
      }
    },
  }

  const serializeAuthorityOperation = <T extends (input?: unknown) => Promise<unknown>>(
    operation: T,
    requiresFinalizedDraft = false,
  ): T => ((input?: unknown) => enqueueAuthorityOperation(() => {
    if (requiresFinalizedDraft && pendingDraftFinalization) return Promise.resolve(ipcFailure(new PublicError('OPERATION_FAILED')))
    return operation(input)
  })) as T

  const serializeSaveDraft = (input?: unknown) => {
    const draftIdAtInvocation = ownedDraftId
    const terminalEpochAtInvocation = draftTerminalEpoch
    return enqueueAuthorityOperation(async () => {
      activeQueuedAutosaveDraftId = draftIdAtInvocation
      activeQueuedDraftEpoch = terminalEpochAtInvocation
      try {
        return await operations.saveDraft(input)
      } finally {
        activeQueuedAutosaveDraftId = null
      }
    })
  }

  const serializeSaveDocument = (input?: unknown) => {
    const saveOwnerAtInvocation = {
      session: ownedDocumentSession,
      relativePath: ownedDocument?.relativePath ?? null,
    }
    return enqueueAuthorityOperation(async () => {
      activeQueuedSaveOwner = saveOwnerAtInvocation
      try {
        if (pendingDraftFinalization) return ipcFailure(new PublicError('OPERATION_FAILED'))
        return await operations.saveDocument(input)
      } finally {
        activeQueuedSaveOwner = null
      }
    })
  }

  return {
    ...operations,
    // Main-only admission. Renderer overlays are not authority to start new work during an update.
    admitUpdateOperation: (name: string): boolean => {
      const safety = new Set(['getAppUpdateState', 'performUpdateAction', 'notifyUpdateAbout', 'openUpdateWebsite',
        'requestRequiredUpdateExit', 'protectUpdateWork', 'controlWindow', 'saveDocument', 'beginSaveDocumentAs',
        'commitSaveDocumentAs', 'abortSaveDocumentAs', 'saveDraft', 'cleanDraft', 'discardDraft', 'ignoreDraft',
        'retryDraftFinalization', 'releaseDraftRecovery', 'cancelAiConversation', 'cancelTranslation',
        'submitAiCurrentDocumentPortResponse', 'submitAiOpenDocumentPortResponse', 'unregisterAiCurrentDocumentPort',
        'unregisterAiOpenDocumentPort', 'updateApplicationMenuWindowState'])
      if (deps.updates?.isWorkBlocked?.() && !safety.has(name) && !/^(?:get|read|list|peek|inspect)/.test(name)) return false
      if (/^(?:create|save|beginSave|commitSave|import|paste|rename|trash|duplicate|choose|apply|set)/.test(name)
        || ['claimRecoveredDraft', 'startAiConversation', 'submitAiAuthorizationResult', 'startTranslation', 'printDocument'].includes(name)) deps.updates?.noteWorkStarted?.()
      return true
    },
    seedStartupDocumentOwnership,
    authorizeDraftRecovery,
    releaseDraftOwnership: () => deps.drafts?.releaseOwner?.(draftOwner),
    getCurrentDocumentAbsolutePath: () => ownedAbsolutePath,
    clearDocumentView: () => documentView.clear(),
    // This main-only getter is not registered as an IPC operation. Selection
    // comes from completed document ownership transitions, not a renderer path.
    getCurrentDocumentWriteAuthority: () => {
      const root = currentWorkspaceRootOrNull()
      if (!ownedDocument || !ownedAbsolutePath || !root
        || path.resolve(root, ownedDocument.relativePath).toLocaleLowerCase('en-US')
          !== path.resolve(ownedAbsolutePath).toLocaleLowerCase('en-US')) return null
      return { path: ownedDocument.relativePath, session: ownedDocumentSession }
    },
    releaseClipboardResources,
    chooseWorkspace: serializeAuthorityOperation(operations.chooseWorkspace, true),
    restoreWorkspace: serializeAuthorityOperation(operations.restoreWorkspace, true),
    listDirectory: serializeAuthorityOperation(operations.listDirectory),
    openDroppedPath: serializeAuthorityOperation(operations.openDroppedPath, true),
    prepareDroppedPath: serializeAuthorityOperation(operations.prepareDroppedPath, true),
    settleDroppedPath: serializeAuthorityOperation(operations.settleDroppedPath, true),
    importDocx: serializeAuthorityOperation(operations.importDocx, true),
    importAsset: serializeAuthorityOperation(operations.importAsset, true),
    createWorkspaceFolder: serializeAuthorityOperation(operations.createWorkspaceFolder),
    renameWorkspaceEntry: serializeAuthorityOperation(operations.renameWorkspaceEntry, true),
    duplicateWorkspaceDocument: serializeAuthorityOperation(operations.duplicateWorkspaceDocument),
    trashWorkspaceEntry: serializeAuthorityOperation(operations.trashWorkspaceEntry, true),
    revealWorkspaceEntry: serializeAuthorityOperation(operations.revealWorkspaceEntry),
    openWorkspaceEntryWindow: serializeAuthorityOperation(operations.openWorkspaceEntryWindow),
    getWorkspaceEntryProperties: serializeAuthorityOperation(operations.getWorkspaceEntryProperties),
    getWorkspaceRootProperties: serializeAuthorityOperation(operations.getWorkspaceRootProperties),
    getWorkspaceColorMarks: serializeAuthorityOperation(operations.getWorkspaceColorMarks),
    setWorkspaceColorMark: serializeAuthorityOperation(operations.setWorkspaceColorMark),
    moveWorkspaceColorMark: serializeAuthorityOperation(operations.moveWorkspaceColorMark),
    deleteWorkspaceColorMarks: serializeAuthorityOperation(operations.deleteWorkspaceColorMarks),
    createDocument: serializeAuthorityOperation(operations.createDocument, true),
    readDocument: serializeAuthorityOperation(operations.readDocument, true),
    peekDocument: serializeAuthorityOperation(operations.peekDocument),
    saveDocument: serializeSaveDocument,
    pasteClipboardImage: serializeAuthorityOperation(operations.pasteClipboardImage, true),
    saveDraft: serializeSaveDraft,
    readDraft: serializeAuthorityOperation(operations.readDraft),
    claimRecoveredDraft: serializeAuthorityOperation(operations.claimRecoveredDraft, true),
    releaseDraftRecovery: serializeAuthorityOperation(operations.releaseDraftRecovery),
    cleanDraft: serializeAuthorityOperation(operations.cleanDraft, true),
    ignoreDraft: serializeAuthorityOperation(operations.ignoreDraft),
    discardDraft: serializeAuthorityOperation(operations.discardDraft, true),
    beginSaveDocumentAs: serializeAuthorityOperation(operations.beginSaveDocumentAs, true),
    commitSaveDocumentAs: serializeAuthorityOperation(operations.commitSaveDocumentAs, true),
    abortSaveDocumentAs: serializeAuthorityOperation(operations.abortSaveDocumentAs),
    retryDraftFinalization: serializeAuthorityOperation(operations.retryDraftFinalization),
    saveDocumentAs: serializeAuthorityOperation(operations.saveDocumentAs, true),
    revealDocument: serializeAuthorityOperation(operations.revealDocument),
    trashDocument: serializeAuthorityOperation(operations.trashDocument, true),
    openAiMessageLink: serializeAuthorityOperation(operations.openAiMessageLink),
  }
}


interface IpcEventLike {
  sender: unknown
  senderFrame: unknown
}

interface IpcMainLike {
  handle(
    channel: string,
    handler: (event: IpcEventLike, ...args: unknown[]) => unknown,
  ): void
  removeHandler(channel: string): void
}

interface WindowLike {
  webContents: {
    mainFrame: unknown
    readonly id?: number
    send?(channel: string, payload: unknown): void
    isDestroyed?(): boolean
  }
  isDestroyed?(): boolean
  getMediaSourceId?(): string
  minimize?(): void
  maximize?(): void
  unmaximize?(): void
  close?(): void
  isMaximized?(): boolean
  isFullScreen?(): boolean
  setFullScreen?(fullscreen: boolean): void
}

function readWindowMediaSourceId(window: WindowLike): string | undefined {
  try {
    return window.getMediaSourceId?.()
  } catch {
    return undefined
  }
}

type IpcOperations = ReturnType<typeof createIpcOperations>
type OperationName = keyof IpcOperations

interface RegistrationTarget {
  window: WindowLike
  operations: Partial<IpcOperations>
  canAcceptAiTerminalResponseWhilePaused?: () => boolean
}

interface SessionDispatch {
  token: object
  target: RegistrationTarget
  accepting: boolean
  drainWaiters: Set<() => void>
  inflight: number
}

interface OwnedDispatch {
  sessions: Map<unknown, SessionDispatch>
  installedChannels: Set<string>
}

export interface IpcRegistration {
  pauseAndDrain(): Promise<void>
  resume(): void
  dispose(): void
}

export interface DocumentIpcRegistration extends IpcRegistration {
  quiesceForClose(): Promise<void>
  resumeAfterClose(beforeAdmission?: () => void | Promise<void>): Promise<void>
  dispose(): Promise<void>
  cancelCodexCliLoginAttempt(): Promise<void>
  seedStartupDocumentOwnership(snapshot: DocumentSnapshot): Promise<void>
  authorizeDraftRecovery(draftId: string): Promise<void>
  getCurrentDocumentWriteAuthority(): { path: string; session: number } | null
  getCurrentDocumentAbsolutePath(): string | null
}

interface DocumentConversionWebContentsLike {
  readonly id: number
  readonly mainFrame: unknown
  send(channel: string, payload: unknown): void
  isDestroyed?(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

interface DocumentConversionSession {
  readonly webContents: DocumentConversionWebContentsLike
  readonly workspace: Pick<WorkspaceService, 'resolveExistingConvertibleDocument'>
  readonly installs: Map<string, string>
  readonly conversions: Map<string, AbortController>
  accepting: boolean
  inflight: number
  readonly drainWaiters: Set<() => void>
  disposed: boolean
  readonly destroyed: () => void
}

interface DocumentConversionDispatch {
  readonly ipcMain: IpcMainLike
  readonly sessions: Map<unknown, DocumentConversionSession>
  readonly manager: Pick<
    DocumentConversionComponentManager,
    'getState' | 'install' | 'cancelInstall' | 'remove' | 'subscribe'
  >
  readonly conversions: Pick<DocumentConversionService, 'convertResolved'>
  readonly channels: Set<string>
  unsubscribeState: () => void
}

const documentConversionRegistrations = new WeakMap<object, DocumentConversionDispatch>()

function cloneDocumentConversionState(value: unknown): DocumentConversionComponentState {
  const parsed = parseDocumentConversionComponentState(value)
  if (!parsed) throw new PublicError('INVALID_RESPONSE')
  return {
    ...parsed,
    progress: parsed.progress ? { ...parsed.progress } : null,
  }
}

function cloneConvertedDocument(
  value: unknown,
  expected: ResolvedConvertibleDocument,
): ConvertedDocument {
  const parsed = parseConvertedDocument(value)
  if (
    !parsed
    || parsed.source.absolutePath !== expected.canonicalPath
    || parsed.source.fileName !== expected.fileName
    || parsed.source.format !== expected.format
    || parsed.source.bytes !== expected.bytes
    || parsed.source.modifiedAtMs !== expected.modifiedAtMs
  ) {
    throw new PublicError('INVALID_RESPONSE')
  }
  return {
    ...parsed,
    source: {
      absolutePath: expected.canonicalPath,
      fileName: expected.fileName,
      format: expected.format,
      bytes: expected.bytes,
      modifiedAtMs: expected.modifiedAtMs,
    },
    warnings: [...parsed.warnings],
  }
}

function parseDocumentConversionRequestId(input: unknown): string {
  if (!isExactOwnInput(input, ['requestId'])) throw new PublicError('INVALID_INPUT')
  const requestId = input.requestId
  if (typeof requestId !== 'string' || !isCanonicalTranslationRequestId(requestId)) {
    throw new PublicError('INVALID_INPUT')
  }
  return requestId
}

function safeConvertibleRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_767
    || value.includes('\0') || value.includes(':')
    || path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)
    || !isMarkItDownConversionPath(value)) return false
  const segments = value.split(/[\\/]/u)
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

function parseConvertWorkspaceDocumentInput(input: unknown): {
  requestId: string
  relativePath: string
} {
  if (!isExactOwnInput(input, ['requestId', 'relativePath'])) {
    throw new PublicError('INVALID_INPUT')
  }
  const requestId = input.requestId
  const relativePath = input.relativePath
  if (typeof requestId !== 'string' || !isCanonicalTranslationRequestId(requestId)
    || !safeConvertibleRelativePath(relativePath)) {
    throw new PublicError('INVALID_INPUT')
  }
  return { requestId, relativePath }
}

function documentConversionOwner(webContentsId: number, requestId: string): string {
  return `${webContentsId}:${requestId}`
}

function finishDocumentConversionInflight(session: DocumentConversionSession): void {
  session.inflight -= 1
  if (session.inflight !== 0) return
  for (const resolve of session.drainWaiters) resolve()
  session.drainWaiters.clear()
}

function cancelDocumentConversionSession(
  dispatch: DocumentConversionDispatch,
  session: DocumentConversionSession,
): void {
  for (const owner of session.installs.values()) {
    void dispatch.manager.cancelInstall(owner).catch(() => undefined)
  }
  session.installs.clear()
  for (const controller of session.conversions.values()) {
    controller.abort(new DOMException('Renderer was destroyed', 'AbortError'))
  }
  session.conversions.clear()
}

async function handleDocumentConversionRequest(
  dispatch: DocumentConversionDispatch,
  channel: string,
  event: IpcEventLike,
  args: unknown[],
): Promise<ApiResult<unknown>> {
  const session = dispatch.sessions.get(event.sender)
  if (!session || event.senderFrame !== session.webContents.mainFrame) {
    return failure('UNTRUSTED_SENDER')
  }
  if (!session.accepting) return failure('OPERATION_FAILED')
  session.inflight += 1
  try {
    if (channel === IPC_CHANNELS.getDocumentConversionComponentState) {
      if (args.length !== 0) throw new PublicError('INVALID_INPUT')
      return { ok: true, value: cloneDocumentConversionState(dispatch.manager.getState()) }
    }
    if (channel === IPC_CHANNELS.removeDocumentConversionComponent) {
      if (args.length !== 0) throw new PublicError('INVALID_INPUT')
      return { ok: true, value: cloneDocumentConversionState(await dispatch.manager.remove()) }
    }
    if (args.length !== 1) throw new PublicError('INVALID_INPUT')
    if (channel === IPC_CHANNELS.installDocumentConversionComponent) {
      const requestId = parseDocumentConversionRequestId(args[0])
      if (session.installs.has(requestId) || session.conversions.has(requestId)) {
        throw new PublicError('INVALID_INPUT')
      }
      const owner = documentConversionOwner(session.webContents.id, requestId)
      session.installs.set(requestId, owner)
      try {
        return { ok: true, value: cloneDocumentConversionState(await dispatch.manager.install(owner)) }
      } finally {
        if (session.installs.get(requestId) === owner) session.installs.delete(requestId)
      }
    }
    if (channel === IPC_CHANNELS.cancelDocumentConversionComponentInstall) {
      const requestId = parseDocumentConversionRequestId(args[0])
      const owner = session.installs.get(requestId)
      if (!owner) throw new PublicError('INVALID_INPUT')
      session.installs.delete(requestId)
      await dispatch.manager.cancelInstall(owner).catch(() => undefined)
      return { ok: true, value: null }
    }
    if (channel === IPC_CHANNELS.convertWorkspaceDocument) {
      const { requestId, relativePath } = parseConvertWorkspaceDocumentInput(args[0])
      if (session.installs.has(requestId) || session.conversions.has(requestId)) {
        throw new PublicError('INVALID_INPUT')
      }
      const controller = new AbortController()
      session.conversions.set(requestId, controller)
      try {
        const resolved = await session.workspace.resolveExistingConvertibleDocument(relativePath)
        controller.signal.throwIfAborted()
        const converted = await dispatch.conversions.convertResolved(resolved, controller.signal)
        return { ok: true, value: cloneConvertedDocument(converted, resolved) }
      } finally {
        if (session.conversions.get(requestId) === controller) session.conversions.delete(requestId)
      }
    }
    if (channel === IPC_CHANNELS.cancelWorkspaceDocumentConversion) {
      const requestId = parseDocumentConversionRequestId(args[0])
      const controller = session.conversions.get(requestId)
      if (!controller) throw new PublicError('INVALID_INPUT')
      session.conversions.delete(requestId)
      controller.abort(new DOMException('Document conversion was cancelled', 'AbortError'))
      return { ok: true, value: null }
    }
    return failure('OPERATION_FAILED')
  } catch (error) {
    return ipcFailure(error)
  } finally {
    finishDocumentConversionInflight(session)
  }
}

function installDocumentConversionDispatch(options: {
  ipcMain: IpcMainLike
  manager: DocumentConversionDispatch['manager']
  conversions: DocumentConversionDispatch['conversions']
}): DocumentConversionDispatch {
  const dispatch: DocumentConversionDispatch = {
    ipcMain: options.ipcMain,
    sessions: new Map(),
    manager: options.manager,
    conversions: options.conversions,
    channels: new Set(),
    unsubscribeState: () => undefined,
  }
  try {
    for (const channel of DOCUMENT_CONVERSION_IPC_CHANNELS) {
      options.ipcMain.handle(channel, (event, ...args) => (
        handleDocumentConversionRequest(dispatch, channel, event, args)
      ))
      dispatch.channels.add(channel)
    }
    dispatch.unsubscribeState = options.manager.subscribe((value) => {
      let state: DocumentConversionComponentState
      try { state = cloneDocumentConversionState(value) } catch { return }
      for (const session of dispatch.sessions.values()) {
        if (session.disposed || session.webContents.isDestroyed?.()) continue
        try {
          session.webContents.send(
            DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
            cloneDocumentConversionState(state),
          )
        } catch { /* Current state remains available through the query channel. */ }
      }
    })
  } catch (error) {
    try { dispatch.unsubscribeState() } catch { /* registration rollback continues */ }
    for (const channel of dispatch.channels) options.ipcMain.removeHandler(channel)
    throw error
  }
  documentConversionRegistrations.set(options.ipcMain as object, dispatch)
  return dispatch
}

export function registerDocumentConversionIpc(options: {
  ipcMain: IpcMainLike
  window: { webContents: DocumentConversionWebContentsLike }
  workspace: Pick<WorkspaceService, 'resolveExistingConvertibleDocument'>
  componentManager: DocumentConversionDispatch['manager']
  conversions: DocumentConversionDispatch['conversions']
}): IpcRegistration {
  const webContents = options.window.webContents
  if (!Number.isSafeInteger(webContents.id) || webContents.id < 0) {
    throw new Error('Invalid document conversion webContents owner')
  }
  const dispatch = documentConversionRegistrations.get(options.ipcMain as object)
    ?? installDocumentConversionDispatch({
      ipcMain: options.ipcMain,
      manager: options.componentManager,
      conversions: options.conversions,
    })
  if (dispatch.manager !== options.componentManager || dispatch.conversions !== options.conversions) {
    throw new Error('Document conversion IPC dependencies changed')
  }
  if (dispatch.sessions.has(webContents)) throw new Error('Document conversion IPC already registered')

  let session!: DocumentConversionSession
  let dispose = (): void => undefined
  const destroyed = () => dispose()
  session = {
    webContents,
    workspace: options.workspace,
    installs: new Map(),
    conversions: new Map(),
    accepting: true,
    inflight: 0,
    drainWaiters: new Set(),
    disposed: false,
    destroyed,
  }
  dispatch.sessions.set(webContents, session)
  webContents.once('destroyed', destroyed)

  dispose = (): void => {
    if (session.disposed) return
    session.disposed = true
    session.accepting = false
    webContents.removeListener('destroyed', destroyed)
    cancelDocumentConversionSession(dispatch, session)
    dispatch.sessions.delete(webContents)
    if (dispatch.sessions.size !== 0) return
    documentConversionRegistrations.delete(options.ipcMain as object)
    try { dispatch.unsubscribeState() } catch { /* handler cleanup continues */ }
    for (const channel of dispatch.channels) options.ipcMain.removeHandler(channel)
  }

  return {
    pauseAndDrain() {
      if (session.disposed) return Promise.resolve()
      session.accepting = false
      if (session.inflight === 0) return Promise.resolve()
      return new Promise<void>((resolve) => session.drainWaiters.add(resolve))
    },
    resume() {
      if (!session.disposed) session.accepting = true
    },
    dispose,
  }
}

const operationNameByChannel = new Map<string, OperationName>([
  [IPC_CHANNELS.claimWorkspaceIntroduction, 'claimWorkspaceIntroduction'],
  [IPC_CHANNELS.chooseWorkspace, 'chooseWorkspace'],
  [IPC_CHANNELS.restoreWorkspace, 'restoreWorkspace'],
  [IPC_CHANNELS.listDirectory, 'listDirectory'],
  [IPC_CHANNELS.startWorkspaceFileDrag, 'startWorkspaceFileDrag'],
  [IPC_CHANNELS.inspectDroppedPath, 'inspectDroppedPath'],
  [IPC_CHANNELS.openDroppedPath, 'openDroppedPath'],
  [IPC_CHANNELS.prepareDroppedPath, 'prepareDroppedPath'],
  [IPC_CHANNELS.settleDroppedPath, 'settleDroppedPath'],
  [IPC_CHANNELS.createDocument, 'createDocument'],
  [IPC_CHANNELS.readDocument, 'readDocument'],
  [IPC_CHANNELS.peekDocument, 'peekDocument'],
  [IPC_CHANNELS.saveDocument, 'saveDocument'],
  [IPC_CHANNELS.beginSaveDocumentAs, 'beginSaveDocumentAs'],
  [IPC_CHANNELS.commitSaveDocumentAs, 'commitSaveDocumentAs'],
  [IPC_CHANNELS.abortSaveDocumentAs, 'abortSaveDocumentAs'],
  [IPC_CHANNELS.retryDraftFinalization, 'retryDraftFinalization'],
  [IPC_CHANNELS.saveDraft, 'saveDraft'],
  [IPC_CHANNELS.listRecoverableDrafts, 'listRecoverableDrafts'],
  [IPC_CHANNELS.readDraft, 'readDraft'],
  [IPC_CHANNELS.claimRecoveredDraft, 'claimRecoveredDraft'],
  [IPC_CHANNELS.releaseDraftRecovery, 'releaseDraftRecovery'],
  [IPC_CHANNELS.cleanDraft, 'cleanDraft'],
  [IPC_CHANNELS.ignoreDraft, 'ignoreDraft'],
  [IPC_CHANNELS.discardDraft, 'discardDraft'],
  [IPC_CHANNELS.revealDocument, 'revealDocument'],
  [IPC_CHANNELS.trashDocument, 'trashDocument'],
  [IPC_CHANNELS.importDocx, 'importDocx'],
  [IPC_CHANNELS.exportDocx, 'exportDocx'],
  [IPC_CHANNELS.exportXlsx, 'exportXlsx'],
  [IPC_CHANNELS.readClipboardFormats, 'readClipboardFormats'],
  [IPC_CHANNELS.pasteClipboardImage, 'pasteClipboardImage'],
  [IPC_CHANNELS.importAsset, 'importAsset'],
  [IPC_CHANNELS.openAsset, 'openAsset'],
  [IPC_CHANNELS.openDocumentWindow, 'openDocumentWindow'],
  [IPC_CHANNELS.navigateDocumentView, 'navigateDocumentView'],
  [IPC_CHANNELS.refreshDocumentView, 'refreshDocumentView'],
  [IPC_CHANNELS.inspectDocumentView, 'inspectDocumentView'],
  [IPC_CHANNELS.openDocumentView, 'openDocumentView'],
  [IPC_CHANNELS.revealLocalFileLink, 'revealLocalFileLink'],
  [IPC_CHANNELS.controlWindow, 'controlWindow'],
  [IPC_CHANNELS.getWindowState, 'getWindowState'],
  [IPC_CHANNELS.getAppUpdateState, 'getAppUpdateState'],
  [IPC_CHANNELS.notifyUpdateAbout, 'notifyUpdateAbout'],
  [IPC_CHANNELS.openUpdateWebsite, 'openUpdateWebsite'],
  [IPC_CHANNELS.requestRequiredUpdateExit, 'requestRequiredUpdateExit'],
  [IPC_CHANNELS.protectUpdateWork, 'protectUpdateWork'],
  [IPC_CHANNELS.performUpdateAction, 'performUpdateAction'],
  [IPC_CHANNELS.getSearchPreferences, 'getSearchPreferences'],
  [IPC_CHANNELS.getPreferenceSnapshot, 'getPreferenceSnapshot'],
  [IPC_CHANNELS.patchPreferences, 'patchPreferences'],
  [IPC_CHANNELS.getKeyboardShortcuts, 'getKeyboardShortcuts'],
  [IPC_CHANNELS.updateKeyboardShortcuts, 'updateKeyboardShortcuts'],
  [IPC_CHANNELS.setShortcutRecording, 'setShortcutRecording'],
  [IPC_CHANNELS.setSearchPreferences, 'setSearchPreferences'],
  [IPC_CHANNELS.getEditorAppearancePreferences, 'getEditorAppearancePreferences'],
  [IPC_CHANNELS.setEditorAppearancePreferences, 'setEditorAppearancePreferences'],
  [IPC_CHANNELS.compareAndSetEditorAppearancePreferences, 'compareAndSetEditorAppearancePreferences'],
  [IPC_CHANNELS.getLayoutPreferences, 'getLayoutPreferences'],
  [IPC_CHANNELS.compareAndSetLayoutPreferences, 'compareAndSetLayoutPreferences'],
  [IPC_CHANNELS.getStickyNotePreferences, 'getStickyNotePreferences'],
  [IPC_CHANNELS.setStickyNotePreferences, 'setStickyNotePreferences'],
  [IPC_CHANNELS.getDesktopLifecyclePreferences, 'getDesktopLifecyclePreferences'],
  [IPC_CHANNELS.getShellIntegrationPreferences, 'getShellIntegrationPreferences'],
  [IPC_CHANNELS.getDefaultApplicationsStatus, 'getDefaultApplicationsStatus'],
  [IPC_CHANNELS.openDefaultApplicationsSettings, 'openDefaultApplicationsSettings'],
  [IPC_CHANNELS.setDefaultApplicationsEnabled, 'setDefaultApplicationsEnabled'],
  [IPC_CHANNELS.updateShellIntegrationPreference, 'updateShellIntegrationPreference'],
  [IPC_CHANNELS.setDesktopLifecyclePreferences, 'setDesktopLifecyclePreferences'],
  [IPC_CHANNELS.getArknotePreferences, 'getArknotePreferences'],
  [IPC_CHANNELS.setArknotePreferences, 'setArknotePreferences'],
  [IPC_CHANNELS.previewStickyNoteWallpaperAppearances, 'previewStickyNoteWallpaperAppearances'],
  [IPC_CHANNELS.getSystemFonts, 'getSystemFonts'],
  [IPC_CHANNELS.previewArknoteThemeColor, 'previewArknoteThemeColor'],
  [IPC_CHANNELS.getModelCapabilityRules, 'getModelCapabilityRules'],
  [IPC_CHANNELS.setModelCapabilityRules, 'setModelCapabilityRules'],
  [IPC_CHANNELS.getLargeModelSettings, 'getLargeModelSettings'],
  [IPC_CHANNELS.getModelSettingsSnapshot, 'getModelSettingsSnapshot'],
  [IPC_CHANNELS.connectModel, 'connectModel'],
  [IPC_CHANNELS.listModels, 'listModels'],
  [IPC_CHANNELS.testModel, 'testModel'],
  [IPC_CHANNELS.deleteModel, 'deleteModel'],
  [IPC_CHANNELS.setAiConversationSettings, 'setAiConversationSettings'],
  [IPC_CHANNELS.testCodexCliConnection, 'testCodexCliConnection'],
  [IPC_CHANNELS.startCodexCliLogin, 'startCodexCliLogin'],
  [IPC_CHANNELS.cancelCodexCliLogin, 'cancelCodexCliLogin'],
  [IPC_CHANNELS.removeCodexCliConnection, 'removeCodexCliConnection'],
  [IPC_CHANNELS.setSelectionTranslationSettings, 'setSelectionTranslationSettings'],
  [IPC_CHANNELS.setScreenshotTranslationSettings, 'setScreenshotTranslationSettings'],
  [IPC_CHANNELS.setFloatingTranslationSettings, 'setFloatingTranslationSettings'],
  [IPC_CHANNELS.acceptTranslationPrivacyNotice, 'acceptTranslationPrivacyNotice'],
  [IPC_CHANNELS.startTranslation, 'startTranslation'],
  [IPC_CHANNELS.cancelTranslation, 'cancelTranslation'],
  [IPC_CHANNELS.startAiConversation, 'startAiConversation'],
  [IPC_CHANNELS.cancelAiConversation, 'cancelAiConversation'],
  [IPC_CHANNELS.getAiWorkspaceState, 'getAiWorkspaceState'],
  [IPC_CHANNELS.setAiConversationCapabilities, 'setAiConversationCapabilities'],
  [IPC_CHANNELS.submitAiAuthorizationResult, 'submitAiAuthorizationResult'],
  [IPC_CHANNELS.clearAiConversation, 'clearAiConversation'],
  [IPC_CHANNELS.notifyAiCurrentDocumentChanged, 'notifyAiCurrentDocumentChanged'],
  [IPC_CHANNELS.registerAiCurrentDocumentPort, 'registerAiCurrentDocumentPort'],
  [IPC_CHANNELS.unregisterAiCurrentDocumentPort, 'unregisterAiCurrentDocumentPort'],
  [IPC_CHANNELS.submitAiCurrentDocumentPortResponse, 'submitAiCurrentDocumentPortResponse'],
  [IPC_CHANNELS.registerAiOpenDocumentPort, 'registerAiOpenDocumentPort'],
  [IPC_CHANNELS.unregisterAiOpenDocumentPort, 'unregisterAiOpenDocumentPort'],
  [IPC_CHANNELS.submitAiOpenDocumentPortResponse, 'submitAiOpenDocumentPortResponse'],
  [IPC_CHANNELS.openAiMessageLink, 'openAiMessageLink'],
  [SCREENSHOT_OCR_MODEL_CHANNELS.getState, 'getScreenshotOcrModelState'],
  [SCREENSHOT_OCR_MODEL_CHANNELS.downloadMedium, 'downloadScreenshotOcrMedium'],
  [SCREENSHOT_OCR_MODEL_CHANNELS.cancelMediumDownload, 'cancelScreenshotOcrMediumDownload'],
  [SCREENSHOT_OCR_MODEL_CHANNELS.removeMedium, 'removeScreenshotOcrMedium'],
  [IPC_CHANNELS.updateScreenshotCapturePointer, 'updateScreenshotCapturePointer'],
  [IPC_CHANNELS.readyScreenshotCapture, 'readyScreenshotCapture'],
  [IPC_CHANNELS.commitScreenshotCapture, 'commitScreenshotCapture'],
  [IPC_CHANNELS.cancelScreenshotCapture, 'cancelScreenshotCapture'],
  [IPC_CHANNELS.submitScreenshotOcr, 'submitScreenshotOcr'],
  [IPC_CHANNELS.settleScreenshotOcr, 'settleScreenshotOcr'],
  [IPC_CHANNELS.startScreenshotTranslation, 'startScreenshotTranslation'],
  [IPC_CHANNELS.cancelScreenshotTranslation, 'cancelScreenshotTranslation'],
  [IPC_CHANNELS.minimizeScreenshotTranslation, 'minimizeScreenshotTranslation'],
  [IPC_CHANNELS.closeScreenshotTranslation, 'closeScreenshotTranslation'],
  [IPC_CHANNELS.openScreenshotTranslationSettings, 'openScreenshotTranslationSettings'],
  [IPC_CHANNELS.searchSelection, 'searchSelection'],
  [IPC_CHANNELS.openExternal, 'openExternal'],
  [IPC_CHANNELS.revealImage, 'revealImage'],
  [IPC_CHANNELS.copyImage, 'copyImage'],
  [IPC_CHANNELS.saveImageCopy, 'saveImageCopy'],
  [IPC_CHANNELS.copyImageTo, 'copyImageTo'],
  [IPC_CHANNELS.copyMermaidImage, 'copyMermaidImage'],
  [IPC_CHANNELS.openMermaidViewer, 'openMermaidViewer'],
  [IPC_CHANNELS.getMermaidViewerSnapshot, 'getMermaidViewerSnapshot'],
  [IPC_CHANNELS.saveMermaidImage, 'saveMermaidImage'],
  [IPC_CHANNELS.createWorkspaceFolder, 'createWorkspaceFolder'],
  [IPC_CHANNELS.renameWorkspaceEntry, 'renameWorkspaceEntry'],
  [IPC_CHANNELS.duplicateWorkspaceDocument, 'duplicateWorkspaceDocument'],
  [IPC_CHANNELS.trashWorkspaceEntry, 'trashWorkspaceEntry'],
  [IPC_CHANNELS.revealWorkspaceEntry, 'revealWorkspaceEntry'],
  [IPC_CHANNELS.openWorkspaceEntryWindow, 'openWorkspaceEntryWindow'],
  [IPC_CHANNELS.getWorkspaceEntryProperties, 'getWorkspaceEntryProperties'],
  [IPC_CHANNELS.getWorkspaceRootProperties, 'getWorkspaceRootProperties'],
  [IPC_CHANNELS.getWorkspaceColorMarks, 'getWorkspaceColorMarks'],
  [IPC_CHANNELS.setWorkspaceColorMark, 'setWorkspaceColorMark'],
  [IPC_CHANNELS.moveWorkspaceColorMark, 'moveWorkspaceColorMark'],
  [IPC_CHANNELS.deleteWorkspaceColorMarks, 'deleteWorkspaceColorMarks'],
  [IPC_CHANNELS.openApplicationMenu, 'openApplicationMenu'],
  [IPC_CHANNELS.executeApplicationMenuItem, 'executeApplicationMenuItem'],
  [IPC_CHANNELS.recordRecentDocument, 'recordRecentDocument'],
  [IPC_CHANNELS.updateApplicationMenuWindowState, 'updateApplicationMenuWindowState'],
  [IPC_CHANNELS.printDocument, 'printDocument'],
  [IPC_CHANNELS.takePrintDocument, 'takePrintDocument'],
  [IPC_CHANNELS.readyPrintDocument, 'readyPrintDocument'],
  [IPC_CHANNELS.connectArknote, 'connectArknote'],
  [IPC_CHANNELS.listStickyNotes, 'listStickyNotes'],
  [IPC_CHANNELS.reorderStickyNotes, 'reorderStickyNotes'],
  [IPC_CHANNELS.searchStickyNotes, 'searchStickyNotes'],
  [IPC_CHANNELS.readStickyNote, 'readStickyNote'],
  [IPC_CHANNELS.createStickyNote, 'createStickyNote'],
  [IPC_CHANNELS.renameStickyNote, 'renameStickyNote'],
  [IPC_CHANNELS.archiveStickyNote, 'archiveStickyNote'],
  [IPC_CHANNELS.restoreStickyNote, 'restoreStickyNote'],
  [IPC_CHANNELS.restoreArchivedStickyNotes, 'restoreArchivedStickyNotes'],
  [IPC_CHANNELS.deleteStickyNote, 'deleteStickyNote'],
  [IPC_CHANNELS.deleteArchivedStickyNotes, 'deleteArchivedStickyNotes'],
  [IPC_CHANNELS.importStickyNote, 'importStickyNote'],
  [IPC_CHANNELS.importStickyNoteSelection, 'importStickyNoteSelection'],
  [IPC_CHANNELS.stageStickyNoteSave, 'stageStickyNoteSave'],
  [IPC_CHANNELS.flushStickyNoteSave, 'flushStickyNoteSave'],
  [IPC_CHANNELS.openStickyNote, 'openStickyNote'],
  [IPC_CHANNELS.closeStickyNote, 'closeStickyNote'],
  [IPC_CHANNELS.releaseStickyNote, 'releaseStickyNote'],
  [IPC_CHANNELS.reclaimStickyNote, 'reclaimStickyNote'],
  [IPC_CHANNELS.setStickyNotePinned, 'setStickyNotePinned'],
  [IPC_CHANNELS.setStickyNoteStyle, 'setStickyNoteStyle'],
  [IPC_CHANNELS.setStickyNoteFontSize, 'setStickyNoteFontSize'],
  [IPC_CHANNELS.setStickyNoteLineSpacingMode, 'setStickyNoteLineSpacingMode'],
  [IPC_CHANNELS.chooseStickyNoteImage, 'chooseStickyNoteImage'],
  [IPC_CHANNELS.copyStickyNoteImage, 'copyStickyNoteImage'],
  [IPC_CHANNELS.resizeStickyNoteToContent, 'resizeStickyNoteToContent'],
  [IPC_CHANNELS.openBackgroundSettings, 'openBackgroundSettings'],
  [IPC_CHANNELS.getBackgroundPresentation, 'getBackgroundPresentation'],
  [IPC_CHANNELS.chooseBackgroundImage, 'chooseBackgroundImage'],
  [IPC_CHANNELS.removeBackgroundImage, 'removeBackgroundImage'],
  [IPC_CHANNELS.previewBackground, 'previewBackground'],
  [IPC_CHANNELS.applyBackground, 'applyBackground'],
  [IPC_CHANNELS.cancelBackgroundSettings, 'cancelBackgroundSettings'],
])
const registrations = new WeakMap<object, OwnedDispatch>()
const closedFailure = (): ApiResult<never> => failure('OPERATION_FAILED')

function finishInflight(session: SessionDispatch): void {
  session.inflight -= 1
  if (session.inflight !== 0) return
  for (const resolve of session.drainWaiters) resolve()
  session.drainWaiters.clear()
}

function createHandler(dispatch: OwnedDispatch, channel: string) {
  return async (event: IpcEventLike, ...args: unknown[]) => {
    const session = dispatch.sessions.get(event.sender)
    if (!session) {
      return {
        ok: false as const,
        error: { code: 'UNTRUSTED_SENDER', message: PUBLIC_ERROR_MESSAGES.UNTRUSTED_SENDER },
      }
    }
    if (!session.accepting && !(
      (channel === IPC_CHANNELS.submitAiCurrentDocumentPortResponse || channel === IPC_CHANNELS.submitAiOpenDocumentPortResponse)
      && session.target.canAcceptAiTerminalResponseWhilePaused?.()
    )) return closedFailure()
    if (event.senderFrame !== session.target.window.webContents.mainFrame) {
      return {
        ok: false as const,
        error: { code: 'UNTRUSTED_SENDER', message: PUBLIC_ERROR_MESSAGES.UNTRUSTED_SENDER },
      }
    }
    if (args.length > 1) {
      return { ok: false as const, error: { code: 'INVALID_INPUT', message: PUBLIC_ERROR_MESSAGES.INVALID_INPUT } }
    }

    const operationName = operationNameByChannel.get(channel)
    if (!operationName) return closedFailure()
    const operation = session.target.operations[operationName] as ((input?: unknown, accepting?: () => boolean) => unknown) | undefined
    if (!operation) return closedFailure()
    if (session.target.operations.admitUpdateOperation?.(operationName) === false) return closedFailure()
    session.inflight += 1
    try {
      if (operationName !== 'startWorkspaceFileDrag') return await operation(args[0])
      const frame = event.senderFrame
      return await operation(args[0], () => dispatch.sessions.get(event.sender) === session
        && session.accepting && session.target.window.webContents.mainFrame === frame
        && !session.target.window.isDestroyed?.() && !session.target.window.webContents.isDestroyed?.())
    } catch (error) {
      return ipcFailure(error)
    } finally {
      finishInflight(session)
    }
  }
}

function installOwnedDispatch(ipcMain: IpcMainLike): OwnedDispatch {
  const dispatch: OwnedDispatch = {
    sessions: new Map(),
    installedChannels: new Set(),
  }
  try {
    for (const channel of operationNameByChannel.keys()) {
      ipcMain.handle(channel, createHandler(dispatch, channel))
      dispatch.installedChannels.add(channel)
    }
  } catch (error) {
    for (const channel of dispatch.installedChannels) ipcMain.removeHandler(channel)
    throw error
  }
  registrations.set(ipcMain as object, dispatch)
  return dispatch
}

function createRegistration(
  ipcMain: IpcMainLike,
  dispatch: OwnedDispatch,
  sender: unknown,
  session: SessionDispatch,
): IpcRegistration {
  let disposed = false
  return {
    pauseAndDrain: () => {
      if (disposed || dispatch.sessions.get(sender) !== session) return Promise.resolve()
      session.accepting = false
      if (session.inflight === 0) return Promise.resolve()
      return new Promise<void>((resolve) => session.drainWaiters.add(resolve))
    },
    resume: () => {
      if (!disposed && dispatch.sessions.get(sender) === session) session.accepting = true
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (dispatch.sessions.get(sender) !== session) return
      session.accepting = false
      dispatch.sessions.delete(sender)
      if (dispatch.sessions.size !== 0) return
      registrations.delete(ipcMain as object)
      for (const channel of dispatch.installedChannels) ipcMain.removeHandler(channel)
    },
  }
}

export function createChooseDirectory(
  showOpenDialog: (
    window: unknown,
    options: { properties: ['openDirectory']; defaultPath?: string },
  ) => Promise<{ canceled: boolean; filePaths: string[] }>,
  window: unknown,
  getDefaultPath: () => string | null | Promise<string | null> = () => null,
): () => Promise<string | null> {
  return async () => {
    const defaultPath = await getDefaultPath()
    const result = await showOpenDialog(window, {
      properties: ['openDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    })
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  }
}

export function registerIpcHandlers(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  operations: Partial<IpcOperations>
  canAcceptAiTerminalResponseWhilePaused?: () => boolean
}): IpcRegistration {
  const dispatch = registrations.get(options.ipcMain as object) ?? installOwnedDispatch(options.ipcMain)
  const sender = options.window.webContents
  const current = dispatch.sessions.get(sender)
  if (current && !current.accepting) throw new Error('IPC registration is paused')
  const session: SessionDispatch = {
    token: {},
    target: { window: options.window, operations: options.operations,
      canAcceptAiTerminalResponseWhilePaused: options.canAcceptAiTerminalResponseWhilePaused },
    accepting: true,
    drainWaiters: new Set(),
    inflight: 0,
  }
  dispatch.sessions.set(sender, session)
  return createRegistration(options.ipcMain, dispatch, sender, session)
}

function createScreenshotSurfaceOperations(dependencies: {
  screenshots?: Pick<ScreenshotCaptureCoordinator, 'updatePointer' | 'ready' | 'commit' | 'cancel'>
  screenshotOcrModels?: Pick<ScreenshotOcrModelManager, 'getState' | 'getObservedState' | 'downloadMedium' | 'cancelMediumDownload' | 'removeMedium'> & { initialize?(): Promise<void> }
  screenshotResults?: ScreenshotResultOperations
  screenshotOcrHost?: Pick<ScreenshotResultOperations, 'submit' | 'settleOcr'>
}): IpcOperations {
  return createIpcOperations({
    chooseDirectory: async () => null,
    workspace: undefined as unknown as WorkspaceService,
    documents: undefined as unknown as DocumentService,
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: () => undefined,
    ...dependencies,
  })
}

export function registerScreenshotSelectionWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  displayId: string
  operations: Pick<ScreenshotCaptureCoordinator, 'updatePointer' | 'ready' | 'commit' | 'cancel'>
}): IpcRegistration {
  const bound: Pick<ScreenshotCaptureCoordinator, 'updatePointer' | 'ready' | 'commit' | 'cancel'> = {
    updatePointer: (input) => input.displayId === options.displayId
      ? options.operations.updatePointer(input)
      : Promise.resolve(null),
    ready: (input) => input.displayId === options.displayId
      ? options.operations.ready(input)
      : Promise.resolve(),
    commit: (input) => input.displayId === options.displayId
      ? options.operations.commit(input)
      : Promise.resolve(),
    cancel: (input) => options.operations.cancel(input),
  }
  const all = createScreenshotSurfaceOperations({ screenshots: bound })
  return registerIpcHandlers({
    ipcMain: options.ipcMain,
    window: options.window,
    operations: {
      updateScreenshotCapturePointer: all.updateScreenshotCapturePointer,
      readyScreenshotCapture: all.readyScreenshotCapture,
      commitScreenshotCapture: all.commitScreenshotCapture,
      cancelScreenshotCapture: all.cancelScreenshotCapture,
    },
  })
}

export function registerScreenshotResultWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  operations: ScreenshotResultOperations
  modelCapabilityRules?: Pick<ModelCapabilityRulesStore, 'getState' | 'update'>
  observedModelConnections?: Pick<TransactionalModelConnectionService, 'getSettings' | 'setFeature'>
}): IpcRegistration {
  const screenshotResults: ScreenshotResultOperations = {
    ...options.operations,
    close: async (input) => {
      if (!options.operations.canClose(input)) return false
      queueMicrotask(() => { void options.operations.close(input) })
      return true
    },
  }

  const all = createScreenshotSurfaceOperations({ screenshotResults })
  return registerIpcHandlers({
    ipcMain: options.ipcMain,
    window: options.window,
    operations: {
      submitScreenshotOcr: all.submitScreenshotOcr,
      settleScreenshotOcr: all.settleScreenshotOcr,
      startScreenshotTranslation: all.startScreenshotTranslation,
      cancelScreenshotTranslation: all.cancelScreenshotTranslation,
      minimizeScreenshotTranslation: all.minimizeScreenshotTranslation,
      closeScreenshotTranslation: all.closeScreenshotTranslation,
      openScreenshotTranslationSettings: all.openScreenshotTranslationSettings,
      getModelCapabilityRules: async (input?: unknown) => {
        try {
          noInputSchema.parse(input)
          if (!options.modelCapabilityRules) throw new PublicError('OPERATION_FAILED')
          return { ok: true as const, value: options.modelCapabilityRules.getState() }
        } catch (error) { return ipcFailure(error) }
      },
      getLargeModelSettings: async (input?: unknown) => {
        try {
          noInputSchema.parse(input)
          if (!options.observedModelConnections) throw new PublicError('OPERATION_FAILED')
          return { ok: true as const, value: (await options.observedModelConnections.getSettings()).settings }
        } catch (error) { return ipcFailure(error) }
      },
      getModelSettingsSnapshot: async (input?: unknown) => {
        try {
          noInputSchema.parse(input)
          if (!options.observedModelConnections) throw new PublicError('OPERATION_FAILED')
          return { ok: true as const, value: await options.observedModelConnections.getSettings() }
        } catch (error) { return ipcFailure(error) }
      },
      setScreenshotTranslationSettings: async (input?: unknown) => {
        try {
          const value = parseObservedModelCommand(input, input => parseModelFeaturePatch('screenshotTranslation', input))
          if (!value) throw new PublicError('INVALID_INPUT')
          const service = options.observedModelConnections
          if (!service) throw new PublicError('OPERATION_FAILED')
          return { ok: true as const, value: await service.setFeature(value.observed, 'screenshotTranslation', value.input) }
        } catch (error) { return ipcFailure(error) }
      },
    },
  })
}

export function registerIpc(options: {
  updates?: import('../updates/update-ipc').UpdateWindowPort

  workspaceFileDrag?: Pick<WorkspaceFileDrag, 'start'>
  claimWorkspaceIntroduction?(legacySeen: boolean): Promise<{ showIntroduction: boolean }>
  settingsPreferences?: Pick<SettingsPreferenceService, 'read' | 'patch'>
  defaultApplications?: Pick<DefaultApplicationsService, 'getStatus' | 'openSettings' | 'setEnabled'>
  ipcMain: IpcMainLike
  showOpenDialog: Parameters<typeof createChooseDirectory>[0]
  window: WindowLike
  workspace: WorkspaceService
  documents: DocumentService
  stickyNotes?: StickyNoteIpcService
  backgrounds?: BackgroundIpcService
  drafts?: DraftService
  chooseSavePath?: (suggestedFileName?: string) => Promise<string | null>
  assets?: AssetService
  docx?: DocxOperations
  chooseDocxExportPath?: (suggestedBaseName: string) => Promise<string | null>
  xlsx?: Pick<XlsxExportService, 'export'>
  chooseXlsxExportPath?: (suggestedBaseName: string) => Promise<string | null>
  readClipboardFormats?: () => ClipboardFormatsSnapshot
  onDocumentSourceChanged?: (sourceDocxPath: string | null) => void
  previewArknoteThemeColor?: (themeColor: string) => Promise<void>
  openAsset?: (url: string) => Promise<void>
  openDocumentWindow?: (absolutePath: string, location?: DocumentViewLocation) => Promise<void>
  getSearchPreferences?: () => BrowserSearchPreferences
  setSearchPreferences?: (preferences: BrowserSearchPreferences) => Promise<void>
  getKeyboardShortcuts?: () => Promise<ObservedShortcutSnapshot>
  updateKeyboardShortcuts?: (update: ObservedShortcutUpdate) => Promise<ObservedShortcutUpdateResult>
  setShortcutRecording?: (active: boolean) => void
  getEditorAppearancePreferences?: () => EditorAppearanceSnapshot
  setEditorAppearancePreferences?: (
    preferences: EditorAppearancePreferences,
  ) => Promise<EditorAppearanceSnapshot>
  compareAndSetEditorAppearancePreferences?: (
    expectedRevision: number,
    expected: EditorAppearancePreferences,
    replacement: EditorAppearancePreferences,
  ) => Promise<EditorAppearanceSnapshot>
  getLayoutPreferences?: () => LayoutPreferencesSnapshot
  compareAndSetLayoutPreferences?: (
    expectedRevision: number,
    expected: LayoutPreferences,
    replacement: LayoutPreferences,
  ) => Promise<{ applied: boolean; snapshot: LayoutPreferencesSnapshot }>
  getStickyNotePreferences?: () => StickyNotePreferences
  setStickyNotePreferences?: (preferences: StickyNotePreferences) => Promise<void>
  shellIntegration?: Pick<ShellIntegrationService, 'readObserved' | 'updateObserved'>
  getDesktopLifecyclePreferences?: () => DesktopLifecyclePreferences
  setDesktopLifecyclePreferences?: (preferences: DesktopLifecyclePreferences) => Promise<void>
  getArknotePreferences?: () => ArknotePreferences | Promise<ArknotePreferences>
  setArknotePreferences?: (preferences: ArknotePreferencesUpdate) => Promise<ArknotePreferences>
  getSystemFonts?: () => Promise<string[]>
  modelCapabilityRules?: Pick<ModelCapabilityRulesStore, 'getState' | 'update'>
  modelConnections?: Pick<
    ModelConnectionService,
    'getSettings' | 'connect' | 'listModels' | 'test' | 'delete'
      | 'setSelectionTranslation' | 'setScreenshotTranslation' | 'setFloatingTranslation' | 'acceptTranslationPrivacyNotice'
  > & {
    setAiConversation?(input: AiConversationSettings): Promise<LargeModelSettings>
  }
  observedModelConnections?: Pick<TransactionalModelConnectionService,
    'getSettings' | 'connect' | 'listModels' | 'test' | 'delete' | 'setFeature' | 'acceptTranslationPrivacyNotice'>
  observedCodexCliConnections?: Pick<TransactionalCodexConnectionService, 'test' | 'remove'>
  codexCliConnections?: Pick<CodexCliConnectionService, 'test' | 'remove'>
  ensureCodexCli?(signal?: AbortSignal): Promise<boolean>
  startCodexCliLogin?(): Promise<CodexCliLoginOutcome>
  cancelCodexCliLogin?(): Promise<void>
  translations?: Pick<TranslationSessionService, 'start' | 'cancel'>
  aiConversations?: Pick<
    AiConversationSessionService,
    'start' | 'cancel' | 'submitAuthorizationResult' | 'setCapabilities'
      | 'clearConversation' | 'notifyCurrentDocumentChanged'
  >
  desktopAi?: DesktopAiIpcAuthority
  aiRendererPortBridgeFactory?: typeof createAiRendererPortBridge
  openDocumentRegistry?: OpenDocumentRegistry
  screenshots?: Pick<ScreenshotCaptureCoordinator, 'updatePointer' | 'ready' | 'commit' | 'cancel'>
  screenshotOcrModels?: Pick<ScreenshotOcrModelManager, 'getState' | 'getObservedState' | 'downloadMedium' | 'cancelMediumDownload' | 'removeMedium'> & { initialize?(): Promise<void> }
  screenshotOcrHost?: Pick<ScreenshotResultOperations, 'submit' | 'settleOcr'>
  searchSelection?: (query: string) => Promise<void>
  openExternal?: (target: string) => Promise<void>
  aiMessageLinkIo?: AiMessageLinkIo
  openApplicationMenu?: (section: AppMenuSectionId, x: number, y: number) => void
  executeApplicationMenuItem?: (itemId: string) => void
  recordRecentDocument?: (absolutePath: string) => Promise<readonly string[]>
  updateApplicationMenuWindowState?: (state: ApplicationMenuWindowState) => void
  printDocument?: (input: PrintDocumentInput) => Promise<void>
  controlWindow: (action: WindowControlAction) => WindowStateSnapshot
  getWindowState: () => WindowStateSnapshot
  imageContext?: ImageContextService
  mermaidImageExport?: MermaidImageExportService
  openMermaidViewer?: (input: MermaidViewerSnapshot) => Promise<void>
  workspaceEntries?: WorkspaceEntryService
  workspaceColors?: {
    get(): Promise<WorkspaceColorMarksSnapshot>
    set(relativePath: string, color: WorkspaceColorId | null): Promise<WorkspaceColorMarksSnapshot>
    move(fromRelativePath: string, toRelativePath: string): Promise<WorkspaceColorMarksSnapshot>
    delete(relativePath: string): Promise<WorkspaceColorMarksSnapshot>
  }
  getLastWorkspace: () => string | null
  setLastWorkspace: (root: string | null) => Promise<void> | void
  getLastFolderPickerPath?: () => string | null
  setLastFolderPickerPath?: (root: string | null) => Promise<void> | void
  reportError: (error: unknown) => void
  showItemInFolder?: (absolutePath: string) => void
  trashItem?: (absolutePath: string) => Promise<void>
}): DocumentIpcRegistration {
  let aiRendererPorts: AiRendererPortBridge | undefined
  let detachAiTransport: (() => void) | undefined
  let registration: IpcRegistration | undefined
  let closeTransportReplies = false
  let closeFrame: unknown
  const reportCleanupError = (error: unknown): void => {
    try { options.reportError(error) } catch { /* cleanup reporting must not stop cleanup */ }
  }
  const disposeAiRendererPorts = (): void => {
    if (!aiRendererPorts) return
    try {
      void aiRendererPorts.dispose().catch(reportCleanupError)
    } catch (error) {
      reportCleanupError(error)
    }
  }
  let operations!: ReturnType<typeof createIpcOperations>
  try {
    if (options.desktopAi) {
      const webContents = options.window.webContents
      if (!Number.isSafeInteger(webContents.id) || webContents.id !== options.desktopAi.ownerId
        || typeof webContents.send !== 'function' || typeof webContents.isDestroyed !== 'function'
        || typeof options.window.isDestroyed !== 'function') {
        throw new Error('AI IPC requires an owner-bound desktop window')
      }
      aiRendererPorts = (options.aiRendererPortBridgeFactory ?? createAiRendererPortBridge)({
        window: options.window as AiRendererPortWindow,
        desktopAi: options.desktopAi,
      })
      detachAiTransport = options.desktopAi.registerTransportLifecycle?.({
        pauseAndDrain: () => aiRendererPorts!.pauseAndDrain(),
        unregister: () => aiRendererPorts!.dispose(),
      })
    }
    operations = createIpcOperations({
      ...options,
      aiRendererPorts,
      getSystemFonts: options.getSystemFonts ?? listSystemFontFamilies,
      getStickyNoteForegroundSourceId: () => readWindowMediaSourceId(options.window),
      controlWindow: options.controlWindow,
      getWindowState: options.getWindowState,
      chooseDirectory: createChooseDirectory(
        options.showOpenDialog,
        options.window,
        () => workspacePickerDefaultPath(() => options.workspace.getValidatedActivationSnapshot(),
          () => options.getLastFolderPickerPath?.() ?? null),
      ),
    })
    registration = registerIpcHandlers({ ...options, operations,
      canAcceptAiTerminalResponseWhilePaused: () => closeTransportReplies
        && options.window.webContents.mainFrame === closeFrame
        && !options.window.isDestroyed?.() && !options.window.webContents.isDestroyed?.(),
    })
  } catch (error) {
    try { detachAiTransport?.() } catch (cleanupError) { reportCleanupError(cleanupError) }
    detachAiTransport = undefined
    disposeAiRendererPorts()
    try { registration?.dispose() } catch (cleanupError) { reportCleanupError(cleanupError) }
    throw error
  }
  const activeRegistration = registration
  const ownedSession = registrations.get(options.ipcMain as object)?.sessions.get(options.window.webContents)
  const cancelCodexCliLoginAttempt = async (): Promise<void> => {
    const result = await operations.cancelCodexCliLogin()
    if (!result.ok) throw new Error('Codex login cancellation failed')
  }
  const startCleanup = (cleanup: () => unknown): Promise<void> => {
    try { return Promise.resolve(cleanup()).then(() => undefined) }
    catch (error) { return Promise.reject(error) }
  }
  const cleanupFailures = (results: readonly PromiseSettledResult<unknown>[]): unknown[] =>
    results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  let disposal: Promise<void> | undefined
  let closeDrain: Promise<void> | undefined
  let closeResume: Promise<void> | undefined
  let closeReady = false
  let lifecycleGeneration = 0
  let closeGeneration = 0
  const validCloseWindow = (): boolean => !disposal && closeReady
    && lifecycleGeneration === closeGeneration
    && ownedSession !== undefined
    && registrations.get(options.ipcMain as object)?.sessions.get(options.window.webContents) === ownedSession
    && !options.window.isDestroyed?.() && !options.window.webContents.isDestroyed?.()
    && options.window.webContents.mainFrame === closeFrame
  return Object.freeze({
    cancelCodexCliLoginAttempt,
    seedStartupDocumentOwnership: operations.seedStartupDocumentOwnership,
    authorizeDraftRecovery: operations.authorizeDraftRecovery,
    getCurrentDocumentWriteAuthority: operations.getCurrentDocumentWriteAuthority,
    getCurrentDocumentAbsolutePath: operations.getCurrentDocumentAbsolutePath,
    quiesceForClose: () => {
      if (closeDrain) return closeDrain
      if (disposal) return Promise.reject(new PublicError('OPERATION_FAILED'))
      closeFrame = options.window.webContents.mainFrame
      closeGeneration = lifecycleGeneration
      closeTransportReplies = true
      const drains = [startCleanup(() => activeRegistration.pauseAndDrain()), startCleanup(cancelCodexCliLoginAttempt),
        startCleanup(() => aiRendererPorts?.quiesceForClose())]
      closeDrain = (async () => {
        const results = await Promise.allSettled(drains)
        // Only replies to existing strict correlations were admitted above.
        // Seal that lane, then wait any response handler still finishing.
        closeTransportReplies = false
        results.push(...await Promise.allSettled([startCleanup(() => activeRegistration.pauseAndDrain())]))
        if (cleanupFailures(results).length) throw new AggregateError(cleanupFailures(results), 'IPC close quiescence failed')
        closeReady = true
        if (!validCloseWindow()) { closeReady = false; throw new PublicError('OPERATION_FAILED') }
      })()
      return closeDrain
    },
    resumeAfterClose: (beforeAdmission?: () => void | Promise<void>) => {
      if (closeResume) return closeResume
      const operation = (async () => {
        if (!closeDrain) throw new PublicError('OPERATION_FAILED')
        await closeDrain
        if (!validCloseWindow()) throw new PublicError('OPERATION_FAILED')
        try {
          const restoreOwner = async (): Promise<void> => {
            if (!validCloseWindow()) throw new PublicError('OPERATION_FAILED')
            await beforeAdmission?.()
            if (!validCloseWindow()) throw new PublicError('OPERATION_FAILED')
          }
          if (aiRendererPorts) await aiRendererPorts.resumeAfterClose(restoreOwner)
          else await restoreOwner()
          if (!validCloseWindow()) throw new PublicError('OPERATION_FAILED')
        } catch (error) {
          // Re-close the restored transport without revoking its handles. Failed
          // owner restoration must never reopen ordinary IPC or claim success.
          try { await aiRendererPorts?.quiesceForClose() } catch { /* retain the original restoration failure */ }
          throw error
        }
        activeRegistration.resume()
        closeDrain = undefined
        closeReady = false
      })()
      closeResume = operation
      void operation.then(() => { closeResume = undefined }, () => { closeResume = undefined })
      return operation
    },
    pauseAndDrain: async () => {
      lifecycleGeneration += 1
      closeReady = false
      closeTransportReplies = false
      // Cancellation may fail while ordinary operations are still committing.
      // All work already started must settle before the close owner sees failure.
      const results = await Promise.allSettled([
        startCleanup(() => activeRegistration.pauseAndDrain()),
        startCleanup(cancelCodexCliLoginAttempt),
      ])
      results.push(...await Promise.allSettled([startCleanup(() => aiRendererPorts?.pauseAndDrain())]))
      const failures = cleanupFailures(results)
      if (failures.length) throw new AggregateError(failures, 'IPC close drain failed')
    },
    resume: () => {
      if (closeDrain || disposal) return
      activeRegistration.resume()
      aiRendererPorts?.resume()
    },
    dispose: () => {
      if (disposal) return disposal
      let complete!: () => void
      let fail!: (error: unknown) => void
      disposal = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
      lifecycleGeneration += 1
      closeReady = false
      closeTransportReplies = false
      const drains = [
        startCleanup(() => activeRegistration.pauseAndDrain()),
        startCleanup(cancelCodexCliLoginAttempt),
        // Preview tokens are read-only. Revoke them at disposal admission so a
        // late read cannot publish into a closed view; document write ownership
        // and AI ports remain intact until all admitted mutations settle.
        startCleanup(() => operations.clearDocumentView()),
      ]
      void (async () => {
        // Standalone disposal has the same safety fence as close: an entered
        // mutation must settle before its document ports/owner are revoked.
        const results = await Promise.allSettled(drains)
        const tasks = [
          startCleanup(() => detachAiTransport?.()),
          startCleanup(() => aiRendererPorts?.dispose()),
          startCleanup(() => activeRegistration.dispose()),
          startCleanup(async () => {
            const result = await operations.retryDraftFinalization()
            if (!result.ok) throw new Error('Draft finalization cleanup failed')
          }),
          startCleanup(() => operations.releaseClipboardResources()),
        ]
        detachAiTransport = undefined
        results.push(...await Promise.allSettled(tasks))
        results.push(...await Promise.allSettled([startCleanup(() => operations.releaseDraftOwnership())]))
        const failures = cleanupFailures(results)
        for (const error of failures) reportCleanupError(error)
        if (failures.length) throw new AggregateError(failures, 'IPC disposal cleanup failed')
      })().then(complete, fail)
      return disposal
    },
  })
}

export function registerPrintWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  takePrintDocument: (token: string) => PrintSurfaceDocumentInput
  readyPrintDocument: (token: string) => void
}): IpcRegistration {
  const all = createIpcOperations({
    chooseDirectory: async () => null,
    workspace: undefined as unknown as WorkspaceService,
    documents: undefined as unknown as DocumentService,
    takePrintDocument: options.takePrintDocument,
    readyPrintDocument: options.readyPrintDocument,
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: () => undefined,
  })
  return registerIpcHandlers({
    ...options,
    operations: {
      takePrintDocument: all.takePrintDocument,
      readyPrintDocument: all.readyPrintDocument,
    },
  })
}


export function registerStickyNoteWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  stickyNotes: StickyNoteIpcService
  assets?: AssetService
  clipboardNoteId?: string
  stickyNoteDataRoot?: string
  getStickyNotePreferences?: () => StickyNotePreferences
  getArknotePreferences?: () => ArknotePreferences | Promise<ArknotePreferences>
  chooseStickyNoteImage?: (noteId: string) => Promise<string | null>
  openExternal?: (target: string) => Promise<void>
  backgrounds?: BackgroundIpcService
}): IpcRegistration {
  const all = createIpcOperations({
    chooseDirectory: async () => null,
    workspace: undefined as unknown as WorkspaceService,
    documents: undefined as unknown as DocumentService,
    stickyNotes: options.stickyNotes,
    assets: options.assets,
    clipboardNoteId: options.clipboardNoteId,
    stickyNoteDataRoot: options.stickyNoteDataRoot,
    getStickyNotePreferences: options.getStickyNotePreferences,
    getArknotePreferences: options.getArknotePreferences,
    chooseStickyNoteImage: options.chooseStickyNoteImage,
    openExternal: options.openExternal,
    backgrounds: options.backgrounds,
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: () => undefined,
  })
  const operations: Partial<IpcOperations> = {
    pasteClipboardImage: all.pasteClipboardImage,
    listStickyNotes: all.listStickyNotes,
    reorderStickyNotes: all.reorderStickyNotes,
    readStickyNote: all.readStickyNote,
    createStickyNote: all.createStickyNote,
    renameStickyNote: all.renameStickyNote,
    archiveStickyNote: all.archiveStickyNote,
    restoreStickyNote: all.restoreStickyNote,
    deleteStickyNote: all.deleteStickyNote,
    importStickyNote: all.importStickyNote,
    stageStickyNoteSave: all.stageStickyNoteSave,
    flushStickyNoteSave: all.flushStickyNoteSave,
    openStickyNote: all.openStickyNote,
    closeStickyNote: all.closeStickyNote,
    releaseStickyNote: all.releaseStickyNote,
    reclaimStickyNote: all.reclaimStickyNote,
    setStickyNotePinned: all.setStickyNotePinned,
    setStickyNoteStyle: all.setStickyNoteStyle,
    setStickyNoteFontSize: all.setStickyNoteFontSize,
    setStickyNoteLineSpacingMode: all.setStickyNoteLineSpacingMode,
    chooseStickyNoteImage: all.chooseStickyNoteImage,
    copyStickyNoteImage: all.copyStickyNoteImage,
    resizeStickyNoteToContent: all.resizeStickyNoteToContent,
    getStickyNotePreferences: all.getStickyNotePreferences,
    getArknotePreferences: all.getArknotePreferences,
    openExternal: all.openExternal,
    openBackgroundSettings: all.openBackgroundSettings,
    getBackgroundPresentation: all.getBackgroundPresentation,
    chooseBackgroundImage: all.chooseBackgroundImage,
    removeBackgroundImage: all.removeBackgroundImage,
    previewBackground: all.previewBackground,
    applyBackground: all.applyBackground,
    cancelBackgroundSettings: all.cancelBackgroundSettings,
  }
  return registerIpcHandlers({ ...options, operations })
}

export function registerMermaidViewerWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  getMermaidViewerSnapshot: () => MermaidViewerSnapshot
  controlWindow: (action: WindowControlAction) => WindowStateSnapshot
  getWindowState: () => WindowStateSnapshot
  mermaidImageExport?: Pick<MermaidImageExportService, 'copyPng' | 'save'>
}): IpcRegistration {
  const all = createIpcOperations({
    chooseDirectory: async () => null,
    workspace: undefined as unknown as WorkspaceService,
    documents: undefined as unknown as DocumentService,
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: () => undefined,
    getMermaidViewerSnapshot: options.getMermaidViewerSnapshot,
    mermaidImageExport: options.mermaidImageExport,
    controlWindow: options.controlWindow,
    getWindowState: options.getWindowState,
  })
  return registerIpcHandlers({ ...options, operations: {
    getMermaidViewerSnapshot: all.getMermaidViewerSnapshot,
    saveMermaidImage: all.saveMermaidImage,
    controlWindow: all.controlWindow,
    getWindowState: all.getWindowState,
  } })
}

export function registerBackgroundSettingsWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  backgrounds: BackgroundIpcService
  getEditorAppearancePreferences?: () => EditorAppearanceSnapshot
}): IpcRegistration {
  const all = createIpcOperations({
    chooseDirectory: async () => null,
    workspace: undefined as unknown as WorkspaceService,
    documents: undefined as unknown as DocumentService,
    backgrounds: options.backgrounds,
    getEditorAppearancePreferences: options.getEditorAppearancePreferences,
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: () => undefined,
  })
  return registerIpcHandlers({
    ...options,
    operations: {
      getEditorAppearancePreferences: all.getEditorAppearancePreferences,
      getBackgroundPresentation: all.getBackgroundPresentation,
      chooseBackgroundImage: all.chooseBackgroundImage,
      removeBackgroundImage: all.removeBackgroundImage,
      previewBackground: all.previewBackground,
      applyBackground: all.applyBackground,
      cancelBackgroundSettings: all.cancelBackgroundSettings,
    },
  })
}

export function registerArknoteBoxWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  stickyNotes: StickyNoteIpcService
  getStickyNotePreferences: () => StickyNotePreferences
}): IpcRegistration {
  const all = createIpcOperations({
    chooseDirectory: async () => null,
    workspace: undefined as unknown as WorkspaceService,
    documents: undefined as unknown as DocumentService,
    stickyNotes: options.stickyNotes,
    getStickyNotePreferences: options.getStickyNotePreferences,
    getStickyNoteForegroundSourceId: () => readWindowMediaSourceId(options.window),
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: () => undefined,
  })
  const operations: Partial<IpcOperations> = {
    listStickyNotes: all.listStickyNotes,
    reorderStickyNotes: all.reorderStickyNotes,
    searchStickyNotes: all.searchStickyNotes,
    readStickyNote: all.readStickyNote,
    createStickyNote: all.createStickyNote,
    renameStickyNote: all.renameStickyNote,
    archiveStickyNote: all.archiveStickyNote,
    restoreStickyNote: all.restoreStickyNote,
    restoreArchivedStickyNotes: all.restoreArchivedStickyNotes,
    deleteStickyNote: all.deleteStickyNote,
    deleteArchivedStickyNotes: all.deleteArchivedStickyNotes,
    importStickyNote: all.importStickyNote,
    openStickyNote: all.openStickyNote,
    closeStickyNote: all.closeStickyNote,
    flushStickyNoteSave: all.flushStickyNoteSave,
    releaseStickyNote: all.releaseStickyNote,
    reclaimStickyNote: all.reclaimStickyNote,
    setStickyNoteStyle: all.setStickyNoteStyle,
    getStickyNotePreferences: all.getStickyNotePreferences,
  }
  return registerIpcHandlers({ ...options, operations })
}

export function registerArknoteSettingsWindowIpc(options: {
  ipcMain: IpcMainLike
  window: WindowLike
  getArknotePreferences: () => ArknotePreferences | Promise<ArknotePreferences>
  setArknotePreferences: (preferences: ArknotePreferencesUpdate) => Promise<ArknotePreferences>
  previewStickyNoteWallpaperAppearances?: (appearances: StickyNoteWallpaperAppearances | null) => Promise<StickyNoteWallpaperAppearances>
}): IpcRegistration {
  const all = createIpcOperations({
    chooseDirectory: async () => null,
    workspace: undefined as unknown as WorkspaceService,
    documents: undefined as unknown as DocumentService,
    getArknotePreferences: options.getArknotePreferences,
    setArknotePreferences: options.setArknotePreferences,
    previewStickyNoteWallpaperAppearances: options.previewStickyNoteWallpaperAppearances,
    getLastWorkspace: () => null,
    setLastWorkspace: () => undefined,
    reportError: () => undefined,
  })
  return registerIpcHandlers({
    ...options,
    operations: {
      getArknotePreferences: all.getArknotePreferences,
      setArknotePreferences: all.setArknotePreferences,
      previewStickyNoteWallpaperAppearances: all.previewStickyNoteWallpaperAppearances,
    },
  })
}
