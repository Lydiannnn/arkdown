import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

function dependencies() {
  return {
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    imageContext: {
      reveal: vi.fn(async () => undefined),
      copyToClipboard: vi.fn(async () => undefined),
      saveCopy: vi.fn(async () => 'C:\\copies\\photo.png'),
      copyTo: vi.fn(async () => 'C:\\assets\\photo.png'),
    },
  }
}

it('dispatches validated image-only operations and returns selected copy paths', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)
  const source = 'C:\\photos\\photo.png'

  await expect(operations.revealImage({ source })).resolves.toEqual({
    ok: true,
    value: null,
  })
  await expect(operations.copyImage({ source })).resolves.toEqual({
    ok: true,
    value: null,
  })
  await expect(operations.saveImageCopy({ source })).resolves.toEqual({
    ok: true,
    value: 'C:\\copies\\photo.png',
  })
  await expect(operations.copyImageTo({ source })).resolves.toEqual({
    ok: true,
    value: 'C:\\assets\\photo.png',
  })

  expect(deps.imageContext.reveal).toHaveBeenCalledWith(source)
  expect(deps.imageContext.copyToClipboard).toHaveBeenCalledWith(source)
  expect(deps.imageContext.saveCopy).toHaveBeenCalledWith(source)
  expect(deps.imageContext.copyTo).toHaveBeenCalledWith(source)
})

it('rejects relative and non-image-looking source paths before side effects', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  for (const source of ['photo.png', 'C:\\photos\\photo.txt', '']) {
    await expect(operations.revealImage({ source })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  expect(deps.imageContext.reveal).not.toHaveBeenCalled()
})
