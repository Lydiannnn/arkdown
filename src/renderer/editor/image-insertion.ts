import type { ArkdownApi } from '../../shared/contracts'
import { DOCUMENT_TYPES } from '../../shared/document-types'

const IMAGE_ACCEPT = DOCUMENT_TYPES
  .filter((definition) => definition.category === 'image')
  .map((definition) => definition.mime)
  .join(',')

interface ImageInsertionOptions {
  api: Pick<ArkdownApi, 'pathForDroppedFile' | 'importAsset'>
  insertMarkdown(markdown: string): void
  reportError(message: string): void
}

async function importSelectedImage(
  file: File,
  options: ImageInsertionOptions,
): Promise<void> {
  const absolutePath = options.api.pathForDroppedFile(file)
  if (!absolutePath) {
    options.reportError('无法读取所选图片的 Windows 路径')
    return
  }
  if (!options.api.importAsset) {
    options.reportError('无法引用该图片')
    return
  }
  const result = await options.api.importAsset(absolutePath)
  if (!result.ok) {
    options.reportError(result.error.message)
    return
  }
  options.insertMarkdown(result.value.markdown)
}

export function chooseImageForInsertion(
  options: ImageInsertionOptions,
): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = IMAGE_ACCEPT
  input.multiple = false
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (!file) return
    void importSelectedImage(file, options)
  })
  input.click()
  return input
}
