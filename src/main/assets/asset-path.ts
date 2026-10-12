import { lstat, realpath } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { documentTypeForPath } from '../../shared/document-types'
import {
  externalAssetPathFromUrl,
  externalAssetUrl,
} from '../../shared/local-resource-path'
import { appError } from '../../shared/public-errors'

export { ASSET_PROTOCOL } from '../../shared/asset-protocol'
import { ASSET_PROTOCOL } from '../../shared/asset-protocol'

function isPreviewCategory(category: string | undefined): boolean {
  return category === 'image' || category === 'audio' || category === 'video'
}

export class AssetAccessRegistry {
  async allowRoot(_root: string): Promise<void> {
    // Source-linked resources do not grant directory-wide access.
  }

  async urlFor(target: string): Promise<string> {
    const metadata = await lstat(target).catch(() => {
      throw appError('FILE_NOT_FOUND')
    })
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const canonical = await realpath(target).catch(() => {
      throw appError('FILE_NOT_FOUND')
    })
    if (!isPreviewCategory(documentTypeForPath(canonical)?.category)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    return externalAssetUrl(canonical)
  }

  async resolve(url: string): Promise<string> {
    const requested = externalAssetPathFromUrl(url)
    if (!requested) throw appError('INVALID_INPUT')
    if (!isPreviewCategory(documentTypeForPath(requested)?.category)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const metadata = await lstat(requested).catch(() => {
      throw appError('FILE_NOT_FOUND')
    })
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const canonical = await realpath(requested).catch(() => {
      throw appError('FILE_NOT_FOUND')
    })
    if (!isPreviewCategory(documentTypeForPath(canonical)?.category)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    return canonical
  }

  async responseUrl(url: string): Promise<string> {
    return pathToFileURL(await this.resolve(url)).toString()
  }
}
