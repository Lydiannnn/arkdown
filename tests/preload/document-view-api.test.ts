import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import { DOCUMENT_VIEW_ERROR_MESSAGES } from '../../src/shared/document-view'

const id = '12345678-1234-4123-8123-123456789abc'
const snapshot = { id, absolutePath: 'C:\\notes\\a.md', displayName: 'a.md', text: '# Hello', kind: 'markdown', revision: 'a'.repeat(64) }

it('validates file-reveal requests, including preview tokens, and sanitizes missing-file messages', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: null })
  const api = createArkdownApi(invoke)
  for (const input of [{ href: 'C:/notes/a.md' }, { href: '../a.md', sourceId: id }]) {
    await expect(api.revealLocalFileLink!(input)).resolves.toEqual({ ok: true, value: null })
    expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.revealLocalFileLink, input)
  }
  invoke.mockClear()
  for (const input of [{ href: 'https://example.com' }, { href: '../a.md', sourcePath: 'C:/other' }, { href: '../a.md', sourceId: 'fake' }]) {
    await expect(api.revealLocalFileLink!(input)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(invoke).not.toHaveBeenCalled()
  invoke.mockResolvedValue({ ok: false, error: { code: 'LOCAL_FILE_NOT_FOUND', message: 'private diagnostic' } })
  await expect(api.revealLocalFileLink!({ href: '../a.md' })).resolves.toEqual({ ok: false, error: {
    code: 'LOCAL_FILE_NOT_FOUND', message: '无法找到文件。目标文件已不在原位置，或当前文档已被移动到新位置。',
  } })
})

it('routes the four preview APIs with validated requests and typed responses', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: { kind: 'document', document: snapshot } })
  const api = createArkdownApi(invoke)
  const input = { href: '../中文/a%20b.md#title', sourceId: id, activeIds: [id] }
  await expect(api.navigateDocumentView!(input)).resolves.toEqual({ ok: true, value: { kind: 'document', document: snapshot } })
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.navigateDocumentView, input)
  invoke.mockResolvedValue({ ok: true, value: snapshot })
  await expect(api.refreshDocumentView!(id)).resolves.toEqual({ ok: true, value: snapshot })
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.refreshDocumentView, { id })
  invoke.mockResolvedValue({ ok: true, value: { changed: true, exists: true } })
  await expect(api.inspectDocumentView!(id)).resolves.toEqual({ ok: true, value: { changed: true, exists: true } })
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.inspectDocumentView, { id })
  invoke.mockResolvedValue({ ok: true, value: null })
  await expect(api.openDocumentView!(id)).resolves.toEqual({ ok: true, value: null })
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.openDocumentView, { id })
})

it('rejects forged ownership and malformed responses, and never trusts error message strings', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)
  for (const input of [{ href: '../a.md', sourcePath: 'C:\\secret' }, { href: 'C:\\a.md' }, { href: '../a.md', sourceId: 'other-window' }, { href: '../a.md', activeIds: Array(33).fill(id) }]) {
    await expect(api.navigateDocumentView!(input)).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  await expect(api.openDocumentView!('C:\\a.md')).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
  invoke.mockResolvedValue({ ok: true, value: { kind: 'document', document: { ...snapshot, revision: 'wrong' } } })
  await expect(api.navigateDocumentView!({ href: '../a.md' })).resolves.toMatchObject({ ok: false })
  invoke.mockResolvedValue({ ok: false, error: { code: 'DOCUMENT_VIEW_BINARY', message: 'C:\\sensitive\\secret' } })
  await expect(api.refreshDocumentView!(id)).resolves.toEqual({ ok: false, error: { code: 'DOCUMENT_VIEW_BINARY', message: DOCUMENT_VIEW_ERROR_MESSAGES.DOCUMENT_VIEW_BINARY } })
})
