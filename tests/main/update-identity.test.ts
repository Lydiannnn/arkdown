// @vitest-environment node
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readUpdateIdentity } from '../../src/main/updates/update-identity'
const roots: string[] = []
async function fixture(edition = 'full') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ark-update-')); roots.push(root)
  const resourcesPath = path.join(root, 'resources'); await mkdir(resourcesPath)
  await writeFile(path.join(resourcesPath, 'package-edition.json'), JSON.stringify({ schemaVersion: 1, edition, components: [] }))
  return { root, options: { appVersion: '1.0.4', isPackaged: true, resourcesPath, executablePath: path.join(root, 'Arkdown.exe'), channel: 'stable' as const } }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it.each(['full', 'lite'])('identifies %s portable and installer independently of portable-data', async edition => {
  const { root, options } = await fixture(edition)
  await mkdir(path.join(root, 'portable-data'))
  expect(await readUpdateIdentity(options)).toEqual({ version: '1.0.4', channel: 'stable', edition: edition === 'full' ? 'Full' : 'Lite', kind: 'portable' })
  await writeFile(path.join(root, '.arkdown-installation.ini'), '\ufeff[ArkdownStartup]\r\nInstance=20260920070000-12345\r\n', 'utf16le')
  expect(await readUpdateIdentity(options)).toMatchObject({ kind: 'installer' })
})
it('skips unpackaged, malformed and oversized metadata without guessing', async () => {
  const { root, options } = await fixture()
  expect(await readUpdateIdentity({ ...options, isPackaged: false })).toBeUndefined()
  await writeFile(path.join(root, '.arkdown-installation.ini'), 'broken')
  expect(await readUpdateIdentity(options)).toBeUndefined()
  await rm(path.join(root, '.arkdown-installation.ini'))
  await writeFile(path.join(options.resourcesPath, 'package-edition.json'), ' '.repeat(16385))
  expect(await readUpdateIdentity(options)).toBeUndefined()
  await rm(path.join(options.resourcesPath, 'package-edition.json'))
  expect(await readUpdateIdentity(options)).toBeUndefined()
})
