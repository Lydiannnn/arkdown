import { readFile } from 'node:fs/promises'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

/** Structural PE fixture for in-memory tests only; must never be written as an EXE. */
export async function brandingExecutableFixture(is32Bit = false): Promise<Buffer> {
  const executable = NtExecutable.createEmpty(is32Bit, false)
  const resources = NtExecutableResource.from(executable)
  const icon = Data.IconFile.from(await readFile('assets/branding/arkdown-app-rounded.ico'))
  Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icon.icons.map(item => item.data))
  Resource.VersionInfo.create(1033, { fileVersionMS: 0x10000 }, [{
    lang: 1033, codepage: 1200,
    values: { ProductName: 'Arkdown', FileDescription: 'Arkdown', OriginalFilename: 'Arkdown.exe', FileVersion: '0.1.0' },
  }]).outputToResourceEntries(resources.entries)
  resources.entries.push({ type: 'INTEGRITY', id: 'ELECTRONASAR', lang: 1033, codepage: 1200,
    bin: new TextEncoder().encode('fixture-asar-integrity').buffer })
  resources.outputResource(executable)
  executable.setExtraData(Buffer.from('unrelated-electron-fuse-overlay'))
  return Buffer.from(executable.generate())
}
