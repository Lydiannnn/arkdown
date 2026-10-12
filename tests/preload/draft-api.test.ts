import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

const draftId = '123e4567-e89b-42d3-a456-426614174000'
const summary = {
  draftId,
  originalAbsolutePath: 'C:\\notes\\note.md',
  workspaceAbsolutePath: 'C:\\notes',
  originalRevision: 'a'.repeat(64),
  originalMtimeMs: 1,
  encoding: 'utf8',
  newline: 'lf',
  updatedAt: '2026-07-24T00:00:00.000Z',
  ignoredAt: null,
}

it('invokes only fixed draft channels with bounded payload shapes', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === IPC_CHANNELS.saveDraft) return { ok: true, value: summary }
    if (channel === IPC_CHANNELS.listRecoverableDrafts) return { ok: true, value: [summary] }
    if (channel === IPC_CHANNELS.readDraft || channel === IPC_CHANNELS.claimRecoveredDraft) {
      return { ok: true, value: { manifest: summary, markdown: '# recovered' } }
    }
    return { ok: true, value: null }
  })
  const api = createArkdownApi(invoke)
  const draftInput = {
    draftId,
    markdown: '# changed',
    expectedOriginalRevision: 'a'.repeat(64),
    encoding: 'utf8' as const,
    newline: 'lf' as const,
  }

  await expect(api.saveDraft!(draftInput)).resolves.toMatchObject({ ok: true, value: { draftId } })
  await expect(api.listRecoverableDrafts!()).resolves.toMatchObject({ ok: true, value: [{ draftId }] })
  await expect(api.readDraft!(draftId)).resolves.toMatchObject({
    ok: true,
    value: { markdown: '# recovered' },
  })
  await api.ignoreDraft!(draftId)
  await api.discardDraft!(draftId)
  await expect(api.claimRecoveredDraft!(draftId)).resolves.toMatchObject({ ok: true, value: { markdown: '# recovered' } })
  await api.cleanDraft!(draftId)
  await api.releaseDraftRecovery!(draftId)
  await api.retryDraftFinalization!()

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.saveDraft, draftInput],
    [IPC_CHANNELS.listRecoverableDrafts],
    [IPC_CHANNELS.readDraft, { draftId }],
    [IPC_CHANNELS.ignoreDraft, { draftId }],
    [IPC_CHANNELS.discardDraft, { draftId }],
    [IPC_CHANNELS.claimRecoveredDraft, { draftId }],
    [IPC_CHANNELS.cleanDraft, { draftId }],
    [IPC_CHANNELS.releaseDraftRecovery, { draftId }],
    [IPC_CHANNELS.retryDraftFinalization],
  ])
})

it('preserves the committed file revision when its draft terminal commit needs retry', async () => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: {
    revision: 'b'.repeat(64), mtimeMs: 2, markdown: '# saved', draftEndPending: true,
  } }))
  await expect(api.saveDocument({ relativePath: 'note.md', markdown: '# saved', expectedRevision: 'a'.repeat(64),
    encoding: 'utf8', newline: 'lf' })).resolves.toMatchObject({ ok: true, value: { revision: 'b'.repeat(64), draftEndPending: true } })
})

it('preserves committed Save As destination and pending finalization through its strict parser', async () => {
  const committed = {
    workspace: { name: 'destination', absolutePath: 'C:\\destination' },
    document: { relativePath: 'saved.md', markdown: '# saved', revision: 'b'.repeat(64), mtimeMs: 2, encoding: 'utf8', newline: 'lf' },
    changesWorkspace: true,
    aiWorkspace: { workspaceId: 'destination', workspaceGeneration: 'generation-2' },
    draftEndPending: true,
  }
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: committed })
  const api = createArkdownApi(invoke)
  expect(await api.commitSaveDocumentAs!(draftId)).toEqual({ ok: true, value: committed })
  invoke.mockResolvedValue({ ok: true, value: { ...committed, draftEndPending: false } })
  expect(await api.commitSaveDocumentAs!(draftId)).toMatchObject({ ok: false })
})

it('fails closed on malformed draft summaries', async () => {
  const api = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: { ...summary, draftId: '../escape' },
  }))

  await expect(api.saveDraft!({
    draftId,
    markdown: '# changed',
    expectedOriginalRevision: null,
    encoding: 'utf8',
    newline: 'lf',
  })).resolves.toEqual({
    ok: false,
    error: { code: 'OPERATION_FAILED', message: '操作未能完成' },
  })
})


it('accepts only a recovery event whose draft id matches its manifest', () => {
  const listener: { current: ((payload: unknown) => void) | null } = { current: null }
  const api = createArkdownApi(
    vi.fn(), undefined, undefined, undefined, undefined,
    { subscribe: (next) => { listener.current = next; return () => { listener.current = null } } },
  )
  const recovered = vi.fn()
  api.onRecoverDraft!(recovered)

  listener.current?.({ draftId, manifest: summary, markdown: '# recovered' })
  listener.current?.({ draftId: '223e4567-e89b-42d3-a456-426614174000', manifest: summary, markdown: '# forged' })

  expect(recovered).toHaveBeenCalledTimes(1)
  expect(recovered).toHaveBeenCalledWith({ draftId, manifest: summary, markdown: '# recovered' })
})
