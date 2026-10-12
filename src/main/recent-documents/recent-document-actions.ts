import { realpath, stat } from 'node:fs/promises'
import { documentTypeForPath, isEditableDocumentPath } from '../../shared/document-types'
import { PUBLIC_ERROR_MESSAGES } from '../../shared/public-errors'
import { documentOpenErrorMessage, type DocumentWindowOpener } from '../document-window-opener'

export interface RecentDocumentActions {
  openDocumentInNewWindow: DocumentWindowOpener
  remove(absolutePath: string): Promise<readonly string[]>
  refreshMenus(): void
  showFileNotFound(message: string): Promise<void>
  showOpenError?(message: string): Promise<void>
}

async function validRecentTarget(absolutePath: string): Promise<string | null> {
  try {
    const canonical = await realpath(absolutePath)
    const metadata = await stat(canonical)
    const definition = documentTypeForPath(canonical)
    return (
      metadata.isFile()
      && (isEditableDocumentPath(canonical) || definition?.importWithPandoc === true)
    ) ? canonical : null
  } catch {
    return null
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'FILE_NOT_FOUND'
}

async function removeStaleRecentDocument(
  absolutePath: string,
  actions: RecentDocumentActions,
): Promise<void> {
  let removalError: unknown
  try {
    await actions.remove(absolutePath)
  } catch (error) {
    removalError = error
  }
  actions.refreshMenus()
  await actions.showFileNotFound(PUBLIC_ERROR_MESSAGES.FILE_NOT_FOUND)
  if (removalError !== undefined) throw removalError
}

export async function openRecentDocumentSafely(
  absolutePath: string,
  actions: RecentDocumentActions,
): Promise<void> {
  const target = await validRecentTarget(absolutePath)
  if (target) {
    await actions.openDocumentInNewWindow.withFailureOwner(target, {
      kind: 'recent',
      handle: async (error) => {
        if (!isMissingFileError(error)) {
          if (!actions.showOpenError) throw error
          await actions.showOpenError(documentOpenErrorMessage(error))
          return
        }
        await removeStaleRecentDocument(absolutePath, actions)
      },
    })
    return
  }

  await removeStaleRecentDocument(absolutePath, actions)
}
