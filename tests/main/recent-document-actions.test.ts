import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type {
  DocumentOpenFailureParticipant,
  DocumentWindowOpener,
} from '../../src/main/document-window-opener'
import { openRecentDocumentSafely } from '../../src/main/recent-documents/recent-document-actions'
import { PUBLIC_ERROR_MESSAGES } from '../../src/shared/public-errors'

const roots: string[] = []

it.each(['DOCUMENT_BINARY', 'DOCUMENT_ENCODING_UNSUPPORTED', 'DOCUMENT_TEXT_TOO_LARGE'] as const)(
  'announces %s from a recent code document without deleting the recent entry', async (code) => {
    const root = await mkdtemp(path.join(tmpdir(), 'arkdown-recent-action-'))
    roots.push(root)
    const document = path.join(root, 'settings.json')
    await writeFile(document, '{}', 'utf8')
    const remove = vi.fn(async () => [])
    const showOpenError = vi.fn(async () => undefined)
    await openRecentDocumentSafely(document, {
      openDocumentInNewWindow: fakeDocumentWindowOpener(async () => {
        throw Object.assign(new Error('private internal diagnostic'), { code })
      }),
      remove, refreshMenus: vi.fn(), showFileNotFound: vi.fn(), showOpenError,
    })
    expect(showOpenError).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES[code])
    expect(remove).not.toHaveBeenCalled()
  },
)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fakeDocumentWindowOpener(
  implementation: (absolutePath: string) => Promise<void> = async () => undefined,
): DocumentWindowOpener {
  const open = vi.fn(implementation)
  return Object.assign(open, {
    withFailureOwner: async (
      absolutePath: string,
      participant: DocumentOpenFailureParticipant,
    ) => {
      try {
        await open(absolutePath)
      } catch (error) {
        await participant.handle(error)
      }
    },
  })
}

it('opens a valid recent document in a new window without mutating the current session', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-recent-action-'))
  roots.push(root)
  const document = path.join(root, 'note.md')
  await writeFile(document, '# Note\n', 'utf8')
  const openDocumentInNewWindow = fakeDocumentWindowOpener()
  const remove = vi.fn(async () => [])
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)

  await openRecentDocumentSafely(document, {
    openDocumentInNewWindow,
    remove,
    refreshMenus,
    showFileNotFound,
  })

  expect(openDocumentInNewWindow).toHaveBeenCalledOnce()
  expect(openDocumentInNewWindow).toHaveBeenCalledWith(expect.stringMatching(/note\.md$/i))
  expect(remove).not.toHaveBeenCalled()
  expect(showFileNotFound).not.toHaveBeenCalled()
})

it('removes a stale recent target, announces FILE_NOT_FOUND, and does not open a window', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-recent-action-'))
  roots.push(root)
  const missing = path.join(root, 'missing.md')
  const openDocumentInNewWindow = fakeDocumentWindowOpener()
  const remove = vi.fn(async () => [])
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)

  await openRecentDocumentSafely(missing, {
    openDocumentInNewWindow,
    remove,
    refreshMenus,
    showFileNotFound,
  })

  expect(openDocumentInNewWindow).not.toHaveBeenCalled()
  expect(remove).toHaveBeenCalledWith(missing)
  expect(refreshMenus).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)
})

it('still announces a stale target when removing it from storage fails', async () => {
  const missing = 'C:\\Docs\\missing.md'
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)

  await expect(openRecentDocumentSafely(missing, {
    openDocumentInNewWindow: fakeDocumentWindowOpener(),
    remove: vi.fn(async () => { throw new Error('disk full') }),
    refreshMenus,
    showFileNotFound,
  })).rejects.toThrow('disk full')

  expect(refreshMenus).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)
})

it('cleans up when a validated file disappears before the new window opens', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-recent-action-'))
  roots.push(root)
  const document = path.join(root, 'vanishing.md')
  await writeFile(document, '# Vanishing\n', 'utf8')
  const remove = vi.fn(async () => [])
  const refreshMenus = vi.fn()
  const showFileNotFound = vi.fn(async () => undefined)

  await openRecentDocumentSafely(document, {
    openDocumentInNewWindow: fakeDocumentWindowOpener(async () => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    }),
    remove,
    refreshMenus,
    showFileNotFound,
  })

  expect(remove).toHaveBeenCalledWith(document)
  expect(refreshMenus).toHaveBeenCalledOnce()
  expect(showFileNotFound).toHaveBeenCalledWith(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)
})
