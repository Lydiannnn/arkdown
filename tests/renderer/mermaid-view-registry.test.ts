import { describe, expect, it, vi } from 'vitest'

import {
  MERMAID_MAX_BLOCKS,
  MERMAID_PRINT_BATCH_BUDGET_MS,
  MERMAID_QUEUE_LIMIT,
  type MermaidAppearance,
  type MermaidRenderable,
  type MermaidRegistryPort,
} from '../../src/renderer/editor/mermaid/mermaid-types'
import {
  createMermaidViewRegistry,
  MermaidRegistryCapacityError,
} from '../../src/renderer/editor/mermaid/mermaid-view-registry'
import { createMermaidRenderService } from '../../src/renderer/editor/mermaid/mermaid-render-service'
import type { MermaidRenderResult } from '../../src/renderer/editor/mermaid/mermaid-types'
import { PRINT_DOCUMENT_SURFACE_TIMEOUT_MS } from '../../src/main/printing/print-document-service'

const appearance: MermaidAppearance = {
  revision: 1,
  editorTheme: 'minimal',
  colorScheme: 'light',
  themeColor: '#123456',
  bodyFontFamily: 'Inter',
}

const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0L2 2"/></svg>'

function view(): MermaidRenderable & {
  preparePrint: ReturnType<typeof vi.fn>
  refresh: ReturnType<typeof vi.fn>
  finishPrintTimeout: ReturnType<typeof vi.fn>
} {
  return {
    preparePrint: vi.fn(() => undefined),
    refresh: vi.fn((_reason: 'source' | 'theme' | 'print') => undefined),
    finishPrintTimeout: vi.fn(() => undefined),
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function promiseState(promise: Promise<unknown>) {
  const marker = Symbol('pending')
  const state = await Promise.race([promise.then(() => 'fulfilled', () => 'rejected'), Promise.resolve(marker)])
  return state === marker ? 'pending' : state
}

describe('Mermaid view registry', () => {
  it('rejects registration beyond the maximum with a typed capacity error', () => {
    const registry = createMermaidViewRegistry(appearance)
    const unregister = Array.from({ length: MERMAID_MAX_BLOCKS }, () => registry.register(view()))

    expect(() => registry.register(view())).toThrow(MermaidRegistryCapacityError)
    expect(() => registry.register(view())).toThrowError(
      expect.objectContaining({ code: 'MERMAID_MAX_BLOCKS' }),
    )

    unregister.forEach((remove) => remove())
  })

  it('makes unregister idempotent and permits a replacement after removal', () => {
    const registry = createMermaidViewRegistry(appearance)
    const first = view()
    const remove = registry.register(first)

    remove()
    remove()
    expect(() => registry.register(view())).not.toThrow()
  })

  it('refreshes each view only when appearance changes', () => {
    const registry = createMermaidViewRegistry(appearance)
    const first = view()
    const second = view()
    registry.register(first)
    registry.register(second)

    registry.refreshAppearance({ ...appearance })
    expect(first.refresh).not.toHaveBeenCalled()
    expect(second.refresh).not.toHaveBeenCalled()

    const next = { ...appearance, revision: 2, colorScheme: 'dark' as const }
    registry.refreshAppearance(next)
    expect(first.refresh).toHaveBeenCalledTimes(1)
    expect(first.refresh).toHaveBeenCalledWith('theme')
    expect(second.refresh).toHaveBeenCalledTimes(1)
    expect(registry.appearance()).toEqual(next)
  })

  it('broadcasts print refresh to every current view', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const first = view()
    const second = view()
    registry.register(first)
    registry.register(second)

    await registry.renderAll()

    expect(first.preparePrint).toHaveBeenCalledWith(false)
    expect(second.preparePrint).toHaveBeenCalledWith(false)
    expect(first.refresh).toHaveBeenCalledOnce()
    expect(first.refresh).toHaveBeenCalledWith('print')
    expect(second.refresh).toHaveBeenCalledOnce()
    expect(second.refresh).toHaveBeenCalledWith('print')
  })

  it('cancels view-local work and drains tracked tasks before admitting a print wave', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const prior = deferred<void>()
    const current = view()
    registry.register(current)
    registry.track('prior', 1, prior.promise)

    const batch = registry.renderAll()
    expect(current.preparePrint).toHaveBeenCalledWith(false)
    expect(current.refresh).not.toHaveBeenCalled()

    prior.resolve()
    await batch
    expect(current.refresh).toHaveBeenCalledOnce()
  })

  it('serializes a cold 30-view print batch so every unique render reaches ready', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const mermaid = {
      initialize: vi.fn(() => undefined),
      parse: vi.fn(async () => ({ diagramType: 'flowchart-v2' })),
      render: vi.fn(async (_id: string, source: string) => {
        if (source === 'diagram-0') await firstGate
        return { svg: safeSvg }
      }),
    }
    const renderer = createMermaidRenderService({ loadMermaid: async () => mermaid })
    const registry = createMermaidViewRegistry(appearance)
    const results: MermaidRenderResult[] = []

    for (let index = 0; index < MERMAID_MAX_BLOCKS; index += 1) {
      const instanceId = `diagram-${index}`
      registry.register({
        preparePrint: () => undefined,
        refresh: () => {
          const task = renderer.render({
            instanceId,
            generation: 1,
            source: instanceId,
            appearance,
            signal: new AbortController().signal,
          }).then((result) => {
            results.push(result)
          })
          registry.track(instanceId, 1, task)
        },
        finishPrintTimeout: () => undefined,
      })
    }

    const batch = registry.renderAll()
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce())
    releaseFirst()
    await batch
    await registry.whenIdle()

    expect(results).toHaveLength(30)
    expect(results.filter((result) => result.status === 'ready')).toHaveLength(30)
    expect(results.filter((result) => (
      result.status === 'resource-error' && result.code === 'QUEUE_LIMIT'
    ))).toHaveLength(0)
  })

  it('uses queue-sized waves and waits before dispatching the next print wave', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const firstWave = Array.from({ length: MERMAID_QUEUE_LIMIT }, () => deferred<void>())
    const printViews = Array.from({ length: MERMAID_QUEUE_LIMIT + 1 }, (_, index) => {
      const current = {
        preparePrint: vi.fn(() => undefined),
        refresh: vi.fn(() => registry.track(
          `block-${index}`,
          1,
          firstWave[index]?.promise ?? Promise.resolve(),
        )),
        finishPrintTimeout: vi.fn(() => undefined),
      }
      registry.register(current)
      return current
    })

    const batch = registry.renderAll()
    await Promise.resolve()
    await Promise.resolve()
    expect(printViews.slice(0, MERMAID_QUEUE_LIMIT).every(
      (current) => current.refresh.mock.calls.length === 1,
    )).toBe(true)
    expect(printViews[MERMAID_QUEUE_LIMIT]!.refresh).not.toHaveBeenCalled()

    firstWave.forEach((gate) => gate.resolve())
    await batch
    expect(printViews[MERMAID_QUEUE_LIMIT]!.refresh).toHaveBeenCalledOnce()
  })

  it('stops undispatched print views after disposal without leaving the batch pending', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const first = deferred<void>()
    const firstRefresh = vi.fn(() => registry.track('first', 1, first.promise))
    const undispatchedRefresh = vi.fn()
    registry.register({
      preparePrint: () => undefined,
      refresh: firstRefresh,
      finishPrintTimeout: () => undefined,
    })
    for (let index = 1; index < MERMAID_QUEUE_LIMIT; index += 1) {
      registry.register({
        preparePrint: () => undefined,
        refresh: () => undefined,
        finishPrintTimeout: () => undefined,
      })
    }
    registry.register({
      preparePrint: () => undefined,
      refresh: undispatchedRefresh,
      finishPrintTimeout: () => undefined,
    })

    const batch = registry.renderAll()
    await Promise.resolve()
    await Promise.resolve()
    expect(firstRefresh).toHaveBeenCalledOnce()
    expect(undispatchedRefresh).not.toHaveBeenCalled()
    registry.dispose()
    first.resolve()

    await expect(batch).resolves.toBeUndefined()
    expect(undispatchedRefresh).not.toHaveBeenCalled()
  })

  it('finishes pending and undispatched views as timeout errors inside the print budget', async () => {
    vi.useFakeTimers()
    try {
      const registry = createMermaidViewRegistry(appearance)
      const blocked = deferred<void>()
      const printViews = Array.from({ length: MERMAID_MAX_BLOCKS }, (_, index) => {
        let generation = 0
        const current = {
          preparePrint: vi.fn(() => undefined),
          refresh: vi.fn(() => {
            generation += 1
            registry.track(`block-${index}`, generation, blocked.promise)
          }),
          finishPrintTimeout: vi.fn(() => {
            generation += 1
            registry.track(`block-${index}`, generation, Promise.resolve())
          }),
        }
        registry.register(current)
        return current
      })

      const batch = registry.renderAll()
      await Promise.resolve()
      await Promise.resolve()
      expect(printViews.slice(0, MERMAID_QUEUE_LIMIT).every(
        (current) => current.refresh.mock.calls.length === 1,
      )).toBe(true)
      expect(printViews.slice(MERMAID_QUEUE_LIMIT).every(
        (current) => current.refresh.mock.calls.length === 0,
      )).toBe(true)

      await vi.advanceTimersByTimeAsync(MERMAID_PRINT_BATCH_BUDGET_MS)
      await expect(batch).resolves.toBeUndefined()
      expect(printViews.every(
        (current) => current.finishPrintTimeout.mock.calls.length === 1,
      )).toBe(true)
      await expect(registry.whenIdle()).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors an already-expired main-process deadline before admitting a print wave', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-30T00:00:00.000Z'))
      const registry = createMermaidViewRegistry(appearance)
      const current = view()
      registry.register(current)

      await registry.renderAll(Date.now())

      expect(current.preparePrint).toHaveBeenCalledWith(true)
      expect(current.refresh).not.toHaveBeenCalled()
      expect(current.finishPrintTimeout).toHaveBeenCalledOnce()
      await expect(registry.whenIdle()).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reserves at least ten seconds of the main print-surface deadline for loading and layout', () => {
    expect(PRINT_DOCUMENT_SURFACE_TIMEOUT_MS - MERMAID_PRINT_BATCH_BUDGET_MS)
      .toBeGreaterThanOrEqual(10_000)
  })

  it('waits until the newest tracked generation settles', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const first = deferred<void>()
    const second = deferred<void>()
    registry.track('block', 1, first.promise)
    const idle = registry.whenIdle()
    registry.track('block', 2, second.promise)

    first.resolve()
    await Promise.resolve()
    expect(await promiseState(idle)).toBe('pending')

    second.resolve()
    await expect(idle).resolves.toBeUndefined()
  })

  it('settles when a tracked task rejects', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const rejected = deferred<void>()
    registry.track('block', 1, rejected.promise)
    const idle = registry.whenIdle()

    rejected.reject(new Error('render failed'))

    await expect(idle).resolves.toBeUndefined()
  })

  it('does not let stale completion remove a newer tracked generation', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const first = deferred<void>()
    const second = deferred<void>()
    registry.track('block', 1, first.promise)
    registry.track('block', 2, second.promise)
    const idle = registry.whenIdle()

    first.resolve()
    await Promise.resolve()
    expect(await promiseState(idle)).toBe('pending')

    second.resolve()
    await expect(idle).resolves.toBeUndefined()
  })

  it('clears views and makes future tracking inert after dispose', async () => {
    const registry = createMermaidViewRegistry(appearance)
    const current = view()
    registry.register(current)
    const task = deferred<void>()
    registry.track('block', 1, task.promise)

    registry.dispose()
    registry.renderAll()
    registry.refreshAppearance({ ...appearance, revision: 2 })
    registry.track('block', 2, Promise.resolve())
    task.resolve()

    expect(current.refresh).not.toHaveBeenCalled()
    await expect(registry.whenIdle()).resolves.toBeUndefined()
  })
})

// Keep the port in the test's type surface so API drift is caught by TypeScript.
const _registryPort: MermaidRegistryPort = createMermaidViewRegistry(appearance)
void _registryPort
