// @vitest-environment node
import { createHash } from 'node:crypto'
import { link, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { UpdateCache, updateArtifactKey } from '../../src/main/updates/update-cache'
import type { UpdateArtifact } from '../../src/main/updates/update-protocol'
const data = Buffer.from('cache sample')
const artifact: UpdateArtifact = { version: '1.0.5', channel: 'stable', edition: 'Full', kind: 'portable',
  filename: 'Arkdown.zip', url: 'https://download.cotax.tech/Arkdown.zip', bytes: data.length,
  sha256: createHash('sha256').update(data).digest('hex') }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-cache-test-')); roots.push(root); return new UpdateCache(root) }
it('isolates version/channel/edition/kind/content identities', () => {
  const keys = [artifact, { ...artifact, version: '1.0.6' }, { ...artifact, channel: 'beta' },
    { ...artifact, edition: 'Lite' }, { ...artifact, kind: 'installer' }, { ...artifact, sha256: 'b'.repeat(64) }]
  expect(new Set(keys.map(x => updateArtifactKey(x as UpdateArtifact))).size).toBe(6)
})
it('refuses a cache junction without reading or deleting files outside it', async () => {
  const cache = await setup(), outside = await setup(), junction = path.join(cache.root, 'junction')
  await writeFile(path.join(outside.root, 'keep.txt'), 'keep')
  await symlink(outside.root, junction, 'junction')
  try {
    await expect(new UpdateCache(junction).getVerified(artifact)).rejects.toThrow('路径不安全')
    expect(await readFile(path.join(outside.root, 'keep.txt'), 'utf8')).toBe('keep')
  } finally { await unlink(junction) }
})
it('refuses linked cached files and preserves their other name', async () => {
  const cache = await setup(), other = path.join(cache.root, 'keep.zip')
  await writeFile(other, data); await link(other, cache.file(artifact))
  await expect(cache.getVerified(artifact)).rejects.toThrow('文件不安全')
  expect(await readFile(other)).toEqual(data)
})
it('rejects unknown deletion targets even if they are inside the cache', async () => {
  const cache = await setup(), file = path.join(cache.root, 'keep.txt')
  await writeFile(file, 'keep')
  await expect(cache.removePartial(file)).rejects.toThrow('Invalid partial')
  expect(await readFile(file, 'utf8')).toBe('keep')
})
it('fails cleanly when the cache path is an existing file', async () => {
  const cache = await setup(), file = path.join(cache.root, 'a-file')
  await writeFile(file, 'keep')
  await expect(new UpdateCache(file).createPartial(artifact)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe('keep')
})
