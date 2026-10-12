import { expect, it } from 'vitest'
import type { ConvertedDocument } from '../../src/shared/document-conversion'
import {
  EMPTY_SESSION,
  documentSessionReducer,
  isDirty,
} from '../../src/renderer/editor/document-session'

it('settles cancelled persistence without changing document content or revisions', () => {
  const saving = documentSessionReducer(EMPTY_SESSION, { type: 'saving' })
  expect(documentSessionReducer(saving, { type: 'persistence-cancelled' })).toEqual({
    ...EMPTY_SESSION,
    status: 'ready',
  })
})

const snapshot = {
  relativePath: 'note.md',
  markdown: 'one',
  revision: 'a'.repeat(64),
  encoding: 'utf8' as const,
  newline: 'lf' as const,
  mtimeMs: 1,
}

function converted(fileName: string, format: ConvertedDocument['source']['format']): ConvertedDocument {
  return {
    source: {
      absolutePath: `C:\\notes\\${fileName}`,
      fileName,
      format,
      bytes: 128,
      modifiedAtMs: 1,
    },
    markdown: '# Converted\n\nBody',
    converterVersion: '0.1.7-py3.12.10',
    fingerprint: 'f'.repeat(64),
    warnings: [],
  }
}

it('owns distinct opening, saved, and current Markdown baselines', () => {
  expect(EMPTY_SESSION).toMatchObject({
    openingMarkdown: '',
    savedMarkdown: '',
    markdown: '',
  })

  const loaded = documentSessionReducer(EMPTY_SESSION, { type: 'loaded', snapshot })
  expect(loaded).toMatchObject({
    openingMarkdown: 'one',
    savedMarkdown: 'one',
    markdown: 'one',
  })

  const changed = documentSessionReducer(loaded, { type: 'changed', markdown: 'two' })
  expect(changed).toMatchObject({
    openingMarkdown: 'one',
    savedMarkdown: 'one',
    markdown: 'two',
  })

  const saved = documentSessionReducer(changed, {
    type: 'saved',
    markdown: 'two',
    revision: 'b'.repeat(64),
    mtimeMs: 2,
  })
  expect(saved).toMatchObject({
    openingMarkdown: 'one',
    savedMarkdown: 'two',
    draftMarkdown: 'two',
    markdown: 'two',
  })

  const changedAgain = documentSessionReducer(saved, { type: 'changed', markdown: 'three' })
  expect(documentSessionReducer(changedAgain, { type: 'discarded' })).toMatchObject({
    openingMarkdown: 'one',
    savedMarkdown: 'two',
    markdown: 'two',
  })
  expect(documentSessionReducer(changedAgain, { type: 'cleared' })).toMatchObject({
    openingMarkdown: '',
    savedMarkdown: '',
    markdown: '',
  })
})

it('starts imported and recovered lifetimes with the correct opening baseline', () => {
  const imported = documentSessionReducer(EMPTY_SESSION, {
    type: 'imported',
    imported: {
      sourceAbsolutePath: 'C:\\notes\\report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  })
  expect(imported).toMatchObject({
    openingMarkdown: '# Imported',
    savedMarkdown: '# Imported',
    markdown: '# Imported',
  })

  const recovered = documentSessionReducer(EMPTY_SESSION, {
    type: 'recovered',
    snapshot,
    markdown: 'recovered draft',
    conflict: false,
  })
  expect(recovered).toMatchObject({
    openingMarkdown: 'one',
    savedMarkdown: 'one',
    markdown: 'recovered draft',
  })

  const recoveredWithoutSource = documentSessionReducer(EMPTY_SESSION, {
    type: 'recovered',
    snapshot: null,
    markdown: 'orphan draft',
    conflict: false,
  })
  expect(recoveredWithoutSource).toMatchObject({
    openingMarkdown: '',
    savedMarkdown: '',
    markdown: 'orphan draft',
  })
})

it('preserves opening Markdown through metadata, persistence, and explicit Save As actions', () => {
  const loaded = documentSessionReducer(EMPTY_SESSION, { type: 'loaded', snapshot })
  const changed = documentSessionReducer(loaded, { type: 'changed', markdown: 'two' })
  const metadataActions = [
    { type: 'loading' as const },
    { type: 'display-name-changed' as const, displayName: 'plan.md' },
    { type: 'renamed' as const, relativePath: 'renamed.md' },
    { type: 'draft-saving' as const },
    { type: 'draft-saved' as const, markdown: 'two' },
    { type: 'saving' as const },
    { type: 'failed' as const, message: 'failure', conflict: false },
  ]
  let state = changed
  for (const action of metadataActions) {
    state = documentSessionReducer(state, action)
    expect(state.openingMarkdown).toBe('one')
  }

  const savedAsSnapshot = {
    ...snapshot,
    relativePath: 'saved-as.md',
    markdown: 'two',
    revision: 'c'.repeat(64),
    mtimeMs: 3,
  }
  expect(documentSessionReducer(changed, {
    type: 'saved-as',
    snapshot: savedAsSnapshot,
    openingMarkdown: changed.openingMarkdown,
  })).toMatchObject({
    relativePath: 'saved-as.md',
    openingMarkdown: 'one',
    savedMarkdown: 'two',
    draftMarkdown: 'two',
    markdown: 'two',
    revision: 'c'.repeat(64),
    mtimeMs: 3,
  })
})

it('keeps later edits dirty when an earlier snapshot finishes saving', () => {
  const loaded = documentSessionReducer(EMPTY_SESSION, { type: 'loaded', snapshot })
  const edited = documentSessionReducer(loaded, { type: 'changed', markdown: 'two' })
  const editingAgain = documentSessionReducer(edited, { type: 'changed', markdown: 'three' })
  const saved = documentSessionReducer(editingAgain, {
    type: 'saved',
    markdown: 'two',
    revision: 'b'.repeat(64),
    mtimeMs: 2,
  })

  expect(saved.markdown).toBe('three')
  expect(saved.savedMarkdown).toBe('two')
  expect(saved.revision).toBe('b'.repeat(64))
  expect(saved.mtimeMs).toBe(2)
  expect(isDirty(saved)).toBe(true)
})

it('keeps a conflict active when the user continues editing', () => {
  const loaded = documentSessionReducer(EMPTY_SESSION, { type: 'loaded', snapshot })
  const conflicted = documentSessionReducer(loaded, {
    type: 'failed',
    message: 'changed on disk',
    conflict: true,
  })
  const changed = documentSessionReducer(conflicted, { type: 'changed', markdown: 'mine' })

  expect(changed.status).toBe('conflict')
  expect(changed.error).toBe('changed on disk')
  expect(changed.markdown).toBe('mine')
  expect(isDirty(changed)).toBe(true)
})

it('treats a converted DOCX as a clean imported baseline', () => {
  const imported = documentSessionReducer(EMPTY_SESSION, {
    type: 'imported',
    imported: {
      sourceAbsolutePath: 'C:\\notes\\report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  })

  expect(imported).toMatchObject({
    relativePath: null,
    sourceFormat: 'docx',
    displayName: 'report.docx',
    markdown: '# Imported',
    savedMarkdown: '# Imported',
    draftMarkdown: '# Imported',
    recovered: false,
  })
  expect(isDirty(imported)).toBe(false)
})

it('retains an imported DOCX source format after Save As and rename to Markdown', () => {
  const imported = documentSessionReducer(EMPTY_SESSION, {
    type: 'imported',
    imported: {
      sourceAbsolutePath: 'C:\\notes\\report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  })
  const savedAs = documentSessionReducer(imported, {
    type: 'saved-as',
    openingMarkdown: '# Imported',
    snapshot: {
      relativePath: 'report.md',
      markdown: '# Imported',
      revision: 'a'.repeat(64),
      encoding: 'utf8',
      newline: 'lf',
      mtimeMs: 1,
    },
  })
  const renamed = documentSessionReducer(savedAs, { type: 'renamed', relativePath: 'renamed.md' })

  expect(renamed.sourceFormat).toBe('docx')
})

it.each([
  ['quarter.final.PPTX', 'pptx' as const, 'quarter.final.md'],
  ['book.release.epub', 'epub' as const, 'book.release.md'],
])('creates a dirty ordinary Markdown draft from converted %s', (fileName, format, displayName) => {
  const state = documentSessionReducer(EMPTY_SESSION, {
    type: 'converted',
    converted: converted(fileName, format),
  })

  expect(state).toEqual({
    status: 'ready',
    relativePath: null,
    sourceRelativePath: null,
    sourceFormat: format,
    displayName,
    persistenceKind: 'unsaved-document',
    openingMarkdown: '',
    markdown: '# Converted\n\nBody',
    savedMarkdown: '',
    draftMarkdown: '',
    revision: null,
    encoding: 'utf8',
    newline: 'lf',
    mtimeMs: null,
    error: null,
    recovered: false,
    hasSavedThisOpen: false,
  })
  expect(isDirty(state)).toBe(true)
})

it('supersedes only transient loading without changing the current document', () => {
  const loaded = documentSessionReducer(EMPTY_SESSION, { type: 'loaded', snapshot })
  const edited = documentSessionReducer(loaded, { type: 'changed', markdown: 'two' })
  const loading = documentSessionReducer(edited, { type: 'loading' })

  expect(documentSessionReducer(loading, { type: 'open-superseded' })).toEqual({
    ...loading,
    status: 'ready',
  })
  expect(documentSessionReducer(edited, { type: 'open-superseded' })).toBe(edited)
})


it('remembers a new display name without changing document content state', () => {
  const imported = documentSessionReducer(EMPTY_SESSION, {
    type: 'imported',
    imported: {
      sourceAbsolutePath: 'C:\\notes\\report.docx',
      sourceFileName: 'report.docx',
      markdown: '# Imported',
    },
  })
  const named = documentSessionReducer(imported, {
    type: 'display-name-changed',
    displayName: '计划.md',
  })

  expect(named).toMatchObject({
    relativePath: null,
    displayName: '计划.md',
    markdown: '# Imported',
    savedMarkdown: '# Imported',
    draftMarkdown: '# Imported',
  })
  expect(isDirty(named)).toBe(false)
})

it('rebinds a renamed document path without clearing dirty content', () => {
  const loaded = documentSessionReducer(EMPTY_SESSION, { type: 'loaded', snapshot })
  const edited = documentSessionReducer(loaded, { type: 'changed', markdown: 'two' })
  const renamed = documentSessionReducer(edited, {
    type: 'renamed',
    relativePath: '计划.md',
  })

  expect(renamed).toMatchObject({
    relativePath: '计划.md',
    displayName: null,
    markdown: 'two',
    savedMarkdown: 'one',
    revision: snapshot.revision,
  })
  expect(isDirty(renamed)).toBe(true)
})
