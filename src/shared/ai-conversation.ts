import {
  parseAiWritePolicy,
  type AiWritePolicy,
} from './large-model-settings'
import {
  PUBLIC_ERROR_MESSAGES,
  isPublicErrorCode,
  type PublicErrorCode,
} from './public-errors'
import { parseAiProcessEvent, type AiProcessEvent } from './ai-process-events'
import { parseModelErrorDetail, type ModelErrorDetail } from './model-error-detail'
import { parseAiBudgetNotExecuted, parseAiBudgetPausedEvent, type AiBudgetNotExecuted, type AiBudgetPausedEvent } from './ai-budget-result'

export type AiConversationVisibleRole = 'user' | 'assistant'
export type AiReadCapability = 'current-document' | 'workspace'

export const AI_WORKSPACE_TOOL_NAMES = [
  'read_current_document',
  'list_workspace_entries',
  'read_workspace_document',
  'edit_workspace_document',
  'create_workspace_document',
  'rename_workspace_document',
  'delete_workspace_document',
] as const

export type AiWorkspaceToolName = (typeof AI_WORKSPACE_TOOL_NAMES)[number]
export type AiMutationToolName = Extract<AiWorkspaceToolName,
  'edit_workspace_document' | 'create_workspace_document'
  | 'rename_workspace_document' | 'delete_workspace_document'>

export interface AiConversationVisibleMessage {
  id: string
  role: AiConversationVisibleRole
  content: string
}

export interface AiConversationUserMessage extends AiConversationVisibleMessage {
  role: 'user'
}

export interface AiConversationCapabilities {
  currentDocument: boolean
  workspace: boolean
}

export const DEFAULT_AI_CONVERSATION_CAPABILITIES: Readonly<AiConversationCapabilities> = Object.freeze({
  currentDocument: true,
  workspace: true,
})

export interface StartAiConversationInput {
  /** Main-issued, single-use paused-segment identity; never trusted history. */
  continuationOfSegmentId?: string
  requestId: string
  conversationId: string
  workspaceKey: string
  acknowledgedTranscriptRevision: number
  messages: [AiConversationUserMessage]
  capabilities: AiConversationCapabilities
  currentDocumentOnce?: true
  /** Renderer-local opaque identity; never serialized into provider messages. Null forbids an ambiguous source read. */
  expectedDocumentId?: string | null
  writePolicy: AiWritePolicy
}

export interface CancelAiConversationInput {
  requestId: string
}

export interface AiDocumentToolArguments {
  cursor: number
  maxChars: number
}

export interface AiCurrentDocumentToolArguments extends AiDocumentToolArguments {}

declare const aiPositiveCursorBrand: unique symbol
export type AiPositiveCursor = number & { readonly [aiPositiveCursorBrand]: 'AiPositiveCursor' }

export type AiListWorkspaceEntriesArguments =
  | {
  path: string
  cursor: 0
  maxEntries: number
  directoryVersion: null
}
  | {
    path: string
    cursor: AiPositiveCursor
    maxEntries: number
    directoryVersion: AiWorkspaceDirectoryVersion
  }

export interface AiReadWorkspaceDocumentArguments extends AiDocumentToolArguments {
  path: string
}

export interface AiFileVersion {
  fileId: string
  revision: string
  size: number
  mtimeMs: number
}

export interface AiEditWorkspaceDocumentArguments {
  path: string
  content: string
  expectedVersion: AiFileVersion
}

export interface AiCreateWorkspaceDocumentArguments {
  path: string
  content: string
}

export interface AiRenameWorkspaceDocumentArguments {
  path: string
  newPath: string
  expectedVersion: AiFileVersion
}

export interface AiDeleteWorkspaceDocumentArguments {
  path: string
  expectedVersion: AiFileVersion
}

export interface AiDocumentPage {
  displayName: string
  sourceFormat: string
  dirty: boolean
  cursor: number
  content: string
  nextCursor: number | null
  hasMore: boolean
  totalChars: number
  version: AiFileVersion
}

export interface AiWorkspaceDocumentPage extends Omit<AiDocumentPage, 'dirty'> {
  path: string
}

export interface AiWorkspaceEntry {
  path: string
  name: string
  kind: 'directory' | 'document'
}

export interface AiWorkspaceDirectoryVersion {
  workspaceGeneration: string
  directoryId: string
  revision: string
}

export type AiSingleMutationPaths = readonly [string]
export type AiRenameMutationPaths = readonly [string, string]
export const AI_STALE_TARGET_GUIDANCE = 'The target changed. Read the affected document again from cursor 0 and use the newly returned version before requesting a new write.'
export const AI_RECYCLE_UNAVAILABLE_GUIDANCE = '当前版本的 AI 暂不支持安全移入回收站，本次删除未执行，文件保留在原位置。请在资源管理器中手动移入回收站。'
export type AiRecycleUnavailableResult = {
  kind: 'mutation'
  operationId: string
  paths: AiSingleMutationPaths
  state: 'failed'
  reason: 'recycle-unavailable'
  guidance: typeof AI_RECYCLE_UNAVAILABLE_GUIDANCE
}
export interface AiStaleTargetRecovery {
  reason: 'target-changed'
  guidance: typeof AI_STALE_TARGET_GUIDANCE
}
export type AiWorkspaceUnavailableResult = { kind: 'unavailable' } & (
  | { reason?: never; guidance?: never }
  | AiStaleTargetRecovery
)
export type AiMutationResult<Paths extends readonly string[]> = {
  kind: 'mutation'
  operationId: string
  paths: Paths
} & (
  | { state: AiOperationState; reason?: never; guidance?: never }
  | ({ state: 'failed' } & AiStaleTargetRecovery)
)

export type AiCurrentDocumentToolResult =
  | { kind: 'document'; displayName: string; sourceFormat: string; dirty: boolean; cursor: number; content: string; nextCursor: number | null; hasMore: boolean; totalChars: number; version: AiFileVersion }
  | { kind: 'unavailable' }
  | AiToolDenial

export type AiToolDenial = {
  kind: 'denied'
  guidance?: '请开启“AI 可查看文档”。' | '请开启“AI 可查看工作区”。' | '创建、重命名或删除文档需要选择“每次询问”或“按工作区许可”。'
}

export type AiWorkspaceToolResult =
  | AiBudgetNotExecuted
  | { kind: 'entries'; directoryPath: string; directoryVersion: AiWorkspaceDirectoryVersion; cursor: number; entries: AiWorkspaceEntry[]; nextCursor: number | null }
  | { kind: 'document'; path: string; displayName: string; sourceFormat: string; cursor: number; content: string; nextCursor: number | null; hasMore: boolean; totalChars: number; version: AiFileVersion }
  | AiMutationResult<readonly string[]>
  | AiRecycleUnavailableResult
  | AiToolDenial
  | AiWorkspaceUnavailableResult

export interface AiWorkspaceToolContractMap {
  read_current_document: { arguments: AiCurrentDocumentToolArguments; result: AiCurrentDocumentToolResult | AiBudgetNotExecuted }
  list_workspace_entries: { arguments: AiListWorkspaceEntriesArguments; result: Extract<AiWorkspaceToolResult, { kind: 'entries' | 'denied' | 'not-executed' }> | { kind: 'unavailable' } }
  read_workspace_document: { arguments: AiReadWorkspaceDocumentArguments; result: Extract<AiWorkspaceToolResult, { kind: 'document' | 'denied' | 'not-executed' }> | { kind: 'unavailable' } }
  edit_workspace_document: { arguments: AiEditWorkspaceDocumentArguments; result: AiMutationResult<AiSingleMutationPaths> | AiToolDenial | AiBudgetNotExecuted | AiWorkspaceUnavailableResult }
  create_workspace_document: { arguments: AiCreateWorkspaceDocumentArguments; result: AiMutationResult<AiSingleMutationPaths> | AiToolDenial | AiBudgetNotExecuted | AiWorkspaceUnavailableResult }
  rename_workspace_document: { arguments: AiRenameWorkspaceDocumentArguments; result: AiMutationResult<AiRenameMutationPaths> | AiToolDenial | AiBudgetNotExecuted | AiWorkspaceUnavailableResult }
  delete_workspace_document: { arguments: AiDeleteWorkspaceDocumentArguments; result: AiRecycleUnavailableResult | AiMutationResult<AiSingleMutationPaths> | AiToolDenial | AiBudgetNotExecuted | AiWorkspaceUnavailableResult }
}

export type AiWorkspaceToolCall = {
  [Name in AiWorkspaceToolName]: {
    toolName: Name
    arguments: AiWorkspaceToolContractMap[Name]['arguments']
  }
}[AiWorkspaceToolName]

export type AiWorkspaceToolArguments = AiWorkspaceToolCall

export type SubmitAiWorkspaceToolResultInput = {
  [Name in AiWorkspaceToolName]: {
    requestId: string
    toolCallId: string
    toolName: Name
    result: AiWorkspaceToolContractMap[Name]['result']
  }
}[AiWorkspaceToolName]

export interface AiOperationManifest {
  operationId: string
  idempotencyKey: string
  nonce: string
  workspaceGeneration: string
  toolName: AiMutationToolName
  relativePaths: readonly string[]
  expectedVersions: readonly AiFileVersion[]
}

export type AiOperationState =
  | 'planned' | 'awaitingApproval' | 'authorized' | 'executing'
  | 'succeeded' | 'failed' | 'unknown'

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cachedInputTokens: number | null
  estimated: boolean
}

export type AiAuthorizationScope = 'action' | 'document' | 'workspace'

export interface AiAuthorizationRequestEvent {
  requestId: string
  type: 'authorization-requested'
  toolCallId: string
  toolName: AiMutationToolName
  operationId: string
  scope: AiAuthorizationScope
  paths: string[]
}

export interface AiAuthorizationResultEvent {
  requestId: string
  type: 'authorization-result'
  toolName: AiMutationToolName
  operationId: string
  scope: AiAuthorizationScope
  allowed: boolean
}

export interface AiAuditEvent {
  requestId: string
  type: 'audit'
  action: 'authorization-allowed' | 'authorization-denied' | 'edited' | 'created' | 'renamed' | 'deleted'
  absolutePaths: string[]
}

export interface AiUsageEvent {
  requestId: string
  type: 'usage'
  usage: ModelUsage
}

/** Local timeline metadata only; never part of visible messages or model history. */
export type AiContextCompactionRecord =
  | { status: 'compacted'; beforeTokens: number; afterTokens: number; contextWindowTokens: number }
  | { status: 'failed' }

export type AiContextCompactionEvent = {
  requestId: string
  type: 'context-compaction'
  transcriptRevision: number
} & AiContextCompactionRecord

export interface AiOperationStatusEvent {
  requestId: string
  type: 'operation-status'
  toolName: AiMutationToolName
  operationId: string
  status: 'unknown'
  paths: string[]
}

export type AiConversationEvent =
  | AiProcessEvent
  | AiBudgetPausedEvent
  | { requestId: string; type: 'started'; transcriptRevision: number }
  | { requestId: string; type: 'user-message-accepted'; messageId: string; transcriptRevision: number }
  | { requestId: string; type: 'message-start'; messageId: string; previousTranscriptRevision: number }
  | { requestId: string; type: 'thinking'; messageId: string; active: boolean; elapsedMs: number }
  | { requestId: string; type: 'delta'; messageId: string; delta: string }
  | { requestId: string; type: 'message-completed'; messageId: string; transcriptRevision: number }
  | { requestId: string; type: 'completed' }
  | { requestId: string; type: 'stopped' }
  | { requestId: string; type: 'failed'; code: PublicErrorCode; message: string; detail?: ModelErrorDetail }
  | AiAuthorizationRequestEvent
  | AiAuthorizationResultEvent
  | AiAuditEvent
  | AiUsageEvent
  | AiContextCompactionEvent
  | AiOperationStatusEvent

export const AI_CONVERSATION_WORKSPACE_KEY_MAX_LENGTH = 32_767
export const AI_CONVERSATION_VISIBLE_MESSAGE_LIMIT = 200
export const AI_CONVERSATION_MESSAGE_MAX_CHARS = 48_000
export const AI_CONVERSATION_DELTA_MAX_BYTES = 256 * 1024
export const AI_CONVERSATION_DELTA_CHUNK_MAX_BYTES = 240 * 1024
export const AI_DOCUMENT_PAGE_MAX_CHARS = 48_000
export const AI_DOCUMENT_TOOL_CALL_LIMIT = 8
export const AI_WORKSPACE_LIST_PAGE_MAX_ENTRIES = 1_000
export const AI_WORKSPACE_PATH_MAX_LENGTH = 32_767
export const AI_WORKSPACE_MUTATION_CONTENT_MAX_CHARS = 48_000
export const AI_WORKSPACE_PATH_SEGMENT_MAX_LENGTH = 255
export const AI_OPERATION_PATH_LIMIT = 2
export const AI_AUDIT_ABSOLUTE_PATH_MAX_LENGTH = 32_767
export const AI_AUDIT_PATH_LIMIT = 2

const CASE_INSENSITIVE_RESERVED_SEGMENT = '(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][1-9]|[lL][pP][tT][1-9])'
const RELATIVE_WORKSPACE_PATH_ASSERTIONS = `(?!\\s)(?!.*\\s$)(?!.*(?:^|/)[^/]{256,}(?:/|$))(?!.*[\\u0000\\\\:<>"|?*])(?!.*(?:^|/)${CASE_INSENSITIVE_RESERVED_SEGMENT}(?:\\.[^/]*)?(?:/|$))(?!.*(?:^|/)[^/]*[. ](?:/|$))(?!.*//)(?!/)(?!.*\\/$)(?!.*(?:^|/)\\.{1,2}(?:/|$))`
export const AI_WORKSPACE_RELATIVE_PATH_PATTERN = `^${RELATIVE_WORKSPACE_PATH_ASSERTIONS}.+$`
export const AI_OPAQUE_IDENTIFIER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$'

const AI_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const AI_TOOL_CALL_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,255}$/
const VISIBLE_ROLES = new Set<AiConversationVisibleRole>(['user', 'assistant'])
const MUTATION_TOOLS = new Set<AiMutationToolName>([
  'edit_workspace_document', 'create_workspace_document',
  'rename_workspace_document', 'delete_workspace_document',
])

export function isExactOwnRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype) return false
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<PropertyKey, PropertyDescriptor>
  const ownKeys = Reflect.ownKeys(descriptors)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => {
      const descriptor = descriptors[key]
      return descriptor?.enumerable === true
        && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    })
}

function isExactArray(value: unknown): value is unknown[] {
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
}

function frozenWireArray<T>(value: readonly T[]): T[] {
  return Object.freeze([...value]) as unknown as T[]
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && AI_UUID_PATTERN.test(value)
}

export function isCanonicalAiConversationRequestId(value: unknown): value is string { return isCanonicalUuid(value) }
export function isCanonicalAiConversationId(value: unknown): value is string { return isCanonicalUuid(value) }
export function isCanonicalAiConversationMessageId(value: unknown): value is string { return isCanonicalUuid(value) }
export function isCanonicalAiToolCallId(value: unknown): value is string {
  return typeof value === 'string' && AI_TOOL_CALL_ID_PATTERN.test(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isCanonicalBoundedText(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength && value === value.trim()
}

export function isCanonicalWorkspaceRelativePath(value: unknown): value is string {
  if (!isCanonicalBoundedText(value, AI_WORKSPACE_PATH_MAX_LENGTH) || value.startsWith('/') || value.endsWith('/')) return false
  return value.split('/').every(isSafeWorkspacePathSegment)
}

function isSafeWorkspacePathSegment(value: string): boolean {
  if (value.length === 0 || value.length > AI_WORKSPACE_PATH_SEGMENT_MAX_LENGTH || value === '.' || value === '..') return false
  if (/[\u0000\\/:<>"|?*]/.test(value) || /[. ]$/.test(value)) return false
  const stem = value.split('.', 1)[0].toUpperCase()
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}

function isSafeWireName(value: unknown, maximumLength = AI_WORKSPACE_PATH_SEGMENT_MAX_LENGTH): value is string {
  return typeof value === 'string' && value.length <= maximumLength && isSafeWorkspacePathSegment(value)
}

function isSafeOpaqueIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength
    && new RegExp(AI_OPAQUE_IDENTIFIER_PATTERN).test(value)
}

function parseVisibleMessage(value: unknown): AiConversationVisibleMessage | undefined {
  if (!isExactOwnRecord(value, ['id', 'role', 'content'])
    || !isCanonicalAiConversationMessageId(value.id)
    || typeof value.role !== 'string' || !VISIBLE_ROLES.has(value.role as AiConversationVisibleRole)
    || !isCanonicalBoundedText(value.content, AI_CONVERSATION_MESSAGE_MAX_CHARS)) return undefined
  return Object.freeze({
    id: value.id, role: value.role as AiConversationVisibleRole, content: value.content,
  })
}

function parseVisibleMessages(value: unknown): AiConversationVisibleMessage[] | undefined {
  if (!isExactArray(value) || value.length > AI_CONVERSATION_VISIBLE_MESSAGE_LIMIT) return undefined
  const parsed = value.map(parseVisibleMessage)
  if (parsed.some((message) => message === undefined)) return undefined
  const messages = parsed as AiConversationVisibleMessage[]
  return new Set(messages.map((message) => message.id)).size === messages.length
    ? frozenWireArray(messages) : undefined
}

function parseCapabilities(value: unknown): AiConversationCapabilities | undefined {
  if (!isExactOwnRecord(value, ['currentDocument', 'workspace'])
    || typeof value.currentDocument !== 'boolean' || typeof value.workspace !== 'boolean') return undefined
  return Object.freeze({ currentDocument: value.currentDocument, workspace: value.workspace })
}

export function parseStartAiConversationInput(value: unknown): StartAiConversationInput | undefined {
  const keys = [
    'requestId', 'conversationId', 'workspaceKey', 'acknowledgedTranscriptRevision',
    'messages', 'capabilities', 'writePolicy',
  ]
  if (typeof value === 'object' && value !== null && 'currentDocumentOnce' in value) {
    keys.push('currentDocumentOnce')
  }
  if (typeof value === 'object' && value !== null && 'expectedDocumentId' in value) keys.push('expectedDocumentId')
  if (typeof value === 'object' && value !== null && 'continuationOfSegmentId' in value) keys.push('continuationOfSegmentId')
  if (!isExactOwnRecord(value, keys)
    || !isCanonicalAiConversationRequestId(value.requestId)
    || !isCanonicalAiConversationId(value.conversationId)
    || !isCanonicalBoundedText(value.workspaceKey, AI_CONVERSATION_WORKSPACE_KEY_MAX_LENGTH)
    || !isSafeNonNegativeInteger(value.acknowledgedTranscriptRevision)
    || parseAiWritePolicy(value.writePolicy) === undefined
    || ('currentDocumentOnce' in value && value.currentDocumentOnce !== true)
    || ('expectedDocumentId' in value && value.expectedDocumentId !== null
      && !isCanonicalAiConversationRequestId(value.expectedDocumentId))
    || ('continuationOfSegmentId' in value && !isCanonicalAiConversationRequestId(value.continuationOfSegmentId))) return undefined
  const messages = parseVisibleMessages(value.messages)
  const capabilities = parseCapabilities(value.capabilities)
  if (messages === undefined || messages.length !== 1 || messages[0]?.role !== 'user'
    || capabilities === undefined) return undefined
  return Object.freeze({
    requestId: value.requestId,
    conversationId: value.conversationId,
    workspaceKey: value.workspaceKey,
    acknowledgedTranscriptRevision: value.acknowledgedTranscriptRevision,
    messages: Object.freeze([messages[0] as AiConversationUserMessage]) as unknown as [AiConversationUserMessage],
    capabilities,
    ...('currentDocumentOnce' in value ? { currentDocumentOnce: true as const } : {}),
    ...('expectedDocumentId' in value ? { expectedDocumentId: value.expectedDocumentId as string | null } : {}),
    ...('continuationOfSegmentId' in value ? { continuationOfSegmentId: value.continuationOfSegmentId as string } : {}),
    writePolicy: parseAiWritePolicy(value.writePolicy)!,
  })
}

export function isStartAiConversationInput(value: unknown): value is StartAiConversationInput {
  return parseStartAiConversationInput(value) !== undefined
}

export function parseCancelAiConversationInput(value: unknown): CancelAiConversationInput | undefined {
  return isExactOwnRecord(value, ['requestId']) && isCanonicalAiConversationRequestId(value.requestId)
    ? { requestId: value.requestId } : undefined
}

function parsePageArguments(value: unknown, keys: readonly string[], path: boolean): AiDocumentToolArguments | undefined {
  if (!isExactOwnRecord(value, keys)
    || (path && !isCanonicalWorkspaceRelativePath(value.path))
    || !isSafeNonNegativeInteger(value.cursor) || !isSafeNonNegativeInteger(value.maxChars)
    || value.maxChars === 0 || value.maxChars > AI_DOCUMENT_PAGE_MAX_CHARS) return undefined
  return { cursor: value.cursor, maxChars: value.maxChars }
}

export function parseCurrentDocumentToolArguments(value: unknown): AiCurrentDocumentToolArguments | undefined {
  return parsePageArguments(value, ['cursor', 'maxChars'], false)
}

export function parseReadWorkspaceDocumentArguments(value: unknown): AiReadWorkspaceDocumentArguments | undefined {
  const page = parsePageArguments(value, ['path', 'cursor', 'maxChars'], true)
  return page === undefined ? undefined : { path: (value as Record<string, unknown>).path as string, ...page }
}

export function parseListWorkspaceEntriesArguments(value: unknown): AiListWorkspaceEntriesArguments | undefined {
  if (isExactOwnRecord(value, ['path', 'maxEntries'])) {
    return parseListWorkspaceEntriesArguments({ ...value, cursor: 0, directoryVersion: null })
  }
  if (!isExactOwnRecord(value, ['path', 'cursor', 'maxEntries', 'directoryVersion'])
    || !(value.path === '' || isCanonicalWorkspaceRelativePath(value.path))
    || !isSafeNonNegativeInteger(value.cursor) || !isSafeNonNegativeInteger(value.maxEntries)
    || value.maxEntries === 0 || value.maxEntries > AI_WORKSPACE_LIST_PAGE_MAX_ENTRIES) return undefined
  if (value.cursor === 0 && value.directoryVersion === null) {
    return { path: value.path, cursor: 0, maxEntries: value.maxEntries, directoryVersion: null }
  }
  const directoryVersion = parseAiWorkspaceDirectoryVersion(value.directoryVersion)
  return value.cursor > 0 && directoryVersion !== undefined
    ? { path: value.path, cursor: value.cursor as AiPositiveCursor, maxEntries: value.maxEntries, directoryVersion }
    : undefined
}

export function parseAiFileVersion(value: unknown): AiFileVersion | undefined {
  if (!isExactOwnRecord(value, ['fileId', 'revision', 'size', 'mtimeMs'])
    || !isSafeOpaqueIdentifier(value.fileId, 512) || !isSafeOpaqueIdentifier(value.revision, 512)
    || !isSafeNonNegativeInteger(value.size) || !isSafeNonNegativeInteger(value.mtimeMs)) return undefined
  return { fileId: value.fileId, revision: value.revision, size: value.size, mtimeMs: value.mtimeMs }
}

function parseMutationArguments(value: unknown, keys: readonly string[], paths: readonly string[], content: boolean, version: boolean): Record<string, unknown> | undefined {
  if (!isExactOwnRecord(value, keys)
    || paths.some((key) => !isCanonicalWorkspaceRelativePath(value[key]))
    || (content && (typeof value.content !== 'string' || value.content.length > AI_WORKSPACE_MUTATION_CONTENT_MAX_CHARS))
    || (version && parseAiFileVersion(value.expectedVersion) === undefined)) return undefined
  return value
}

export function parseEditWorkspaceDocumentArguments(value: unknown): AiEditWorkspaceDocumentArguments | undefined {
  const source = parseMutationArguments(value, ['path', 'content', 'expectedVersion'], ['path'], true, true)
  if (source === undefined) return undefined
  return { path: source.path as string, content: source.content as string, expectedVersion: parseAiFileVersion(source.expectedVersion)! }
}

export function parseCreateWorkspaceDocumentArguments(value: unknown): AiCreateWorkspaceDocumentArguments | undefined {
  const source = parseMutationArguments(value, ['path', 'content'], ['path'], true, false)
  return source === undefined ? undefined : { path: source.path as string, content: source.content as string }
}

export function parseRenameWorkspaceDocumentArguments(value: unknown): AiRenameWorkspaceDocumentArguments | undefined {
  const source = parseMutationArguments(value, ['path', 'newPath', 'expectedVersion'], ['path', 'newPath'], false, true)
  if (source === undefined) return undefined
  return { path: source.path as string, newPath: source.newPath as string, expectedVersion: parseAiFileVersion(source.expectedVersion)! }
}

export function parseDeleteWorkspaceDocumentArguments(value: unknown): AiDeleteWorkspaceDocumentArguments | undefined {
  const source = parseMutationArguments(value, ['path', 'expectedVersion'], ['path'], false, true)
  if (source === undefined) return undefined
  return { path: source.path as string, expectedVersion: parseAiFileVersion(source.expectedVersion)! }
}

export function parseWorkspaceToolArguments(toolName: AiWorkspaceToolName, value: unknown): AiWorkspaceToolArguments | undefined {
  switch (toolName) {
    case 'read_current_document': { const argumentsValue = parseCurrentDocumentToolArguments(value); return argumentsValue === undefined ? undefined : { toolName, arguments: argumentsValue } }
    case 'list_workspace_entries': { const argumentsValue = parseListWorkspaceEntriesArguments(value); return argumentsValue === undefined ? undefined : { toolName, arguments: argumentsValue } }
    case 'read_workspace_document': { const argumentsValue = parseReadWorkspaceDocumentArguments(value); return argumentsValue === undefined ? undefined : { toolName, arguments: argumentsValue } }
    case 'edit_workspace_document': { const argumentsValue = parseEditWorkspaceDocumentArguments(value); return argumentsValue === undefined ? undefined : { toolName, arguments: argumentsValue } }
    case 'create_workspace_document': { const argumentsValue = parseCreateWorkspaceDocumentArguments(value); return argumentsValue === undefined ? undefined : { toolName, arguments: argumentsValue } }
    case 'rename_workspace_document': { const argumentsValue = parseRenameWorkspaceDocumentArguments(value); return argumentsValue === undefined ? undefined : { toolName, arguments: argumentsValue } }
    case 'delete_workspace_document': { const argumentsValue = parseDeleteWorkspaceDocumentArguments(value); return argumentsValue === undefined ? undefined : { toolName, arguments: argumentsValue } }
  }
}

function parseDocumentPage(value: unknown, withPath: boolean, current: boolean): AiDocumentPage | AiWorkspaceDocumentPage | undefined {
  const keys = [
    ...(withPath ? ['path'] : []), 'displayName', 'sourceFormat', ...(current ? ['dirty'] : []),
    'cursor', 'content', 'nextCursor', 'hasMore', 'totalChars', 'version',
  ]
  if (!isExactOwnRecord(value, keys)
    || (withPath && !isCanonicalWorkspaceRelativePath(value.path))
    || !isSafeWireName(value.displayName) || !isSafeOpaqueIdentifier(value.sourceFormat, 64)
    || (current && typeof value.dirty !== 'boolean')
    || !isSafeNonNegativeInteger(value.cursor) || typeof value.content !== 'string'
    || value.content.length > AI_DOCUMENT_PAGE_MAX_CHARS
    || !(value.nextCursor === null || isSafeNonNegativeInteger(value.nextCursor))
    || typeof value.hasMore !== 'boolean' || !isSafeNonNegativeInteger(value.totalChars)
    || parseAiFileVersion(value.version) === undefined) return undefined
  const consumed = value.cursor + value.content.length
  if (value.cursor > value.totalChars || consumed > value.totalChars
    || (value.hasMore && (value.nextCursor === null || value.nextCursor !== consumed || value.nextCursor >= value.totalChars))
    || (!value.hasMore && (value.nextCursor !== null || consumed !== value.totalChars))) return undefined
  const page = {
    displayName: value.displayName, sourceFormat: value.sourceFormat, cursor: value.cursor, content: value.content,
    nextCursor: value.nextCursor, hasMore: value.hasMore, totalChars: value.totalChars, version: parseAiFileVersion(value.version)!,
  }
  return current
    ? { ...page, dirty: value.dirty as boolean }
    : { ...page, path: value.path as string }
}

export function parseCurrentDocumentToolResult(value: unknown): AiCurrentDocumentToolResult | undefined {
  const denied = parseAiToolDenial(value)
  if (denied !== undefined) return denied
  if (isExactOwnRecord(value, ['kind']) && value.kind === 'unavailable') return { kind: 'unavailable' }
  if (!isExactOwnRecord(value, ['kind', 'displayName', 'sourceFormat', 'dirty', 'cursor', 'content', 'nextCursor', 'hasMore', 'totalChars', 'version']) || value.kind !== 'document') return undefined
  const page = parseDocumentPage(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'kind')), false, true)
  return page === undefined ? undefined : { kind: 'document', ...(page as AiDocumentPage) }
}

function parseWorkspaceEntries(value: unknown): AiWorkspaceEntry[] | undefined {
  if (!isExactArray(value) || value.length > AI_WORKSPACE_LIST_PAGE_MAX_ENTRIES) return undefined
  const entries: AiWorkspaceEntry[] = []
  for (const entry of value) {
    if (!isExactOwnRecord(entry, ['path', 'name', 'kind']) || !isCanonicalWorkspaceRelativePath(entry.path)
      || !isSafeWireName(entry.name) || (entry.kind !== 'directory' && entry.kind !== 'document')) return undefined
    entries.push({ path: entry.path, name: entry.name, kind: entry.kind })
  }
  return entries
}

function parseAiToolDenial(value: unknown): AiToolDenial | undefined {
  if (isExactOwnRecord(value, ['kind']) && value.kind === 'denied') return { kind: 'denied' }
  if (isExactOwnRecord(value, ['kind', 'guidance']) && value.kind === 'denied'
    && (value.guidance === '请开启“AI 可查看文档”。'
      || value.guidance === '请开启“AI 可查看工作区”。'
      || value.guidance === '创建、重命名或删除文档需要选择“每次询问”或“按工作区许可”。')) {
    return { kind: 'denied', guidance: value.guidance }
  }
  return undefined
}

function parseGenericAiWorkspaceToolResult(value: unknown): AiWorkspaceToolResult | undefined {
  const denied = parseAiToolDenial(value)
  if (denied !== undefined) return denied
  if (isExactOwnRecord(value, ['kind']) && value.kind === 'unavailable') return { kind: 'unavailable' }
  if (isExactOwnRecord(value, ['kind', 'reason', 'guidance']) && value.kind === 'unavailable'
    && value.reason === 'target-changed' && value.guidance === AI_STALE_TARGET_GUIDANCE) {
    return { kind: 'unavailable', reason: 'target-changed', guidance: AI_STALE_TARGET_GUIDANCE }
  }
  if (isExactOwnRecord(value, ['kind', 'directoryPath', 'directoryVersion', 'cursor', 'entries', 'nextCursor']) && value.kind === 'entries') {
    const entries = parseWorkspaceEntries(value.entries)
    const version = parseAiWorkspaceDirectoryVersion(value.directoryVersion)
    if (entries === undefined || version === undefined
      || !(value.directoryPath === '' || isCanonicalWorkspaceRelativePath(value.directoryPath))
      || !isSafeNonNegativeInteger(value.cursor) || !(value.nextCursor === null || isSafeNonNegativeInteger(value.nextCursor))
      || (value.nextCursor !== null && value.nextCursor <= value.cursor)) return undefined
    return {
      kind: 'entries', directoryPath: value.directoryPath, directoryVersion: version,
      cursor: value.cursor, entries, nextCursor: value.nextCursor,
    }
  }
  if (isExactOwnRecord(value, ['kind', 'path', 'displayName', 'sourceFormat', 'cursor', 'content', 'nextCursor', 'hasMore', 'totalChars', 'version']) && value.kind === 'document') {
    const page = parseDocumentPage(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'kind')), true, false)
    return page === undefined ? undefined : { kind: 'document', ...(page as AiWorkspaceDocumentPage) }
  }
  const staleMutation = isExactOwnRecord(value, ['kind', 'operationId', 'state', 'paths', 'reason', 'guidance'])
    && value.state === 'failed' && value.reason === 'target-changed' && value.guidance === AI_STALE_TARGET_GUIDANCE
  const recycleUnavailable = isExactOwnRecord(value, ['kind', 'operationId', 'state', 'paths', 'reason', 'guidance'])
    && value.state === 'failed' && value.reason === 'recycle-unavailable' && value.guidance === AI_RECYCLE_UNAVAILABLE_GUIDANCE
  if ((isExactOwnRecord(value, ['kind', 'operationId', 'state', 'paths']) || staleMutation || recycleUnavailable) && value.kind === 'mutation'
    && isCanonicalUuid(value.operationId) && typeof value.state === 'string'
    && ['planned', 'awaitingApproval', 'authorized', 'executing', 'succeeded', 'failed', 'unknown'].includes(value.state)
    && isExactArray(value.paths) && value.paths.length > 0 && value.paths.length <= AI_OPERATION_PATH_LIMIT
    && new Set(value.paths).size === value.paths.length && value.paths.every((path) => isCanonicalWorkspaceRelativePath(path))) {
    const mutation = {
      kind: 'mutation' as const, operationId: value.operationId,
      paths: frozenWireArray(value.paths as string[]),
    }
    if (recycleUnavailable) {
      if (mutation.paths.length !== 1) return undefined
      return Object.freeze({ ...mutation, paths: Object.freeze([mutation.paths[0]] as [string]), state: 'failed' as const,
        reason: 'recycle-unavailable' as const, guidance: AI_RECYCLE_UNAVAILABLE_GUIDANCE })
    }
    return staleMutation
      ? Object.freeze({ ...mutation, state: 'failed' as const, reason: 'target-changed' as const, guidance: AI_STALE_TARGET_GUIDANCE })
      : Object.freeze({ ...mutation, state: value.state as AiOperationState })
  }
  return undefined
}

export function parseWorkspaceToolResult<Name extends AiWorkspaceToolName>(
  toolName: Name,
  value: unknown,
): AiWorkspaceToolContractMap[Name]['result'] | undefined {
  const notExecuted = parseAiBudgetNotExecuted(value)
  if (notExecuted && AI_WORKSPACE_TOOL_NAMES.includes(toolName)) return notExecuted
  const result = toolName === 'read_current_document'
    ? parseCurrentDocumentToolResult(value)
    : parseGenericAiWorkspaceToolResult(value)
  if (result === undefined) return undefined
  if (result.kind === 'mutation' && result.reason === 'recycle-unavailable' && toolName !== 'delete_workspace_document') return undefined
  if (result.kind === 'unavailable' && 'reason' in result && !MUTATION_TOOLS.has(toolName as AiMutationToolName)) return undefined
  if (toolName === 'list_workspace_entries' && result.kind !== 'entries' && result.kind !== 'denied' && result.kind !== 'unavailable') return undefined
  if (toolName === 'read_workspace_document' && result.kind !== 'document' && result.kind !== 'denied' && result.kind !== 'unavailable') return undefined
  if (MUTATION_TOOLS.has(toolName as AiMutationToolName) && result.kind !== 'mutation' && result.kind !== 'denied' && result.kind !== 'unavailable') return undefined
  if (result.kind === 'mutation' && !hasMutationPathCardinality(toolName as AiMutationToolName, result.paths)) return undefined
  return result as AiWorkspaceToolContractMap[Name]['result']
}

export function parseAiWorkspaceDirectoryVersion(value: unknown): AiWorkspaceDirectoryVersion | undefined {
  if (!isExactOwnRecord(value, ['workspaceGeneration', 'directoryId', 'revision'])
    || !isSafeOpaqueIdentifier(value.workspaceGeneration, 512)
    || !isSafeOpaqueIdentifier(value.directoryId, 512)
    || !isSafeOpaqueIdentifier(value.revision, 512)) return undefined
  return {
    workspaceGeneration: value.workspaceGeneration,
    directoryId: value.directoryId,
    revision: value.revision,
  }
}

export function isSubmitAiWorkspaceToolResultInput(value: unknown): value is SubmitAiWorkspaceToolResultInput {
  return parseSubmitAiWorkspaceToolResultInput(value) !== undefined
}

export function parseSubmitAiWorkspaceToolResultInput(value: unknown): SubmitAiWorkspaceToolResultInput | undefined {
  if (!isExactOwnRecord(value, ['requestId', 'toolCallId', 'toolName', 'result'])
    || !isCanonicalAiConversationRequestId(value.requestId) || !isCanonicalAiToolCallId(value.toolCallId)
    || typeof value.toolName !== 'string' || !AI_WORKSPACE_TOOL_NAMES.includes(value.toolName as AiWorkspaceToolName)) return undefined
  const toolName = value.toolName as AiWorkspaceToolName
  const result = parseWorkspaceToolResult(toolName, value.result)
  if (result === undefined) return undefined
  return { requestId: value.requestId, toolCallId: value.toolCallId, toolName, result } as SubmitAiWorkspaceToolResultInput
}

export function parseAiOperationManifest(value: unknown): AiOperationManifest | undefined {
  if (!isExactOwnRecord(value, ['operationId', 'idempotencyKey', 'nonce', 'workspaceGeneration', 'toolName', 'relativePaths', 'expectedVersions'])
    || !isCanonicalUuid(value.operationId) || !isSafeOpaqueIdentifier(value.idempotencyKey, 512)
    || !isSafeOpaqueIdentifier(value.nonce, 512) || !isSafeOpaqueIdentifier(value.workspaceGeneration, 512)
    || typeof value.toolName !== 'string' || !MUTATION_TOOLS.has(value.toolName as AiMutationToolName)
    || !isExactArray(value.relativePaths) || !hasMutationPathCardinality(value.toolName as AiMutationToolName, value.relativePaths)
    || !isExactArray(value.expectedVersions) || !hasExpectedVersionCardinality(value.toolName as AiMutationToolName, value.expectedVersions)) return undefined
  return {
    operationId: value.operationId, idempotencyKey: value.idempotencyKey, nonce: value.nonce,
    workspaceGeneration: value.workspaceGeneration, toolName: value.toolName as AiMutationToolName,
    relativePaths: [...value.relativePaths] as string[], expectedVersions: value.expectedVersions.map((version) => parseAiFileVersion(version)!),
  }
}

function hasMutationPathCardinality(toolName: AiMutationToolName, paths: readonly unknown[]): paths is readonly string[] {
  const count = toolName === 'rename_workspace_document' ? 2 : 1
  return paths.length === count && paths.length <= AI_OPERATION_PATH_LIMIT
    && new Set(paths).size === paths.length
    && paths.every((path) => isCanonicalWorkspaceRelativePath(path))
}

function hasExpectedVersionCardinality(toolName: AiMutationToolName, versions: readonly unknown[]): boolean {
  const count = toolName === 'create_workspace_document' ? 0 : 1
  return versions.length === count && versions.every((version) => parseAiFileVersion(version) !== undefined)
}

function hasAuthorizationPathCardinality(toolName: AiMutationToolName, paths: readonly unknown[]): paths is readonly string[] {
  return hasMutationPathCardinality(toolName, paths)
}

function isAllowedAuthorizationScope(toolName: AiMutationToolName, scope: unknown): scope is AiAuthorizationScope {
  if (toolName !== 'edit_workspace_document') return scope === 'action' || scope === 'workspace'
  return scope === 'action' || scope === 'document' || scope === 'workspace'
}

function isBoundedLocalAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 3 && value.length <= AI_AUDIT_ABSOLUTE_PATH_MAX_LENGTH
    && /^[A-Za-z]:\\/.test(value) && !/[\u0000\r\n]/.test(value)
}

function hasAuditPathCardinality(action: AiAuditEvent['action'], paths: readonly unknown[]): paths is readonly string[] {
  const count = action === 'renamed' ? 2 : action === 'authorization-allowed' || action === 'authorization-denied' ? 0 : 1
  return paths.length === count && paths.length <= AI_AUDIT_PATH_LIMIT && paths.every(isBoundedLocalAbsolutePath)
}

function parseUsage(value: unknown): ModelUsage | undefined {
  if (!isExactOwnRecord(value, ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'estimated'])
    || !isSafeNonNegativeInteger(value.inputTokens) || !isSafeNonNegativeInteger(value.outputTokens)
    || !isSafeNonNegativeInteger(value.totalTokens) || value.totalTokens !== value.inputTokens + value.outputTokens
    || !(value.cachedInputTokens === null || isSafeNonNegativeInteger(value.cachedInputTokens))
    || typeof value.estimated !== 'boolean') return undefined
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens, cachedInputTokens: value.cachedInputTokens, estimated: value.estimated }
}

export function parseAiConversationEvent(value: unknown): AiConversationEvent | undefined {
  if (typeof value !== 'object' || value === null || !Object.prototype.hasOwnProperty.call(value, 'type')) return undefined
  const discriminant = Object.getOwnPropertyDescriptor(value, 'type')
  if (!discriminant || !Object.hasOwn(discriminant, 'value')) return undefined
  const type = discriminant.value
  if (type === 'budget-paused') return parseAiBudgetPausedEvent(value)
  if (type === 'process-text' || type === 'process-stage' || type === 'process-tool') return parseAiProcessEvent(value)
  if (type === 'thinking') {
    if (!isExactOwnRecord(value, ['requestId', 'type', 'messageId', 'active', 'elapsedMs'])
      || !isCanonicalAiConversationRequestId(value.requestId) || !isCanonicalAiConversationMessageId(value.messageId)
      || typeof value.active !== 'boolean' || !isSafeNonNegativeInteger(value.elapsedMs)) return undefined
    return { requestId: value.requestId, type, messageId: value.messageId, active: value.active, elapsedMs: value.elapsedMs }
  }
  if (type === 'context-compaction') {
    const commonKeys = ['requestId', 'type', 'transcriptRevision', 'status']
    if (isExactOwnRecord(value, commonKeys)) {
      return isCanonicalAiConversationRequestId(value.requestId)
        && isSafeNonNegativeInteger(value.transcriptRevision) && value.status === 'failed'
        ? { requestId: value.requestId, type, transcriptRevision: value.transcriptRevision, status: 'failed' }
        : undefined
    }
    if (!isExactOwnRecord(value, [...commonKeys, 'beforeTokens', 'afterTokens', 'contextWindowTokens'])
      || !isCanonicalAiConversationRequestId(value.requestId)
      || !isSafeNonNegativeInteger(value.transcriptRevision) || value.status !== 'compacted'
      || !isSafeNonNegativeInteger(value.beforeTokens) || !isSafeNonNegativeInteger(value.afterTokens)
      || value.afterTokens > value.beforeTokens || !isSafeNonNegativeInteger(value.contextWindowTokens)
      || value.contextWindowTokens === 0) return undefined
    return {
      requestId: value.requestId, type, transcriptRevision: value.transcriptRevision,
      status: 'compacted', beforeTokens: value.beforeTokens, afterTokens: value.afterTokens,
      contextWindowTokens: value.contextWindowTokens,
    }
  }
  const keys = type === 'user-message-accepted' ? ['requestId', 'type', 'messageId', 'transcriptRevision']
    : type === 'message-start' ? ['requestId', 'type', 'messageId', 'previousTranscriptRevision']
    : type === 'delta' ? ['requestId', 'type', 'messageId', 'delta']
      : type === 'message-completed' ? ['requestId', 'type', 'messageId', 'transcriptRevision']
    : type === 'failed' ? ['requestId', 'type', 'code', 'message', ...(Object.hasOwn(value, 'detail') ? ['detail'] : [])]
      : type === 'authorization-requested' ? ['requestId', 'type', 'toolCallId', 'toolName', 'operationId', 'scope', 'paths']
        : type === 'authorization-result' ? ['requestId', 'type', 'toolName', 'operationId', 'scope', 'allowed']
          : type === 'operation-status' ? ['requestId', 'type', 'toolName', 'operationId', 'status', 'paths']
          : type === 'audit' ? ['requestId', 'type', 'action', 'absolutePaths']
            : type === 'usage' ? ['requestId', 'type', 'usage']
              : type === 'started' ? ['requestId', 'type', 'transcriptRevision']
                : ['requestId', 'type']
  if (!isExactOwnRecord(value, keys) || !isCanonicalAiConversationRequestId(value.requestId)) return undefined
  if (type === 'started') return isSafeNonNegativeInteger(value.transcriptRevision)
    ? { requestId: value.requestId, type, transcriptRevision: value.transcriptRevision } : undefined
  if (type === 'user-message-accepted') return isCanonicalAiConversationMessageId(value.messageId)
    && isSafeNonNegativeInteger(value.transcriptRevision)
    ? { requestId: value.requestId, type, messageId: value.messageId, transcriptRevision: value.transcriptRevision }
    : undefined
  if (type === 'completed' || type === 'stopped') return { requestId: value.requestId, type }
  if (type === 'message-start') return isCanonicalAiConversationMessageId(value.messageId)
    && isSafeNonNegativeInteger(value.previousTranscriptRevision)
    ? { requestId: value.requestId, type, messageId: value.messageId, previousTranscriptRevision: value.previousTranscriptRevision }
    : undefined
  if (type === 'delta') return isCanonicalAiConversationMessageId(value.messageId)
    && typeof value.delta === 'string'
    && new TextEncoder().encode(value.delta).byteLength <= AI_CONVERSATION_DELTA_CHUNK_MAX_BYTES
    ? { requestId: value.requestId, type, messageId: value.messageId, delta: value.delta } : undefined
  if (type === 'message-completed') return isCanonicalAiConversationMessageId(value.messageId)
    && isSafeNonNegativeInteger(value.transcriptRevision)
    ? { requestId: value.requestId, type, messageId: value.messageId, transcriptRevision: value.transcriptRevision }
    : undefined
  if (type === 'failed') {
    if (!isPublicErrorCode(value.code) || typeof value.message !== 'string' || value.message !== PUBLIC_ERROR_MESSAGES[value.code]) return undefined
    const detail = Object.hasOwn(value, 'detail') ? parseModelErrorDetail(value.detail) : undefined
    if (detail === null) return undefined
    return { requestId: value.requestId, type, code: value.code, message: value.message, ...(detail ? { detail } : {}) }
  }
  if (type === 'authorization-requested') return isCanonicalAiToolCallId(value.toolCallId) && typeof value.toolName === 'string' && MUTATION_TOOLS.has(value.toolName as AiMutationToolName) && isCanonicalUuid(value.operationId) && isAllowedAuthorizationScope(value.toolName as AiMutationToolName, value.scope) && isExactArray(value.paths) && hasAuthorizationPathCardinality(value.toolName as AiMutationToolName, value.paths) ? Object.freeze({ requestId: value.requestId, type, toolCallId: value.toolCallId, toolName: value.toolName as AiMutationToolName, operationId: value.operationId, scope: value.scope, paths: frozenWireArray(value.paths as string[]) }) : undefined
  if (type === 'authorization-result') return typeof value.toolName === 'string' && MUTATION_TOOLS.has(value.toolName as AiMutationToolName) && isCanonicalUuid(value.operationId) && isAllowedAuthorizationScope(value.toolName as AiMutationToolName, value.scope) && typeof value.allowed === 'boolean' ? { requestId: value.requestId, type, toolName: value.toolName as AiMutationToolName, operationId: value.operationId, scope: value.scope, allowed: value.allowed } : undefined
  if (type === 'operation-status') return typeof value.toolName === 'string' && MUTATION_TOOLS.has(value.toolName as AiMutationToolName) && isCanonicalUuid(value.operationId) && value.status === 'unknown' && isExactArray(value.paths) && hasMutationPathCardinality(value.toolName as AiMutationToolName, value.paths) ? Object.freeze({ requestId: value.requestId, type, toolName: value.toolName as AiMutationToolName, operationId: value.operationId, status: value.status, paths: frozenWireArray(value.paths as string[]) }) : undefined
  if (type === 'audit') return typeof value.action === 'string' && ['authorization-allowed', 'authorization-denied', 'edited', 'created', 'renamed', 'deleted'].includes(value.action) && isExactArray(value.absolutePaths) && hasAuditPathCardinality(value.action as AiAuditEvent['action'], value.absolutePaths) ? Object.freeze({ requestId: value.requestId, type, action: value.action as AiAuditEvent['action'], absolutePaths: frozenWireArray(value.absolutePaths as string[]) }) : undefined
  if (type === 'usage') { const usage = parseUsage(value.usage); return usage === undefined ? undefined : { requestId: value.requestId, type, usage } }
  return undefined
}

export function aiConversationEventUtf8ByteLength(event: AiConversationEvent): number {
  return new TextEncoder().encode(JSON.stringify(event)).byteLength
}

export function aiConversationOverflowEvent(requestId: string): AiConversationEvent {
  return { requestId, type: 'failed', code: 'OPERATION_FAILED', message: PUBLIC_ERROR_MESSAGES.OPERATION_FAILED }
}
