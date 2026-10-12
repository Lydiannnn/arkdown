import { describe, expect, it, vi } from 'vitest'
import { StickyNoteAppLifecycle } from '../../src/main/sticky-notes/sticky-note-app-lifecycle'

class FakeWindow {
  hidden = false
  closeCalls = 0
  private closeListener: ((event: { preventDefault(): void }) => void) | undefined

  on(event: 'close', listener: (event: { preventDefault(): void }) => void) {
    if (event === 'close') this.closeListener = listener
  }
  hide() { this.hidden = true }
  close() { this.closeCalls += 1 }
  isDestroyed() { return false }
  triggerClose() {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    this.closeListener?.(event)
    return event
  }
}

function setup(closeBehavior: 'tray' | 'quit' = 'tray') {
  const order: string[] = []
  const window = new FakeWindow()
  const options = {
    getCloseBehavior: vi.fn(() => closeBehavior),
    prepareMainWindows: vi.fn(async () => { order.push('prepare'); return true }),
    flushStickyNotes: vi.fn(async () => { order.push('flush') }),
    destroyTray: vi.fn(() => order.push('destroy-tray')),
    closeStickyWindows: vi.fn(async () => { order.push('close-sticky') }),
    quitApp: vi.fn(() => order.push('quit')),
    reportError: vi.fn(),
  }
  const lifecycle = new StickyNoteAppLifecycle(options)
  lifecycle.registerMainWindow(window)
  return { lifecycle, options, order, window }
}

describe('StickyNoteAppLifecycle', () => {
  it('hides the main window for close-to-tray without quitting', () => {
    const { lifecycle, options, window } = setup('tray')

    expect(window.triggerClose().defaultPrevented).toBe(true)
    expect(window.hidden).toBe(true)
    expect(lifecycle.isQuitting()).toBe(false)
    expect(options.prepareMainWindows).not.toHaveBeenCalled()
    expect(options.quitApp).not.toHaveBeenCalled()
  })

  it('prepares documents, flushes notes, then tears down and quits', async () => {
    const { lifecycle, order, window } = setup('quit')

    expect(window.triggerClose().defaultPrevented).toBe(true)
    await lifecycle.pendingQuit()

    expect(order).toEqual([
      'prepare',
      'flush',
      'destroy-tray',
      'close-sticky',
      'quit',
    ])
    expect(window.closeCalls).toBe(1)
    expect(lifecycle.isQuitting()).toBe(true)
  })

  it('tray quit bypasses close-to-tray and duplicate requests share one shutdown', async () => {
    const { lifecycle, options, window } = setup('tray')

    const first = lifecycle.requestQuit()
    const second = lifecycle.requestQuit()
    expect(first).toBe(second)
    await first

    expect(options.prepareMainWindows).toHaveBeenCalledTimes(1)
    expect(options.flushStickyNotes).toHaveBeenCalledTimes(1)
    expect(options.quitApp).toHaveBeenCalledTimes(1)
    expect(window.closeCalls).toBe(1)
  })

  it('keeps the process alive after all windows close unless shutdown is explicit', async () => {
    const { lifecycle, options } = setup('tray')

    lifecycle.handleWindowAllClosed()
    expect(options.quitApp).not.toHaveBeenCalled()

    await lifecycle.requestQuit()
    lifecycle.handleWindowAllClosed()
    expect(options.quitApp).toHaveBeenCalled()
  })

  it('aborts shutdown when a document refuses close preparation', async () => {
    const { lifecycle, options, window } = setup('quit')
    options.prepareMainWindows.mockResolvedValueOnce(false)

    await lifecycle.requestQuit()

    expect(lifecycle.isQuitting()).toBe(false)
    expect(options.flushStickyNotes).not.toHaveBeenCalled()
    expect(window.closeCalls).toBe(0)
  })

  it('keeps windows and tray alive after a sticky-note save failure and permits retry', async () => {
    const { lifecycle, options, order, window } = setup('tray')
    options.flushStickyNotes
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined)

    await expect(lifecycle.requestQuit()).resolves.toBe(false)

    expect(lifecycle.isQuitting()).toBe(false)
    expect(window.closeCalls).toBe(0)
    expect(options.destroyTray).not.toHaveBeenCalled()
    expect(options.closeStickyWindows).not.toHaveBeenCalled()
    expect(options.quitApp).not.toHaveBeenCalled()
    expect(options.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'disk full' }))

    await expect(lifecycle.requestQuit()).resolves.toBe(true)
    expect(options.flushStickyNotes).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['prepare', 'prepare', 'destroy-tray', 'close-sticky', 'quit'])
  })
})
