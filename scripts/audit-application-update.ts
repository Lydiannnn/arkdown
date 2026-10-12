import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import { verifyUpdateManagedManifest } from './package-update-manifest.ts'
export async function auditApplicationUpdate(root: string): Promise<string[]> {
  const findings: string[] = [], asar = path.join(root, 'resources/app.asar')
  try {
    const metadata = JSON.parse(extractFile(asar, 'package.json').toString('utf8'))
    const edition = JSON.parse((await readFile(path.join(root, 'resources/package-edition.json'), 'utf8')).replace(/^\uFEFF/, ''))
    await verifyUpdateManagedManifest(root, metadata.version, edition.edition)
  } catch { findings.push('invalid update managed files manifest') }
  try {
    const directory = path.join(root, 'resources/application-updater'), entry = path.join(directory, 'Arkdown.Update.exe')
    const stat = await lstat(entry), names = await readdir(directory)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 2 * 1024 * 1024 || names.length !== 1 || names[0] !== 'Arkdown.Update.exe') throw new Error('Invalid updater')
    const bytes = await readFile(entry), hash = createHash('sha256').update(bytes).digest('hex')
    if (bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Invalid PE')
    const offset = bytes.readUInt32LE(0x3c)
    if (offset + 6 > bytes.length || bytes.subarray(offset, offset + 4).toString('binary') !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Invalid updater architecture')
    const mainChunks = listPackage(asar, { isPack: false }).map(name => name.replace(/^[/\\]+/, '').replaceAll('\\', '/')).filter(name => /^\.vite\/build\/[^/]+\.js$/.test(name))
    if (!mainChunks.some(name => { const content = extractFile(asar, path.normalize(name)).toString('utf8'); return content.includes(hash) && content.includes(String(bytes.length)) })) throw new Error('Missing compiled updater hash')
  } catch (error) {
    const reason = error instanceof Error && ['Invalid updater', 'Invalid PE', 'Invalid updater architecture', 'Missing compiled updater hash'].includes(error.message) ? error.message : 'unreadable updater resources'
    findings.push('invalid or unanchored application updater: ' + reason)
  }
  return findings
}
