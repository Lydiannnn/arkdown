import { expect, it, vi } from 'vitest'
import {
  WindowStateSnapshotController,
  type AcceptedWindowStateSnapshot,
} from '../../src/renderer/app/window-state-snapshot-controller'
import type { WindowStateSnapshot } from '../../src/shared/contracts'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

it('drops a deferred snapshot that resolves after disposal', async () => {
  const accepted = vi.fn<(acceptance: AcceptedWindowStateSnapshot) => void>()
  const controller = new WindowStateSnapshotController(accepted)
  const initial = deferred<WindowStateSnapshot>()
  const settlement = initial.promise.then((snapshot) => controller.accept(snapshot))

  controller.dispose()
  initial.resolve({ maximized: true, fullscreen: true, revision: 4 })

  await expect(settlement).resolves.toBe(false)
  expect(accepted).not.toHaveBeenCalled()
})

it('accepts only newer revisions and describes confirmed fullscreen transitions', () => {
  const acceptances: AcceptedWindowStateSnapshot[] = []
  const controller = new WindowStateSnapshotController((acceptance) => {
    acceptances.push(acceptance)
  })

  expect(controller.accept({ maximized: false, fullscreen: false, revision: 0 })).toBe(true)
  expect(controller.accept({ maximized: true, fullscreen: true, revision: 2 })).toBe(true)
  expect(controller.accept({ maximized: false, fullscreen: false, revision: 1 })).toBe(false)
  expect(controller.accept({ maximized: false, fullscreen: false, revision: 2 })).toBe(false)
  expect(controller.accept({ maximized: false, fullscreen: true, revision: 3 })).toBe(true)
  expect(controller.accept({ maximized: false, fullscreen: false, revision: 4 })).toBe(true)

  expect(acceptances).toEqual([
    {
      snapshot: { maximized: false, fullscreen: false, revision: 0 },
      transition: 'initial',
    },
    {
      snapshot: { maximized: true, fullscreen: true, revision: 2 },
      transition: 'entered-fullscreen',
    },
    {
      snapshot: { maximized: false, fullscreen: true, revision: 3 },
      transition: 'updated',
    },
    {
      snapshot: { maximized: false, fullscreen: false, revision: 4 },
      transition: 'exited-fullscreen',
    },
  ])
})

it('stops accepting newer snapshots once disposed', () => {
  const accepted = vi.fn<(acceptance: AcceptedWindowStateSnapshot) => void>()
  const controller = new WindowStateSnapshotController(accepted)

  expect(controller.accept({ maximized: false, fullscreen: false, revision: 0 })).toBe(true)
  controller.dispose()
  expect(controller.accept({ maximized: true, fullscreen: true, revision: 1 })).toBe(false)
  expect(accepted).toHaveBeenCalledOnce()
})
