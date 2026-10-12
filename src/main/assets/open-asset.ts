import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { documentTypeForPath } from '../../shared/document-types'
import { appError } from '../../shared/public-errors'

export async function openPdfAsset(
  target: string,
  _resolveAsset: (url: string) => Promise<string>,
  openPath: (target: string) => Promise<string>,
): Promise<void> {
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    throw appError('INVALID_INPUT')
  }
  const metadata = await lstat(target).catch(() => {
    throw appError('FILE_NOT_FOUND')
  })
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw appError('UNSUPPORTED_FILE_TYPE')
  }
  const canonical = await realpath(target).catch(() => {
    throw appError('FILE_NOT_FOUND')
  })
  const category = documentTypeForPath(canonical)?.category
  if (category !== 'pdf' && category !== 'attachment') {
    throw appError('UNSUPPORTED_FILE_TYPE')
  }
  const error = await openPath(canonical)
  if (error) throw new Error(error)
}
