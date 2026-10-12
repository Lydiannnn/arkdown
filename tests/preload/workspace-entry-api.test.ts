import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

it('exposes the fixed workspace entry API surface', async () => {
  const entry = { name: '资料', relativePath: '资料', kind: 'directory' }
  const properties = {
    name: '资料',
    relativePath: '资料',
    absolutePath: 'C:\\workspace\\资料',
    kind: 'directory',
    size: 0,
    createdAt: '2026-07-25T00:00:00.000Z',
    modifiedAt: '2026-07-25T00:00:00.000Z',
    itemCount: 0,
  }
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: entry })
    .mockResolvedValueOnce({
      ok: true,
      value: { entry, colorMarks: { marks: { old: '#2563EB' } } },
    })
    .mockResolvedValueOnce({ ok: true, value: { ...entry, kind: 'document' } })
    .mockResolvedValueOnce({ ok: true, value: { colorMarks: { marks: {} } } })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: properties })
    .mockResolvedValueOnce({ ok: true, value: properties })
    .mockResolvedValueOnce({ ok: true, value: { marks: { 'notes/first.md': '#2563EB' } } })
    .mockResolvedValueOnce({ ok: true, value: { marks: { 'notes/first.md': '#18864B' } } })
    .mockResolvedValueOnce({ ok: true, value: { marks: { 'archive/first.md': '#18864B' } } })
    .mockResolvedValueOnce({ ok: true, value: { marks: {} } })
  const api = createArkdownApi(invoke)

  await api.createWorkspaceFolder?.('', '资料')
  await expect(api.renameWorkspaceEntry?.('old', '资料')).resolves.toEqual({
    ok: true,
    value: { entry, colorMarks: { marks: { old: '#2563EB' } } },
  })
  await api.duplicateWorkspaceDocument?.('first.md')
  await expect(api.trashWorkspaceEntry?.('first.md')).resolves.toEqual({
    ok: true,
    value: { colorMarks: { marks: {} } },
  })
  await api.revealWorkspaceEntry?.('first.md')
  await api.openWorkspaceEntryWindow?.('first.md')
  await api.getWorkspaceEntryProperties?.('资料')
  await api.getWorkspaceRootProperties?.()
  await api.getWorkspaceColorMarks?.()
  await api.setWorkspaceColorMark?.('notes/first.md', '#18864B')
  await api.moveWorkspaceColorMark?.('notes', 'archive')
  await api.deleteWorkspaceColorMarks?.('archive')

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.createWorkspaceFolder, { parentRelativePath: '', name: '资料' }],
    [IPC_CHANNELS.renameWorkspaceEntry, { relativePath: 'old', newName: '资料' }],
    [IPC_CHANNELS.duplicateWorkspaceDocument, { relativePath: 'first.md' }],
    [IPC_CHANNELS.trashWorkspaceEntry, { relativePath: 'first.md' }],
    [IPC_CHANNELS.revealWorkspaceEntry, { relativePath: 'first.md' }],
    [IPC_CHANNELS.openWorkspaceEntryWindow, { relativePath: 'first.md' }],
    [IPC_CHANNELS.getWorkspaceEntryProperties, { relativePath: '资料' }],
    [IPC_CHANNELS.getWorkspaceRootProperties],
    [IPC_CHANNELS.getWorkspaceColorMarks],
    [IPC_CHANNELS.setWorkspaceColorMark, { relativePath: 'notes/first.md', color: '#18864B' }],
    [IPC_CHANNELS.moveWorkspaceColorMark, { fromRelativePath: 'notes', toRelativePath: 'archive' }],
    [IPC_CHANNELS.deleteWorkspaceColorMarks, { relativePath: 'archive' }],
  ])
})
