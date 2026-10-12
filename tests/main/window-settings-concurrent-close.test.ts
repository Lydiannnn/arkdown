import { expect, it, vi } from 'vitest'
import { installWindowBoundsSaveOnClose } from '../../src/main/settings/window-bounds-close'

class FakeWindow {
  closeCalls = 0
  private closeListener: ((event: { preventDefault(): void }) => void) | undefined

  on(event: 'close', listener: (closeEvent: { preventDefault(): void }) => void): void {
    if (event === 'close') this.closeListener = listener
  }

  getSize(): number[] {
    return [1200, 800]
  }

  getPosition(): number[] {
    return [80, 60]
  }

  close(): void {
    this.closeCalls += 1
  }

  triggerClose(): { defaultPrevented: boolean } {
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    this.closeListener?.(event)
    return event
  }
}

it('prevents concurrent close events until settings are persisted', async () => {
  const window = new FakeWindow()
  let resolveSave: (() => void) | undefined
  const savePromise = new Promise<void>((resolve) => {
    resolveSave = resolve
  })
  const close = installWindowBoundsSaveOnClose(window, {
    saveWindowBounds: () => savePromise, prepareRendererClose: async () => ({ status: 'ready' }), reportError: () => {},
  })

  expect(window.triggerClose().defaultPrevented).toBe(true)
  expect(window.triggerClose().defaultPrevented).toBe(true)
  expect(window.closeCalls).toBe(0)

  resolveSave?.()
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
  close.closed()
})
