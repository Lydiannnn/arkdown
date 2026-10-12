import { expect, type ElectronApplication } from '@playwright/test'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
export const CLIPBOARD_IMAGE_SENTINEL = 'arkdown-image-paste-unwanted-text'

export async function installNativeClipboardImage(application: ElectronApplication): Promise<() => Promise<void>> {
  const previous = await application.evaluate(({ clipboard }) => ({
    text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(),
    image: clipboard.readImage().toPNG().toString('base64'),
  }))
  const actual = await application.evaluate(({ clipboard, nativeImage }, input) => {
    const image = nativeImage.createFromBuffer(Buffer.from(input.png, 'base64'))
    clipboard.write({ image, text: input.sentinel, html: `<p>${input.sentinel}</p>` })
    return { empty: clipboard.readImage().isEmpty(), size: clipboard.readImage().getSize(), text: clipboard.readText(), html: clipboard.readHTML() }
  }, { png: PNG, sentinel: CLIPBOARD_IMAGE_SENTINEL })
  expect(actual.empty).toBe(false)
  expect(actual.size).toEqual({ width: 1, height: 1 })
  expect(actual.text).toBe(CLIPBOARD_IMAGE_SENTINEL)
  expect(actual.html).toContain(CLIPBOARD_IMAGE_SENTINEL)
  return async () => {
    await application.evaluate(({ clipboard, nativeImage }, saved) => {
      clipboard.write({ text: saved.text, html: saved.html, rtf: saved.rtf,
        ...(saved.image ? { image: nativeImage.createFromBuffer(Buffer.from(saved.image, 'base64')) } : {}),
      })
    }, previous)
  }
}

export async function expectNativePng(application: ElectronApplication, target: string): Promise<void> {
  const result = await application.evaluate(({ nativeImage }, filePath) => {
    const image = nativeImage.createFromPath(filePath)
    return { empty: image.isEmpty(), size: image.getSize() }
  }, target)
  expect(result).toEqual({ empty: false, size: { width: 1, height: 1 } })
}
