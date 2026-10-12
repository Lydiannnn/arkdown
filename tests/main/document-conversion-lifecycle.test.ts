import { describe, expect, it, vi } from 'vitest'
import {
  createDocumentConversionRuntimeLifecycle,
  runWithDocumentConversionStartupRollback,
} from '../../src/main/document-conversion/document-conversion-lifecycle'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('document conversion runtime lifecycle', () => {
  it('drains conversion execution before disposing the component manager', async () => {
    const conversionCleanup = deferred()
    const managerCleanup = deferred()
    const order: string[] = []
    const conversions = {
      disposeAndDrain: vi.fn(() => {
        order.push('conversion-abort')
        return conversionCleanup.promise.then(() => { order.push('conversion-cleanup') })
      }),
    }
    const manager = {
      dispose: vi.fn(() => {
        order.push('manager-dispose')
        return managerCleanup.promise.then(() => { order.push('manager-cleanup') })
      }),
    }
    const lifecycle = createDocumentConversionRuntimeLifecycle({ conversions, manager })

    const first = lifecycle.dispose()
    const second = lifecycle.dispose()
    expect(second).toBe(first)
    expect(order).toEqual(['conversion-abort'])
    expect(manager.dispose).not.toHaveBeenCalled()

    conversionCleanup.resolve()
    await vi.waitFor(() => expect(manager.dispose).toHaveBeenCalledOnce())
    expect(order).toEqual(['conversion-abort', 'conversion-cleanup', 'manager-dispose'])

    managerCleanup.resolve()
    await first
    expect(order).toEqual([
      'conversion-abort',
      'conversion-cleanup',
      'manager-dispose',
      'manager-cleanup',
    ])
    expect(conversions.disposeAndDrain).toHaveBeenCalledOnce()
  })

  it('awaits conversion and manager rollback before propagating a later startup failure', async () => {
    const conversionCleanup = deferred()
    const managerCleanup = deferred()
    const order: string[] = []
    const lifecycle = createDocumentConversionRuntimeLifecycle({
      conversions: {
        disposeAndDrain: vi.fn(() => {
          order.push('conversion-abort')
          return conversionCleanup.promise.then(() => { order.push('conversion-cleanup') })
        }),
      },
      manager: {
        dispose: vi.fn(() => {
          order.push('manager-dispose')
          return managerCleanup.promise.then(() => { order.push('manager-cleanup') })
        }),
      },
    })
    const startupFailure = new Error('later startup failure')
    let startupSettled = false

    const startup = runWithDocumentConversionStartupRollback(lifecycle, async () => {
      order.push('startup')
      throw startupFailure
    }).finally(() => { startupSettled = true })

    await vi.waitFor(() => expect(order).toEqual(['startup', 'conversion-abort']))
    expect(startupSettled).toBe(false)
    conversionCleanup.resolve()
    await vi.waitFor(() => expect(order).toEqual([
      'startup', 'conversion-abort', 'conversion-cleanup', 'manager-dispose',
    ]))
    expect(startupSettled).toBe(false)
    managerCleanup.resolve()

    await expect(startup).rejects.toBe(startupFailure)
    expect(order).toEqual([
      'startup',
      'conversion-abort',
      'conversion-cleanup',
      'manager-dispose',
      'manager-cleanup',
    ])
  })
})
