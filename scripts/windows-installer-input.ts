import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

export interface InstallerFile { path: string; size: number; sha256: string; preserveExisting: boolean }
export async function installerHash(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function collectInstallerFiles(root: string): Promise<InstallerFile[]> {
  const files: InstallerFile[] = []
  async function visit(relative: string) {
    const absolute = path.join(root, relative), info = await lstat(absolute)
    if (info.isSymbolicLink()) throw new Error('Installer payload cannot contain links: '+relative)
    if (relative && /^(?:portable-data|temp|\.arkdown-dev-data|\.git|node_modules)(?:\/|$)/iu.test(relative)) {
      throw new Error('Installer payload contains user data or development files: '+relative)
    }
    if (info.isDirectory()) for (const entry of await readdir(absolute)) await visit(relative ? relative+'/'+entry : entry)
    else if (info.isFile()) files.push({ path: relative, size: info.size, sha256: await installerHash(absolute), preserveExisting: relative.startsWith('初始工作区/') })
    else throw new Error('Installer payload must contain regular files: '+relative)
  }
  await visit('')
  return files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
function quote(value: string): string {
  if (/[\r\n\0*?]/u.test(value)) throw new Error('Unsafe installer filename')
  return value.replaceAll('"', '""').replaceAll('{', '{{')
}
export function installerFileEntries(root: string, files: readonly InstallerFile[]): string {
  return files.map(file => {
    if (file.path.startsWith('/') || file.path.split('/').some(part => !part || part === '.' || part === '..') || file.path.includes('\\')) throw new Error('Invalid relative installer path')
    const directory = path.posix.dirname(file.path)
    const destination = '{app}'+(directory === '.' ? '' : '\\'+quote(directory.replaceAll('/', '\\')))
    return `Source: "${quote(path.join(root, file.path))}"; DestDir: "${destination}"; Flags: ${file.preserveExisting ? 'onlyifdoesntexist uninsneveruninstall' : 'ignoreversion'}`
  }).join('\n')+'\n'
}
export function installerDefines(version: string, edition: string) {
  if (!/^\d+\.\d+\.\d+$/u.test(version) || !['full','lite'].includes(edition)) throw new Error('Invalid installer version or edition')
  const parts = version.split('.').map(Number)
  if (parts.some(value => value > 65535)) throw new Error('Version component exceeds Windows range')
  return { version, edition: edition === 'full' ? 'Full' : 'Lite', versionMS: parts[0]*65536+parts[1], versionLS: parts[2]*65536 }
}
