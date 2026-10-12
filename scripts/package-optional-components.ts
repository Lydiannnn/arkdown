import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import type { DocumentConversionComponentDescriptor } from '../src/shared/document-conversion.ts'

export interface ComponentTreeFile { path: string; bytes: number; sha256: string }
const manifestName = 'component-manifest.json'
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const safeName = (name: unknown): name is string => typeof name === 'string' && name.length > 0
  && !/[\\:<>"|?*\u0000-\u001f]/u.test(name)
  && name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part))

export async function componentTreeFiles(root: string): Promise<ComponentTreeFile[]> {
  const resolved = path.resolve(root), stat = await lstat(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid component root')
  const canonical = await realpath(resolved)
  const files: ComponentTreeFile[] = [], names = new Set<string>()
  async function visit(relative: string) {
    const directory = path.join(resolved, relative)
    const metadata = await lstat(directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid component directory')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? relative+'/'+entry.name : entry.name
      if (!safeName(name) || entry.isSymbolicLink() || names.has(name.toLowerCase())) throw new Error('Invalid component entry')
      names.add(name.toLowerCase())
      if (names.size > 20_000) throw new Error('Component inventory too large')
      if (entry.isDirectory()) { await visit(name); continue }
      if (!entry.isFile()) throw new Error('Invalid component file')
      const target = path.join(resolved, name), info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 ** 2) throw new Error('Invalid component file')
      const within = path.relative(canonical, await realpath(target))
      if (within === '..' || within.startsWith('..'+path.sep) || path.isAbsolute(within)) throw new Error('Component path escaped root')
      const bytes = await readFile(target), after = await lstat(target)
      if (bytes.length !== info.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error('Component changed while reading')
      files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) })
    }
  }
  await visit('')
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/** An externally pinned raw-manifest hash is the trust root, never the manifest itself. */
export async function auditComponentTree(root: string, treeManifestSha256: string): Promise<string[]> {
  try {
    const files = await componentTreeFiles(root)
    const inventory = files.find(file => file.path === manifestName)
    if (!inventory || inventory.bytes > 8 * 1024 ** 2 || inventory.sha256 !== treeManifestSha256) throw new Error('Component inventory hash mismatch')
    const manifest = JSON.parse(await readFile(path.join(root, manifestName), 'utf8')) as { schemaVersion?: number; files?: ComponentTreeFile[] }
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid component inventory')
    const expected = manifest.files
    const seen = new Set<string>()
    for (const file of expected) {
      if (!file || !safeName(file.path) || file.path === manifestName || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(file.sha256) || seen.has(file.path.toLowerCase())) throw new Error('Invalid component inventory')
      seen.add(file.path.toLowerCase())
    }
    const actual = files.filter(file => file.path !== manifestName)
    if (actual.length !== expected.length || expected.some(file => !actual.some(value => value.path === file.path
      && value.bytes === file.bytes && value.sha256 === file.sha256))) throw new Error('Component payload mismatch')
    return []
  } catch (error) { return [error instanceof Error ? error.message : 'Invalid component tree'] }
}

export async function publishRuntimeComponent(options: {
  id: string; version: string; entry: string; runtimeRoot: string; outputRoot: string
}) {
  if (!/^[a-z0-9-]+$/u.test(options.id) || !/^[A-Za-z0-9.-]+$/u.test(options.version)
    || !safeName(options.entry)) throw new Error('Invalid component identity')
  const files = (await componentTreeFiles(options.runtimeRoot)).filter(file => file.path !== manifestName)
  if (options.id === 'pandoc' && files.some(file => file.path.toLowerCase() === 'manual.html')) {
    throw new Error('Pandoc MANUAL.html must be omitted')
  }
  if (!files.some(file => file.path === options.entry)) throw new Error('Component entry missing')
  const tree = JSON.stringify({ schemaVersion: 1, version: options.version, entry: options.entry, files }, null, 2)+'\n'
  await writeFile(path.join(options.runtimeRoot, manifestName), tree, 'utf8')
  const treeManifestSha256 = digest(Buffer.from(tree))
  await mkdir(options.outputRoot, { recursive: true })
  const archiveName = `arkdown-${options.id}-${options.version}-win-x64.tar.gz`
  const archivePath = path.resolve(options.outputRoot, archiveName)
  await tar.c({ file: archivePath, cwd: options.runtimeRoot, portable: true, gzip: { level: 9 },
    noDirRecurse: true, mtime: new Date('2026-01-01T00:00:00Z') }, [...files.map(file => file.path), manifestName])
  const bytes = await readFile(archivePath)
  const descriptor: DocumentConversionComponentDescriptor = { source: 'https', version: options.version, archiveName,
    bytes: bytes.length, sha256: digest(bytes),
    url: `https://github.com/Lydiannnn/arkdown-releases/releases/download/${options.id}-${options.version}-win-x64/${archiveName}` }
  await writeFile(path.join(options.outputRoot, 'manifest.json'), JSON.stringify(descriptor, null, 2)+'\n', 'utf8')
  if ((await auditComponentTree(options.runtimeRoot, treeManifestSha256)).length) throw new Error('Published component verification failed')
  return { archivePath, descriptor, treeManifestSha256 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [id, version, entry, runtimeRoot, outputRoot] = process.argv.slice(2)
  if (!id || !version || !entry) throw new Error('Usage: package-optional-components.ts <id> <version> <entry> [runtimeRoot] [outputRoot]')
  const sourceDirectory = id === 'pandoc' ? `${id}-${version}` : id
  publishRuntimeComponent({ id, version, entry,
    runtimeRoot: runtimeRoot ? path.resolve(runtimeRoot) : path.resolve('.components', sourceDirectory, 'runtime'),
    outputRoot: outputRoot ? path.resolve(outputRoot) : path.resolve('.components', `public-${sourceDirectory}-release`),
  }).then(result => process.stdout.write(JSON.stringify(result, null, 2)+'\n')).catch(error => { console.error(error); process.exitCode = 1 })
}
