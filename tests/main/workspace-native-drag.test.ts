import { expect, it, vi } from 'vitest'
import { prepareWorkspaceNativeDrag } from '../../src/main/workspace/workspace-native-drag'

it('uses the owned HWND and original admitted file with the Shell drag API', async () => {
  const startWorkspaceFileDrag = vi.fn(() => 'copy')
  const load = vi.fn(() => ({ startWorkspaceFileDrag }))
  const window = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.from([23, 0, 0, 0, 0, 0, 0, 0]) }
  const begin = await prepareWorkspaceNativeDrag(window, 'C:\\Notes\\保存.md', load)
  expect(startWorkspaceFileDrag).not.toHaveBeenCalled()
  expect(begin()).toBeUndefined()
  expect(startWorkspaceFileDrag).toHaveBeenCalledExactlyOnceWith(23n, 'C:\\Notes\\保存.md')
})

it('does not enter a native loop after its owning window has closed', async () => {
  let destroyed = false
  const startWorkspaceFileDrag = vi.fn(() => 'cancelled')
  const begin = await prepareWorkspaceNativeDrag({ isDestroyed: () => destroyed,
    getNativeWindowHandle: () => Buffer.alloc(8, 1) }, 'C:\\Notes\\note.md', () => ({ startWorkspaceFileDrag }))
  destroyed = true
  expect(begin).toThrow()
  expect(startWorkspaceFileDrag).not.toHaveBeenCalled()
})

it('accepts cancellation as a completed drag loop without retrying or claiming a copied file', async () => {
  const startWorkspaceFileDrag = vi.fn(() => 'cancelled')
  const begin = await prepareWorkspaceNativeDrag({ isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.alloc(8, 1) }, 'C:\\Notes\\note.md', () => ({ startWorkspaceFileDrag }))
  expect(begin()).toBeUndefined()
  expect(startWorkspaceFileDrag).toHaveBeenCalledOnce()
})

it('rejects an old addon before drag admission rather than silently reverting to incomplete file formats', async () => {
  await expect(prepareWorkspaceNativeDrag({ isDestroyed: () => false,
    getNativeWindowHandle: () => Buffer.alloc(8) }, 'C:\\Notes\\note.md', () => ({}))).rejects.toThrow('Shell file drag is unavailable')
})
