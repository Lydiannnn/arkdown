import { useCallback, useReducer, useRef } from 'react'
import {
  appendTranslationHistoryRecord,
  compareTranslationHistoryRecords,
  type TranslationHistoryAnchor,
  type TranslationHistoryRecord,
  type TranslationHistoryRecordInput,
  type TranslationHistoryStore,
} from '../editor/translation-history'

interface HistoryState {
  records: readonly TranslationHistoryRecord[]
  selectedRecordId: string | null
}

type HistoryAction =
  | { type: 'finalize'; record: TranslationHistoryRecord }
  | { type: 'select'; recordId: string | null }
  | { type: 'anchor'; recordId: string; anchor: TranslationHistoryAnchor }
  | {
    type: 'identity'
    documentKey: string
    identity: {
      nextDocumentKey: string
      workspaceAbsolutePath: string | null
      documentRelativePath: string | null
      documentAbsolutePath: string | null
      documentRevision: string | null
    }
  }

const EMPTY_HISTORY: HistoryState = { records: [], selectedRecordId: null }

function normalizePath(value: string | null, relative = false): string | null {
  if (value === null) return null
  let normalized = value.replaceAll('\\', '/')
  if (relative) normalized = normalized.replace(/^\/+/, '')
  if (!/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '')
  return normalized || null
}

function normalizeIdentity(identity: {
  workspaceAbsolutePath: string | null
  documentRelativePath: string | null
  documentAbsolutePath: string | null
}) {
  const workspaceAbsolutePath = normalizePath(identity.workspaceAbsolutePath)
  const documentRelativePath = normalizePath(identity.documentRelativePath, true)
  const documentAbsolutePath = workspaceAbsolutePath && documentRelativePath
    ? `${workspaceAbsolutePath}/${documentRelativePath}`
    : normalizePath(identity.documentAbsolutePath)
  return { workspaceAbsolutePath, documentRelativePath, documentAbsolutePath }
}

function reduceHistory(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'finalize') {
    return {
      records: appendTranslationHistoryRecord(state.records, action.record),
      selectedRecordId: action.record.id,
    }
  }
  if (action.type === 'select') return { ...state, selectedRecordId: action.recordId }
  if (action.type === 'anchor') {
    return {
      ...state,
      records: state.records.map((record) => record.id === action.recordId
        ? { ...record, anchor: action.anchor }
        : record),
    }
  }
  const normalized = normalizeIdentity(action.identity)
  return {
    ...state,
    records: state.records.map((record) => record.documentKey === action.documentKey
      ? {
          ...record,
          documentKey: action.identity.nextDocumentKey,
          ...normalized,
          documentRevision: action.identity.documentRevision,
        }
      : record),
  }
}

function defaultCreateId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function orderedRecords(records: readonly TranslationHistoryRecord[]): TranslationHistoryRecord[] {
  return [...records].sort(compareTranslationHistoryRecords)
}

export function useTranslationHistory(options: {
  createId?: () => string
  now?: () => number
} = {}): TranslationHistoryStore {
  const [, dispatch] = useReducer(reduceHistory, EMPTY_HISTORY)
  const stateRef = useRef<HistoryState>(EMPTY_HISTORY)
  const finalizedRequestIdsRef = useRef(new Set<string>())
  const createIdRef = useRef(options.createId ?? defaultCreateId)
  const nowRef = useRef(options.now ?? Date.now)

  const commit = useCallback((action: HistoryAction) => {
    stateRef.current = reduceHistory(stateRef.current, action)
    dispatch(action)
  }, [])

  const finalize = useCallback((input: TranslationHistoryRecordInput) => {
    if (finalizedRequestIdsRef.current.has(input.requestId)) return null
    finalizedRequestIdsRef.current.add(input.requestId)
    const record: TranslationHistoryRecord = {
      ...input,
      ...normalizeIdentity(input),
      id: createIdRef.current(),
      createdAt: nowRef.current(),
    }
    commit({ type: 'finalize', record })
    return record
  }, [commit])

  const selectById = useCallback((recordId: string) => {
    const record = stateRef.current.records.find(({ id }) => id === recordId) ?? null
    if (record) commit({ type: 'select', recordId })
    return record
  }, [commit])

  const selectLatest = useCallback(() => {
    const ordered = orderedRecords(stateRef.current.records)
    const record = ordered.at(-1) ?? null
    if (record) commit({ type: 'select', recordId: record.id })
    return record
  }, [commit])

  const navigate = useCallback((offset: -1 | 1) => {
    const ordered = orderedRecords(stateRef.current.records)
    const index = ordered.findIndex(({ id }) => id === stateRef.current.selectedRecordId)
    if (index < 0) return null
    const record = ordered[index + offset] ?? null
    if (record) commit({ type: 'select', recordId: record.id })
    return record
  }, [commit])

  const updateAnchor = useCallback((recordId: string, anchor: TranslationHistoryAnchor) => {
    commit({ type: 'anchor', recordId, anchor })
  }, [commit])

  const updateDocumentIdentity = useCallback((
    documentKey: string,
    identity: {
      nextDocumentKey: string
      workspaceAbsolutePath: string | null
      documentRelativePath: string | null
      documentAbsolutePath: string | null
      documentRevision: string | null
    },
  ) => {
    commit({ type: 'identity', documentKey, identity })
  }, [commit])

  const storeRef = useRef<TranslationHistoryStore | null>(null)
  if (!storeRef.current) {
    storeRef.current = {
      get records() { return stateRef.current.records },
      get selectedRecordId() { return stateRef.current.selectedRecordId },
      finalize,
      selectLatest,
      selectById,
      selectPrevious: () => navigate(-1),
      selectNext: () => navigate(1),
      updateAnchor,
      updateDocumentIdentity,
    }
  }
  return storeRef.current
}
