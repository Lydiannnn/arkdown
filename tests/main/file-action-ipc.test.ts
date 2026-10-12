import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

const revision = 'a'.repeat(64)

function dependencies() {
  const workspace = {
    resolveExistingDocument: vi.fn(async (relativePath: string) => `C:\\notes\\${relativePath}`),
  }
  const documents = {
    create: vi.fn(async (relativePath: string, markdown: string) => ({
      relativePath,
      markdown,
      revision,
      encoding: 'utf8' as const,
      newline: 'lf' as const,
      mtimeMs: 1,
    })),
  }
  return {
    chooseDirectory: vi.fn(),
    workspace,
    documents,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn(async () => undefined),
  }
}

it('creates, reveals, and trashes validated workspace documents', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps as never) as unknown as {
    createDocument(input: unknown): Promise<unknown>
    revealDocument(input: unknown): Promise<unknown>
    trashDocument(input: unknown): Promise<unknown>
  }

  await expect(operations.createDocument({ relativePath: 'new.md' })).resolves.toMatchObject({
    ok: true,
    value: { relativePath: 'new.md', markdown: '' },
  })
  expect(deps.documents.create).toHaveBeenCalledWith('new.md', '')

  await expect(operations.revealDocument({ relativePath: 'new.md' })).resolves.toEqual({
    ok: true,
    value: null,
  })
  expect(deps.showItemInFolder).toHaveBeenCalledWith('C:\\notes\\new.md')

  await expect(operations.trashDocument({ relativePath: 'new.md' })).resolves.toEqual({
    ok: true,
    value: null,
  })
  expect(deps.trashItem).toHaveBeenCalledWith('C:\\notes\\new.md')
})

it('rejects extra keys and invalid paths before file side effects', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps as never) as unknown as {
    createDocument(input: unknown): Promise<unknown>
    revealDocument(input: unknown): Promise<unknown>
    trashDocument(input: unknown): Promise<unknown>
  }

  for (const input of [
    { relativePath: 7 },
    { relativePath: 'new.md', extra: true },
    { relativePath: 'x'.repeat(32768) },
  ]) {
    await expect(operations.createDocument(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    await expect(operations.revealDocument(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
    await expect(operations.trashDocument(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  expect(deps.documents.create).not.toHaveBeenCalled()
  expect(deps.showItemInFolder).not.toHaveBeenCalled()
  expect(deps.trashItem).not.toHaveBeenCalled()
})
