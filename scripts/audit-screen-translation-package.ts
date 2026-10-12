import { createHash } from 'node:crypto'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR } from '../src/shared/screen-translation-component-manifest.ts'

export interface ScreenTranslationResourceAudit {
  findings: string[]
  approvedEntries: Map<string, 'file' | 'directory'>
}
const resourcePrefix = 'resources/screen-translation'
const nativeNames = ['Arkdown.ScreenTranslation.exe', 'Arkdown.ScreenTranslation.exe.config'] as const
const manifestLimit = 2 * 1024 * 1024

function canonicalPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32767
    && !/[\\:<>"|?*\u0000-\u001f]/u.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && !/[. ]$/u.test(segment))
}

/** Reject links in every resource ancestor before reading an inventory member. */
async function regularDirectory(root: string, relative: string): Promise<void> {
  let current = path.resolve(root)
  for (const segment of ['', ...relative.split('/').filter(Boolean)]) {
    current = path.join(current, segment)
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('not a regular directory')
  }
}

async function verifiedFile(root: string, relative: string, retain = false): Promise<{ bytes: number; sha256: string; data?: Buffer }> {
  if (!canonicalPath(relative)) throw new Error('invalid path')
  const parents = relative.split('/').slice(0, -1).join('/')
  await regularDirectory(root, parents)
  const target = path.join(root, ...relative.split('/'))
  const before = await lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || retain && before.size > manifestLimit) throw new Error('invalid file')
  const realRoot = await realpath(root)
  const contained = async () => {
    const relativeTarget = path.relative(realRoot, await realpath(target))
    if (relativeTarget.startsWith('..'+path.sep) || relativeTarget === '..' || path.isAbsolute(relativeTarget)) throw new Error('outside resource root')
  }
  await contained()
  const handle = await open(target, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error('changed file')
    const hash = createHash('sha256'), buffers: Buffer[] = []
    let bytes = 0
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length
      if (bytes > before.size) throw new Error('changed file')
      hash.update(chunk)
      if (retain) buffers.push(chunk)
    }
    const after = await handle.stat(), current = await lstat(target)
    if (!current.isFile() || current.isSymbolicLink() || after.ino !== current.ino || after.dev !== current.dev
      || bytes !== before.size || after.size !== before.size || current.size !== before.size
      || after.mtimeMs !== before.mtimeMs || current.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || current.ctimeMs !== before.ctimeMs) throw new Error('changed file')
    await regularDirectory(root, parents)
    await contained()
    return { bytes, sha256: hash.digest('hex'), ...(retain ? { data: Buffer.concat(buffers) } : {}) }
  } finally { await handle.close() }
}

export async function auditScreenTranslationResources(
  packageRoot: string,
  repoRoot = path.resolve(import.meta.dirname, '..'),
  verifiedRuntimeEntries: ReadonlyMap<string, 'file' | 'directory'> = new Map(),
): Promise<ScreenTranslationResourceAudit> {
  const findings: string[] = [], approvedEntries = new Map<string, 'file' | 'directory'>()
  const report = () => ({ findings: [...new Set(findings)].sort(), approvedEntries: findings.length ? new Map<string, 'file' | 'directory'>() : approvedEntries })
  const resourceRoot = path.join(packageRoot, resourcePrefix)
  if (!await lstat(resourceRoot).catch(() => null)) {
    findings.push('missing screen translation resources'); return report()
  }
  try { await regularDirectory(packageRoot, resourcePrefix) }
  catch { findings.push('invalid screen translation resource root'); return report() }
  // The application carries a pinned download descriptor, never a bundled runtime inventory.
  const expected = new Map<string, { bytes: number; sha256: string }>([['manifest.json', { bytes: 0, sha256: '' }]])
  for (const name of nativeNames) {
    try { expected.set(name, await verifiedFile(repoRoot, '.native-cache/screen-translation/'+name)) }
    catch { findings.push('invalid screen translation native build reference: '+name) }
  }
  const directories = new Set<string>([''])
  for (const name of expected.keys()) {
    const segments = name.split('/')
    for (let count = 1; count < segments.length; count += 1) directories.add(segments.slice(0, count).join('/'))
  }
  const seen = new Set<string>()
  async function visit(relative: string): Promise<void> {
    try { await regularDirectory(resourceRoot, relative) }
    catch { findings.push('invalid screen translation directory: '+relative); return }
    approvedEntries.set(resourcePrefix+(relative ? '/'+relative : ''), 'directory')
    for (const entry of await readdir(path.join(resourceRoot, relative), { withFileTypes: true })) {
      const name = relative ? relative+'/'+entry.name : entry.name
      if (name === 'runtime' && entry.isDirectory() && !entry.isSymbolicLink()
        && verifiedRuntimeEntries.get(resourcePrefix+'/runtime') === 'directory') {
        for (const [key, value] of verifiedRuntimeEntries) if (key.startsWith(resourcePrefix+'/runtime/')) approvedEntries.set(key, value)
        approvedEntries.set(resourcePrefix+'/runtime', 'directory')
        continue
      }
      if (entry.isSymbolicLink()) { findings.push('invalid screen translation asset: '+name); continue }
      if (entry.isDirectory() && directories.has(name)) { await visit(name); continue }
      const expectedFile = expected.get(name)
      if (!entry.isFile() || !expectedFile) { findings.push('unexpected screen translation asset: '+name); continue }
      seen.add(name)
      try {
        const actual = await verifiedFile(resourceRoot, name, name === 'manifest.json')
        if (name === 'manifest.json') {
          const manifest = JSON.parse(actual.data!.toString('utf8').replace(/^\uFEFF/u, '')) as Record<string, unknown>
          const descriptor = SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR
          if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
            || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(Object.keys(descriptor).sort())
            || Object.entries(descriptor).some(([key, value]) => manifest[key] !== value)) throw new Error('mismatch')
        } else if (actual.bytes !== expectedFile.bytes || actual.sha256 !== expectedFile.sha256) throw new Error('mismatch')
        approvedEntries.set(resourcePrefix+'/'+name, 'file')
      } catch { findings.push(name === 'manifest.json' ? 'modified screen translation manifest' : 'modified screen translation asset: '+name) }
    }
  }
  try { await visit('') } catch { findings.push('unreadable screen translation resource inventory') }
  for (const name of expected.keys()) if (!seen.has(name)) findings.push('missing screen translation asset: '+name)
  return report()
}
