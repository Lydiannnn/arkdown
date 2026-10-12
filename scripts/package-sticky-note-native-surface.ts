import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ELECTRON_NATIVE_SURFACE_VERSION, nativeSurfaceSourceHash } from './build-sticky-note-native-surface.ts'

export interface StickyNoteNativeSurfaceManifest {
  schemaVersion: 1; platform: 'win32'; arch: 'x64'; electronVersion: string; file: 'surface.node'; bytes: number; sha256: string; sourceSha256: string; windowsSdkVersion: string
}
export function validateStickyNoteNativeSurfaceManifest(value: unknown): StickyNoteNativeSurfaceManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid native surface manifest')
  const record = value as Record<string, unknown>
  const keys = ['schemaVersion', 'platform', 'arch', 'electronVersion', 'file', 'bytes', 'sha256', 'sourceSha256', 'windowsSdkVersion']
  if (Object.keys(record).sort().join(',') !== keys.sort().join(',') || record.schemaVersion !== 1 || record.platform !== 'win32' || record.arch !== 'x64' || record.electronVersion !== ELECTRON_NATIVE_SURFACE_VERSION || record.file !== 'surface.node' || !Number.isSafeInteger(record.bytes) || (record.bytes as number) <= 0 || (record.bytes as number) > 64 * 1024 * 1024 || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sha256) || typeof record.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.sourceSha256) || typeof record.windowsSdkVersion !== 'string' || !/^10\.0\.\d+\.0$/u.test(record.windowsSdkVersion)) throw Error('Invalid native surface manifest')
  return value as StickyNoteNativeSurfaceManifest
}
async function regularBytes(file: string, max: number): Promise<Buffer> {
  const metadata = await lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > max) throw Error('Native surface source must be a bounded regular file')
  return await readFile(file)
}
export async function copyStickyNoteNativeSurface(outputPaths: readonly string[], options: { repoRoot?: string; sourceDirectory?: string } = {}): Promise<void> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd())
  const source = path.resolve(options.sourceDirectory ?? path.join(repoRoot, 'native/sticky-note-surface/dist/x64'))
  if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink()) throw Error('Invalid native surface source directory')
  const manifestBytes = await regularBytes(path.join(source, 'manifest.json'), 4096)
  const manifest = validateStickyNoteNativeSurfaceManifest(JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/u, '')))
  const bytes = await regularBytes(path.join(source, 'surface.node'), 64 * 1024 * 1024)
  const notice = await regularBytes(path.join(source, 'NOTICE'), 64 * 1024)
  if (!notice.equals(await regularBytes(path.join(repoRoot, 'native/sticky-note-surface/NOTICE'), 64 * 1024))) throw Error('Native surface notice source mismatch')
  if (bytes.length !== manifest.bytes || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw Error('Native surface binary hash mismatch')
  if (await nativeSurfaceSourceHash(repoRoot) !== manifest.sourceSha256) throw Error('Native surface build source identity mismatch; rebuild required')
  const roots = outputPaths.map(value => path.resolve(value))
  if (!roots.length || new Set(roots.map(root => root.toLowerCase())).size !== roots.length) throw Error('Invalid Forge package outputs')
  // Check every output before mutating any. Recursive replacement must stay inside real package roots.
  for (const root of roots) {
    for (const directory of [root, path.join(root, 'resources')]) {
      const metadata = await lstat(directory)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error('Invalid Forge package directory')
    }
    const resolvedRoot = await realpath(root), resolvedResources = await realpath(path.join(root, 'resources'))
    if (path.relative(resolvedRoot, resolvedResources) !== 'resources') throw Error('Native surface destination escapes package root')
  }
  for (const root of roots) {
    for (const file of ['Arkdown.exe', 'resources/app.asar']) if (!(await lstat(path.join(root, file))).isFile()) throw Error('Invalid Forge package output')
    const resources = path.join(root, 'resources'), parent = path.join(resources, 'sticky-note-native-surface')
    const existingParent = await lstat(parent).catch(() => undefined)
    if (existingParent && (!existingParent.isDirectory() || existingParent.isSymbolicLink())) throw Error('Invalid native surface package destination')
    await mkdir(parent, { recursive: true })
    if (path.relative(await realpath(root), await realpath(parent)) !== path.join('resources', 'sticky-note-native-surface')) throw Error('Native surface destination escapes package root')
    const target = path.join(parent, 'x64')
    const targetMetadata = await lstat(target).catch(() => undefined)
    if (targetMetadata && (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink())) throw Error('Invalid native surface package target')
    const staging = await mkdtemp(path.join(parent, '.staging-'))
    try {
      await writeFile(path.join(staging, 'surface.node'), bytes, { flag: 'wx' })
      await writeFile(path.join(staging, 'manifest.json'), manifestBytes, { flag: 'wx' })
      await writeFile(path.join(staging, 'NOTICE'), notice, { flag: 'wx' })
      if (createHash('sha256').update(await readFile(path.join(staging, 'surface.node'))).digest('hex') !== manifest.sha256) throw Error('Packaged native surface verification failed')
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  }
}
