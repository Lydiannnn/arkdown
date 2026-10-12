import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const NOTE_ID = '00000000-0000-4000-8000-000000000001'
const main = { kind: 'main' as const }
const sticky = { kind: 'sticky-note' as const, noteId: NOTE_ID }
const presentation = {
  settings: { ...DEFAULT_BACKGROUND_SETTINGS },
  imageUrl: null,
}

function harness() {
  const backgrounds = {
    open: vi.fn(async () => undefined),
    get: vi.fn(async () => presentation),
    choose: vi.fn(async () => presentation),
    remove: vi.fn(async () => presentation),
    preview: vi.fn(async () => undefined),
    apply: vi.fn(async () => presentation),
    cancel: vi.fn(async () => undefined),
  }
  const operations = createIpcOperations({
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    backgrounds,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
  })
  return { backgrounds, operations }
}

it('validates and forwards background settings operations', async () => {
  const { backgrounds, operations } = harness()
  const controls = {
    ...DEFAULT_BACKGROUND_SETTINGS,
    imageOpacityPercent: 41,
    maskType: 'column-horizontal' as const,
  }

  await expect(operations.openBackgroundSettings(main)).resolves.toEqual({ ok: true, value: null })
  await expect(operations.getBackgroundPresentation(sticky)).resolves.toEqual({ ok: true, value: presentation })
  await expect(operations.chooseBackgroundImage(sticky)).resolves.toEqual({ ok: true, value: presentation })
  await expect(operations.removeBackgroundImage(sticky)).resolves.toEqual({ ok: true, value: presentation })
  await expect(operations.previewBackground({ target: sticky, settings: controls }))
    .resolves.toEqual({ ok: true, value: null })
  await expect(operations.applyBackground({ target: sticky, settings: controls }))
    .resolves.toEqual({ ok: true, value: presentation })
  await expect(operations.cancelBackgroundSettings(sticky)).resolves.toEqual({ ok: true, value: null })

  expect(backgrounds.open).toHaveBeenCalledWith(main)
  expect(backgrounds.get).toHaveBeenCalledWith(sticky)
  expect(backgrounds.choose).toHaveBeenCalledWith(sticky)
  expect(backgrounds.remove).toHaveBeenCalledWith(sticky)
  expect(backgrounds.preview).toHaveBeenCalledWith(sticky, controls)
  expect(backgrounds.apply).toHaveBeenCalledWith(sticky, controls)
  expect(backgrounds.cancel).toHaveBeenCalledWith(sticky)
})

it('rejects malformed targets and settings before dispatch', async () => {
  const { backgrounds, operations } = harness()
  const invalidTargets = [
    undefined,
    {},
    { kind: 'main', noteId: NOTE_ID },
    { kind: 'sticky-note' },
    { kind: 'sticky-note', noteId: 'not-a-uuid' },
    { kind: 'other' },
  ]
  for (const target of invalidTargets) {
    await expect(operations.openBackgroundSettings(target)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  await expect(operations.applyBackground({
    target: main,
    settings: { ...DEFAULT_BACKGROUND_SETTINGS, imageOpacityPercent: 10.5 },
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(operations.previewBackground({
    target: main,
    settings: { ...DEFAULT_BACKGROUND_SETTINGS, extra: true },
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

  expect(backgrounds.open).not.toHaveBeenCalled()
  expect(backgrounds.apply).not.toHaveBeenCalled()
  expect(backgrounds.preview).not.toHaveBeenCalled()
})
