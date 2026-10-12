import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

const revision = 'a'.repeat(64)
const value = {
  workspace: { name: 'notes', absolutePath: 'C:\\notes' },
  document: {
    relativePath: 'guide.md',
    markdown: '# Guide',
    revision,
    encoding: 'utf8' as const,
    newline: 'lf' as const,
    mtimeMs: 1,
  },
}

it('invokes the fixed dropped-path channel and reconstructs its exact result', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value })
  const api = createArkdownApi(invoke)

  await expect(api.openDroppedPath('C:\\notes\\guide.md')).resolves.toEqual({
    ok: true,
    value,
  })
  expect(invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.openDroppedPath,
    { absolutePath: 'C:\\notes\\guide.md' },
  )
})

it('rejects malformed dropped-path response values', async () => {
  for (const malformed of [
    { workspace: value.workspace },
    { workspace: null, document: null },
    { workspace: value.workspace, document: { ...value.document, revision: 'bad' } },
  ]) {
    const api = createArkdownApi(vi.fn().mockResolvedValue({ ok: true, value: malformed }))
    await expect(api.openDroppedPath('C:\\notes')).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    })
  }
})

it('invokes the fixed dropped-item inspection channel and rejects malformed results', async () => {
  const invoke = vi.fn().mockResolvedValue({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\notes\\archive.bin' },
  })
  const api = createArkdownApi(invoke)

  await expect(api.inspectDroppedPath?.('C:\\notes\\archive.bin')).resolves.toEqual({
    ok: true,
    value: { kind: 'file', absolutePath: 'C:\\notes\\archive.bin' },
  })
  expect(invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.inspectDroppedPath,
    { absolutePath: 'C:\\notes\\archive.bin' },
  )

  const malformed = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: { kind: 'folder', absolutePath: 'C:\\notes' },
  }))
  await expect(malformed.inspectDroppedPath?.('C:\\notes')).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})

it('uses exact guarded preparation and one-shot settlement payloads', async () => {
  const token = '123e4567-e89b-42d3-a456-426614174000'
  const invoke = vi.fn().mockResolvedValueOnce({ ok: true, value: { ...value, token } })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value })
  const api = createArkdownApi(invoke)
  expect(await api.prepareDroppedPath?.('C:/notes/guide.md')).toEqual({ ok: true, value: { ...value, token } })
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.prepareDroppedPath, { absolutePath: 'C:/notes/guide.md' })
  expect(await api.settleDroppedPath?.(token, false)).toEqual({ ok: true, value: null })
  expect(invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settleDroppedPath, { token, accept: false })
  expect(await api.settleDroppedPath?.(token, true)).toEqual({ ok: true, value })
  for (const malformed of [{ ...value }, { ...value, token: '' }, { ...value, token, extra: true }]) {
    invoke.mockResolvedValueOnce({ ok: true, value: malformed })
    expect(await api.prepareDroppedPath?.('C:/notes/guide.md')).toMatchObject({ ok: false })
  }
})
