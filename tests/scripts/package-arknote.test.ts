import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyArknoteExecutable, createArknoteExecutable } from '../../scripts/package-arknote'
import { brandingExecutableFixture } from '../fixtures/branding-executable'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'

// Minimal PE fixtures are structural test data, not runnable programs. Keep them
// in memory: emitting them as EXEs caused real-time antivirus alerts on Windows.
describe('Arknote packaged executable', () => {
  it('embeds the approved N without changing Arkdown, integrity, version or overlay', async () => {
    const editorBytes = await brandingExecutableFixture()
    const original = Buffer.from(editorBytes)
    const output = createArknoteExecutable(editorBytes, await readFile('assets/branding/arknote-app.ico'))
    expect(editorBytes).toEqual(original)
    expect(output).not.toEqual(editorBytes)
    const executable = NtExecutable.from(output), resources = NtExecutableResource.from(executable)
    const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
    const expected = Data.IconFile.from(await readFile('assets/branding/arknote-app.ico'))
    expect(groups).toHaveLength(1)
    expect(groups[0].icons).toHaveLength(42)
    expect(groups[0].getIconItemsFromEntries(resources.entries).map(i => Buffer.from(i.isRaw() ? i.bin : i.generate())))
      .toEqual(expected.icons.map(i => Buffer.from(i.data.isRaw() ? i.data.bin : i.data.generate())))
    expect(executable.getExtraData()).toEqual(NtExecutable.from(editorBytes).getExtraData())
    expect(resources.entries.find(e => e.type === 'INTEGRITY')?.bin)
      .toEqual(NtExecutableResource.from(NtExecutable.from(editorBytes)).entries.find(e => e.type === 'INTEGRITY')?.bin)
    const info = Resource.VersionInfo.fromEntries(resources.entries)[0]
    expect(info.getStringValues(info.getAllLanguagesForStringValues()[0])).toMatchObject({
      ProductName: 'Arknote', FileDescription: 'Arknote', OriginalFilename: 'Arknote.exe', FileVersion: '0.1.0',
      CompanyName: 'Miterh', LegalCopyright: 'Copyright (c) 2026 Miterh',
    })
  })

  it.each([false, true])('preserves PE architecture (32-bit: %s)', async (is32Bit) => {
    const output = createArknoteExecutable(await brandingExecutableFixture(is32Bit), await readFile('assets/branding/arknote-app.ico'))
    expect(NtExecutable.from(output).is32bit()).toBe(is32Bit)
  })

  it('fails instead of producing a broken Arknote executable when Arkdown.exe is missing', async () => {
    const packageRoot = path.resolve('missing-in-memory-package')

    await expect(copyArknoteExecutable([packageRoot])).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
