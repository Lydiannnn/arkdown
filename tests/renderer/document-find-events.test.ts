import { expect, it } from 'vitest'
import { readDocumentFindSnapshot } from '../../src/renderer/editor/document-find-events'

it('accepts only internally consistent document-find snapshots', () => {
  expect(readDocumentFindSnapshot(new CustomEvent('snapshot', {
    detail: { query: 'needle', current: 2, total: 3, revision: 4 },
  }))).toEqual({ query: 'needle', current: 2, total: 3, revision: 4 })

  for (const detail of [
    null,
    { query: 1, current: 0, total: 0, revision: 0 },
    { query: '', current: 1, total: 0, revision: 0 },
    { query: '', current: 3, total: 2, revision: 0 },
    { query: '', current: -1, total: 0, revision: 0 },
    { query: '', current: 0, total: 0, revision: 0.5 },
  ]) {
    expect(readDocumentFindSnapshot(new CustomEvent('snapshot', { detail }))).toBeNull()
  }
})
