import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { auditEditionResources, editionComponents, packageEditionResources, parsePackageEdition } from '../../scripts/package-editions'
import type { EditionComponent } from '../../scripts/package-editions'
const roots: string[] = []
it('uses the versioned Astra-capable Codex input without changing its installed resource location', () => {
  const repo = path.resolve('fixture-repository')
  const component = editionComponents(repo).find(value => value.id === 'codex-cli')!
  expect(component.version).toBe('0.162.1')
  expect(component.sourceRoot).toBe(path.join(repo, '.components', 'codex-cli-0.162.1', 'runtime'))
  expect(component.resourcePath).toBe('components/codex-cli')
})
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-edition-')); roots.push(root)
  const runtime = path.join(root, 'runtime'); await mkdir(runtime)
  const data = Buffer.from('fixture payload')
  await writeFile(path.join(runtime, 'worker.js'), data)
  const manifest = JSON.stringify({ schemaVersion: 1, version: '1.0.0', entry: 'worker.js', files: [
    { path: 'worker.js', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') },
  ] })
  await writeFile(path.join(runtime, 'component-manifest.json'), manifest)
  const components: EditionComponent[] = [{ id: 'fixture', version: '1.0.0', sourceRoot: runtime,
    resourcePath: 'components/fixture', treeManifestSha256: createHash('sha256').update(manifest).digest('hex') }]
  return { root, runtime, components, output: path.join(root, 'package') }
}
it('requires an explicit known edition', () => {
  expect(parsePackageEdition('full')).toBe('full')
  expect(parsePackageEdition('lite')).toBe('lite')
  for (const input of [undefined, '', 'FULL', '../lite']) expect(() => parsePackageEdition(input)).toThrow()
})
it('Full copies verified expanded payloads and records an exact immutable edition inventory', async () => {
  const t = await fixture()
  await packageEditionResources(t.output, 'full', { components: t.components })
  expect(await readFile(path.join(t.output, 'resources/components/fixture/worker.js'), 'utf8')).toBe('fixture payload')
  expect((await auditEditionResources(t.output, { components: t.components })).findings).toEqual([])
  await writeFile(path.join(t.output, 'resources/components/fixture/extra.txt'), 'unexpected')
  expect((await auditEditionResources(t.output, { components: t.components })).findings.length).toBeGreaterThan(0)
})
it('Lite never reads optional inputs and rejects retained heavyweight trees', async () => {
  const t = await fixture()
  await rm(t.runtime, { recursive: true })
  await packageEditionResources(t.output, 'lite', { components: t.components })
  expect((await auditEditionResources(t.output, { components: t.components })).findings).toEqual([])
  await mkdir(path.join(t.output, 'resources/components/fixture'), { recursive: true })
  await writeFile(path.join(t.output, 'resources/components/fixture/worker.js'), 'unexpected')
  expect((await auditEditionResources(t.output, { components: t.components })).findings.length).toBeGreaterThan(0)
})
it('rejects a corrupted Full input before copying or writing edition metadata', async () => {
  const t = await fixture(); await writeFile(path.join(t.runtime, 'worker.js'), 'tampered')
  await expect(packageEditionResources(t.output, 'full', { components: t.components })).rejects.toThrow()
  await expect(readFile(path.join(t.output, 'resources/package-edition.json'))).rejects.toThrow()
})
it('audits a Full legacy subset using compiled hashes with no source cache dependency', async () => {
  const t = await fixture()
  const tree = JSON.parse(await readFile(path.join(t.runtime, 'component-manifest.json'), 'utf8'))
  t.components[0]!.selectedFiles = ['worker.js']; t.components[0]!.selectedInventory = tree.files
  await packageEditionResources(t.output, 'full', { components: t.components })
  await rm(t.runtime, { recursive: true })
  expect((await auditEditionResources(t.output, { components: t.components })).findings).toEqual([])
  await writeFile(path.join(t.output, 'resources/components/fixture/worker.js'), 'tampered')
  expect((await auditEditionResources(t.output, { components: t.components })).findings.length).toBeGreaterThan(0)
})
it('rejects empty unlisted directories and junctions in a component ancestor', async () => {
  const t = await fixture()
  await packageEditionResources(t.output, 'full', { components: t.components })
  const componentsRoot = path.join(t.output, 'resources/components')
  await mkdir(path.join(componentsRoot, 'fixture/empty'))
  expect((await auditEditionResources(t.output, { components: t.components })).findings.length).toBeGreaterThan(0)
  await rm(componentsRoot, { recursive: true })
  const outside = path.join(t.root, 'outside'); await mkdir(outside)
  await symlink(outside, componentsRoot, 'junction')
  expect((await auditEditionResources(t.output, { components: t.components })).findings).toContain('fixture: invalid component directory')
})
