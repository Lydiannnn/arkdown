import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { SCREENSHOT_OCR_MODEL_CHANNELS } from '../../src/shared/contracts'

const observed = { revision: 4, preferredTier: 'small' as const, tierRevision: 2 }
const state = { activeTier: 'small', bundledVersion: '6.0.0', mediumVersion: null,
  availableMediumVersion: '6.0.0', status: 'medium-absent', progress: null, errorCode: null }
it('transports the opening OCR observation and only finite checked action outcomes', async () => {
  const invoke = vi.fn().mockResolvedValueOnce({ ok: true, value: { state, observed } })
    .mockResolvedValueOnce({ ok: true, value: { status: 'conflict' } })
    .mockResolvedValueOnce({ ok: true, value: state })
  const api = createArkdownApi(invoke)
  await expect(api.getScreenshotOcrModelState!()).resolves.toEqual({ ok: true, value: { state, observed } })
  await expect(api.downloadScreenshotOcrMedium!(observed)).resolves.toEqual({ ok: true, value: { status: 'conflict' } })
  await expect(api.removeScreenshotOcrMedium!(observed)).resolves.toEqual({ ok: true, value: state })
  expect(invoke.mock.calls.slice(1)).toEqual([
    [SCREENSHOT_OCR_MODEL_CHANNELS.downloadMedium, observed], [SCREENSHOT_OCR_MODEL_CHANNELS.removeMedium, observed],
  ])
})

it('rejects malformed observed revisions and accessors before invoking main', async () => {
  const invoke = vi.fn(); const api = createArkdownApi(invoke)
  const getter = vi.fn(() => 2)
  for (const input of [undefined, { ...observed, revision: -1 }, { ...observed, tierRevision: 5 },
    { ...observed, extra: 'private' }, Object.defineProperty({ ...observed }, 'tierRevision', { get: getter })]) {
    await expect(api.downloadScreenshotOcrMedium!(input as never)).resolves.toMatchObject({ ok: false })
  }
  expect(invoke).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled()
})
