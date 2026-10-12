import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

const defaults = { leftSidebarWidth: 300, rightSidebarWidth: 530 }

function dependencies() {
  return {
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    getLayoutPreferences: vi.fn(() => ({ layout: defaults, revision: 0 })),
    compareAndSetLayoutPreferences: vi.fn(async () => ({
      applied: false,
      snapshot: { layout: { leftSidebarWidth: 420, rightSidebarWidth: 760 }, revision: 1 },
    })),
  }
}

it('exposes only revisioned layout preference writes through IPC operations', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  await expect(operations.getLayoutPreferences()).resolves.toEqual({
    ok: true,
    value: { layout: defaults, revision: 0 },
  })
  expect(operations).not.toHaveProperty('setLayoutPreferences')
})

it('uses a strict expected layout revision for compare-and-set writes', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)
  const replacement = { leftSidebarWidth: 420, rightSidebarWidth: 760 }

  await expect(operations.compareAndSetLayoutPreferences({
    expectedRevision: 0,
    expectedLayout: defaults,
    replacement,
  })).resolves.toEqual({
    ok: true,
    value: {
      applied: false,
      snapshot: { layout: replacement, revision: 1 },
    },
  })
  expect(deps.compareAndSetLayoutPreferences).toHaveBeenCalledWith(0, defaults, replacement)
})

it('rejects malformed, out-of-bounds, and unsafe-revision layout compare-and-set writes', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  for (const replacement of [
    { leftSidebarWidth: 179, rightSidebarWidth: 530 },
    { leftSidebarWidth: 300, rightSidebarWidth: 239 },
    { leftSidebarWidth: 600.5, rightSidebarWidth: 530 },
    { leftSidebarWidth: 300, rightSidebarWidth: 1801 },
    { leftSidebarWidth: 300, rightSidebarWidth: 530, extra: true },
  ]) {
    await expect(operations.compareAndSetLayoutPreferences({
      expectedRevision: 0,
      expectedLayout: defaults,
      replacement,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  await expect(operations.compareAndSetLayoutPreferences({
    expectedRevision: Number.MAX_SAFE_INTEGER + 1,
    expectedLayout: defaults,
    replacement: defaults,
  })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  expect(deps.compareAndSetLayoutPreferences).not.toHaveBeenCalled()
})
