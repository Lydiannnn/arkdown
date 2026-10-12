import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

it('forwards only a saved-file drag request and rejects a false copy-success receipt', async () => {
  const invoke = vi.fn().mockResolvedValue({ ok: true, value: undefined })
  const api = createArkdownApi(invoke)
  const input = { workspace: 'C:\\notes', relativePath: 'original.pdf' }
  await expect(api.startWorkspaceFileDrag!(input)).resolves.toEqual({ ok: true, value: undefined })
  expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.startWorkspaceFileDrag, input)
  invoke.mockResolvedValueOnce({ ok: true, value: { copied: true } })
  await expect(api.startWorkspaceFileDrag!(input)).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
})
