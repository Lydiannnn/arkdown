import { expect, it, vi } from 'vitest'
import {
  createVisualDocumentFindSession,
  type DocumentHighlightRegistry,
} from '../../src/renderer/editor/visual-document-find'

it('finds, cycles, and clears non-mutating visual document matches', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>Alpha beta alpha</p><p>ALPHA</p>'
  const ranges = new Map<string, Range[]>()
  const registry: DocumentHighlightRegistry = {
    set: vi.fn((name, nextRanges) => ranges.set(name, nextRanges)),
    delete: vi.fn((name) => ranges.delete(name)),
  }
  const session = createVisualDocumentFindSession(root, registry)
  const scrollIntoView = vi.fn()
  for (const paragraph of root.querySelectorAll('p')) paragraph.scrollIntoView = scrollIntoView

  expect(session.setQuery('alpha')).toMatchObject({ query: 'alpha', current: 1, total: 3 })
  expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'nearest' })
  expect(ranges.get('arkdown-document-find-match')).toHaveLength(3)
  expect(ranges.get('arkdown-document-find-current')?.[0].toString()).toBe('Alpha')

  expect(session.next()).toMatchObject({ query: 'alpha', current: 2, total: 3 })
  expect(ranges.get('arkdown-document-find-current')?.[0].toString()).toBe('alpha')

  expect(session.previous()).toMatchObject({ query: 'alpha', current: 1, total: 3 })
  expect(session.previous()).toMatchObject({ query: 'alpha', current: 3, total: 3 })

  root.querySelector('p')!.textContent = 'Alpha only'
  expect(session.refresh()).toMatchObject({ query: 'alpha', current: 1, total: 2 })
  session.close()

  expect(registry.delete).toHaveBeenCalledWith('arkdown-document-find-match')
  expect(registry.delete).toHaveBeenCalledWith('arkdown-document-find-current')
  expect(root.innerHTML).toBe('<p>Alpha only</p><p>ALPHA</p>')
})

it('publishes an authoritative snapshot after every query, navigation, edit, and close', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>one one</p>'
  const snapshots: Array<{ query: string; current: number; total: number; revision: number }> = []
  const session = createVisualDocumentFindSession(root, {
    set: vi.fn(),
    delete: vi.fn(),
  }, (snapshot) => snapshots.push(snapshot))

  session.setQuery('missing')
  session.setQuery('one')
  session.next()
  root.textContent = 'one'
  session.refresh()
  session.close()

  expect(snapshots.map(({ query, current, total }) => ({ query, current, total }))).toEqual([
    { query: 'missing', current: 0, total: 0 },
    { query: 'one', current: 1, total: 2 },
    { query: 'one', current: 2, total: 2 },
    { query: 'one', current: 1, total: 1 },
    { query: '', current: 0, total: 0 },
  ])
  expect(snapshots.map(({ revision }) => revision)).toEqual([1, 2, 3, 4, 5])
})
