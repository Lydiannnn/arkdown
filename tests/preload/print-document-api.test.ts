import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import type { PrintDocumentInput } from '../../src/shared/printing'

const token = '00000000-0000-4000-8000-000000000001'
const input: PrintDocumentInput = {
  markdown: '# Printed title',
  documentName: 'plan.md',
  documentAbsolutePath: 'C:\\Docs\\plan.md',
  appearance: { ...DEFAULT_EDITOR_APPEARANCE, editorTheme: 'minimal' } as never,
}
const surfaceInput = { ...input, surfaceDeadlineEpochMs: 1_788_048_030_000 }

it('uses fixed print channels and returns only validated results', async () => {
  const invoke = vi.fn(async (channel: string) => ({
    ok: true,
    value: channel === IPC_CHANNELS.takePrintDocument ? surfaceInput : null,
  }))
  const api = createArkdownApi(invoke)

  await expect(api.printDocument(input)).resolves.toEqual({ ok: true, value: null })
  await expect(api.takePrintDocument(token)).resolves.toEqual({ ok: true, value: surfaceInput })
  await expect(api.readyPrintDocument(token)).resolves.toEqual({ ok: true, value: null })

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.printDocument, input],
    [IPC_CHANNELS.takePrintDocument, { token }],
    [IPC_CHANNELS.readyPrintDocument, { token }],
  ])
  expect(api).not.toHaveProperty('ipcRenderer')
})

it('rejects malformed print input and token before invoking IPC', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)
  const { editorTheme: _missingTheme, ...missingTheme } = input.appearance as unknown as Record<string, unknown>

  await expect(api.printDocument({ ...input, markdown: '' })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  await expect(api.printDocument({
    ...input,
    documentAbsolutePath: 'relative/plan.md',
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(api.printDocument(surfaceInput)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  await expect(api.printDocument({
    ...input,
    appearance: missingTheme as never,
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(api.takePrintDocument('guessable-token')).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  await expect(api.readyPrintDocument('guessable-token')).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(invoke).not.toHaveBeenCalled()
})

it('fails closed on malformed payload and acknowledgement responses', async () => {
  const missingDeadline = createArkdownApi(vi.fn(async () => ({
    ok: true,
    value: input,
  })))
  await expect(missingDeadline.takePrintDocument(token)).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  const malformedPayload = createArkdownApi(vi.fn(async () => ({
    ok: true,
    value: { ...surfaceInput, appearance: { ...input.appearance, extra: true } },
  })))
  await expect(malformedPayload.takePrintDocument(token)).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  const { editorTheme: _missingTheme, ...missingTheme } = input.appearance as unknown as Record<string, unknown>
  const incompletePayload = createArkdownApi(vi.fn(async () => ({
    ok: true,
    value: { ...surfaceInput, appearance: missingTheme },
  })))
  await expect(incompletePayload.takePrintDocument(token)).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  for (const surfaceDeadlineEpochMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidDeadline = createArkdownApi(vi.fn(async () => ({
      ok: true,
      value: { ...surfaceInput, surfaceDeadlineEpochMs },
    })))
    await expect(invalidDeadline.takePrintDocument(token)).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    })
  }

  const extraSurfaceKey = createArkdownApi(vi.fn(async () => ({
    ok: true,
    value: { ...surfaceInput, extra: true },
  })))
  await expect(extraSurfaceKey.takePrintDocument(token)).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })

  const malformedAcknowledgement = createArkdownApi(vi.fn(async () => ({
    ok: true,
    value: undefined,
  })))
  await expect(malformedAcknowledgement.printDocument(input)).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})
