export type ReadClipboardImage = () => Promise<string | null>

export function clipboardHasImage(data: DataTransfer): boolean {
  return Array.from(data.types).some((type) => type.startsWith('image/'))
    || Array.from(data.items ?? []).some((item) => item.kind === 'file' && item.type.startsWith('image/'))
}

export async function readClipboardMarkdown(readImage: ReadClipboardImage | undefined, imageOnly = false): Promise<string | null> {
  const image = await readImage?.()
  if (image) return image
  if (imageOnly) return null
  return await navigator.clipboard?.readText() ?? null
}
