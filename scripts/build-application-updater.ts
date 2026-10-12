import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
export const APPLICATION_UPDATER_TRUST_ENV = 'ARKDOWN_APPLICATION_UPDATER_TRUST_JSON'
export interface ApplicationUpdaterArtifact { bytes: Buffer; trust: { bytes: number; sha256: string } }
export async function buildApplicationUpdater(repoRoot: string): Promise<ApplicationUpdaterArtifact> {
  if (process.platform !== 'win32') throw new Error('Application updater requires Windows')
  const source = path.join(repoRoot, 'native/application-updater'), output = path.join(repoRoot, '.native-cache/application-updater')
  await mkdir(output, { recursive: true })
  const executable = path.join(output, 'Arkdown.Update.exe')
  await promisify(execFile)(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), [
    '/nologo', '/utf8output', '/codepage:65001', '/target:winexe', '/platform:x64', '/optimize+',
    `/out:${executable}`, `/win32manifest:${path.join(source, 'app.manifest')}`, '/reference:System.dll', '/reference:System.Core.dll',
    '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll',
    '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
    ...(await readdir(path.join(source, 'src'))).filter(f => f.endsWith('.cs')).sort().map(f => path.join(source, 'src', f)),
  ], { windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  const bytes = await readFile(executable)
  if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Invalid update helper build')
  return { bytes, trust: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
}
