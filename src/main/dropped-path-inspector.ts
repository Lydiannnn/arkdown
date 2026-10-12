import { lstat } from 'node:fs/promises'
import path from 'node:path'
import type { DroppedPathInspection } from '../shared/contracts'
import { isEditableDocumentPath } from '../shared/document-types'
import { appError } from '../shared/public-errors'

export async function inspectDroppedPath(
  absolutePath: string,
  resolveDocumentShortcut = false,
): Promise<DroppedPathInspection> {
  if (!path.isAbsolute(absolutePath)) throw appError('INVALID_INPUT')
  const metadata = await lstat(absolutePath).catch(() => {
    throw appError('FILE_NOT_FOUND')
  })
  if (metadata.isSymbolicLink()) throw appError('UNSUPPORTED_FILE_TYPE')
  if (metadata.isFile() && resolveDocumentShortcut && path.extname(absolutePath).toLowerCase() === '.lnk') {
    // Read the target only: never launch a shortcut or interpret its command-line arguments.
    const { shell } = await import('electron')
    let shortcut: Electron.ShortcutDetails
    try {
      shortcut = shell.readShortcutLink(absolutePath)
    } catch {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    if (
      !shortcut.target || !path.isAbsolute(shortcut.target)
      || shortcut.target.length > 32767 || shortcut.args?.trim()
      || !isEditableDocumentPath(shortcut.target)
    ) throw appError('UNSUPPORTED_FILE_TYPE')
    const target = await inspectDroppedPath(shortcut.target)
    if (target.kind !== 'file') throw appError('UNSUPPORTED_FILE_TYPE')
    return target
  }
  if (metadata.isFile()) return { kind: 'file', absolutePath }
  if (metadata.isDirectory()) return { kind: 'directory', absolutePath }
  throw appError('UNSUPPORTED_FILE_TYPE')
}
