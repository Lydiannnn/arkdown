import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type {
  TranslationHistoryAnchor,
  TranslationHistoryRecordInput,
} from '../../src/renderer/editor/translation-history'
import { useTranslationHistory } from '../../src/renderer/app/use-translation-history'

const visualAnchor: TranslationHistoryAnchor = {
  mode: 'visual',
  from: 1,
  to: 9,
  blockStart: 0,
  fingerprint: { before: 'a', selected: 'selected', after: 'z' },
  status: 'valid',
}

function input(
  requestId: string,
  documentKey = 'C:/Notes/note.md',
): TranslationHistoryRecordInput {
  return {
    requestId,
    documentKey,
    workspaceAbsolutePath: 'C:\\Notes\\',
    documentRelativePath: 'folder\\note.md',
    documentAbsolutePath: 'ignored-display-address',
    documentRevision: 'revision-a',
    mode: 'visual',
    source: { markdown: 'selected', plainText: 'selected' },
    translatedMarkdown: 'translated',
    modelId: 'chat-model',
    targetLanguage: 'zh-CN',
    terminal: 'completed',
    anchor: visualAnchor,
  }
}

it('finalizes from the event boundary without a React render-phase update diagnostic', () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    const { result } = renderHook(() => useTranslationHistory({
      createId: () => 'record-a',
      now: () => 100,
    }))

    act(() => { result.current.finalize(input('request-a')) })

    const diagnostics = consoleError.mock.calls.map((args) => args.join(' ')).join('\n')
    expect(diagnostics).not.toMatch(
      /Cannot update a component|Cannot update during an existing state transition/,
    )
  } finally {
    consoleError.mockRestore()
  }
})

it('starts empty, finalizes each request once, and normalizes the guarded document identity', () => {
  const ids = ['record-a', 'record-b']
  const { result } = renderHook(() => useTranslationHistory({
    createId: () => ids.shift()!,
    now: () => 100,
  }))

  expect(result.current.records).toEqual([])
  let first: ReturnType<typeof result.current.finalize> = null
  act(() => {
    first = result.current.finalize(input('request-a'))
    expect(result.current.finalize(input('request-a'))).toBeNull()
  })

  expect(first).toMatchObject({
    id: 'record-a',
    workspaceAbsolutePath: 'C:/Notes',
    documentRelativePath: 'folder/note.md',
    documentAbsolutePath: 'C:/Notes/folder/note.md',
  })
  expect(result.current.records).toHaveLength(1)
})

it('uses injected factories while retaining ninety-nine records per document', () => {
  let nextId = 0
  let nextTime = 0
  const { result } = renderHook(() => useTranslationHistory({
    createId: () => String(++nextId),
    now: () => ++nextTime,
  }))

  act(() => {
    for (let index = 1; index <= 100; index += 1) {
      result.current.finalize(input(`request-a-${index}`, 'document-a'))
    }
    for (let index = 1; index <= 3; index += 1) {
      result.current.finalize(input(`request-b-${index}`, 'document-b'))
    }
  })

  expect(result.current.records.filter(({ documentKey }) => documentKey === 'document-a')).toHaveLength(99)
  expect(result.current.records.filter(({ documentKey }) => documentKey === 'document-b')).toHaveLength(3)
  expect(result.current.records.map(({ id }) => id)).toEqual(
    Array.from({ length: 102 }, (_, index) => String(index + 2)),
  )
  expect(result.current.finalize(input('request-a-1', 'document-a'))).toBeNull()
})

it('navigates by createdAt and id deterministically when timestamps are equal', () => {
  const ids = ['record-b', 'record-a', 'record-c']
  const { result } = renderHook(() => useTranslationHistory({
    createId: () => ids.shift()!,
    now: () => 100,
  }))

  act(() => {
    result.current.finalize(input('request-b'))
    result.current.finalize(input('request-a'))
    result.current.finalize(input('request-c'))
  })
  act(() => { expect(result.current.selectLatest()?.id).toBe('record-c') })
  act(() => { expect(result.current.selectPrevious()?.id).toBe('record-b') })
  act(() => { expect(result.current.selectPrevious()?.id).toBe('record-a') })
  act(() => { expect(result.current.selectNext()?.id).toBe('record-b') })
  act(() => { expect(result.current.selectById('missing')).toBeNull() })
  expect(result.current.selectedRecordId).toBe('record-b')
})

it('publishes the same tuple order when injected clocks move backwards', () => {
  const ids = ['record-z', 'record-b', 'record-a']
  const times = [30, 10, 10]
  const { result } = renderHook(() => useTranslationHistory({
    createId: () => ids.shift()!,
    now: () => times.shift()!,
  }))

  act(() => {
    result.current.finalize(input('request-z'))
    result.current.finalize(input('request-b'))
    result.current.finalize(input('request-a'))
  })

  expect(result.current.records.map(({ id }) => id)).toEqual([
    'record-a',
    'record-b',
    'record-z',
  ])
})

it('updates anchors and Save or Save As identity without touching unrelated documents', () => {
  const { result } = renderHook(() => useTranslationHistory({
    createId: (() => {
      let id = 0
      return () => `record-${++id}`
    })(),
    now: () => 100,
  }))
  act(() => {
    result.current.finalize(input('request-a', 'draft'))
    result.current.finalize(input('request-b', 'other'))
  })
  const sourceAnchor: TranslationHistoryAnchor = {
    mode: 'source',
    from: 4,
    to: 12,
    lineStart: 4,
    fingerprint: { before: '', selected: 'selected', after: '\n' },
    status: 'location-changed',
  }
  act(() => {
    result.current.updateAnchor('record-1', sourceAnchor)
    result.current.updateDocumentIdentity('draft', {
      nextDocumentKey: 'C:/Notes/saved.md',
      workspaceAbsolutePath: 'C:\\Notes',
      documentRelativePath: 'saved.md',
      documentAbsolutePath: null,
      documentRevision: 'revision-b',
    })
  })

  expect(result.current.records[0]).toMatchObject({
    documentKey: 'C:/Notes/saved.md',
    documentAbsolutePath: 'C:/Notes/saved.md',
    documentRevision: 'revision-b',
    anchor: sourceAnchor,
  })
  expect(result.current.records[1]?.documentKey).toBe('other')
})
