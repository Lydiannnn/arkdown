import { constants } from 'node:fs'
import { copyFile, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { documentTypeForPath } from '../../shared/document-types'
import { appError } from '../../shared/public-errors'

export type ImageCopyMode = 'save-copy' | 'copy-to'

export class ImageContextService {
  constructor(private readonly dependencies: {
    reveal(absolutePath: string): void
    copyImageToClipboard(absolutePath: string): Promise<void> | void
    chooseTarget(sourceAbsolutePath: string, mode: ImageCopyMode): Promise<string | null>
  }) {}

  private async canonicalImage(sourceAbsolutePath: string): Promise<string> {
    if (typeof sourceAbsolutePath !== 'string' || !path.isAbsolute(sourceAbsolutePath)) {
      throw appError('INVALID_INPUT')
    }
    const definition = documentTypeForPath(sourceAbsolutePath)
    if (definition?.category !== 'image') throw appError('UNSUPPORTED_FILE_TYPE')
    const metadata = await lstat(sourceAbsolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw appError('FILE_NOT_FOUND')
      throw error
    })
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const canonical = await realpath(sourceAbsolutePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw appError('FILE_NOT_FOUND')
      throw error
    })
    if (documentTypeForPath(canonical)?.category !== 'image') {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    return canonical
  }

  async reveal(sourceAbsolutePath: string): Promise<void> {
    this.dependencies.reveal(await this.canonicalImage(sourceAbsolutePath))
  }

  async copyToClipboard(sourceAbsolutePath: string): Promise<void> {
    await this.dependencies.copyImageToClipboard(
      await this.canonicalImage(sourceAbsolutePath),
    )
  }

  saveCopy(sourceAbsolutePath: string): Promise<string | null> {
    return this.copy(sourceAbsolutePath, 'save-copy')
  }

  copyTo(sourceAbsolutePath: string): Promise<string | null> {
    return this.copy(sourceAbsolutePath, 'copy-to')
  }

  private async copy(
    sourceAbsolutePath: string,
    mode: ImageCopyMode,
  ): Promise<string | null> {
    const source = await this.canonicalImage(sourceAbsolutePath)
    const target = await this.dependencies.chooseTarget(source, mode)
    if (target === null) return null
    if (!path.isAbsolute(target)) throw appError('INVALID_INPUT')
    if (
      documentTypeForPath(target)?.category !== 'image'
      || path.extname(target).toLocaleLowerCase('en-US')
        !== path.extname(source).toLocaleLowerCase('en-US')
    ) {
      throw appError('INVALID_INPUT')
    }
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL)
      return target
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') throw appError('PERMISSION_DENIED')
      throw appError('ASSET_COPY_FAILED')
    }
  }
}
