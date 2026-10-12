import { describe, expect, it, vi } from 'vitest'
import { createRuntimeInstallBroker, type RuntimeInstallPresentation } from '../../src/main/components/runtime-install-broker'
import type { RuntimeComponentManager } from '../../src/main/components/runtime-component-manager'

function harness() {
  let complete!: () => void
  let installed: string | undefined
  const manager: RuntimeComponentManager = {
    getState: () => ({ status: 'absent', version: '1', downloadBytes: 10, progress: null, error: null }),
    ensureRuntime: vi.fn(async () => installed), subscribe: () => () => undefined,
    install: vi.fn(() => new Promise<void>(resolve => { complete = resolve })),
    cancel: vi.fn(async () => { complete?.() }), dispose: vi.fn(async () => undefined),
  }
  let presentation!: RuntimeInstallPresentation
  const close = vi.fn()
  const present = vi.fn((input: RuntimeInstallPresentation) => { presentation = input; return { update: vi.fn(), close } })
  return { manager, present, close, broker: createRuntimeInstallBroker({ present }),
    finish: () => { installed = '/verified/tool'; complete() }, get presentation() { return presentation } }
}
describe('runtime first-use installation', () => {
  it('opens a new install after an earlier cancellation has finished', async () => {
    const h = harness()
    let cancelled!: () => void
    vi.mocked(h.manager.cancel).mockImplementationOnce(() => new Promise<void>(resolve => { cancelled = resolve }))
    const first = h.broker.ensure(h.manager, 'tool')
    await vi.waitFor(() => expect(h.present).toHaveBeenCalledOnce())
    h.presentation.cancel()
    const next = h.broker.ensure(h.manager, 'tool')
    await Promise.resolve()
    expect(h.present).toHaveBeenCalledOnce()
    cancelled()
    expect(await first).toBeUndefined()
    await vi.waitFor(() => expect(h.present).toHaveBeenCalledTimes(2))
    h.finish()
    expect(await next).toBe('/verified/tool')
  })
  it('does not continue the action when cancel races with completed activation', async () => {
    const h = harness()
    let cancelled!: () => void
    vi.mocked(h.manager.cancel).mockImplementationOnce(() => new Promise<void>(resolve => { cancelled = resolve }))
    const pending = h.broker.ensure(h.manager, 'tool')
    await vi.waitFor(() => expect(h.present).toHaveBeenCalledOnce())
    h.presentation.cancel()
    h.finish()
    cancelled()
    expect(await pending).toBeUndefined()
  })
  it('joins two callers into one window and continues both on success', async () => {
    const h = harness()
    const first = h.broker.ensure(h.manager, 'tool')
    const second = h.broker.ensure(h.manager, 'tool')
    await vi.waitFor(() => expect(h.manager.install).toHaveBeenCalledTimes(1))
    h.finish()
    expect(await first).toBe('/verified/tool')
    expect(await second).toBe('/verified/tool')
    expect(h.present).toHaveBeenCalledTimes(1)
    expect(h.close).toHaveBeenCalledOnce()
  })
  it('cancels the download when the last initiating operation closes', async () => {
    const h = harness(), owner = new AbortController()
    const pending = h.broker.ensure(h.manager, 'tool', owner.signal)
    await vi.waitFor(() => expect(h.present).toHaveBeenCalledOnce())
    owner.abort()
    expect(await pending).toBeUndefined()
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce())
    expect(h.manager.cancel).toHaveBeenCalledOnce()
  })
  it('keeps installation alive for another caller and never continues a canceled operation', async () => {
    const h = harness(), owner = new AbortController()
    const first = h.broker.ensure(h.manager, 'tool', owner.signal)
    const second = h.broker.ensure(h.manager, 'tool')
    await vi.waitFor(() => expect(h.present).toHaveBeenCalledOnce())
    owner.abort()
    expect(await first).toBeUndefined()
    expect(h.manager.cancel).not.toHaveBeenCalled()
    h.finish()
    expect(await second).toBe('/verified/tool')
  })
  it('does not open a window for a ready Full component', async () => {
    const h = harness()
    vi.mocked(h.manager.ensureRuntime).mockResolvedValue('/bundle/tool')
    expect(await h.broker.ensure(h.manager, 'tool')).toBe('/bundle/tool')
    expect(h.present).not.toHaveBeenCalled()
    expect(h.manager.install).not.toHaveBeenCalled()
  })
  it('allows retry in the same window after an installation failure', async () => {
    const h = harness()
    vi.mocked(h.manager.install).mockResolvedValueOnce()
    const pending = h.broker.ensure(h.manager, 'tool')
    await vi.waitFor(() => expect(h.manager.install).toHaveBeenCalledOnce())
    h.presentation.retry()
    await vi.waitFor(() => expect(h.manager.install).toHaveBeenCalledTimes(2))
    h.finish()
    expect(await pending).toBe('/verified/tool')
  })
})
