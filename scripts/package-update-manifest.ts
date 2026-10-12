import { createHash } from 'node:crypto'
import { lstat, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const UPDATE_MANIFEST = 'resources/update-managed-files.json'
const forbiddenRoots = new Set(['portable-data', 'user-data', 'userdata', 'temp', '.git', '.arkdown-update-pending.json', '.arkdown-installer-update.ini'])
async function collectManifest(root: string, version: string, edition: 'full' | 'lite') {
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) || !['full', 'lite'].includes(edition)) throw new Error('Invalid package identity')
  root = path.resolve(root)
  const canonical = await realpath(root)
  if (canonical.toLowerCase() !== root.toLowerCase() || (await lstat(root)).isSymbolicLink()) throw new Error('Unsafe package root')
  const files: { path: string; bytes: number; sha256: string }[] = []
  const names = new Set<string>()
  let total = 0
  async function visit(directory: string, relative: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (!relative && forbiddenRoots.has(name.toLowerCase())) throw new Error('Package contains user data or update state')
      if (/[<>:"|?*\\\x00-\x1f]/u.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) throw new Error('Unsafe package filename')
      const rel = relative ? relative + '/' + name : name, full = path.join(directory, name)
      const stat = await lstat(full)
      if (stat.isSymbolicLink()) throw new Error('Package contains a reparse entry')
      if (stat.isDirectory()) { await visit(full, rel); continue }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Package contains a non-regular file')
      if (rel === UPDATE_MANIFEST) continue
      if (names.has(rel.toLowerCase())) throw new Error('Duplicate package path')
      names.add(rel.toLowerCase())
      total += stat.size
      if (files.length >= 100_000 || total > 64 * 1024 ** 3) throw new Error('Package manifest size limit')
      const handle = await open(full, 'r')
      try {
        const before = await handle.stat()
        if (before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size) throw new Error('Package changed during manifest creation')
        const hash = createHash('sha256')
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
        const after = await handle.stat(), current = await lstat(full)
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino) throw new Error('Package changed during manifest creation')
        files.push({ path: rel, bytes: stat.size, sha256: hash.digest('hex') })
      } finally { await handle.close() }
    }
  }
  await visit(root, '')
  if (!names.has('arkdown.exe') || !names.has('resources/app.asar')) throw new Error('Incomplete application package')
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const target = path.join(root, UPDATE_MANIFEST)
  const existing = await lstat(target).catch(() => undefined)
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('Unsafe existing manifest')
  return { schemaVersion: 1, product: 'Arkdown', version, edition: edition === 'full' ? 'Full' : 'Lite', files }
}
export async function writeUpdateManagedManifest(root: string, version: string, edition: 'full' | 'lite'): Promise<void> {
  const manifest = await collectManifest(root, version, edition)
  await writeFile(path.join(root, UPDATE_MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
}
export async function verifyUpdateManagedManifest(root: string, version: string, edition: 'full' | 'lite'): Promise<void> {
  const expected = await collectManifest(root, version, edition), manifestPath = path.join(root, UPDATE_MANIFEST)
  if ((await lstat(manifestPath)).size > 32 * 1024 * 1024) throw new Error('Update manifest is oversized')
  const actual = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Update managed manifest does not match package files')
}
