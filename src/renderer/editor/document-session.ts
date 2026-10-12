import type { DocumentSnapshot, ImportedDocx } from '../../shared/contracts'
import type { ConvertedDocument } from '../../shared/document-conversion'

export type DocumentPersistenceKind =
  | 'imported-docx'
  | 'saved-document'
  | 'unsaved-document'

export interface DocumentSession {
  status: 'idle' | 'loading' | 'ready' | 'draft-saving' | 'draft-saved' | 'saving' | 'error' | 'conflict'
  relativePath: string | null
  sourceRelativePath: string | null
  sourceFormat?: string | null
  displayName: string | null
  readonly persistenceKind: DocumentPersistenceKind
  openingMarkdown: string
  markdown: string
  savedMarkdown: string
  draftMarkdown: string
  revision: string | null
  encoding: DocumentSnapshot['encoding']
  newline: DocumentSnapshot['newline']
  mtimeMs: number | null
  error: string | null
  recovered: boolean
  hasSavedThisOpen: boolean
}

export type PersistenceOutcome =
  | { status: 'clean' | 'saved' | 'discarded' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }

export const EMPTY_SESSION: DocumentSession = {
  status: 'ready',
  relativePath: null,
  sourceRelativePath: null,
  displayName: null,
  persistenceKind: 'unsaved-document',
  openingMarkdown: '',
  markdown: '',
  savedMarkdown: '',
  draftMarkdown: '',
  revision: null,
  encoding: 'utf8',
  newline: 'lf',
  mtimeMs: null,
  error: null,
  recovered: false,
  hasSavedThisOpen: false,
}

export type DocumentAction =
  | { type: 'loading' }
  | { type: 'loaded'; snapshot: DocumentSnapshot }
  | { type: 'saved-as'; snapshot: DocumentSnapshot; openingMarkdown: string }
  | { type: 'imported'; imported: ImportedDocx; sourceRelativePath?: string | null }
  | { type: 'converted'; converted: ConvertedDocument }
  | { type: 'recovered'; snapshot: DocumentSnapshot | null; markdown: string; conflict: boolean }
  | { type: 'open-superseded' }
  | { type: 'cleared' }
  | { type: 'changed'; markdown: string }
  | { type: 'display-name-changed'; displayName: string }
  | { type: 'renamed'; relativePath: string }
  | { type: 'draft-saving' }
  | { type: 'draft-saved'; markdown: string }
  | { type: 'draft-ended' }
  | { type: 'draft-finalized' }
  | { type: 'saving' }
  | { type: 'persistence-cancelled' }
  | { type: 'saved'; markdown: string; persistedMarkdown?: string; revision: string; mtimeMs: number }
  | { type: 'exported'; markdown: string }
  | { type: 'discarded'; markdown?: string }
  | { type: 'failed'; message: string; conflict: boolean }

export function documentSessionReducer(
  state: DocumentSession,
  action: DocumentAction,
): DocumentSession {
  switch (action.type) {
    case 'loading':
      return { ...state, status: 'loading', error: null }
    case 'loaded':
      return {
        status: 'ready',
        ...action.snapshot,
        sourceRelativePath: null,
        displayName: null,
        persistenceKind: 'saved-document',
        openingMarkdown: action.snapshot.markdown,
        savedMarkdown: action.snapshot.markdown,
        draftMarkdown: action.snapshot.markdown,
        error: null,
        recovered: false,
        hasSavedThisOpen: false,
      }
    case 'recovered': {
      const source = action.snapshot
      return {
        status: action.conflict ? 'conflict' : 'draft-saved',
        relativePath: source?.relativePath ?? null,
        sourceRelativePath: null,
        displayName: source?.relativePath.split('/').at(-1) ?? null,
        persistenceKind: source ? 'saved-document' : 'unsaved-document',
        openingMarkdown: source?.markdown ?? '',
        markdown: action.markdown,
        savedMarkdown: source?.markdown ?? '',
        draftMarkdown: action.markdown,
        revision: source?.revision ?? null,
        encoding: source?.encoding ?? 'utf8',
        newline: source?.newline ?? 'lf',
        mtimeMs: source?.mtimeMs ?? null,
        error: action.conflict ? '原文件已在草稿创建后发生变化' : null,
        recovered: action.conflict || action.markdown !== (source?.markdown ?? ''),
        hasSavedThisOpen: false,
      }
    }
    case 'imported':
      return {
        status: 'ready',
        relativePath: null,
        sourceRelativePath: action.sourceRelativePath ?? null,
        sourceFormat: 'docx',
        displayName: action.imported.sourceFileName,
        persistenceKind: 'imported-docx',
        openingMarkdown: action.imported.markdown,
        markdown: action.imported.markdown,
        savedMarkdown: action.imported.markdown,
        draftMarkdown: action.imported.markdown,
        revision: null,
        encoding: 'utf8',
        newline: 'lf',
        mtimeMs: null,
        error: null,
        recovered: false,
        hasSavedThisOpen: false,
      }
    case 'converted': {
      const sourceName = action.converted.source.fileName
      const finalDot = sourceName.lastIndexOf('.')
      const sourceBase = finalDot > 0 ? sourceName.slice(0, finalDot) : sourceName
      return {
        status: 'ready',
        relativePath: null,
        sourceRelativePath: null,
        sourceFormat: action.converted.source.format,
        displayName: `${sourceBase}.md`,
        persistenceKind: 'unsaved-document',
        openingMarkdown: '',
        markdown: action.converted.markdown,
        savedMarkdown: '',
        draftMarkdown: '',
        revision: null,
        encoding: 'utf8',
        newline: 'lf',
        mtimeMs: null,
        error: null,
        recovered: false,
        hasSavedThisOpen: false,
      }
    }
    case 'open-superseded':
      return state.status === 'loading' ? { ...state, status: 'ready' } : state
    case 'saved-as':
      return {
        status: 'ready',
        ...action.snapshot,
        ...(state.sourceFormat ? { sourceFormat: state.sourceFormat } : {}),
        sourceRelativePath: null,
        displayName: null,
        persistenceKind: 'saved-document',
        openingMarkdown: action.openingMarkdown,
        savedMarkdown: action.snapshot.markdown,
        draftMarkdown: action.snapshot.markdown,
        error: null,
        recovered: false,
        hasSavedThisOpen: true,
      }
    case 'cleared':
      return EMPTY_SESSION
    case 'changed':
      return {
        ...state,
        status: state.status === 'conflict' || state.status === 'saving'
          || state.status === 'draft-saving'
          ? state.status
          : 'ready',
        markdown: action.markdown,
        error: state.status === 'conflict' ? state.error : null,
      }
    case 'display-name-changed':
      return { ...state, displayName: action.displayName, error: null }
    case 'renamed':
      return {
        ...state,
        relativePath: action.relativePath,
        sourceRelativePath: null,
        displayName: null,
        error: null,
      }
    case 'draft-saving':
      return { ...state, status: state.status === 'conflict' ? 'conflict' : 'draft-saving', error: state.status === 'conflict' ? state.error : null }
    case 'draft-saved':
      return { ...state, status: state.status === 'conflict' ? 'conflict' : 'draft-saved', draftMarkdown: action.markdown, error: state.status === 'conflict' ? state.error : null }
    case 'draft-ended':
      return { ...state, status: state.status === 'conflict' ? 'conflict' : 'ready', draftMarkdown: state.savedMarkdown,
        error: state.status === 'conflict' ? state.error : null }
    case 'draft-finalized':
      return { ...state, status: state.status === 'conflict' ? 'conflict' : 'ready',
        error: state.status === 'conflict' ? state.error : null }
    case 'saving':
      return { ...state, status: 'saving', error: null }
    case 'persistence-cancelled':
      return state.status === 'saving' || state.status === 'draft-saving'
        ? { ...state, status: 'ready', error: null }
        : state
    case 'saved':
      return {
        ...state,
        status: 'ready',
        markdown: state.markdown === action.markdown ? action.persistedMarkdown ?? action.markdown : state.markdown,
        savedMarkdown: action.persistedMarkdown ?? action.markdown,
        draftMarkdown: action.persistedMarkdown ?? action.markdown,
        revision: action.revision,
        mtimeMs: action.mtimeMs,
        error: null,
        recovered: false,
        hasSavedThisOpen: true,
      }
    case 'exported':
      return {
        ...state,
        status: 'ready',
        savedMarkdown: action.markdown,
        draftMarkdown: action.markdown,
        error: null,
        recovered: false,
        hasSavedThisOpen: true,
      }
    case 'discarded': {
      const markdown = action.markdown ?? state.savedMarkdown
      return {
        ...state,
        status: 'ready',
        markdown,
        savedMarkdown: markdown,
        draftMarkdown: markdown,
        error: null,
        recovered: false,
      }
    }
    case 'failed':
      return {
        ...state,
        status: action.conflict || state.status === 'conflict' ? 'conflict' : 'error',
        error: action.message,
      }
  }
}

export function isDirty(state: DocumentSession): boolean {
  return state.recovered || state.markdown !== state.savedMarkdown
}

export function persistenceKind(session: DocumentSession): DocumentPersistenceKind {
  return session.persistenceKind
}
