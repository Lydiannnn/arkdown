import type { TargetLanguage } from '../../shared/large-model-settings'
import type {
  TranslationEditorMode,
  TranslationSelectionContent,
} from '../../shared/selection-translation'

export type TranslationHistoryTerminal = 'completed' | 'stopped' | 'timeout-partial'

export interface TranslationAnchorFingerprint {
  before: string
  selected: string
  after: string
}

export type TranslationHistoryAnchor =
  | { mode: 'visual'; from: number; to: number; blockStart: number; fingerprint: TranslationAnchorFingerprint; status: 'valid' | 'location-changed' }
  | { mode: 'source'; from: number; to: number; lineStart: number; fingerprint: TranslationAnchorFingerprint; status: 'valid' | 'location-changed' }

export interface TranslationHistoryRecord {
  id: string
  requestId: string
  documentKey: string
  workspaceAbsolutePath: string | null
  documentRelativePath: string | null
  documentAbsolutePath: string | null
  documentRevision: string | null
  mode: TranslationEditorMode
  source: TranslationSelectionContent
  translatedMarkdown: string
  modelId: string
  targetLanguage: Exclude<TargetLanguage, 'auto'>
  terminal: TranslationHistoryTerminal
  createdAt: number
  anchor: TranslationHistoryAnchor
}

export type TranslationHistoryRecordInput = Omit<TranslationHistoryRecord, 'id' | 'createdAt'>

export interface TranslationHistoryStore {
  records: readonly TranslationHistoryRecord[]
  selectedRecordId: string | null
  finalize(input: TranslationHistoryRecordInput): TranslationHistoryRecord | null
  selectLatest(): TranslationHistoryRecord | null
  selectById(recordId: string): TranslationHistoryRecord | null
  selectPrevious(): TranslationHistoryRecord | null
  selectNext(): TranslationHistoryRecord | null
  updateAnchor(recordId: string, anchor: TranslationHistoryAnchor): void
  updateDocumentIdentity(documentKey: string, identity: {
    nextDocumentKey: string
    workspaceAbsolutePath: string | null
    documentRelativePath: string | null
    documentAbsolutePath: string | null
    documentRevision: string | null
  }): void
}

export interface TranslationHistoryAnchorUpdate {
  recordId: string
  anchor: TranslationHistoryAnchor
}

export interface TranslationHistoryEditorPort {
  recordsForDocument(documentKey: string): readonly TranslationHistoryRecord[]
  onAnchorsChanged(documentKey: string, updates: readonly TranslationHistoryAnchorUpdate[]): void
  onOpenRecord(recordId: string): void
}

export type TranslationHistoryRevealAlignment = 'nearest' | 'center'

export interface TranslationHistoryEditorHandle {
  revealTranslationHistoryRecord(
    recordId: string,
    alignment?: TranslationHistoryRevealAlignment,
  ): boolean
  flushTranslationHistoryAnchors(): readonly TranslationHistoryAnchorUpdate[]
  capturePendingTranslationAnchor(pendingKey: string): boolean
  bindPendingTranslationAnchor(pendingKey: string, requestId: string): void
  promotePendingTranslationAnchor(requestId: string): TranslationHistoryAnchor | null
  discardPendingTranslationAnchor(key: string): void
}

export interface TranslationHistoryWindowPort extends TranslationHistoryStore, TranslationHistoryEditorPort {
  openHistory(recordId?: string): void
  closeHistory(): void
}

export const TRANSLATION_HISTORY_LIMIT = 99

export function compareTranslationHistoryRecords(
  left: TranslationHistoryRecord,
  right: TranslationHistoryRecord,
): number {
  return left.createdAt - right.createdAt
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

export function sameTranslationHistoryDocumentKey(left: string, right: string): boolean {
  if (left.startsWith('__untitled__:') || right.startsWith('__untitled__:')) return left === right
  return left.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
    === right.replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
}

export function appendTranslationHistoryRecord(
  records: readonly TranslationHistoryRecord[],
  record: TranslationHistoryRecord,
): readonly TranslationHistoryRecord[] {
  const sameDocument = [
    ...records.filter(({ documentKey }) => (
      sameTranslationHistoryDocumentKey(documentKey, record.documentKey)
    )),
    record,
  ]
    .sort(compareTranslationHistoryRecords)
    .slice(-TRANSLATION_HISTORY_LIMIT)
  const otherDocuments = records.filter(({ documentKey }) => (
    !sameTranslationHistoryDocumentKey(documentKey, record.documentKey)
  ))
  return [...otherDocuments, ...sameDocument].sort(compareTranslationHistoryRecords)
}
