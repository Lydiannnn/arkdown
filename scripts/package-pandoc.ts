import { access, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export async function copyPandocToPackages(
  outputPaths: readonly string[],
  sourceDirectory = path.join(process.cwd(), 'pandoc'),
): Promise<void> {
  const sourceExecutable = path.join(sourceDirectory, 'pandoc.exe')
  await access(sourceExecutable)
  await Promise.all(outputPaths.map(async (outputPath) => {
    const targetDirectory = path.join(outputPath, 'pandoc')
    await mkdir(targetDirectory, { recursive: true })
    await copyFile(sourceExecutable, path.join(targetDirectory, 'pandoc.exe'))
  }))
}
