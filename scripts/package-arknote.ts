import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

export const arknoteIconPath = path.resolve(import.meta.dirname, '../assets/branding/arknote-app.ico')

/** Deterministic resource-only transform; retains executable code, fuses and ASAR integrity. */
export function createArknoteExecutable(source: Uint8Array, icon: Uint8Array): Buffer {
  const executable = NtExecutable.from(source)
  const resources = NtExecutableResource.from(executable)
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  const versions = Resource.VersionInfo.fromEntries(resources.entries)
  if (groups.length !== 1 || versions.length !== 1) throw new Error('Expected one Electron icon group and version resource')
  const icons = Data.IconFile.from(icon)
  if (!icons.icons.length) throw new Error('Arknote icon has no frames')
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, groups[0].id, groups[0].lang, icons.icons.map(item => item.data))
  const version = versions[0]
  for (const language of version.getAllLanguagesForStringValues()) {
    version.setStringValues(language, {
      ProductName: 'Arknote', FileDescription: 'Arknote', InternalName: 'Arknote', OriginalFilename: 'Arknote.exe',
      CompanyName: 'Miterh', LegalCopyright: 'Copyright (c) 2026 Miterh',
    })
  }
  version.outputToResourceEntries(resources.entries)
  resources.outputResource(executable)
  return Buffer.from(executable.generate())
}

export async function copyArknoteExecutable(
  outputPaths: readonly string[],
): Promise<void> {
  const icon = await readFile(arknoteIconPath)
  for (const outputPath of outputPaths) {
    const packageRoot = path.resolve(outputPath)
    const source = await readFile(path.join(packageRoot, 'Arkdown.exe'))
    await writeFile(path.join(packageRoot, 'Arknote.exe'), createArknoteExecutable(source, icon))
  }
}
