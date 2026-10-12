import { expect, it } from 'vitest'
import {
  TRANSLATION_HISTORY_LIMIT,
  appendTranslationHistoryRecord,
  type TranslationHistoryRecord,
} from '../../src/renderer/editor/translation-history'

function record(
  id: string,
  documentKey: string,
  createdAt = Number(id),
): TranslationHistoryRecord {
  return {
    id,
    requestId: `request-${id}`,
    documentKey,
    workspaceAbsolutePath: 'C:/Notes',
    documentRelativePath: `${documentKey}.md`,
    documentAbsolutePath: `C:/Notes/${documentKey}.md`,
    documentRevision: `revision-${id}`,
    mode: 'visual',
    source: { markdown: id, plainText: id },
    translatedMarkdown: `translated-${id}`,
    modelId: 'chat-model',
    targetLanguage: 'zh-CN',
    terminal: 'completed',
    createdAt,
    anchor: {
      mode: 'visual',
      from: 0,
      to: id.length,
      blockStart: 0,
      fingerprint: { before: '', selected: id, after: '' },
      status: 'valid',
    },
  }
}

it('keeps public records sorted by createdAt and id regardless of insertion order', () => {
  let records: readonly TranslationHistoryRecord[] = []
  records = appendTranslationHistoryRecord(records, record('z', 'document-z', 20))
  records = appendTranslationHistoryRecord(records, record('b', 'document-b', 10))
  records = appendTranslationHistoryRecord(records, record('a', 'document-a', 10))

  expect(records.map(({ id }) => id)).toEqual(['a', 'b', 'z'])
})

it('evicts the tuple-oldest record only within the incoming document', () => {
  let records: readonly TranslationHistoryRecord[] = []
  records = appendTranslationHistoryRecord(records, record('other-1', 'document-b', 1))
  records = appendTranslationHistoryRecord(records, record('newest', 'document-a', 100))
  for (let index = 0; index < 99; index += 1) {
    records = appendTranslationHistoryRecord(
      records,
      record(`older-${String(index).padStart(2, '0')}`, 'document-a', index),
    )
  }

  expect(records).toHaveLength(100)
  expect(records.filter(({ documentKey }) => documentKey === 'document-b').map(({ id }) => id))
    .toEqual(['other-1'])
  expect(records.filter(({ documentKey }) => documentKey === 'document-a').map(({ id }) => id))
    .toEqual([
      ...Array.from({ length: 98 }, (_, index) => `older-${String(index + 1).padStart(2, '0')}`),
      'newest',
    ])
})

it('keeps the newest ninety-nine records independently for each document key', () => {
  let records: readonly TranslationHistoryRecord[] = []
  for (let index = 1; index <= 100; index += 1) {
    records = appendTranslationHistoryRecord(
      records,
      record(`a-${index}`, 'document-a', index),
    )
  }
  for (let index = 1; index <= 3; index += 1) {
    records = appendTranslationHistoryRecord(
      records,
      record(`b-${index}`, 'document-b', 200 + index),
    )
  }

  expect(TRANSLATION_HISTORY_LIMIT).toBe(99)
  expect(records.filter(({ documentKey }) => documentKey === 'document-a').map(({ id }) => id)).toEqual(
    Array.from({ length: 99 }, (_, index) => `a-${index + 2}`),
  )
  expect(records.filter(({ documentKey }) => documentKey === 'document-b').map(({ id }) => id))
    .toEqual(['b-1', 'b-2', 'b-3'])
})

it('applies one document limit to equivalent Windows path keys', () => {
  let records: readonly TranslationHistoryRecord[] = []
  for (let index = 1; index <= 99; index += 1) {
    records = appendTranslationHistoryRecord(
      records,
      record(`a-${index}`, 'C:\\Notes\\Chapter.md', index),
    )
  }

  records = appendTranslationHistoryRecord(
    records,
    record('a-100', 'c:/notes/chapter.md', 100),
  )

  expect(records).toHaveLength(99)
  expect(records.map(({ id }) => id)).toEqual(
    Array.from({ length: 99 }, (_, index) => `a-${index + 2}`),
  )
})
