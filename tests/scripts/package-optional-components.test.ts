import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, expect, it } from 'vitest'
import { auditComponentTree, publishRuntimeComponent } from '../../scripts/package-optional-components'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-optional-package-')); roots.push(root)
  const runtime = path.join(root, 'runtime'); await mkdir(path.join(runtime, 'licenses'), { recursive: true })
  await writeFile(path.join(runtime, 'worker.js'), 'synthetic worker')
  await writeFile(path.join(runtime, 'licenses/LICENSE'), 'synthetic public license')
  return { root, runtime }
}
it('publishes a deterministic rootless archive with a compiled inventory anchor and verifies the complete tree', async () => {
  const t = await fixture()
  const options = { id: 'fixture', version: '1.0.0', entry: 'worker.js', runtimeRoot: t.runtime, outputRoot: path.join(t.root, 'public') }
  const first = await publishRuntimeComponent(options)
  const second = await publishRuntimeComponent(options)
  expect(second).toEqual(first)
  expect(await auditComponentTree(t.runtime, first.treeManifestSha256)).toEqual([])
  const archive = await readFile(first.archivePath)
  expect(first.descriptor.bytes).toBe(archive.length)
  expect(first.descriptor.sha256).toBe(createHash('sha256').update(archive).digest('hex'))
  const entries: string[] = []
  await tar.t({ file: first.archivePath, onReadEntry: entry => { entries.push(entry.path) } })
  expect(entries.sort()).toEqual(['component-manifest.json', 'licenses/LICENSE', 'worker.js'])
  await writeFile(path.join(t.runtime, 'worker.js'), 'modified worker!')
  expect((await auditComponentTree(t.runtime, first.treeManifestSha256)).length).toBeGreaterThan(0)
})
it('rejects added files and self-blessed modified inventories', async () => {
  const t = await fixture()
  const result = await publishRuntimeComponent({ id: 'fixture', version: '1', entry: 'worker.js', runtimeRoot: t.runtime, outputRoot: path.join(t.root, 'public') })
  await writeFile(path.join(t.runtime, 'extra.dll'), 'extra')
  expect((await auditComponentTree(t.runtime, result.treeManifestSha256)).length).toBeGreaterThan(0)
  await rm(path.join(t.runtime, 'extra.dll'))
  await writeFile(path.join(t.runtime, 'component-manifest.json'), '{"files":[]}')
  expect((await auditComponentTree(t.runtime, result.treeManifestSha256)).length).toBeGreaterThan(0)
})
it('rejects runtime directory junctions before publishing', async () => {
  const t = await fixture(); const outside = path.join(t.root, 'outside'); await mkdir(outside)
  await writeFile(path.join(outside, 'private.txt'), 'private data')
  await symlink(outside, path.join(t.runtime, 'linked'), 'junction')
  await expect(publishRuntimeComponent({ id: 'fixture', version: '1', entry: 'worker.js', runtimeRoot: t.runtime, outputRoot: path.join(t.root, 'public') })).rejects.toThrow()
})
it('refuses to republish the omitted Pandoc manual from a stale runtime', async () => {
  const t = await fixture()
  await writeFile(path.join(t.runtime, 'pandoc.exe'), 'synthetic converter')
  await writeFile(path.join(t.runtime, 'MANUAL.html'), 'synthetic upstream documentation')
  await expect(publishRuntimeComponent({ id: 'pandoc', version: '3.10.1-r2', entry: 'pandoc.exe',
    runtimeRoot: t.runtime, outputRoot: path.join(t.root, 'public') })).rejects.toThrow('Pandoc MANUAL.html must be omitted')
  await expect(readFile(path.join(t.runtime, 'component-manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
