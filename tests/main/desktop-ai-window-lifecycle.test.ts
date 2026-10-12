import { expect, it, vi } from 'vitest'
import { DesktopAiWindowLifecycle } from '../../src/main/desktop-ai-window-lifecycle'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => { resolve = yes })
  return { promise, resolve }
}

it('drains transports before AI and broker disposal, then unregisters transport and ordinary IPC', async () => {
  const order: string[] = []
  const transportDrain = deferred()
  const lifecycle = new DesktopAiWindowLifecycle({
    disposeConversations: async () => { order.push('conversations') },
    disposeCurrentDocument: async () => { order.push('broker') },
    disposeOrdinary: async () => { order.push('ordinary') },
  })
  lifecycle.registerTransportLifecycle({
    pauseAndDrain: async () => {
      order.push('transport-drain')
      await transportDrain.promise
    },
    unregister: async () => { order.push('transport-unregister') },
  })

  const disposing = lifecycle.dispose()
  await vi.waitFor(() => expect(order).toEqual(['transport-drain']))
  transportDrain.resolve()
  await disposing

  expect(order).toEqual([
    'transport-drain',
    'conversations',
    'broker',
    'transport-unregister',
    'ordinary',
  ])
})

it('continues every cleanup stage after failures and remains idempotent', async () => {
  const order: string[] = []
  const lifecycle = new DesktopAiWindowLifecycle({
    disposeConversations: async () => {
      order.push('conversations')
      throw new Error('conversation cleanup failed')
    },
    disposeCurrentDocument: async () => { order.push('broker') },
    disposeOrdinary: async () => { order.push('ordinary') },
  })
  lifecycle.registerTransportLifecycle({
    pauseAndDrain: async () => {
      order.push('transport-drain')
      throw new Error('transport drain failed')
    },
    unregister: async () => { order.push('transport-unregister') },
  })

  const first = lifecycle.dispose()
  const repeated = lifecycle.dispose()
  expect(repeated).toBe(first)
  await expect(first).rejects.toThrow('Desktop AI window cleanup failed')
  expect(order).toEqual([
    'transport-drain',
    'conversations',
    'broker',
    'transport-unregister',
    'ordinary',
  ])
})

it('rejects transport registration once irreversible cleanup has started', async () => {
  const disposeConversations = deferred()
  const lifecycle = new DesktopAiWindowLifecycle({
    disposeConversations: () => disposeConversations.promise,
    disposeCurrentDocument: vi.fn(async () => undefined),
    disposeOrdinary: vi.fn(async () => undefined),
  })

  const disposing = lifecycle.dispose()
  expect(() => lifecycle.registerTransportLifecycle({
    pauseAndDrain: vi.fn(async () => undefined),
    unregister: vi.fn(async () => undefined),
  })).toThrow('Desktop AI transport registration is closed')
  disposeConversations.resolve()
  await disposing
})
