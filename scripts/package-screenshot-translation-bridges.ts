import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const SCREENSHOT_TRANSLATION_BRIDGE_FILES = [
  'windows-ocr.ps1',
  'windows-window-hit-test.ps1',
] as const

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function copyScreenshotTranslationBridges(
  outputPaths: readonly string[],
  sourceDirectory = path.join(process.cwd(), 'scripts'),
): Promise<void> {
  const packageRoots = outputPaths.map((outputPath) => path.resolve(outputPath))
  if (packageRoots.length === 0 || new Set(packageRoots.map((root) => root.toLocaleLowerCase('en-US'))).size !== packageRoots.length) {
    throw new Error('Invalid Forge package outputs')
  }
  await Promise.all(packageRoots.map(async (packageRoot) => {
    const rootEntries = await readdir(packageRoot, { withFileTypes: true })
    const executable = rootEntries.find((entry) => entry.name === 'Arkdown.exe')
    const resources = rootEntries.find((entry) => entry.name === 'resources')
    if (!executable?.isFile() || !resources?.isDirectory()) throw new Error('Invalid Forge package output')
    const resourceEntries = await readdir(path.join(packageRoot, resources.name), { withFileTypes: true })
    const archive = resourceEntries.find((entry) => entry.name === 'app.asar')
    if (!archive?.isFile()) throw new Error('Invalid Forge package output')
  }))
  const sources = await Promise.all(SCREENSHOT_TRANSLATION_BRIDGE_FILES.map(async (name) => {
    const source = path.join(sourceDirectory, name)
    await access(source)
    return { name, bytes: await readFile(source) }
  }))
  await Promise.all(packageRoots.map(async (packageRoot) => {
    const resources = path.join(packageRoot, 'resources')
    await mkdir(resources, { recursive: true })
    const staging = await mkdtemp(path.join(resources, '.screenshot-translation-'))
    const target = path.join(resources, 'screenshot-translation')
    try {
      for (const source of sources) {
        const destination = path.join(staging, source.name)
        await writeFile(destination, source.bytes, { flag: 'wx' })
        if (sha256(await readFile(destination)) !== sha256(source.bytes)) throw new Error('Screenshot bridge verification failed')
      }
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }))
}
