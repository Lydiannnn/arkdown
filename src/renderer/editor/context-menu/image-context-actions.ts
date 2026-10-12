import type { ApiResult, ArkdownApi } from '../../../shared/contracts'

type ImageResourceApi = Pick<
  ArkdownApi,
  'revealImage' | 'copyImage' | 'saveImageCopy' | 'copyImageTo'
>

export interface ImageActionResult {
  handled: boolean
  replacementSource?: string
  error?: string
}

function errorMessage(result: ApiResult<unknown> | undefined): string | undefined {
  return result && !result.ok ? result.error.message : undefined
}

export async function executeImageResourceCommand(
  command: string,
  source: string,
  api: ImageResourceApi,
  writeText: (value: string) => Promise<void>,
): Promise<ImageActionResult> {
  if (command === 'image-copy-address') {
    await writeText(source)
    return { handled: true }
  }
  if (command === 'image-reveal') {
    const result = await api.revealImage?.(source)
    return { handled: true, error: errorMessage(result) }
  }
  if (command === 'image-copy') {
    const result = await api.copyImage?.(source)
    return { handled: true, error: errorMessage(result) }
  }
  if (command === 'image-save-copy') {
    const result = await api.saveImageCopy?.(source)
    return { handled: true, error: errorMessage(result) }
  }
  if (command === 'image-copy-to') {
    const result = await api.copyImageTo?.(source)
    if (result && result.ok && result.value) {
      return { handled: true, replacementSource: result.value }
    }
    return { handled: true, error: errorMessage(result) }
  }
  return { handled: false }
}
