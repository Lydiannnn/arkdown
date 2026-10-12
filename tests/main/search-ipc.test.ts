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
    getSearchPreferences: vi.fn(() => ({
      provider: 'bing' as const,
      customTemplate: '',
    })),
    setSearchPreferences: vi.fn(async () => undefined),
    searchSelection: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
  }
}

it('gets, updates and executes browser search through validated operations', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  await expect(operations.getSearchPreferences()).resolves.toEqual({
    ok: true,
    value: { provider: 'bing', customTemplate: '' },
  })
  await expect(operations.setSearchPreferences({
    provider: 'google',
    customTemplate: '',
  })).resolves.toEqual({
    ok: true,
    value: { provider: 'google', customTemplate: '' },
  })
  expect(deps.setSearchPreferences).toHaveBeenCalledWith({
    provider: 'google',
    customTemplate: '',
  })

  await expect(operations.searchSelection({ query: 'Arkdown' })).resolves.toEqual({
    ok: true,
    value: null,
  })
  expect(deps.searchSelection).toHaveBeenCalledWith('Arkdown')
})

it('rejects malformed search settings and queries before side effects', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  for (const input of [
    { provider: 'unknown', customTemplate: '' },
    { provider: 'duckduckgo', customTemplate: '' },
    { provider: 'custom', customTemplate: 'http://example.com/?q={query}' },
    { provider: 'bing', customTemplate: '', extra: true },
  ]) {
    await expect(operations.setSearchPreferences(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  await expect(operations.searchSelection({ query: '😀'.repeat(1001) })).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })

  expect(deps.setSearchPreferences).not.toHaveBeenCalled()
  expect(deps.searchSelection).not.toHaveBeenCalled()
})

it('parses supported link targets again in main before opening them', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  await expect(operations.openExternal({ target: 'https://example.com/doc' })).resolves.toEqual({
    ok: true,
    value: null,
  })
  expect(deps.openExternal).toHaveBeenCalledWith('https://example.com/doc')

  await expect(operations.openExternal({
    target: 'file:///C:/Literal%20Folder/note.md',
  })).resolves.toEqual({ ok: true, value: null })
  expect(deps.openExternal).toHaveBeenLastCalledWith('C:\\Literal Folder\\note.md')

  for (const target of [
    'javascript:alert(1)',
    'mailto:hello@example.com',
    'relative.md',
    'https://user:secret@example.com',
    'file:///C:/private.txt?query=unsafe',
  ]) {
    await expect(operations.openExternal({ target })).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
})
