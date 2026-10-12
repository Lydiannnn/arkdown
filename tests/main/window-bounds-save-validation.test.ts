import { expect, it, vi } from 'vitest'
import { installWindowBoundsSaveOnClose } from '../../src/main/settings/window-bounds-close'

it('does not persist bounds rejected by the display validator', async () => {
  let closeListener: ((event: { preventDefault(): void }) => void) | undefined
  const window = {
    on: (_event: 'close', listener: (event: { preventDefault(): void }) => void) => {
      closeListener = listener
    },
    getSize: () => [5000, 3000],
    getPosition: () => [9000, 9000],
    close: vi.fn(),
  }
  const save = vi.fn(async () => {})
  const close = installWindowBoundsSaveOnClose(window, {
    saveWindowBounds: save, prepareRendererClose: async () => ({ status: 'ready' }),
    reportError: vi.fn(), normalizeBounds: () => undefined,
  })

  closeListener?.({ preventDefault() {} })

  await vi.waitFor(() => expect(close.snapshot()?.error).toBe('window-settings-failed'))
  expect(save).not.toHaveBeenCalled()
  expect(window.close).not.toHaveBeenCalled()
  close.dispose()
})
