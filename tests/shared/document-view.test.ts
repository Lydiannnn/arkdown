import { expect, it } from 'vitest'
import { parseDocumentViewId, parseDocumentViewInspection, parseDocumentViewRequest, parseDocumentViewResult, parseDocumentViewSnapshot } from '../../src/shared/document-view'

const id = '12345678-1234-4123-8123-123456789abc'
const snapshot = { id, absolutePath: 'C:\\notes\\report.md', displayName: 'report.md', text: '', kind: 'markdown', revision: 'a'.repeat(64), line: 3, anchor: 'heading' }

it('validates typed payloads and retains the original href', () => {
  expect(parseDocumentViewId(id)).toBe(id)
  expect(parseDocumentViewRequest({ href: '../中文/a%20b.md#section', sourceId: id })).toEqual({ href: '../中文/a%20b.md#section', sourceId: id })
  expect(parseDocumentViewRequest({ href: '../a.md', sourceId: id, activeIds: [id] })).toEqual({ href: '../a.md', sourceId: id, activeIds: [id] })
  expect(parseDocumentViewSnapshot(snapshot)).toEqual(snapshot)
  expect(parseDocumentViewResult({ kind: 'document', document: snapshot })).toEqual({ kind: 'document', document: snapshot })
  expect(parseDocumentViewResult({ kind: 'directory', id, absolutePath: 'C:\\notes', displayName: 'notes' })).toEqual({ kind: 'directory', id, absolutePath: 'C:\\notes', displayName: 'notes' })
  expect(parseDocumentViewInspection({ changed: true, exists: false })).toEqual({ changed: true, exists: false })
})

it('rejects malformed replies, injected source ownership, executable result kinds and getters', () => {
  expect(parseDocumentViewRequest({ href: '../a.md', absolutePath: 'C:\\evil.md', session: 1 })).toBeUndefined()
  expect(parseDocumentViewRequest({ href: 'https://example.com' })).toBeUndefined()
  expect(parseDocumentViewRequest({ get href() { throw new Error('untrusted getter') } })).toBeUndefined()
  expect(parseDocumentViewId('C:\\notes\\a.md')).toBeUndefined()
  expect(parseDocumentViewSnapshot({ ...snapshot, line: 0 })).toBeUndefined()
  expect(parseDocumentViewSnapshot({ ...snapshot, revision: 'unverified' })).toBeUndefined()
  expect(parseDocumentViewSnapshot({ ...snapshot, absolutePath: '../relative.md' })).toBeUndefined()
  expect(parseDocumentViewSnapshot({ ...snapshot, text: 'a'.repeat(8 * 1024 * 1024 + 1) })).toBeUndefined()
  expect(parseDocumentViewResult({ kind: 'executable', id, absolutePath: 'C:\\x.exe', displayName: 'x.exe' })).toBeUndefined()
  expect(parseDocumentViewInspection({ changed: 'true', exists: true })).toBeUndefined()
  expect(parseDocumentViewInspection({ changed: false, exists: true, extra: 1 })).toBeUndefined()
  expect(parseDocumentViewRequest({ href: '../a.md', activeIds: Array(33).fill(id) })).toBeUndefined()
  expect(parseDocumentViewRequest({ href: '../a.md', activeIds: ['C:\\secret.md'] })).toBeUndefined()
  expect(parseDocumentViewRequest({ href: '../a.md', activeIds: [id, id] })).toBeUndefined()
})
