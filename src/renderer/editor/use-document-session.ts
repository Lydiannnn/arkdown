import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useKeyboardShortcuts } from '../settings/use-keyboard-shortcuts'
import { matchesShortcut } from '../../shared/keyboard-shortcuts'
import type {
  ApiResult,
  BeginSaveDocumentAsResult,
  CommitSaveDocumentAsResult,
  DocumentSnapshot,
  ImportedDocx,
} from '../../shared/contracts'
import type { ConvertedDocument } from '../../shared/document-conversion'
import {
  EMPTY_SESSION,
  documentSessionReducer,
  isDirty,
  persistenceKind,
  type DocumentAction,
  type PersistenceOutcome,
  type DocumentSession,
} from './document-session'
import { deriveDocumentSavePresentation } from './document-save-presentation'
import type { BusinessDialogController } from '../modal/BusinessDialogProvider'
import type { ClosePreparationResult, ClosePreparationStage } from '../../shared/close-preparation'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const NOOP_PREPARE = () => undefined

function newDraftId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  const tail = Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${tail}`
}

interface DraftAttempt {
  draftId: string
  relativePath: string | null
  revision: string | null
  markdown: string
  encoding: DocumentSession['encoding']
  newline: DocumentSession['newline']
}

interface PersistenceCoreResult {
  lifecycle: number
  outcome: PersistenceOutcome
}

interface PersistenceCaller {
  requestIsCurrent: () => boolean
  generation: number
}

interface PersistenceFlight {
  lifecycle: number
  generation: number
  phase: 'guarding' | 'saving' | 'complete'
  callers: Set<PersistenceCaller>
  promise: Promise<PersistenceCoreResult>
  confirmation?: TransitionConfirmation
}

export interface TransitionConfirmation {
  title: string
  description: string
  signal?: AbortSignal
  requireSaved?: boolean
}

type SaveAsOutcome =
  | { status: 'saved' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

interface SaveAsResult {
  result: CommitSaveDocumentAsResult | null
  outcome: SaveAsOutcome
}

interface SaveAsFlight {
  lifecycle: number
  generation: number
  intentId: string | null
  settled: boolean
  abortPromise: Promise<void> | null
  promise: Promise<SaveAsResult>
}

export type DocumentOpenResult =
  | { status: 'opened' }
  | { status: 'cancelled' }
  | { status: 'missing' }
  | { status: 'failed'; message: string }

export interface SavedAsTransition {
  result: CommitSaveDocumentAsResult
  openingMarkdown: string
  continuation?: {
    markdown: string
    draftId: string
    draftMarkdown: string
    hasDraft: boolean
    error: string | null
  }
}

export type SaveAsIntentConfirmation = (
  intent: Readonly<BeginSaveDocumentAsResult>,
) => boolean | Promise<boolean>

function draftAttempt(draftId: string, snapshot: DocumentSession): DraftAttempt {
  return {
    draftId,
    relativePath: snapshot.relativePath,
    revision: snapshot.revision,
    markdown: snapshot.markdown,
    encoding: snapshot.encoding,
    newline: snapshot.newline,
  }
}

function isSameDraftAttempt(left: DraftAttempt | null, right: DraftAttempt): boolean {
  return left !== null
    && left.draftId === right.draftId
    && left.relativePath === right.relativePath
    && left.revision === right.revision
    && left.markdown === right.markdown
    && left.encoding === right.encoding
    && left.newline === right.newline
}

const isImportedDocxSession = (session: DocumentSession) => (
  persistenceKind(session) === 'imported-docx'
)

export function useDocumentSession(
  prepare: () => void = NOOP_PREPARE,
  onSavedAs?: (transition: SavedAsTransition) => void | Promise<void>,
  onSaved?: (snapshot: DocumentSession) => void | Promise<void>,
  dialogs?: Pick<BusinessDialogController, 'confirm'>,
  confirmSaveAsIntent?: SaveAsIntentConfirmation,
  onDocumentActivated?: () => void,
  initialContent?: { markdown: string; displayName: string },
) {
  const interactionLockedRef = useRef(false)
  const { snapshot: shortcutSnapshot } = useKeyboardShortcuts()
  const setInteractionLocked = useCallback((locked: boolean) => { interactionLockedRef.current = locked }, [])
  const [state, dispatch] = useReducer(documentSessionReducer, initialContent, (content): DocumentSession => (
    content ? {
      ...EMPTY_SESSION,
      displayName: content.displayName,
      openingMarkdown: content.markdown,
      markdown: content.markdown,
      savedMarkdown: content.markdown,
      draftMarkdown: content.markdown,
    } : EMPTY_SESSION
  ))
  const clipboardAssetsRetainedRef = useRef(false)
  const clipboardPasteSequenceRef = useRef(0)
  const savedClipboardSequenceRef = useRef(0)
  const stateRef = useRef<DocumentSession>(state)
  const prepareRef = useRef(prepare)
  prepareRef.current = prepare
  const onSavedAsRef = useRef(onSavedAs)
  onSavedAsRef.current = onSavedAs
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const confirmSaveAsIntentRef = useRef(confirmSaveAsIntent)
  confirmSaveAsIntentRef.current = confirmSaveAsIntent
  const onDocumentActivatedRef = useRef(onDocumentActivated)
  onDocumentActivatedRef.current = onDocumentActivated
  const mountedRef = useRef(true)
  const persistenceFlightRef = useRef<PersistenceFlight | null>(null)
  const saveAsFlightRef = useRef<SaveAsFlight | null>(null)
  const saveFlightRef = useRef<{
    lifecycle: number
    sequence: number
    promise: Promise<boolean>
    flushLatest: boolean
  } | null>(null)
  const saveSequenceRef = useRef(0)
  const openRequestRef = useRef(0)
  const documentLifecycleRef = useRef(0)
  const documentChangeGenerationRef = useRef(0)
  const documentTransitionGenerationRef = useRef(0)
  const documentIntentGenerationRef = useRef(0)
  const transitionConfirmationAbortRef = useRef<AbortController | null>(null)
  const draftIdRef = useRef(newDraftId())
  const documentExportSessionIdRef = useRef(newDraftId())
  const draftFlightRef = useRef<{
    lifecycle: number
    promise: Promise<boolean>
    flushLatest: boolean
  } | null>(null)
  const dirtySinceRef = useRef<number | null>(null)
  const rejectedDraftRef = useRef<DraftAttempt | null>(null)
  const hasDraftRef = useRef(false)
  const lastBackedUpDraftIdRef = useRef<string | null>(null)
  const endingDraftRef = useRef<{ draftId: string } | null>(null)
  const cleanDraftFlightRef = useRef<{ lifecycle: number; promise: Promise<boolean>; error: string | null } | null>(null)
  const pendingDraftFinalizationRef = useRef(false)
  const finalizationFlightRef = useRef<{ lifecycle: number; promise: Promise<boolean> } | null>(null)
  const persistenceStageRef = useRef<ClosePreparationStage>('settle-document')
  const closeFlightRef = useRef<{
    promise: Promise<ClosePreparationResult>
    enter(stage: ClosePreparationStage): void
    failureCode: 'document-save-failed' | 'draft-end-failed'
  } | null>(null)
  const reportPersistenceStage = useCallback((stage: ClosePreparationStage) => {
    persistenceStageRef.current = stage
    try { closeFlightRef.current?.enter(stage) } catch { /* Feedback never changes persistence. */ }
  }, [])
  const reportDraftEndFailure = useCallback(() => {
    if (closeFlightRef.current) closeFlightRef.current.failureCode = 'draft-end-failed'
  }, [])

  const apply = useCallback((action: DocumentAction) => {
    if (!mountedRef.current) return
    const previous = stateRef.current
    const next = documentSessionReducer(previous, action)
    if (next.markdown !== previous.markdown) documentChangeGenerationRef.current += 1
    stateRef.current = next
    dispatch(action)
  }, [])

  const sameLifetime = useCallback((lifecycle: number) => (
    mountedRef.current && documentLifecycleRef.current === lifecycle
  ), [])

  const beginDocumentLifecycle = useCallback((savedAs = false) => {
    if (!savedAs) {
      documentIntentGenerationRef.current += 1
      transitionConfirmationAbortRef.current?.abort()
    }
    clipboardAssetsRetainedRef.current = false
    clipboardPasteSequenceRef.current = 0
    savedClipboardSequenceRef.current = 0
    documentLifecycleRef.current += 1
    documentChangeGenerationRef.current += 1
    documentTransitionGenerationRef.current += 1
    documentExportSessionIdRef.current = newDraftId()
    persistenceFlightRef.current = null
    saveFlightRef.current = null
    draftFlightRef.current = null
    hasDraftRef.current = false
    lastBackedUpDraftIdRef.current = null
    endingDraftRef.current = null
    cleanDraftFlightRef.current = null
    pendingDraftFinalizationRef.current = false
    finalizationFlightRef.current = null
    onDocumentActivatedRef.current?.()
  }, [])

  const getDocumentChangeGeneration = useCallback(
    () => documentChangeGenerationRef.current,
    [],
  )

  const getDocumentLifecycle = useCallback(
    () => documentLifecycleRef.current,
    [],
  )

  const getDocumentTransitionGeneration = useCallback(
    () => documentTransitionGenerationRef.current,
    [],
  )

  const beginDocumentTransition = useCallback(() => {
    documentIntentGenerationRef.current += 1
    transitionConfirmationAbortRef.current?.abort()
    documentTransitionGenerationRef.current += 1
  }, [])

  const retryDraftFinalization = useCallback((): Promise<boolean> => {
    const lifecycle = documentLifecycleRef.current
    if (!pendingDraftFinalizationRef.current) return Promise.resolve(true)
    const existing = finalizationFlightRef.current
    if (existing?.lifecycle === lifecycle) return existing.promise
    const slot = { lifecycle, promise: null as unknown as Promise<boolean> }
    slot.promise = (async () => {
      try {
        if (!window.arkdown.retryDraftFinalization) throw new Error('草稿结束重试不可用')
        const result = await window.arkdown.retryDraftFinalization()
        if (!sameLifetime(lifecycle)) return false
        if (!result.ok) throw new Error(result.error.message)
        pendingDraftFinalizationRef.current = false
        apply({ type: 'draft-finalized' })
        return true
      } catch (error) {
        if (sameLifetime(lifecycle)) apply({ type: 'failed', message: `文档已另存，但草稿结束失败：${errorMessage(error)}。请重试保存或关闭。`, conflict: false })
        return false
      } finally {
        if (finalizationFlightRef.current === slot) finalizationFlightRef.current = null
      }
    })()
    finalizationFlightRef.current = slot
    return slot.promise
  }, [apply, sameLifetime])

  const waitForIdleDraftEnd = useCallback(async (lifecycle: number): Promise<boolean> => {
    const flight = cleanDraftFlightRef.current
    if (flight?.lifecycle !== lifecycle) return sameLifetime(lifecycle)
    await flight.promise
    if (!sameLifetime(lifecycle)) return false
    // A successful clean may return false because new text is now dirty. Its
    // explicit failure, rather than that dirty result, decides whether to save.
    if (flight.error) {
      apply({ type: 'failed', message: flight.error, conflict: false })
      return false
    }
    return true
  }, [apply, sameLifetime])

  const backupDraft = useCallback((prepareEditor = false, force = false): Promise<boolean> => {
    const lifecycle = documentLifecycleRef.current
    const valid = () => sameLifetime(lifecycle)
    if (!valid()) return Promise.resolve(false)
    if (endingDraftRef.current?.draftId === draftIdRef.current) return Promise.resolve(false)
    if (prepareEditor) prepareRef.current()
    const existing = draftFlightRef.current
    if (existing?.lifecycle === lifecycle) {
      existing.flushLatest = true
      return existing.promise
    }
    const slot = {
      lifecycle,
      flushLatest: true,
      promise: null as unknown as Promise<boolean>,
    }

    const run = async (): Promise<boolean> => {
      try {
        while (valid() && endingDraftRef.current?.draftId !== draftIdRef.current) {
          slot.flushLatest = false
          const snapshot = stateRef.current
          if (!force && (!isDirty(snapshot) || snapshot.markdown === snapshot.draftMarkdown)) return true
          if (!window.arkdown.saveDraft) return false
          const markdown = snapshot.markdown
          const attempt = draftAttempt(draftIdRef.current, snapshot)
          if (!force && isSameDraftAttempt(rejectedDraftRef.current, attempt)) return false
          apply({ type: 'draft-saving' })
          const result = await window.arkdown.saveDraft({
            draftId: attempt.draftId,
            markdown,
            expectedOriginalRevision: snapshot.revision,
            encoding: snapshot.encoding,
            newline: snapshot.newline,
          })
          if (!valid()) {
            return false
          }
          if (!result.ok) {
            if (result.error.code === 'INVALID_INPUT') rejectedDraftRef.current = attempt
            else {
              // The failed write may have left a recoverable record.
              hasDraftRef.current = true
              lastBackedUpDraftIdRef.current = attempt.draftId
            }
            apply({ type: 'failed', message: result.error.message, conflict: false })
            return false
          }
          rejectedDraftRef.current = null
          hasDraftRef.current = true
          lastBackedUpDraftIdRef.current = attempt.draftId
          apply({ type: 'draft-saved', markdown })
          force = false
          if (endingDraftRef.current?.draftId === attempt.draftId || (!slot.flushLatest && stateRef.current.markdown === markdown)) return true
        }
      } catch (error) {
        if (valid()) apply({ type: 'failed', message: errorMessage(error), conflict: false })
        return false
      }
      return false
    }

    const worker = run()
    slot.promise = worker.then(
      (result) => {
        if (draftFlightRef.current === slot) draftFlightRef.current = null
        return result
      },
      (error) => {
        if (valid()) apply({ type: 'failed', message: errorMessage(error), conflict: false })
        if (draftFlightRef.current === slot) draftFlightRef.current = null
        return false
      },
    )
    draftFlightRef.current = slot
    return slot.promise
  }, [apply, sameLifetime])

  const readClipboardImage = useCallback(async (): Promise<string | null> => {
    if (!window.arkdown.pasteClipboardImage) return null
    const lifecycle = documentLifecycleRef.current
    const draftId = draftIdRef.current
    if (!await backupDraft(false, true)) throw new Error('无法建立图片草稿')
    if (!sameLifetime(lifecycle) || draftIdRef.current !== draftId) return null
    const result = await window.arkdown.pasteClipboardImage({ draftId })
    if (!sameLifetime(lifecycle) || draftIdRef.current !== draftId) return null
    if (!result.ok) throw new Error(result.error.message)
    if (result.value) clipboardPasteSequenceRef.current += 1
    return result.value
  }, [backupDraft, sameLifetime])

  const persist = useCallback(async (slot: {
    lifecycle: number
    flushLatest: boolean
  }): Promise<boolean> => {
    const lifecycle = slot.lifecycle
    const valid = () => sameLifetime(lifecycle)
    if (!valid()) return false
    prepareRef.current()

    const current = stateRef.current
    if (current.status === 'conflict') {
      return false
    }
    const dirty = isDirty(current)
    if (!current.relativePath || !current.revision) {
      return !dirty
    }
    if (!dirty && clipboardPasteSequenceRef.current === savedClipboardSequenceRef.current) {
      return true
    }

    try {
        while (valid()) {
          const shouldFlush = slot.flushLatest
          slot.flushLatest = false
          if (shouldFlush) prepareRef.current()
          const snapshot = stateRef.current
          if (snapshot.status === 'conflict') {
            return false
          }
          if (!snapshot.relativePath || !snapshot.revision || (!isDirty(snapshot) && clipboardPasteSequenceRef.current === savedClipboardSequenceRef.current)) {
            return true
          }

          const markdown = snapshot.markdown
          const clipboardSequence = clipboardPasteSequenceRef.current
          apply({ type: 'saving' })
          const result = await window.arkdown.saveDocument({
            relativePath: snapshot.relativePath,
            markdown,
            expectedRevision: snapshot.revision,
            encoding: snapshot.encoding,
            newline: snapshot.newline,
          })

          if (!valid()) {
            return false
          }
          if (!result.ok) {
            apply({
              type: 'failed',
              message: result.error.message,
              conflict: result.error.code === 'DOCUMENT_CONFLICT',
            })
            return false
          }

          clipboardAssetsRetainedRef.current = result.value.clipboardAssetsRetained === true
          savedClipboardSequenceRef.current = clipboardSequence
          apply({ type: 'saved', markdown, persistedMarkdown: result.value.markdown, revision: result.value.revision, mtimeMs: result.value.mtimeMs })
          if (result.value.draftEndPending) {
            savedClipboardSequenceRef.current = -1
            apply({ type: 'failed', message: '正文已保存，但草稿结束失败。请重试保存或关闭。', conflict: false })
            return false
          }
          if (!valid()) return false
          await Promise.resolve(onSavedRef.current?.(stateRef.current))
          if (!valid()) return false
          prepareRef.current()
          if (isDirty(stateRef.current)) {
            slot.flushLatest = true
            continue
          }
          if (!slot.flushLatest) return true
        }
    } catch (error) {
      if (valid()) {
        apply({ type: 'failed', message: errorMessage(error), conflict: false })
      }
      return false
    }
    return false
  }, [apply, sameLifetime])

  const exportImportedDocx = useCallback(async (
    lifecycle: number,
    confirmationAlreadyGranted = false,
  ): Promise<boolean> => {
    const valid = () => sameLifetime(lifecycle)
    if (!valid()) return false
    prepareRef.current()
    const initial = stateRef.current
    if (!isImportedDocxSession(initial)) return false
    if (!dialogs || !window.arkdown.exportDocx) {
      apply({ type: 'failed', message: 'DOCX 导出不可用', conflict: false })
      return false
    }

    try {
      if (!confirmationAlreadyGranted) {
        reportPersistenceStage('await-user')
        const confirmation = await dialogs.confirm({
          title: '是否导出为新的docx文档？',
          description: initial.hasSavedThisOpen
            ? 'Arkdown无法修改原docx文档。\n新的修改内容将保存到刚刚导出的文档。'
            : 'Arkdown无法修改原docx文档。',
          confirmLabel: '导出',
          cancelLabel: '取消',
          actionOrder: 'confirm-cancel',
        }).finally(() => reportPersistenceStage('settle-document'))
        if (!valid()) return false
        if (confirmation !== 'confirm') return false
      }

      prepareRef.current()
      const snapshot = stateRef.current
      if (!isImportedDocxSession(snapshot)) return false
      const markdown = snapshot.markdown
      const suggestedBaseName = (snapshot.displayName ?? '文档.docx')
        .replace(/\.docx$/iu, '') || '文档'
      apply({ type: 'saving' })
      const result = await window.arkdown.exportDocx({
        documentSessionId: documentExportSessionIdRef.current,
        markdown,
        mode: snapshot.hasSavedThisOpen ? 'reuse' : 'choose',
        suggestedBaseName,
      })
      if (!valid()) return false
      if (!result.ok) {
        apply({ type: 'failed', message: result.error.message, conflict: false })
        return false
      }
      if (!result.value) {
        apply({ type: 'persistence-cancelled' })
        return false
      }
      apply({ type: 'exported', markdown })
      await Promise.resolve(onSavedRef.current?.(stateRef.current))
      return valid()
    } catch (error) {
      if (valid()) apply({ type: 'failed', message: errorMessage(error), conflict: false })
      return false
    }
  }, [apply, dialogs, reportPersistenceStage, sameLifetime])

  const abortSaveAsFlight = useCallback(async (flight: SaveAsFlight): Promise<void> => {
    if (!flight.intentId || flight.settled) return
    if (!flight.abortPromise) {
      const intentId = flight.intentId
      flight.abortPromise = (async () => {
        try {
          await window.arkdown.abortSaveDocumentAs?.(intentId)
        } catch {
          // Best effort: main remains authoritative when renderer ownership disappears.
        } finally {
          flight.settled = true
        }
      })()
    }
    await flight.abortPromise
  }, [])

  const saveAsWithOutcome = useCallback((): Promise<SaveAsResult> => {
    const lifecycle = documentLifecycleRef.current
    const existing = saveAsFlightRef.current
    if (existing?.lifecycle === lifecycle && !existing.settled) return existing.promise
    if (!sameLifetime(lifecycle)) {
      return Promise.resolve({ result: null, outcome: { status: 'cancelled' } })
    }
    prepareRef.current()
    const generation = documentChangeGenerationRef.current
    const flight: SaveAsFlight = {
      lifecycle,
      generation,
      intentId: null,
      settled: false,
      abortPromise: null,
      promise: null as unknown as Promise<SaveAsResult>,
    }
    const isCurrent = () => (
      sameLifetime(flight.lifecycle)
      && documentChangeGenerationRef.current === flight.generation
    )
    const cancelled = (): SaveAsResult => ({
      result: null,
      outcome: { status: 'cancelled' },
    })
    const fail = (message: string): SaveAsResult => {
      if (isCurrent()) apply({ type: 'failed', message, conflict: false })
      return isCurrent()
        ? { result: null, outcome: { status: 'failed', message } }
        : cancelled()
    }
    const run = async (): Promise<SaveAsResult> => {
      if (cleanDraftFlightRef.current?.lifecycle === lifecycle && !await waitForIdleDraftEnd(lifecycle)) return fail(stateRef.current.error ?? '草稿结束失败，请重试。')
      if (!isCurrent()) return cancelled()
      if (pendingDraftFinalizationRef.current && !await retryDraftFinalization()) return fail(stateRef.current.error ?? '草稿结束失败，请重试。')
      if (!isCurrent()) return cancelled()
      if (!window.arkdown.beginSaveDocumentAs
        || !window.arkdown.commitSaveDocumentAs
        || !window.arkdown.abortSaveDocumentAs) return cancelled()
      if (!(await backupDraft(false, true))) {
        if (!isCurrent()) return cancelled()
        return stateRef.current.error
          ? { result: null, outcome: { status: 'failed', message: stateRef.current.error } }
          : cancelled()
      }
      if (!isCurrent()) return cancelled()
      const snapshot = stateRef.current
      let begun: Awaited<ReturnType<NonNullable<typeof window.arkdown.beginSaveDocumentAs>>>
      try {
        reportPersistenceStage('await-user')
        begun = await window.arkdown.beginSaveDocumentAs({
          draftId: draftIdRef.current,
          markdown: snapshot.markdown,
          encoding: snapshot.encoding,
          newline: snapshot.newline,
          suggestedFileName: snapshot.displayName
            ?? snapshot.relativePath?.split('/').at(-1)
            ?? undefined,
        })
      } catch (error) {
        return fail(errorMessage(error))
      } finally { reportPersistenceStage('settle-document') }
      if (!begun.ok) return fail(begun.error.message)
      if (!begun.value) return cancelled()
      flight.intentId = begun.value.intentId
      if (!isCurrent()) {
        await abortSaveAsFlight(flight)
        return cancelled()
      }
      let confirmed = true
      try {
        reportPersistenceStage('await-user')
        confirmed = await Promise.resolve(confirmSaveAsIntentRef.current?.(begun.value) ?? true)
      } catch (error) {
        await abortSaveAsFlight(flight)
        return fail(errorMessage(error))
      } finally { reportPersistenceStage('settle-document') }
      if (!isCurrent() || !confirmed) {
        await abortSaveAsFlight(flight)
        return cancelled()
      }
      let committed: Awaited<ReturnType<NonNullable<typeof window.arkdown.commitSaveDocumentAs>>>
      try {
        committed = await window.arkdown.commitSaveDocumentAs(begun.value.intentId)
      } catch (error) {
        await abortSaveAsFlight(flight)
        return fail(errorMessage(error))
      }
      if (!committed.ok) {
        await abortSaveAsFlight(flight)
        return fail(committed.error.message)
      }
      flight.settled = true
      // The commit has already changed main's destination/AI authority. A text
      // edit can cancel precommit work, but cannot cancel that durable result.
      if (!sameLifetime(flight.lifecycle)) return cancelled()
      let continuationError: string | null = null
      // Visual editors may still hold a buffered change. Flush it while the
      // old lifetime's callback is valid, before applying the destination.
      try { prepareRef.current() } catch (error) { continuationError = errorMessage(error) }
      if (!sameLifetime(flight.lifecycle)) return cancelled()
      const openingMarkdown = snapshot.openingMarkdown
      const newerMarkdown = stateRef.current.markdown !== snapshot.markdown ? stateRef.current.markdown : null
      beginDocumentLifecycle(true)
      pendingDraftFinalizationRef.current = committed.value.draftEndPending === true
      const settledLifecycle = documentLifecycleRef.current
      const settledIsCurrent = () => sameLifetime(settledLifecycle)
      apply({ type: 'saved-as', snapshot: committed.value.document, openingMarkdown })
      if (newerMarkdown !== null) apply({ type: 'changed', markdown: newerMarkdown })
      draftIdRef.current = newDraftId()
      dirtySinceRef.current = null
      // Main retains the old immutable image paths for this live history, and
      // rewrites their copies into this new draft before it reports a backup.
      if (newerMarkdown !== null && !await backupDraft(false, false)) {
        continuationError = stateRef.current.error ?? '文档已另存，但新修改的临时备份失败。请重试。'
      }
      if (!settledIsCurrent()) return cancelled()
      try {
        await Promise.resolve(onSavedRef.current?.(stateRef.current))
        if (!settledIsCurrent()) return cancelled()
        // The backup/onSaved awaits leave the editor usable. Take its last
        // buffered change now, then capture and hand off without another yield.
        // This changes live text only: draftMarkdown remains the actual backup.
        try { prepareRef.current() } catch (error) { continuationError ??= errorMessage(error) }
        if (!settledIsCurrent()) return cancelled()
        const current = stateRef.current
        await Promise.resolve(onSavedAsRef.current?.({ result: committed.value, openingMarkdown,
          ...(current.markdown !== committed.value.document.markdown || hasDraftRef.current || continuationError ? {
            continuation: { markdown: current.markdown, draftId: draftIdRef.current,
              draftMarkdown: current.draftMarkdown, hasDraft: hasDraftRef.current, error: continuationError },
          } : {}),
        }))
      } catch (error) {
        if (!settledIsCurrent()) return cancelled()
        const message = errorMessage(error)
        apply({ type: 'failed', message, conflict: false })
        return { result: null, outcome: { status: 'failed', message } }
      }
      if (!settledIsCurrent()) return cancelled()
      if (continuationError) {
        apply({ type: 'failed', message: continuationError, conflict: false })
        return { result: committed.value, outcome: { status: 'failed', message: continuationError } }
      }
      if (committed.value.draftEndPending) {
        reportDraftEndFailure()
        const message = '文档已另存，但草稿结束失败。请重试保存或关闭。'
        apply({ type: 'failed', message, conflict: false })
        return { result: committed.value, outcome: { status: 'failed', message } }
      }
      return { result: committed.value, outcome: { status: 'saved' } }
    }
    const worker = run()
    flight.promise = worker.finally(() => {
      if (saveAsFlightRef.current === flight) saveAsFlightRef.current = null
    })
    saveAsFlightRef.current = flight
    return flight.promise
  }, [abortSaveAsFlight, apply, backupDraft, beginDocumentLifecycle, reportDraftEndFailure, reportPersistenceStage, retryDraftFinalization, sameLifetime, waitForIdleDraftEnd])

  const saveCurrentDocument = useCallback((docxConfirmationAlreadyGranted = false): Promise<boolean> => {
    const lifecycle = documentLifecycleRef.current
    const isCurrent = () => sameLifetime(lifecycle)
    if (!isCurrent()) return Promise.resolve(false)
    const existing = saveFlightRef.current
    if (existing?.lifecycle === lifecycle) {
      existing.flushLatest = true
      prepareRef.current()
      return existing.promise
    }
    const slot = {
      lifecycle,
      sequence: ++saveSequenceRef.current,
      flushLatest: true,
      promise: null as unknown as Promise<boolean>,
    }
    const run = async (): Promise<boolean> => {
    prepareRef.current()
    const current = stateRef.current
    const importedDocx = isImportedDocxSession(current)
    if (!importedDocx && (!current.relativePath || !current.revision)) {
      return (await saveAsWithOutcome()).outcome.status === 'saved'
    }
    const draftWasInFlight = draftFlightRef.current?.lifecycle === lifecycle
    const draftBackup = backupDraft(false, false)
    if (draftWasInFlight) await draftBackup
    if (!isCurrent()) return false
    const draftId = draftIdRef.current
    if (importedDocx) slot.flushLatest = false
    const originalSave = importedDocx
      ? exportImportedDocx(lifecycle, docxConfirmationAlreadyGranted)
      : persist(slot)
    let saved = await originalSave
    if (!isCurrent()) return false
    await draftBackup
    if (!isCurrent()) return false
    if (slot.flushLatest && isDirty(stateRef.current)) {
      slot.flushLatest = false
      saved = importedDocx
        ? await exportImportedDocx(lifecycle, docxConfirmationAlreadyGranted)
        : await persist(slot)
      if (!isCurrent()) return false
    }
    if (!saved) return false
    if (isDirty(stateRef.current)) return true
    if (clipboardAssetsRetainedRef.current) {
      hasDraftRef.current = false
      dirtySinceRef.current = null
      return true
    }
    if (saveFlightRef.current === slot) saveFlightRef.current = null
    const replacementDraftId = newDraftId()
    if (draftIdRef.current === draftId) draftIdRef.current = replacementDraftId
    const cleanupAuthoritative = () => (
      isCurrent() && saveSequenceRef.current === slot.sequence
    )
    if (window.arkdown.discardDraft) {
      let discarded: Awaited<ReturnType<NonNullable<typeof window.arkdown.discardDraft>>>
      try {
        discarded = await window.arkdown.discardDraft(draftId)
      } catch (error) {
        if (!isCurrent()) return false
        if (!cleanupAuthoritative()) return true
        reportDraftEndFailure()
        if (draftIdRef.current === replacementDraftId) draftIdRef.current = draftId
        apply({ type: 'failed', message: errorMessage(error), conflict: false })
        return false
      }
      if (!isCurrent()) return false
      if (!discarded.ok && cleanupAuthoritative() && draftIdRef.current === replacementDraftId) {
        reportDraftEndFailure()
        draftIdRef.current = draftId
        apply({ type: 'failed', message: `正文已保存，但草稿结束失败：${discarded.error.message}。请重试。`, conflict: false })
        return false
      }
      if (discarded.ok && cleanupAuthoritative() && draftIdRef.current === replacementDraftId
        && lastBackedUpDraftIdRef.current === draftId) hasDraftRef.current = false
    }
    dirtySinceRef.current = null
    return true
    }
    const worker = run()
    slot.promise = worker.then(
      (result) => {
        if (saveFlightRef.current === slot) saveFlightRef.current = null
        return result
      },
      (error) => {
        if (isCurrent()) apply({ type: 'failed', message: errorMessage(error), conflict: false })
        if (saveFlightRef.current === slot) saveFlightRef.current = null
        return false
      },
    )
    saveFlightRef.current = slot
    return slot.promise
  }, [apply, backupDraft, exportImportedDocx, persist, reportDraftEndFailure, sameLifetime, saveAsWithOutcome])

  const endCleanDraft = useCallback((): Promise<boolean> => {
    const lifecycle = documentLifecycleRef.current
    const existing = cleanDraftFlightRef.current
    if (existing?.lifecycle === lifecycle) return existing.promise
    const draftId = draftIdRef.current
    const valid = () => sameLifetime(lifecycle) && draftIdRef.current === draftId
    if (!valid() || isDirty(stateRef.current)) return Promise.resolve(false)
    const slot = { lifecycle, promise: null as unknown as Promise<boolean>, error: null as string | null }
    const fence = { draftId }
    endingDraftRef.current = fence
    slot.promise = (async () => {
      try {
        await draftFlightRef.current?.promise
        if (!valid() || isDirty(stateRef.current)) return false
        if (!hasDraftRef.current) return true
        if (!window.arkdown.cleanDraft) throw new Error('草稿结束不可用，请重试。')
        const result = await window.arkdown.cleanDraft(draftId)
        if (!valid()) return false
        if (!result.ok) {
          slot.error = `草稿结束失败：${result.error.message}。请重试。`
          reportDraftEndFailure()
          apply({ type: 'failed', message: slot.error, conflict: false })
          return false
        }
        hasDraftRef.current = false
        apply({ type: 'draft-ended' })
        return !isDirty(stateRef.current)
      } catch (error) {
        slot.error = `草稿结束失败：${errorMessage(error)}。请重试。`
        reportDraftEndFailure()
        if (valid()) apply({ type: 'failed', message: slot.error, conflict: false })
        return false
      } finally {
        if (endingDraftRef.current === fence) endingDraftRef.current = null
        if (cleanDraftFlightRef.current === slot) cleanDraftFlightRef.current = null
      }
    })()
    cleanDraftFlightRef.current = slot
    return slot.promise
  }, [apply, reportDraftEndFailure, sameLifetime])

  const discard = useCallback(async (
    isCurrent?: () => boolean,
    markdown?: string,
  ): Promise<boolean> => {
    const lifecycle = documentLifecycleRef.current
    const ownsCurrentLifetime = () => (
      sameLifetime(lifecycle) && (isCurrent?.() ?? true)
    )
    if (!ownsCurrentLifetime()) return false
    if (cleanDraftFlightRef.current?.lifecycle === lifecycle) {
      await cleanDraftFlightRef.current.promise
      if (!ownsCurrentLifetime()) return false
    }
    const draftId = draftIdRef.current
    const generation = documentChangeGenerationRef.current
    const sameDraft = () => sameLifetime(lifecycle) && draftIdRef.current === draftId
    const fence = { draftId }
    endingDraftRef.current = fence
    try {
      await draftFlightRef.current?.promise
      if (!ownsCurrentLifetime() || !sameDraft()) return false
      if (hasDraftRef.current && !window.arkdown.discardDraft) {
        reportDraftEndFailure()
        apply({ type: 'failed', message: '草稿结束不可用，请重试。', conflict: false })
        return false
      }
      if (hasDraftRef.current && window.arkdown.discardDraft) {
        const result = await window.arkdown.discardDraft(draftId)
        if (!sameDraft()) return false
        if (!result.ok) {
          reportDraftEndFailure()
          apply({ type: 'failed', message: `草稿结束失败：${result.error.message}。请重试。`, conflict: false })
          return false
        }
      }
      // Main's durable result belongs to this document even when the open
      // request that initiated it has become obsolete. Preserve its current
      // text but never keep backing up to an id main has already ended.
      hasDraftRef.current = false
      lastBackedUpDraftIdRef.current = null
      rejectedDraftRef.current = null
      draftIdRef.current = newDraftId()
      if (!ownsCurrentLifetime() || generation !== documentChangeGenerationRef.current) {
        apply({ type: 'draft-ended' })
        return false
      }
      apply({ type: 'discarded', markdown })
      dirtySinceRef.current = null
      return true
    } catch (error) {
      reportDraftEndFailure()
      if (sameDraft()) apply({ type: 'failed', message: errorMessage(error), conflict: false })
      return false
    } finally {
      if (endingDraftRef.current === fence) endingDraftRef.current = null
    }
  }, [apply, reportDraftEndFailure, sameLifetime])

  const runPersistenceCore = useCallback(async (
    lifecycle: number,
    reason: 'save' | 'transition',
    flight: PersistenceFlight,
  ): Promise<PersistenceCoreResult> => {
    const coreIsCurrent = () => (
      sameLifetime(lifecycle)
      && [...flight.callers].some((caller) => caller.requestIsCurrent())
    )
    const settle = (
      outcome: PersistenceOutcome,
      settledLifecycle = lifecycle,
    ): PersistenceCoreResult => {
      flight.phase = 'complete'
      return { lifecycle: settledLifecycle, outcome }
    }
    if (!coreIsCurrent()) return settle({ status: 'cancelled' })
    if (cleanDraftFlightRef.current?.lifecycle === lifecycle && !await waitForIdleDraftEnd(lifecycle)) {
      reportDraftEndFailure()
      return settle({ status: 'failed', message: stateRef.current.error ?? '草稿结束失败，请重试。' })
    }
    if (!coreIsCurrent()) return settle({ status: 'cancelled' })
    if (pendingDraftFinalizationRef.current && !await retryDraftFinalization()) {
      reportDraftEndFailure()
      return settle({ status: 'failed', message: stateRef.current.error ?? '草稿结束失败，请重试。' })
    }
    if (!coreIsCurrent()) return settle({ status: 'cancelled' })
    const current = stateRef.current
    if (current.status === 'conflict') {
      if (reason !== 'transition' || !dialogs) {
        return settle({ status: 'failed', message: current.error ?? 'Document has a save conflict.' })
      }
      const generation = documentChangeGenerationRef.current
      let decision: Awaited<ReturnType<BusinessDialogController['confirm']>>
      try {
        reportPersistenceStage('await-user')
        decision = await dialogs.confirm({
          title: '原文件已发生变化',
          description: flight.confirmation?.requireSaved ? '当前内容与原文件存在冲突。安装更新前请另存为一份文档；也可以取消安装，保留当前编辑内容。'
            : '当前内容与原文件存在冲突，不能直接覆盖保存。可以另存为一份文档；选择“不保存”会放弃当前修改及对应草稿，原文件保持不变。',
          confirmLabel: '另存为', ...(flight.confirmation?.requireSaved ? {} : { discardLabel: '不保存' }), cancelLabel: flight.confirmation?.requireSaved ? '取消安装' : '取消',
          ...(flight.confirmation?.signal ? { signal: flight.confirmation.signal } : {}),
        })
      } finally { reportPersistenceStage('settle-document') }
      if (!coreIsCurrent() || generation !== documentChangeGenerationRef.current || decision === 'cancel') return settle({ status: 'cancelled' })
      if (decision === 'discard') {
        if (flight.confirmation?.requireSaved) return settle({ status: 'cancelled' })
        const discarded = await discard(coreIsCurrent)
        if (!coreIsCurrent()) return settle({ status: 'cancelled' })
        return settle(discarded ? { status: 'discarded' }
          : { status: 'failed', message: stateRef.current.error ?? '草稿结束失败，请重试。' })
      }
      flight.phase = 'saving'
      const result = await saveAsWithOutcome()
      return settle(result.outcome, documentLifecycleRef.current)
    }
    const kind = persistenceKind(current)
    if (reason === 'transition' && !isDirty(current) && !saveFlightRef.current) {
      if (!hasDraftRef.current && !draftFlightRef.current && !cleanDraftFlightRef.current) return settle({ status: 'clean' })
      const ended = window.arkdown.cleanDraft ? await endCleanDraft() : await discard(coreIsCurrent)
      return settle(ended ? { status: 'clean' } : { status: 'failed', message: stateRef.current.error ?? '草稿结束失败，请重试。' })
    }
    if (reason === 'save' && kind === 'saved-document' && !isDirty(current)
      && clipboardPasteSequenceRef.current === savedClipboardSequenceRef.current) {
      if (!hasDraftRef.current && !draftFlightRef.current && !cleanDraftFlightRef.current) return settle({ status: 'clean' })
      const ended = window.arkdown.cleanDraft ? await endCleanDraft() : await discard(coreIsCurrent)
      return settle(ended ? { status: 'clean' } : { status: 'failed', message: stateRef.current.error ?? '草稿结束失败，请重试。' })
    }

    if (reason === 'transition') {
      const draftBackedUp = await backupDraft(false, false)
      if (!coreIsCurrent()) return settle({ status: 'cancelled' })
      if (!dialogs) return settle({ status: 'failed', message: 'Unable to confirm unsaved changes.' })
      const retrySuppressed = !draftBackedUp && isSameDraftAttempt(
        rejectedDraftRef.current,
        draftAttempt(draftIdRef.current, stateRef.current),
      )
      const draftBackupFailure = draftBackedUp
        ? null
        : flight.confirmation?.requireSaved ? '临时草稿备份失败。请先保存内容，或取消安装。'
        : retrySuppressed
          ? '临时草稿备份失败。建议先保存。选择不保存将放弃未保存的修改。'
          : '临时草稿备份失败。建议先保存；也可以取消后重试。选择不保存将放弃未保存的修改。'
      let decision: Awaited<ReturnType<BusinessDialogController['confirm']>>
      try {
        reportPersistenceStage('await-user')
        if (flight.confirmation) {
          const { requireSaved, ...confirmation } = flight.confirmation
          decision = await dialogs.confirm({
            ...confirmation,
            description: draftBackupFailure ? `${flight.confirmation.description}\n${draftBackupFailure}` : flight.confirmation.description,
            confirmLabel: requireSaved ? '保存并继续' : '保存', ...(requireSaved ? {} : { discardLabel: '不保存' }), cancelLabel: requireSaved ? '取消安装' : '取消',
          })
        } else if (kind === 'imported-docx') {
          const exportGuidance = current.hasSavedThisOpen
            ? 'Arkdown无法修改原docx文档。\n新的修改内容将保存到刚刚导出的文档。'
            : 'Arkdown无法修改原docx文档。'
          decision = await dialogs.confirm({
            title: '是否导出为新的docx文档？',
            description: draftBackupFailure
              ? `${exportGuidance}\n${draftBackupFailure}`
              : exportGuidance,
            confirmLabel: '导出',
            discardLabel: '不保存',
            cancelLabel: '取消',
          })
        } else {
          decision = await dialogs.confirm({
            title: `是否保存对“${current.displayName ?? current.relativePath?.split('/').at(-1) ?? '未命名'}”的更改？`,
            description: draftBackupFailure ?? '未保存的内容已备份到临时草稿。',
            confirmLabel: '保存',
            cancelLabel: '取消',
            discardLabel: '不保存',
          })
        }
      } catch (error) {
        if (!coreIsCurrent()) return settle({ status: 'cancelled' })
        return settle({ status: 'failed', message: errorMessage(error) })
      } finally { reportPersistenceStage('settle-document') }
      if (!coreIsCurrent() || decision === 'cancel') return settle({ status: 'cancelled' })
      if (decision === 'discard') {
        if (flight.confirmation?.requireSaved) return settle({ status: 'cancelled' })
        const discarded = await discard(
          coreIsCurrent,
          kind === 'imported-docx' ? current.openingMarkdown : undefined,
        )
        if (!coreIsCurrent()) return settle({ status: 'cancelled' })
        return settle(discarded
          ? { status: 'discarded' }
          : { status: 'failed', message: stateRef.current.error ?? 'Unable to discard changes.' })
      }
    }

    flight.phase = 'saving'
    const saved = await saveCurrentDocument(reason === 'transition' && kind === 'imported-docx')
    if (saved) {
      return settle(
        { status: 'saved' },
        kind === 'unsaved-document' ? documentLifecycleRef.current : lifecycle,
      )
    }
    if (!sameLifetime(lifecycle)) {
      if (kind === 'unsaved-document' && stateRef.current.error) {
        return settle(
          { status: 'failed', message: stateRef.current.error },
          documentLifecycleRef.current,
        )
      }
      return settle({ status: 'cancelled' })
    }
    return settle(stateRef.current.error
      ? { status: 'failed', message: stateRef.current.error }
      : { status: 'cancelled' })
  }, [backupDraft, dialogs, discard, endCleanDraft, reportDraftEndFailure, reportPersistenceStage, retryDraftFinalization, sameLifetime, saveAsWithOutcome, saveCurrentDocument, waitForIdleDraftEnd])

  const persistCurrentDocument = useCallback(async (
    reason: 'save' | 'transition' = 'save',
    requestIsCurrent: () => boolean = () => true,
    confirmation?: TransitionConfirmation,
  ): Promise<PersistenceOutcome> => {
    if (interactionLockedRef.current) return { status: 'cancelled' }
    while (mountedRef.current) {
      const lifecycle = documentLifecycleRef.current
      if (!requestIsCurrent() || !sameLifetime(lifecycle)) return { status: 'cancelled' }
      prepareRef.current()
      if (!requestIsCurrent() || !sameLifetime(lifecycle)) return { status: 'cancelled' }
      const caller: PersistenceCaller = {
        requestIsCurrent,
        generation: documentChangeGenerationRef.current,
      }

      let flight = persistenceFlightRef.current
      const persistenceAlreadyLanded = flight?.phase === 'saving'
        && saveFlightRef.current === null
        && isDirty(stateRef.current)
      if (
        !flight
        || flight.lifecycle !== lifecycle
        || flight.phase === 'complete'
        || (flight.phase === 'guarding' && flight.confirmation !== confirmation)
        || persistenceAlreadyLanded
      ) {
        const slot: PersistenceFlight = {
          lifecycle,
          generation: caller.generation,
          phase: 'guarding',
          callers: new Set([caller]),
          promise: null as unknown as Promise<PersistenceCoreResult>,
          confirmation,
        }
        persistenceFlightRef.current = slot
        slot.promise = runPersistenceCore(lifecycle, reason, slot).then(
          (result) => result,
          (error): PersistenceCoreResult => ({
            lifecycle,
            outcome: { status: 'failed', message: errorMessage(error) },
          }),
        ).then((result) => {
          slot.phase = 'complete'
          if (persistenceFlightRef.current === slot) persistenceFlightRef.current = null
          return result
        })
        flight = slot
      } else {
        flight.callers.add(caller)
      }

      let result: PersistenceCoreResult
      try {
        result = await flight.promise
      } finally {
        flight.callers.delete(caller)
      }
      if (!requestIsCurrent() || !sameLifetime(result.lifecycle)) return { status: 'cancelled' }
      if (
        result.outcome.status === 'saved'
        && caller.generation > flight.generation
        && isImportedDocxSession(stateRef.current)
        && isDirty(stateRef.current)
      ) continue
      return result.outcome
    }
    return { status: 'cancelled' }
  }, [runPersistenceCore, sameLifetime])

  const save = useCallback(async (): Promise<boolean> => {
    if (interactionLockedRef.current) return false
    const outcome = await persistCurrentDocument()
    return outcome.status === 'saved' || outcome.status === 'clean'
  }, [persistCurrentDocument])

  const saveAs = useCallback(async (): Promise<CommitSaveDocumentAsResult | null> => {
    if (interactionLockedRef.current) return null
    if (isImportedDocxSession(stateRef.current)) {
      await persistCurrentDocument()
      return null
    }
    return (await saveAsWithOutcome()).result
  }, [persistCurrentDocument, saveAsWithOutcome])

  const transitionAfterSave = useCallback(async (
    transition: () => void | Promise<void>,
    isOwnerCurrent: () => boolean = () => true,
    confirmation?: TransitionConfirmation,
  ): Promise<boolean> => {
    if (interactionLockedRef.current) return false
    beginDocumentTransition()
    const intent = documentIntentGenerationRef.current
    const abort = confirmation ? new AbortController() : null
    const cancel = () => abort?.abort()
    if (abort) transitionConfirmationAbortRef.current = abort
    confirmation?.signal?.addEventListener('abort', cancel, { once: true })
    if (confirmation?.signal?.aborted) cancel()
    const guardedConfirmation = confirmation ? { ...confirmation, signal: abort!.signal } : undefined
    const ownerIsCurrent = () => mountedRef.current && isOwnerCurrent()
      && (!confirmation || (documentIntentGenerationRef.current === intent && !abort?.signal.aborted))
    try {
      while (ownerIsCurrent()) {
        prepareRef.current()
        if (!ownerIsCurrent()) return false
        if (!isDirty(stateRef.current) && !persistenceFlightRef.current && !saveFlightRef.current
          && !pendingDraftFinalizationRef.current && !hasDraftRef.current && !draftFlightRef.current && !cleanDraftFlightRef.current) {
          await transition()
          return ownerIsCurrent()
        }
        const outcome = await persistCurrentDocument('transition', ownerIsCurrent, guardedConfirmation)
        if (!ownerIsCurrent()) return false
        if (outcome.status === 'cancelled' || outcome.status === 'failed') return false
        if (outcome.status === 'saved') {
          await Promise.resolve()
          continue
        }
        await transition()
        return ownerIsCurrent()
      }
      return false
    } finally {
      confirmation?.signal?.removeEventListener('abort', cancel)
      if (transitionConfirmationAbortRef.current === abort) transitionConfirmationAbortRef.current = null
    }
  }, [beginDocumentTransition, persistCurrentDocument])

  /** Join the existing persistence owner; a timer or repeated close never starts another save. */
  const prepareForClose = useCallback((enter: (stage: ClosePreparationStage) => void, options?: { requireSaved?: boolean }): Promise<ClosePreparationResult> => {
    if (options?.requireSaved && (persistenceFlightRef.current || saveFlightRef.current || saveAsFlightRef.current || closeFlightRef.current)) return Promise.resolve({ status: 'cancelled' })
    if (closeFlightRef.current) return closeFlightRef.current.promise
    const slot = { enter, failureCode: 'document-save-failed' as 'document-save-failed' | 'draft-end-failed',
      promise: null as unknown as Promise<ClosePreparationResult> }
    closeFlightRef.current = slot
    slot.promise = (async (): Promise<ClosePreparationResult> => {
      if (interactionLockedRef.current || !mountedRef.current) return { status: 'cancelled' }
      try {
        // Preserve a real dialog already owned by an earlier save.
        const previousStage = persistenceStageRef.current
        const hasPersistence = Boolean(persistenceFlightRef.current || saveFlightRef.current || saveAsFlightRef.current)
        reportPersistenceStage('prepare-editor')
        beginDocumentTransition()
        while (mountedRef.current) {
          prepareRef.current()
          if (!isDirty(stateRef.current) && !persistenceFlightRef.current && !saveFlightRef.current
            && !saveAsFlightRef.current && !pendingDraftFinalizationRef.current && !hasDraftRef.current
            && !draftFlightRef.current && !cleanDraftFlightRef.current) {
            interactionLockedRef.current = true
            return { status: 'ready' }
          }
          reportPersistenceStage(hasPersistence && persistenceStageRef.current === 'prepare-editor'
            ? previousStage : 'settle-document')
          const current = stateRef.current
          const outcome = await persistCurrentDocument('transition', () => mountedRef.current, options?.requireSaved ? {
            title: `安装更新前，保存“${current.displayName ?? current.relativePath?.split('/').at(-1) ?? '未命名'}”`,
            description: persistenceKind(current) === 'imported-docx' ? '修改将导出为文档。取消保存将取消本次安装。' : '保存成功后将关闭此窗口，并继续检查其他文档。取消保存将取消本次安装。',
            requireSaved: true,
          } : undefined)
          if (!mountedRef.current || outcome.status === 'cancelled') return { status: 'cancelled' }
          if (outcome.status === 'failed') return { status: 'failed', code: slot.failureCode }
          // A late edit, draft backup or Save As handoff must be checked again.
          await Promise.resolve()
        }
        return { status: 'cancelled' }
      } catch { return { status: 'failed', code: slot.failureCode } }
    })().finally(() => { if (closeFlightRef.current === slot) closeFlightRef.current = null })
    return slot.promise
  }, [beginDocumentTransition, persistCurrentDocument, reportPersistenceStage])

  const guardOpenTransition = useCallback(async (requestId: number): Promise<
    { status: 'cancelled' } | { status: 'failed'; message: string } | null
  > => {
    const isRequestCurrent = () => (
      mountedRef.current && requestId === openRequestRef.current
    )
    while (isRequestCurrent()) {
      prepareRef.current()
      if (!isDirty(stateRef.current) && !persistenceFlightRef.current && !saveFlightRef.current
        && !pendingDraftFinalizationRef.current && !hasDraftRef.current && !draftFlightRef.current && !cleanDraftFlightRef.current) return null
      const outcome = await persistCurrentDocument('transition', isRequestCurrent)
      if (!isRequestCurrent()) return { status: 'cancelled' }
      if (outcome.status === 'cancelled') return outcome
      if (outcome.status === 'failed') return outcome
      if (outcome.status === 'saved') {
        await Promise.resolve()
        continue
      }
      return null
    }
    return { status: 'cancelled' }
  }, [persistCurrentDocument])

  const open = useCallback(async (relativePath: string): Promise<DocumentOpenResult> => {
    if (interactionLockedRef.current) return { status: 'cancelled' }
    beginDocumentTransition()
    const requestId = ++openRequestRef.current
    if (stateRef.current.relativePath === relativePath) return { status: 'opened' }
    const initialGuard = await guardOpenTransition(requestId)
    if (initialGuard) return initialGuard
    if (!mountedRef.current || requestId !== openRequestRef.current) return { status: 'cancelled' }
    if (stateRef.current.status === 'conflict') {
      return { status: 'failed', message: stateRef.current.error ?? 'Document has a save conflict.' }
    }

    apply({ type: 'loading' })
    let result: ApiResult<DocumentSnapshot>
    try {
      result = await window.arkdown.readDocument(relativePath)
    } catch (error) {
      result = { ok: false, error: { code: 'READ_FAILED', message: errorMessage(error) } }
    }
    if (!mountedRef.current || requestId !== openRequestRef.current) return { status: 'cancelled' }
    if (!result.ok) {
      if (result.error.code === 'FILE_NOT_FOUND') {
        apply({ type: 'failed', message: result.error.message, conflict: false })
        return { status: 'missing' }
      }
      apply({ type: 'failed', message: result.error.message, conflict: false })
      return { status: 'failed', message: result.error.message }
    }
    if ((stateRef.current as DocumentSession).status === 'conflict') {
      return { status: 'failed', message: stateRef.current.error ?? 'Document has a save conflict.' }
    }
    if (isDirty(stateRef.current)) {
      const secondGuard = await guardOpenTransition(requestId)
      if (secondGuard) return secondGuard
    }
    if (!mountedRef.current || requestId !== openRequestRef.current) return { status: 'cancelled' }
    beginDocumentLifecycle()
    apply({ type: 'loaded', snapshot: result.value })
    draftIdRef.current = newDraftId()
    dirtySinceRef.current = null
    return { status: 'opened' }
  }, [apply, beginDocumentLifecycle, beginDocumentTransition, guardOpenTransition])

  const importDocx = useCallback(async (relativePath: string): Promise<void> => {
    const requestId = ++openRequestRef.current
    const ownsRequest = () => mountedRef.current && requestId === openRequestRef.current
    if (!(await transitionAfterSave(async () => {}, ownsRequest))) return
    if (!mountedRef.current || requestId !== openRequestRef.current) return
    if (!window.arkdown.importDocx) {
      apply({ type: 'failed', message: 'DOCX 导入不可用', conflict: false })
      return
    }

    apply({ type: 'loading' })
    try {
      const result = await window.arkdown.importDocx(relativePath)
      if (!mountedRef.current || requestId !== openRequestRef.current) return
      if (!result.ok) {
        apply({ type: 'failed', message: result.error.message, conflict: false })
        return
      }
      beginDocumentLifecycle()
      apply({ type: 'imported', imported: result.value, sourceRelativePath: relativePath })
      draftIdRef.current = newDraftId()
      dirtySinceRef.current = null
    } catch (error) {
      if (mountedRef.current && requestId === openRequestRef.current) {
        apply({ type: 'failed', message: errorMessage(error), conflict: false })
      }
    }
  }, [apply, beginDocumentLifecycle, transitionAfterSave])

  const create = useCallback(async (relativePath: string): Promise<boolean> => {
    const requestId = ++openRequestRef.current
    const ownsRequest = () => mountedRef.current && requestId === openRequestRef.current
    if (!(await transitionAfterSave(async () => {}, ownsRequest))) return false
    if (!mountedRef.current || requestId !== openRequestRef.current) return false
    apply({ type: 'loading' })
    try {
      const result = await window.arkdown.createDocument(relativePath)
      if (!mountedRef.current || requestId !== openRequestRef.current) return false
      if (!result.ok) {
        apply({ type: 'failed', message: result.error.message, conflict: false })
        return false
      }
      beginDocumentLifecycle()
      apply({ type: 'loaded', snapshot: result.value })
      draftIdRef.current = newDraftId()
      dirtySinceRef.current = null
      return true
    } catch (error) {
      if (mountedRef.current && requestId === openRequestRef.current) {
        apply({ type: 'failed', message: errorMessage(error), conflict: false })
      }
      return false
    }
  }, [apply, beginDocumentLifecycle, transitionAfterSave])

  const reload = useCallback(async (): Promise<boolean> => {
    const lifecycle = documentLifecycleRef.current
    const ownsCurrentLifetime = () => sameLifetime(lifecycle)
    prepareRef.current()
    const current = stateRef.current
    const kind = persistenceKind(current)
    const relativePath = kind === 'imported-docx'
      ? current.sourceRelativePath
      : kind === 'saved-document'
        ? current.relativePath
        : null
    if (!relativePath) return false
    const importDocx = kind === 'imported-docx' ? window.arkdown.importDocx : undefined
    if (kind === 'imported-docx' && !importDocx) {
      apply({ type: 'failed', message: 'DOCX 导入不可用', conflict: false })
      return false
    }
    beginDocumentTransition()
    if (isDirty(current) && !(await discard(ownsCurrentLifetime))) return false
    if (!ownsCurrentLifetime()) return false
    const requestId = ++openRequestRef.current
    apply({ type: 'loading' })
    try {
      if (kind === 'imported-docx') {
        const result = await importDocx!(relativePath)
        if (!mountedRef.current || requestId !== openRequestRef.current) return false
        if (!result.ok) {
          apply({ type: 'failed', message: result.error.message, conflict: false })
          return false
        }
        beginDocumentLifecycle()
        apply({ type: 'imported', imported: result.value, sourceRelativePath: relativePath })
      } else {
        const result = await window.arkdown.readDocument(relativePath)
        if (!mountedRef.current || requestId !== openRequestRef.current) return false
        if (!result.ok) {
          apply({ type: 'failed', message: result.error.message, conflict: false })
          return false
        }
        beginDocumentLifecycle()
        apply({ type: 'loaded', snapshot: result.value })
      }
      draftIdRef.current = newDraftId()
      dirtySinceRef.current = null
      return true
    } catch (error) {
      if (mountedRef.current && requestId === openRequestRef.current) {
        apply({ type: 'failed', message: errorMessage(error), conflict: false })
      }
      return false
    }
  }, [apply, beginDocumentLifecycle, beginDocumentTransition, discard, sameLifetime])

  const recover = useCallback((
    draftId: string,
    markdown: string,
    snapshot: DocumentSnapshot | null,
    conflict: boolean,
  ) => {
    openRequestRef.current += 1
    beginDocumentLifecycle()
    draftIdRef.current = draftId
    hasDraftRef.current = true
    lastBackedUpDraftIdRef.current = draftId
    dirtySinceRef.current = Date.now()
    apply({ type: 'recovered', snapshot, markdown, conflict })
  }, [apply, beginDocumentLifecycle])

  const adopt = useCallback((snapshot: DocumentSnapshot) => {
    openRequestRef.current += 1
    beginDocumentLifecycle()
    draftIdRef.current = newDraftId()
    dirtySinceRef.current = null
    apply({ type: 'loaded', snapshot })
  }, [apply, beginDocumentLifecycle])

  const adoptSavedAs = useCallback((transition: SavedAsTransition) => {
    const snapshot = transition.result.document
    if (!snapshot) return false
    openRequestRef.current += 1
    beginDocumentLifecycle()
    pendingDraftFinalizationRef.current = transition.result.draftEndPending === true
    draftIdRef.current = newDraftId()
    dirtySinceRef.current = null
    apply({
      type: 'saved-as',
      snapshot,
      openingMarkdown: transition.openingMarkdown,
    })
    if (transition.continuation) {
      const continuation = transition.continuation
      draftIdRef.current = continuation.draftId
      hasDraftRef.current = continuation.hasDraft
      lastBackedUpDraftIdRef.current = continuation.hasDraft ? continuation.draftId : null
      apply({ type: 'changed', markdown: continuation.markdown })
      apply({ type: 'draft-saved', markdown: continuation.draftMarkdown })
      if (continuation.error) apply({ type: 'failed', message: continuation.error, conflict: false })
    }
    if (pendingDraftFinalizationRef.current && !transition.continuation?.error) apply({ type: 'failed', message: '文档已另存，但草稿结束失败。请重试保存或关闭。', conflict: false })
    return true
  }, [apply, beginDocumentLifecycle])

  const adoptImportedDocx = useCallback((imported: ImportedDocx) => {
    openRequestRef.current += 1
    beginDocumentLifecycle()
    draftIdRef.current = newDraftId()
    dirtySinceRef.current = null
    apply({ type: 'imported', imported })
  }, [apply, beginDocumentLifecycle])

  const supersedePendingOpen = useCallback(() => {
    openRequestRef.current += 1
    apply({ type: 'open-superseded' })
  }, [apply])

  const adoptConverted = useCallback(async (converted: ConvertedDocument): Promise<boolean> => {
    const requestId = ++openRequestRef.current
    const ownsRequest = () => mountedRef.current && requestId === openRequestRef.current
    if (!(await transitionAfterSave(async () => {}, ownsRequest)) || !ownsRequest()) return false
    beginDocumentLifecycle()
    draftIdRef.current = newDraftId()
    dirtySinceRef.current = Date.now()
    apply({ type: 'converted', converted })
    return true
  }, [apply, beginDocumentLifecycle, transitionAfterSave])

  const clear = useCallback(() => {
    openRequestRef.current += 1
    beginDocumentLifecycle()
    draftIdRef.current = newDraftId()
    dirtySinceRef.current = null
    apply({ type: 'cleared' })
  }, [apply, beginDocumentLifecycle])

  const renderedLifecycle = documentLifecycleRef.current
  const change = useCallback((markdown: string) => {
    if (interactionLockedRef.current || !sameLifetime(renderedLifecycle)) return
    apply({ type: 'changed', markdown })
  }, [apply, renderedLifecycle, sameLifetime])

  const setDisplayName = useCallback((displayName: string) => {
    apply({ type: 'display-name-changed', displayName })
  }, [apply])

  const rebindPath = useCallback((relativePath: string) => {
    apply({ type: 'renamed', relativePath })
  }, [apply])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      openRequestRef.current += 1
      const flight = saveAsFlightRef.current
      if (flight) void abortSaveAsFlight(flight)
    }
  }, [abortSaveAsFlight])

  useEffect(() => {
    if (window.arkdown.cleanDraft && !isDirty(state) && (hasDraftRef.current || draftFlightRef.current)
      && !pendingDraftFinalizationRef.current
      && !saveFlightRef.current && !saveAsFlightRef.current && !persistenceFlightRef.current
      && state.status !== 'error' && state.status !== 'loading') void endCleanDraft()
  }, [endCleanDraft, state])

  useEffect(() => {
    if (!isDirty(state)) {
      dirtySinceRef.current = null
      return
    }
    if (state.markdown === state.draftMarkdown || state.status === 'saving' || state.status === 'conflict') return
    if (dirtySinceRef.current === null) dirtySinceRef.current = Date.now()
    const timer = window.setTimeout(() => {
      void backupDraft()
    }, 800)
    return () => window.clearTimeout(timer)
  }, [backupDraft, state])

  useEffect(() => {
    if (!isDirty(state) || state.markdown === state.draftMarkdown) return
    if (dirtySinceRef.current === null) dirtySinceRef.current = Date.now()
    const remaining = Math.max(0, 5_000 - (Date.now() - dirtySinceRef.current))
    const timer = window.setTimeout(() => {
      void backupDraft()
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [backupDraft, state.markdown, state.draftMarkdown])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Electron owns menu accelerators. Keep this fallback only for a browser host.
      if (window.arkdown?.onMenuCommand) return
      if (document.querySelector('[aria-modal="true"]')) return
      const saveKey = matchesShortcut(event, 'file.save', shortcutSnapshot.bindings)
      const saveAsKey = matchesShortcut(event, 'file.save-as', shortcutSnapshot.bindings)
      if (saveKey || saveAsKey) {
        event.preventDefault()
        if (saveAsKey) void saveAs()
        else void save()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save, saveAs, shortcutSnapshot])

  return {
    state,
    setInteractionLocked,
    dirty: isDirty(state),
    savePresentation: deriveDocumentSavePresentation({
      dirty: isDirty(state),
      hasSavedThisOpen: state.hasSavedThisOpen,
    }),
    draftId: draftIdRef.current,
    readClipboardImage,
    documentExportSessionId: documentExportSessionIdRef.current,
    open, importDocx, create, reload,
    recover, adopt, adoptSavedAs, adoptImportedDocx, adoptConverted, supersedePendingOpen, clear,
    change, setDisplayName, rebindPath,
    getDocumentChangeGeneration, getDocumentLifecycle, getDocumentTransitionGeneration,
    persistCurrentDocument,
    save, saveAs, backupDraft, discard, transitionAfterSave, prepareForClose,
  }
}
