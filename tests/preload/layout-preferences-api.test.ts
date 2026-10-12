import { expect, it, vi } from 'vitest'
import {
  createArkdownApi,
  type LayoutPreferencesChangedTransport,
} from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

const defaults = { leftSidebarWidth: 300, rightSidebarWidth: 530 }

it('exposes only the revisioned layout preference write channel', async () => {
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { layout: defaults, revision: 0 } })
  const api = createArkdownApi(invoke)

  await expect(api.getLayoutPreferences?.()).resolves.toEqual({
    ok: true,
    value: { layout: defaults, revision: 0 },
  })
  expect(api).not.toHaveProperty('setLayoutPreferences')
  expect(invoke.mock.calls).toEqual([[IPC_CHANNELS.getLayoutPreferences]])
})

it('forwards strict layout compare-and-set inputs and conflict snapshots', async () => {
  const replacement = { leftSidebarWidth: 420, rightSidebarWidth: 760 }
  const invoke = vi.fn().mockResolvedValue({
    ok: true,
    value: { applied: false, snapshot: { layout: replacement, revision: 1 } },
  })
  const api = createArkdownApi(invoke)

  await expect(api.compareAndSetLayoutPreferences?.(0, defaults, replacement)).resolves.toEqual({
    ok: true,
    value: { applied: false, snapshot: { layout: replacement, revision: 1 } },
  })
  expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.compareAndSetLayoutPreferences, {
    expectedRevision: 0,
    expectedLayout: defaults,
    replacement,
  })
})

it('delivers only validated layout preference changes', () => {
  let emit: ((payload: unknown) => void) | undefined
  const transport: LayoutPreferencesChangedTransport = {
    subscribe(listener) {
      emit = listener
      return () => { emit = undefined }
    },
  }
  const api = createArkdownApi(
    vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    transport,
  )
  const listener = vi.fn()
  const unsubscribe = api.onLayoutPreferencesChanged?.(listener)

  emit?.({ layout: { leftSidebarWidth: 420, rightSidebarWidth: 760 }, revision: 2 })
  emit?.({ layout: { leftSidebarWidth: 420 }, revision: 3 })
  emit?.({ layout: { leftSidebarWidth: 900, rightSidebarWidth: 2000 }, revision: 3 })
  emit?.({ layout: { leftSidebarWidth: 420, rightSidebarWidth: 760 }, revision: -1 })

  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith({
    layout: { leftSidebarWidth: 420, rightSidebarWidth: 760 },
    revision: 2,
  })
  unsubscribe?.()
  expect(emit).toBeUndefined()
})

it('does not invoke IPC for incomplete layout compare-and-set requests', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)

  await expect(api.compareAndSetLayoutPreferences?.(0, { leftSidebarWidth: 300 } as never, defaults)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(invoke).not.toHaveBeenCalled()
})

it('rejects out-of-range layout requests, responses, and change events without clamping them', async () => {
  const invoke = vi.fn().mockResolvedValue({
    ok: true,
    value: { layout: { leftSidebarWidth: 900, rightSidebarWidth: 2000 }, revision: 1 },
  })
  const api = createArkdownApi(invoke)

  await expect(api.compareAndSetLayoutPreferences?.(
    0,
    defaults,
    { leftSidebarWidth: 900, rightSidebarWidth: 2000 },
  ))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(api.getLayoutPreferences?.()).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
  expect(invoke).toHaveBeenCalledOnce()
})
