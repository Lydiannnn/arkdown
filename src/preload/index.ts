import { APP_UPDATE_CHANGED } from '../shared/app-update'
import { createArknoteBoxThemeApi } from './arknote-box-theme-api'
import { createClosePreparationBridge } from './close-preparation'
import { createCloseRecoveryApi } from './close-recovery-api'
import { createBusinessMessageApi } from './business-message-api'
import { CLOSE_PREPARATION_CHANNELS, parseClosePreparationAttempt } from '../shared/close-preparation'
import { MODEL_CAPABILITY_RULES_CHANGED } from '../shared/model-capability-rules-state'
import { SHORTCUTS_CHANGED_CHANNEL } from '../shared/keyboard-shortcuts'
import { STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL } from '../shared/sticky-note-material-effects'
import { createStickyNoteMaterialEffectsTransport } from './sticky-note-material-effects-transport'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  AI_CONVERSATION_EVENT_CHANNEL,
  CLOSE_CHANNELS,
  APPLICATION_MENU_CHANGED_CHANNEL,
  BACKGROUND_PRESENTATION_CHANNEL,
  DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
  EDITOR_APPEARANCE_CHANGED_CHANNEL,
  LAYOUT_PREFERENCES_CHANGED_CHANNEL,
  IPC_CHANNELS,
  SCREENSHOT_CAPTURE_EVENT_CHANNEL,
  SCREENSHOT_OCR_MODEL_STATE_CHANNEL,
  SCREENSHOT_OCR_HOST_EVENT_CHANNEL,
  SCREENSHOT_TRANSLATION_EVENT_CHANNEL,
  TRANSLATION_EVENT_CHANNEL,
  STICKY_NOTE_EVENT_CHANNEL,
  WINDOW_CHANNELS,
  WINDOW_STATE_CHANGED_CHANNEL,
  type ClosePreparationHeartbeat,
  type ClosePreparationResponse,
  type AiCurrentDocumentRendererPort,
  type AiOpenDocumentRendererPort,
} from '../shared/contracts'
import {
  parseScreenshotCaptureEvent,
  parseScreenshotOcrHostCommand,
  parseScreenshotTranslationEvent,
  type ScreenshotCaptureEvent,
  type ScreenshotOcrHostCommand,
  type ScreenshotTranslationEvent,
} from '../shared/screenshot-translation'
import { MENU_COMMAND_CHANNEL } from '../shared/menu-commands'
import { STICKY_NOTE_CONTEXT_MENU_CHANNELS } from '../shared/sticky-note-context-menu'
import {
  parseTranslationEvent,
  translationEventUtf8ByteLength,
  translationOverflowEvent,
} from '../shared/selection-translation'
import {
  aiConversationEventUtf8ByteLength,
  aiConversationOverflowEvent,
  isCanonicalAiConversationRequestId,
  parseAiConversationEvent,
} from '../shared/ai-conversation'
import { createArkdownApi } from './arkdown-api'
import { createBufferedEventTransport } from './buffered-event-transport'

// Translation buffering is bounded by both retained event count and the
// protocol's 8 MiB SSE response ceiling. A fixed FIFO of recently closed
// request IDs prevents a canceled stream from being revived by duplicate IDs.
const TRANSLATION_PENDING_EVENT_LIMIT = 1024
const TRANSLATION_PENDING_BYTE_LIMIT = 8 * 1024 * 1024
const TRANSLATION_CLOSED_GROUP_LIMIT = 2048

function bufferedIpcTransport(channel: string) {
  return createBufferedEventTransport<unknown>((emit) => {
    ipcRenderer.on(channel, (_event: IpcRendererEvent, payload: unknown) => {
      emit(payload)
    })
  }, channel === TRANSLATION_EVENT_CHANNEL
    ? {
        mode: 'queue',
        maxPending: TRANSLATION_PENDING_EVENT_LIMIT,
        maxClosedGroups: TRANSLATION_CLOSED_GROUP_LIMIT,
        maxPendingBytes: TRANSLATION_PENDING_BYTE_LIMIT,
        prepare(value) {
          const event = parseTranslationEvent(value)
          if (!event) return undefined

          return {
            value: event,
            groupKey: event.requestId,
            byteLength: translationEventUtf8ByteLength(event),
            phase: event.type === 'started'
              ? 'started'
              : event.type === 'delta' ? 'progress' : 'terminal',
          }
        },
        overflow(groupKey) {
          const event = translationOverflowEvent(groupKey)
          return {
            value: event,
            groupKey,
            byteLength: translationEventUtf8ByteLength(event),
            phase: 'terminal',
          }
        },
        onOverflow(groupKey) {
          void Promise.resolve(ipcRenderer.invoke(
            IPC_CHANNELS.cancelTranslation, { requestId: groupKey },
          )).catch(() => undefined)
        },
      }
    : channel === AI_CONVERSATION_EVENT_CHANNEL
      ? {
          mode: 'queue',
          maxPending: TRANSLATION_PENDING_EVENT_LIMIT,
          maxClosedGroups: TRANSLATION_CLOSED_GROUP_LIMIT,
          maxPendingBytes: TRANSLATION_PENDING_BYTE_LIMIT,
          prepare(value) {
            const event = parseAiConversationEvent(value)
            if (!event) return undefined
            return {
              value: event,
              groupKey: event.requestId,
              byteLength: aiConversationEventUtf8ByteLength(event),
              phase: event.type === 'started'
                ? 'started'
                : event.type === 'completed' || event.type === 'stopped' || event.type === 'failed'
                  ? 'terminal'
                  : 'progress',
            }
          },
          overflow(groupKey) {
            const event = aiConversationOverflowEvent(groupKey)
            return {
              value: event,
              groupKey,
              byteLength: aiConversationEventUtf8ByteLength(event),
              phase: 'terminal',
            }
          },
          onOverflow(groupKey) {
            void Promise.resolve(ipcRenderer.invoke(
              IPC_CHANNELS.cancelAiConversation,
              { requestId: groupKey },
            )).catch(() => undefined)
          },
        }
      : undefined)
}

const openIntentTransport = bufferedIpcTransport(WINDOW_CHANNELS.openIntent)
const recoveryTransport = bufferedIpcTransport(WINDOW_CHANNELS.recoverDraft)
const importDocxTransport = bufferedIpcTransport(WINDOW_CHANNELS.importDocx)
const translationTransport = bufferedIpcTransport(TRANSLATION_EVENT_CHANNEL)
const aiConversationTransport = bufferedIpcTransport(AI_CONVERSATION_EVENT_CHANNEL)

const AI_RENDERER_PORT_PENDING_LIMIT = 32
const AI_RENDERER_PORT_SEEN_LIMIT = 2048
const AI_RENDERER_PORT_CALLBACK_TIMEOUT_MS = 15_000
const AI_OPEN_DOCUMENT_TEXT_LIMIT = 32 * 1024 * 1024
const AI_CURRENT_DOCUMENT_PAGE_LIMIT = 48_000
const AI_RENDERER_BINDING_KEYS = [
  'ownerId', 'requestId', 'conversationId', 'workspaceId', 'workspaceGeneration',
  'toolCallId', 'brokerRequestId',
] as const
const AI_OPEN_DOCUMENT_BINDING_KEYS = [
  'registrationToken', 'registrationRevision', 'bindingToken', 'bindingRevision',
] as const
const SHA256 = /^[0-9a-f]{64}$/u
const OPAQUE_AI_PORT_TOKEN = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,511}$/u

function exactAiPortRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  // Requests arrive through IPC; renderer callback results are copied by contextBridge.
  // Inspect own descriptors without invoking accessors in this isolated world. The
  // bridge's serialization of renderer values is a separate, earlier boundary.
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const ownKeys = Reflect.ownKeys(descriptors)
    return ownKeys.length === keys.length
      && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
      && keys.every((key) => {
        const descriptor = descriptors[key]
        return descriptor?.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, 'value')
      })
  } catch {
    return false
  }
}

function validOpenDocumentPayload(
  method: 'captureReadSnapshot' | 'planReplacement' | 'applyTransaction' | 'queryOutcome',
  payload: Record<string, unknown>,
): boolean {
  if (typeof payload.registrationToken !== 'string'
    || !OPAQUE_AI_PORT_TOKEN.test(payload.registrationToken)
    || !Number.isSafeInteger(payload.registrationRevision) || Number(payload.registrationRevision) < 0
    || typeof payload.bindingToken !== 'string'
    || !OPAQUE_AI_PORT_TOKEN.test(payload.bindingToken)
    || !Number.isSafeInteger(payload.bindingRevision) || Number(payload.bindingRevision) < 0) return false
  if (method === 'captureReadSnapshot') return true
  if (typeof payload.operationId !== 'string'
    || !OPAQUE_AI_PORT_TOKEN.test(payload.operationId)
    || !Number.isSafeInteger(payload.expectedEditorRevision)
    || Number(payload.expectedEditorRevision) < 0
    || typeof payload.expectedContentHash !== 'string'
    || !SHA256.test(payload.expectedContentHash)) return false
  return method === 'queryOutcome'
    ? typeof payload.replacementContentHash === 'string'
      && SHA256.test(payload.replacementContentHash)
    : typeof payload.replacementMarkdown === 'string'
      && Buffer.byteLength(payload.replacementMarkdown, 'utf8') <= AI_OPEN_DOCUMENT_TEXT_LIMIT
}

function parseCurrentDocumentResult(method: string, value: unknown): unknown {
  if (method === 'release') return Object.freeze({ status: 'released' })
  if (exactAiPortRecord(value, ['status']) && value.status === 'unavailable') {
    return Object.freeze({ status: 'unavailable' })
  }
  const keys = method === 'openSnapshot'
    ? ['status', 'snapshotId', 'displayName', 'sourceFormat', 'dirty', 'content',
        'nextCursor', 'hasMore', 'totalChars']
    : ['status', 'displayName', 'sourceFormat', 'dirty', 'content',
        'nextCursor', 'hasMore', 'totalChars']
  if (!exactAiPortRecord(value, keys) || value.status !== 'captured'
    || (method === 'openSnapshot' && (typeof value.snapshotId !== 'string'
      || value.snapshotId.length === 0 || value.snapshotId.length > 512))
    || typeof value.displayName !== 'string' || value.displayName.length === 0
    || value.displayName.length > 255 || typeof value.sourceFormat !== 'string'
    || value.sourceFormat.length === 0 || value.sourceFormat.length > 64
    || typeof value.dirty !== 'boolean' || typeof value.content !== 'string'
    || value.content.length > AI_CURRENT_DOCUMENT_PAGE_LIMIT
    || !(value.nextCursor === null || (Number.isSafeInteger(value.nextCursor)
      && Number(value.nextCursor) >= 0))
    || typeof value.hasMore !== 'boolean' || !Number.isSafeInteger(value.totalChars)
    || Number(value.totalChars) < 0) return Object.freeze({ status: 'unavailable' })
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, value[key]])))
}

function validCurrentDocumentPayload(
  method: 'openSnapshot' | 'readPage' | 'release',
  payload: Record<string, unknown>,
): boolean {
  if (!Number.isSafeInteger(payload.ownerId) || Number(payload.ownerId) <= 0
    || !isCanonicalAiConversationRequestId(payload.requestId)
    || !isCanonicalAiConversationRequestId(payload.conversationId)
    || typeof payload.workspaceId !== 'string' || payload.workspaceId.length === 0
    || payload.workspaceId.length > 512 || typeof payload.workspaceGeneration !== 'string'
    || payload.workspaceGeneration.length === 0 || payload.workspaceGeneration.length > 512
    || typeof payload.toolCallId !== 'string' || !OPAQUE_AI_PORT_TOKEN.test(payload.toolCallId)
    || typeof payload.brokerRequestId !== 'string'
    || !OPAQUE_AI_PORT_TOKEN.test(payload.brokerRequestId)) return false
  if (method === 'release') {
    return typeof payload.snapshotId === 'string'
      && payload.snapshotId.length > 0 && payload.snapshotId.length <= 512
  }
  if (!Number.isSafeInteger(payload.cursor) || Number(payload.cursor) < 0
    || !Number.isSafeInteger(payload.maxChars) || Number(payload.maxChars) <= 0
    || Number(payload.maxChars) > AI_CURRENT_DOCUMENT_PAGE_LIMIT) return false
  return method === 'openSnapshot'
    ? payload.cursor === 0 && (!('expectedDocumentId' in payload)
      || isCanonicalAiConversationRequestId(payload.expectedDocumentId))
    : typeof payload.snapshotId === 'string'
      && payload.snapshotId.length > 0 && payload.snapshotId.length <= 512
}

function aiRendererPortTransport() {
  let currentPort: AiCurrentDocumentRendererPort | undefined
  const openPorts = new Map<string, AiOpenDocumentRendererPort>()
  const pending = new Set<string>()
  const seen = new Set<string>()
  const remember = (requestId: string): boolean => {
    if (seen.has(requestId)) return false
    seen.add(requestId)
    while (seen.size > AI_RENDERER_PORT_SEEN_LIMIT) {
      const oldest = seen.values().next().value as string | undefined
      if (oldest) seen.delete(oldest)
    }
    return true
  }
  const respondCurrentDocument = (transportRequestId: string, method: string, result: unknown): void => {
    void Promise.resolve(ipcRenderer.invoke(
      IPC_CHANNELS.submitAiCurrentDocumentPortResponse,
      { transportRequestId, method, result },
    )).catch(() => undefined)
  }
  const respondOpenDocument = (
    transportRequestId: string,
    documentHandle: string,
    method: string,
    result: unknown,
  ): void => {
    void Promise.resolve(ipcRenderer.invoke(
      IPC_CHANNELS.submitAiOpenDocumentPortResponse,
      { transportRequestId, documentHandle, method, result },
    )).catch(() => undefined)
  }
  const openDocumentFallback = (method: string): Readonly<{ status: 'unavailable' | 'unknown' }> => (
    Object.freeze({ status: method === 'captureReadSnapshot' || method === 'planReplacement'
      ? 'unavailable' as const : 'unknown' as const })
  )
  const parseOpenDocumentResult = (method: string, value: unknown): unknown => {
    if (exactAiPortRecord(value, ['status'])) {
      const allowed = method === 'captureReadSnapshot' || method === 'planReplacement'
        ? ['stale', 'unavailable']
        : method === 'applyTransaction' ? ['stale', 'unknown']
          : ['not-applied', 'unknown', 'unavailable', 'stale']
      return typeof value.status === 'string' && allowed.includes(value.status)
        ? Object.freeze({ status: value.status }) : openDocumentFallback(method)
    }
    if (method === 'captureReadSnapshot'
      && exactAiPortRecord(value, ['status', 'editorRevision', 'contentHash', 'markdown', 'dirty'])
      && value.status === 'captured' && Number.isSafeInteger(value.editorRevision)
      && (value.editorRevision as number) >= 0 && typeof value.contentHash === 'string'
      && SHA256.test(value.contentHash) && typeof value.markdown === 'string'
      && Buffer.byteLength(value.markdown, 'utf8') <= AI_OPEN_DOCUMENT_TEXT_LIMIT
      && typeof value.dirty === 'boolean') return Object.freeze({ ...value })
    if (method === 'planReplacement'
      && exactAiPortRecord(value, ['status', 'editorRevision', 'contentHash'])
      && value.status === 'planned' && Number.isSafeInteger(value.editorRevision)
      && (value.editorRevision as number) >= 0 && typeof value.contentHash === 'string'
      && SHA256.test(value.contentHash)) return Object.freeze({ ...value })
    if ((method === 'applyTransaction' || method === 'queryOutcome')
      && exactAiPortRecord(value, ['status', 'editorRevision', 'contentHash', 'dirty'])
      && value.status === 'applied' && Number.isSafeInteger(value.editorRevision)
      && (value.editorRevision as number) >= 0 && typeof value.contentHash === 'string'
      && SHA256.test(value.contentHash) && typeof value.dirty === 'boolean') {
      return Object.freeze({ ...value })
    }
    return openDocumentFallback(method)
  }
  ipcRenderer.on(IPC_CHANNELS.aiRendererPortRequest, (_event: IpcRendererEvent, raw: unknown) => {
    if (exactAiPortRecord(raw, ['transportRequestId', 'documentHandle', 'method', 'payload'])) {
      if (!isCanonicalAiConversationRequestId(raw.transportRequestId)
        || !isCanonicalAiConversationRequestId(raw.documentHandle)
        || (raw.method !== 'captureReadSnapshot' && raw.method !== 'planReplacement'
          && raw.method !== 'applyTransaction' && raw.method !== 'queryOutcome')
        || !remember(raw.transportRequestId)) return
      const method = raw.method
      const payloadKeys = method === 'captureReadSnapshot'
        ? [...AI_OPEN_DOCUMENT_BINDING_KEYS]
        : method === 'queryOutcome'
          ? [...AI_OPEN_DOCUMENT_BINDING_KEYS, 'operationId', 'expectedEditorRevision',
              'expectedContentHash', 'replacementContentHash']
          : [...AI_OPEN_DOCUMENT_BINDING_KEYS, 'operationId', 'expectedEditorRevision',
              'expectedContentHash', 'replacementMarkdown']
      if (!exactAiPortRecord(raw.payload, payloadKeys)
        || !validOpenDocumentPayload(method, raw.payload)) return
      const transportRequestId = raw.transportRequestId
      const documentHandle = raw.documentHandle
      if (pending.size >= AI_RENDERER_PORT_PENDING_LIMIT) {
        respondOpenDocument(transportRequestId, documentHandle, method, openDocumentFallback(method))
        return
      }
      const port = openPorts.get(documentHandle)
      if (!port) {
        respondOpenDocument(transportRequestId, documentHandle, method, openDocumentFallback(method))
        return
      }
      pending.add(transportRequestId)
      const finish = (result: unknown): void => {
        if (!pending.delete(transportRequestId)) return
        respondOpenDocument(transportRequestId, documentHandle, method,
          openPorts.get(documentHandle) === port
            ? parseOpenDocumentResult(method, result) : openDocumentFallback(method))
      }
      const callbackTimer = setTimeout(
        () => finish(openDocumentFallback(method)),
        AI_RENDERER_PORT_CALLBACK_TIMEOUT_MS,
      )
      const complete = (result: unknown): void => {
        clearTimeout(callbackTimer)
        finish(result)
      }
      const editorInput = method === 'captureReadSnapshot'
        ? Object.freeze({})
        : method === 'queryOutcome'
          ? Object.freeze({
              operationId: raw.payload.operationId as string,
              expectedEditorRevision: raw.payload.expectedEditorRevision as number,
              expectedContentHash: raw.payload.expectedContentHash as string,
              replacementContentHash: raw.payload.replacementContentHash as string,
            })
          : Object.freeze({
              operationId: raw.payload.operationId as string,
              expectedEditorRevision: raw.payload.expectedEditorRevision as number,
              expectedContentHash: raw.payload.expectedContentHash as string,
              replacementMarkdown: raw.payload.replacementMarkdown as string,
            })
      try {
        const returned = method === 'captureReadSnapshot'
          ? port.captureReadSnapshot(editorInput as Record<string, never>)
          : method === 'planReplacement'
            ? port.planReplacement(editorInput as Parameters<AiOpenDocumentRendererPort['planReplacement']>[0])
            : method === 'applyTransaction'
              ? port.applyTransaction(editorInput as Parameters<AiOpenDocumentRendererPort['applyTransaction']>[0])
              : port.queryOutcome(editorInput as Parameters<AiOpenDocumentRendererPort['queryOutcome']>[0])
        void Promise.resolve(returned).then(
          complete,
          () => complete(openDocumentFallback(method)),
        )
      } catch {
        complete(openDocumentFallback(method))
      }
      return
    }
    if (!exactAiPortRecord(raw, ['transportRequestId', 'method', 'payload'])
      || !isCanonicalAiConversationRequestId(raw.transportRequestId)
      || (raw.method !== 'openSnapshot' && raw.method !== 'readPage' && raw.method !== 'release')
      || !remember(raw.transportRequestId)) return
    const method = raw.method
    const payloadKeys = method === 'openSnapshot'
      ? [...AI_RENDERER_BINDING_KEYS, 'cursor', 'maxChars',
        ...(typeof raw.payload === 'object' && raw.payload !== null && 'expectedDocumentId' in raw.payload ? ['expectedDocumentId'] : [])]
      : method === 'readPage'
        ? [...AI_RENDERER_BINDING_KEYS, 'snapshotId', 'cursor', 'maxChars']
        : [...AI_RENDERER_BINDING_KEYS, 'snapshotId']
    if (!exactAiPortRecord(raw.payload, payloadKeys)
      || !validCurrentDocumentPayload(method, raw.payload)) return
    const transportRequestId = raw.transportRequestId
    if (pending.size >= AI_RENDERER_PORT_PENDING_LIMIT) {
      respondCurrentDocument(transportRequestId, method, method === 'release' ? { status: 'released' } : { status: 'unavailable' })
      return
    }
    const port = currentPort
    if (!port) {
      respondCurrentDocument(transportRequestId, method, method === 'release' ? { status: 'released' } : { status: 'unavailable' })
      return
    }
    pending.add(transportRequestId)
    const finish = (result: unknown): void => {
      if (!pending.delete(transportRequestId)) return
      respondCurrentDocument(transportRequestId, method, currentPort === port
        ? parseCurrentDocumentResult(method, result)
        : method === 'release' ? { status: 'released' } : { status: 'unavailable' })
    }
    const callbackTimer = setTimeout(
      () => finish(method === 'release' ? { status: 'released' } : { status: 'unavailable' }),
      AI_RENDERER_PORT_CALLBACK_TIMEOUT_MS,
    )
    const complete = (result: unknown): void => {
      clearTimeout(callbackTimer)
      finish(result)
    }
    try {
      if (method === 'release') {
        const returned = port.release(Object.freeze({ snapshotId: raw.payload.snapshotId as string }))
        void Promise.resolve(returned).then(
          () => complete({ status: 'released' }),
          () => complete({ status: 'released' }),
        )
      } else if (method === 'openSnapshot') {
        const returned = port.openSnapshot(Object.freeze({
          cursor: 0,
          maxChars: raw.payload.maxChars as number,
          ...('expectedDocumentId' in raw.payload ? { expectedDocumentId: raw.payload.expectedDocumentId as string } : {}),
        }))
        void Promise.resolve(returned).then(
          complete,
          () => complete({ status: 'unavailable' }),
        )
      } else {
        const returned = port.readPage(Object.freeze({
          snapshotId: raw.payload.snapshotId as string,
          cursor: raw.payload.cursor as number,
          maxChars: raw.payload.maxChars as number,
        }))
        void Promise.resolve(returned).then(
          complete,
          () => complete({ status: 'unavailable' }),
        )
      }
    } catch {
      complete(method === 'release' ? { status: 'released' } : { status: 'unavailable' })
    }
  })
  return Object.freeze({
    attachCurrentDocumentPort(port: AiCurrentDocumentRendererPort) {
      const previousPort = currentPort
      let state: 'pending' | 'committed' | 'rolled-back' | 'detached' = 'pending'
      currentPort = port
      return Object.freeze({
        commit() {
          if (state !== 'pending' || currentPort !== port) {
            throw new Error('AI current-document port attachment is stale')
          }
          state = 'committed'
        },
        rollback() {
          if (state !== 'pending') return
          state = 'rolled-back'
          if (currentPort === port) currentPort = previousPort
        },
        detach() {
          if (state === 'detached' || state === 'rolled-back') return
          const wasPending = state === 'pending'
          state = 'detached'
          if (currentPort === port) currentPort = wasPending ? previousPort : undefined
        },
      })
    },
    attachOpenDocumentPort(port: AiOpenDocumentRendererPort) {
      let documentHandle: string | undefined
      let detached = false
      return Object.freeze({
        bind(nextDocumentHandle: string) {
          if (detached || documentHandle || !isCanonicalAiConversationRequestId(nextDocumentHandle)
            || openPorts.has(nextDocumentHandle)) throw new Error('Invalid AI document handle')
          documentHandle = nextDocumentHandle
          openPorts.set(nextDocumentHandle, port)
        },
        detach() {
          if (detached) return
          detached = true
          if (documentHandle && openPorts.get(documentHandle) === port) {
            openPorts.delete(documentHandle)
          }
        },
      })
    },
  })
}

const aiRendererPorts = aiRendererPortTransport()
const documentConversionComponentStateTransport = bufferedIpcTransport(
  DOCUMENT_CONVERSION_COMPONENT_STATE_CHANNEL,
)
const backgroundPresentationTransport = bufferedIpcTransport(BACKGROUND_PRESENTATION_CHANNEL)
const stickyNoteTransport = bufferedIpcTransport(STICKY_NOTE_EVENT_CHANNEL)
const stickyNoteContextMenuShowTransport = bufferedIpcTransport(STICKY_NOTE_CONTEXT_MENU_CHANNELS.show)
const stickyNoteContextMenuCommandTransport = bufferedIpcTransport(STICKY_NOTE_CONTEXT_MENU_CHANNELS.command)
const stickyNoteContextMenuClosedTransport = bufferedIpcTransport(STICKY_NOTE_CONTEXT_MENU_CHANNELS.closed)
const stickyNoteContextMenuResetTransport = bufferedIpcTransport(STICKY_NOTE_CONTEXT_MENU_CHANNELS.reset)
const applicationMenuChangedTransport = {
  subscribe(listener: (payload: unknown) => void) {
    const onChanged = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(APPLICATION_MENU_CHANGED_CHANNEL, onChanged)
    return () => ipcRenderer.removeListener(APPLICATION_MENU_CHANGED_CHANNEL, onChanged)
  },
}
const editorAppearanceChangedTransport = bufferedIpcTransport(
  EDITOR_APPEARANCE_CHANGED_CHANNEL,
)
const layoutPreferencesChangedTransport = bufferedIpcTransport(
  LAYOUT_PREFERENCES_CHANGED_CHANNEL,
)
const windowStateChangedTransport = {
  subscribe(listener: (payload: unknown) => void) {
    const onChanged = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(WINDOW_STATE_CHANGED_CHANNEL, onChanged)
    return () => ipcRenderer.removeListener(WINDOW_STATE_CHANGED_CHANNEL, onChanged)
  },
}

function screenshotCaptureTransport() {
  let ready: ScreenshotCaptureEvent | undefined
  let latest: ScreenshotCaptureEvent | undefined
  let listener: ((payload: unknown) => void) | undefined
  ipcRenderer.on(SCREENSHOT_CAPTURE_EVENT_CHANNEL, (_event: IpcRendererEvent, payload: unknown) => {
    const event = parseScreenshotCaptureEvent(payload)
    if (!event) return
    if (event.type === 'selection-ready') {
      ready = event
      latest = undefined
      listener?.(event)
      return
    }
    if (ready?.sessionId !== event.sessionId) return
    latest = event
    listener?.(event)
  })
  return {
    subscribe(next: (payload: unknown) => void) {
      listener = next
      if (ready) next(ready)
      if (latest) next(latest)
      return () => { if (listener === next) listener = undefined }
    },
  }
}

const screenshotTransport = screenshotCaptureTransport()

function screenshotTranslationTransport() {
  let snapshot: Extract<ScreenshotTranslationEvent, { type: 'snapshot-ready' }> | undefined
  let ocr: ScreenshotTranslationEvent | undefined
  let documentProgress: Extract<ScreenshotTranslationEvent, {
    type: 'document-translation-progress'
  }> | undefined
  let translation: ScreenshotTranslationEvent | undefined
  let listener: ((payload: unknown) => void) | undefined
  ipcRenderer.on(SCREENSHOT_TRANSLATION_EVENT_CHANNEL, (_event: IpcRendererEvent, payload: unknown) => {
    const event = parseScreenshotTranslationEvent(payload)
    if (!event) return
    if (event.type === 'snapshot-ready') {
      if (snapshot && event.sessionId === snapshot.sessionId && event.generation <= snapshot.generation) return
      snapshot = event
      ocr = undefined
      documentProgress = undefined
      translation = undefined
      listener?.(event)
      return
    }
    if (!snapshot
      || event.sessionId !== snapshot.sessionId
      || event.generation !== snapshot.generation) return
    if (event.type === 'ocr-started' || event.type === 'ocr-completed'
      || (event.type === 'failed' && event.stage === 'ocr')) {
      ocr = event
    } else if (event.type === 'document-translation-progress') {
      documentProgress = event
      translation = undefined
    } else {
      if (event.type === 'translation-started'
        || event.type === 'translation-cancelled'
        || event.type === 'translation-completed'
        || event.type === 'document-translation-completed') {
        documentProgress = undefined
      }
      translation = event
    }
    listener?.(event)
  })
  return {
    subscribe(next: (payload: unknown) => void) {
      listener = next
      if (snapshot) next(snapshot)
      if (ocr) next(ocr)
      if (documentProgress) next(documentProgress)
      if (translation) next(translation)
      return () => { if (listener === next) listener = undefined }
    },
  }
}

const screenshotResultTransport = screenshotTranslationTransport()
const screenshotOcrModelStateTransport = bufferedIpcTransport(SCREENSHOT_OCR_MODEL_STATE_CHANNEL)
const SCREENSHOT_OCR_HOST_PENDING_LIMIT = 2

function createScreenshotOcrHostTransport() {
  const pending: ScreenshotOcrHostCommand[] = []
  let listener: ((payload: unknown) => void) | undefined
  let evictionTail = Promise.resolve()
  let pendingEvictions = 0
  let flushing = false

  const flushPending = (): void => {
    if (!listener || pendingEvictions > 0 || flushing) return
    flushing = true
    try {
      while (pendingEvictions === 0 && pending.length > 0) {
        const currentListener = listener
        if (!currentListener) break
        const command = pending.shift()
        if (command) currentListener(command)
      }
    } finally {
      flushing = false
    }
  }

  const settleEvicted = (
    type: ScreenshotOcrHostCommand['type'],
    sessionId: string,
    generation: number,
  ): void => {
    const token = { sessionId, generation }
    const failure = type === 'recognize'
      ? { ...token, status: 'failure' as const, code: 'OCR_UNAVAILABLE' as const }
      : undefined
    pendingEvictions += 1
    const cleanup = async (): Promise<void> => {
      if (failure) {
        try { await ipcRenderer.invoke(IPC_CHANNELS.submitScreenshotOcr, failure) } catch { /* exact settlement still follows */ }
      }
      try { await ipcRenderer.invoke(IPC_CHANNELS.settleScreenshotOcr, token) } catch { /* main still owns its deadline */ }
    }
    evictionTail = evictionTail
      .then(cleanup, cleanup)
      .finally(() => {
        pendingEvictions -= 1
        flushPending()
      })
      .catch(() => undefined)
  }

  const enqueue = (command: ScreenshotOcrHostCommand): void => {
    pending.push(command)
    while (pending.length > SCREENSHOT_OCR_HOST_PENDING_LIMIT) {
      const evicted = pending.shift()
      if (evicted) settleEvicted(evicted.type, evicted.sessionId, evicted.generation)
    }
  }

  ipcRenderer.on(SCREENSHOT_OCR_HOST_EVENT_CHANNEL, (_event: IpcRendererEvent, payload: unknown) => {
    const command = parseScreenshotOcrHostCommand(payload)
    if (!command) return
    if (listener && pendingEvictions === 0 && pending.length === 0 && !flushing) listener(command)
    else enqueue(command)
  })
  return {
    subscribe(next: (payload: unknown) => void) {
      listener = next
      flushPending()
      return () => { if (listener === next) listener = undefined }
    },
  }
}

const screenshotOcrHostTransport = createScreenshotOcrHostTransport()

const stickyNoteMaterialEffectsTransport = createStickyNoteMaterialEffectsTransport((emit) => {
  const onEffects = (_event: IpcRendererEvent, payload: unknown) => emit(payload)
  ipcRenderer.on(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, onEffects)
  return () => { ipcRenderer.removeListener(STICKY_NOTE_MATERIAL_EFFECTS_CHANNEL, onEffects) }
})
window.addEventListener('unload', () => stickyNoteMaterialEffectsTransport.dispose(), { once: true })

const closePreparation = createClosePreparationBridge({ transport: {
  subscribe(listener) {
    const receive = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(CLOSE_PREPARATION_CHANNELS.request, receive)
    return () => ipcRenderer.removeListener(CLOSE_PREPARATION_CHANNELS.request, receive)
  },
  send: event => ipcRenderer.send(CLOSE_PREPARATION_CHANNELS.event, event),
} })
window.addEventListener('unload', () => closePreparation.dispose(), { once: true })
const api = createArkdownApi(
  (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  {
    subscribe(listener) {
      const onRequest = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
      ipcRenderer.on(CLOSE_CHANNELS.prepare, onRequest)
      return () => ipcRenderer.removeListener(CLOSE_CHANNELS.prepare, onRequest)
    },
    heartbeat(heartbeat: ClosePreparationHeartbeat) {
      ipcRenderer.send(CLOSE_CHANNELS.heartbeat, heartbeat)
    },
    respond(response: ClosePreparationResponse) {
      ipcRenderer.send(CLOSE_CHANNELS.response, response)
    },
  },
  (file) => webUtils.getPathForFile(file),
  {
    subscribe(listener) {
      const onCommand = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
      ipcRenderer.on(MENU_COMMAND_CHANNEL, onCommand)
      return () => ipcRenderer.removeListener(MENU_COMMAND_CHANNEL, onCommand)
    },
  },
  openIntentTransport,
  recoveryTransport,
  importDocxTransport,
  translationTransport,
  stickyNoteTransport,
  stickyNoteTransport,
  stickyNoteContextMenuShowTransport,
  stickyNoteContextMenuCommandTransport,
  stickyNoteContextMenuClosedTransport,
  stickyNoteContextMenuResetTransport,
  applicationMenuChangedTransport,
  editorAppearanceChangedTransport,
  layoutPreferencesChangedTransport,
  windowStateChangedTransport,
  screenshotTransport,
  screenshotResultTransport,
  screenshotOcrModelStateTransport,
  screenshotOcrHostTransport,
  documentConversionComponentStateTransport,
  aiConversationTransport,
  aiRendererPorts,
  backgroundPresentationTransport,
  stickyNoteMaterialEffectsTransport,
  bufferedIpcTransport(MODEL_CAPABILITY_RULES_CHANGED),
  bufferedIpcTransport(SHORTCUTS_CHANGED_CHANNEL),
  bufferedIpcTransport(WINDOW_CHANNELS.documentLocation),
  {
    onPrepareCloseStructured: handler => closePreparation.setHandler(handler),
    onClosePreparationReleased: handler => {
      const receive = (_event: IpcRendererEvent, payload: unknown) => {
        const attempt = parseClosePreparationAttempt(payload)
        if (attempt) handler(attempt)
      }
      ipcRenderer.on(CLOSE_PREPARATION_CHANNELS.released, receive)
      return () => ipcRenderer.removeListener(CLOSE_PREPARATION_CHANNELS.released, receive)
    },
  },
  bufferedIpcTransport(APP_UPDATE_CHANGED),
)

contextBridge.exposeInMainWorld('arkdown', api)
contextBridge.exposeInMainWorld('arkdownMessage', createBusinessMessageApi({
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
}))
contextBridge.exposeInMainWorld('arkdownClose', createCloseRecoveryApi({
  invoke: (channel, input) => ipcRenderer.invoke(channel, input),
  subscribe: (channel, handler) => {
    const receive = (_event: IpcRendererEvent, payload: unknown) => handler(payload)
    ipcRenderer.on(channel, receive)
    return () => ipcRenderer.removeListener(channel, receive)
  },
}))
contextBridge.exposeInMainWorld('arknoteBoxTheme', createArknoteBoxThemeApi(ipcRenderer))
