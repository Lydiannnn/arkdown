import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'
import {
  DEFAULT_BACKGROUND_SETTINGS,
  type BackgroundSettings,
  type BackgroundTarget,
} from '../../src/shared/background-settings'

const NOTE_ID = 'a1111111-2222-4333-8444-555555555555'
const stickyTarget: BackgroundTarget = { kind: 'sticky-note', noteId: NOTE_ID }
const mainTarget: BackgroundTarget = { kind: 'main' }
const settings: BackgroundSettings = {
  ...DEFAULT_BACKGROUND_SETTINGS,
  imageRelativePath: 'backgrounds/forest.webp',
  imageOpacityPercent: 20,
  maskType: 'circle',
  maskOpacityPercent: 42,
  maskTransitionPercent: 50,
}
const presentation = {
  imageUrl: 'arkdown-resource://backgrounds/forest.webp',
  settings,
}

it('accepts only the finite background conflict result, without widening presentation payloads', async () => {
  const invoke = vi.fn(async () => ({ ok: true, value: { status: 'conflict' } }))
  const api = createArkdownApi(invoke)
  await expect(api.applyBackground(mainTarget, settings)).resolves.toEqual({ ok: true, value: { status: 'conflict' } })
  for (const value of [{ status: 'unknown' }, { status: 'conflict', path: 'private' },
    Object.defineProperty({}, 'status', { enumerable: true, get: () => { throw new Error('must not read') } })]) {
    invoke.mockResolvedValueOnce({ ok: true, value } as never)
    await expect(api.applyBackground(mainTarget, settings)).resolves.toMatchObject({ ok: false })
  }
})

it('exposes validated background-setting commands with target-scoped payloads', async () => {
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: presentation })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: presentation })
    .mockResolvedValueOnce({ ok: true, value: null })
    .mockResolvedValueOnce({ ok: true, value: presentation })
    .mockResolvedValueOnce({ ok: true, value: null })
  const api = createArkdownApi(invoke)

  expect(api.openBackgroundSettings).toBeTypeOf('function')
  await expect(api.openBackgroundSettings(mainTarget)).resolves.toEqual({ ok: true, value: null })
  await expect(api.getBackgroundPresentation(stickyTarget)).resolves.toEqual({
    ok: true,
    value: presentation,
  })
  await expect(api.chooseBackgroundImage(stickyTarget)).resolves.toEqual({ ok: true, value: null })
  await expect(api.removeBackgroundImage(stickyTarget)).resolves.toEqual({
    ok: true,
    value: presentation,
  })
  await expect(api.previewBackground(stickyTarget, settings)).resolves.toEqual({ ok: true, value: null })
  await expect(api.applyBackground(stickyTarget, settings)).resolves.toEqual({
    ok: true,
    value: presentation,
  })
  await expect(api.cancelBackgroundSettings(stickyTarget)).resolves.toEqual({ ok: true, value: null })

  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.openBackgroundSettings, mainTarget],
    [IPC_CHANNELS.getBackgroundPresentation, stickyTarget],
    [IPC_CHANNELS.chooseBackgroundImage, stickyTarget],
    [IPC_CHANNELS.removeBackgroundImage, stickyTarget],
    [IPC_CHANNELS.previewBackground, { target: stickyTarget, settings }],
    [IPC_CHANNELS.applyBackground, { target: stickyTarget, settings }],
    [IPC_CHANNELS.cancelBackgroundSettings, stickyTarget],
  ])
})

it('fails closed for malformed targets and settings before invoking main IPC', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)

  await expect(api.getBackgroundPresentation({ kind: 'sticky-note', noteId: NOTE_ID.toUpperCase() }))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(api.openBackgroundSettings({ kind: 'main', extra: true } as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(api.previewBackground(mainTarget, { ...settings, extra: true } as never))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

  expect(invoke).not.toHaveBeenCalled()
})

it('rejects malformed background presentations returned from IPC', async () => {
  const invoke = vi.fn().mockResolvedValue({
    ok: true,
    value: { ...presentation, extra: 'leak' },
  })
  const api = createArkdownApi(invoke)

  await expect(api.getBackgroundPresentation(mainTarget)).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})

it('forwards only exact background-presentation events and can unsubscribe', () => {
  let emit: ((payload: unknown) => void) | undefined
  const unsubscribe = vi.fn()
  const backgroundPresentationTransport = {
    subscribe(listener: (payload: unknown) => void) {
      emit = listener
      return unsubscribe
    },
  }
  const api = createArkdownApi(
    vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    backgroundPresentationTransport,
  )
  const listener = vi.fn()
  const stop = api.onBackgroundPresentation(listener)

  emit?.({
    target: stickyTarget,
    presentation,
    phase: 'preview',
  })
  emit?.({
    target: stickyTarget,
    presentation: { ...presentation, imageUrl: 7 },
    phase: 'preview',
  })
  emit?.({
    target: stickyTarget,
    presentation,
    phase: 'ignored',
  })

  expect(listener).toHaveBeenCalledExactlyOnceWith({
    target: stickyTarget,
    presentation,
    phase: 'preview',
  })
  stop()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
