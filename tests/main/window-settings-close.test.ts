import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { installWindowBoundsSaveOnClose } from '../../src/main/settings/window-bounds-close'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

class FakeWindow {
  closeCalls = 0
  private closeListener: ((event: { preventDefault(): void }) => void) | undefined

  on(event: 'close', listener: (closeEvent: { preventDefault(): void }) => void): void {
    if (event === 'close') this.closeListener = listener
  }

  getSize(): [number, number] {
    return [1200, 800]
  }

  getPosition(): [number, number] {
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

it('saves bounds before closing the window', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-close-'))
  roots.push(root)
  const window = new FakeWindow()
  const store = new SettingsStore(root)
  const close = installWindowBoundsSaveOnClose(window, {
    saveWindowBounds: async windowBounds => { await store.save({ lastWorkspace: 'C:\\文档', windowBounds }) },
    prepareRendererClose: async () => ({ status: 'ready' }), reportError: () => {},
  })

  const event = window.triggerClose()

  expect(event.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(window.closeCalls).toBe(1))
  close.closed()
  await expect(store.load()).resolves.toEqual({
    lastWorkspace: 'C:\\文档',
    windowBounds: { width: 1200, height: 800, x: 80, y: 60 },
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
  })
})

it('keeps the window open and allows retry when saving fails', async () => {
  const window = new FakeWindow()
  let saves = 0
  const reportError = vi.fn()
  const close = installWindowBoundsSaveOnClose(window, {
      saveWindowBounds: async () => {
        saves += 1
        throw new Error('disk full')
      },
      prepareRendererClose: async () => ({ status: 'ready' }), reportError,
  })

  expect(window.triggerClose().defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(1))
  expect(window.closeCalls).toBe(0)

  expect(window.triggerClose().defaultPrevented).toBe(true)
  expect(saves).toBe(1)
  await close.retry()
  await vi.waitFor(() => expect(saves).toBe(2))
  close.dispose()
})

it('does not start document-close preparation after a tray handler prevented close', async () => {
  const window = new FakeWindow()
  const prepare = vi.fn(async () => ({ status: 'ready' as const }))
  const save = vi.fn(async () => undefined)
  installWindowBoundsSaveOnClose(window, { saveWindowBounds: save, prepareRendererClose: prepare, reportError: vi.fn() })

  const event = {
    defaultPrevented: true,
    preventDefault() { this.defaultPrevented = true },
  }
  ;(window as unknown as { closeListener?: (value: { defaultPrevented: boolean; preventDefault(): void }) => void }).closeListener?.(event)
  expect(prepare).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
})
