import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { parseUpdateVersion, type UpdateChannel, type UpdateIdentity } from '../../shared/app-update'

async function boundedFile(file: string, max: number): Promise<Buffer | null> {
  let info
  try { info = await lstat(file) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) throw new Error('Invalid update metadata')
  const handle = await open(file, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > max || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error('Changed update metadata')
    const bytes = Buffer.alloc(max + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > max) throw new Error('Large update metadata')
    return bytes.subarray(0, bytesRead)
  } finally { await handle.close() }
}

export async function readUpdateIdentity(input: { appVersion: string; isPackaged: boolean; resourcesPath: string;
  executablePath: string; channel: UpdateChannel }): Promise<UpdateIdentity | undefined> {
  if (!input.isPackaged || !parseUpdateVersion(input.appVersion)) return undefined
  try {
    const bytes = await boundedFile(path.join(input.resourcesPath, 'package-edition.json'), 16384)
    if (!bytes) return undefined
    const metadata = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
    if (metadata?.schemaVersion !== 1 || !['full', 'lite'].includes(metadata.edition)) return undefined
    const ini = await boundedFile(path.join(path.dirname(input.executablePath), '.arkdown-installation.ini'), 1024)
    let kind: UpdateIdentity['kind'] = 'portable'
    if (ini !== null) {
      const text = ini.toString(ini[0] === 0xff && ini[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
      let section = false; let found = false
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (line.startsWith('[')) section = line === '[ArkdownStartup]'
        else if (section && /^Instance=\d{14}-\d{1,10}$/.test(line)) found = true
      }
      if (!found) return undefined
      kind = 'installer'
    }
    return { version: input.appVersion, channel: input.channel, edition: metadata.edition === 'full' ? 'Full' : 'Lite', kind }
  } catch { return undefined }
}
