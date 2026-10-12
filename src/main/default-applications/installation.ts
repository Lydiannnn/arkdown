import { lstat, open } from 'node:fs/promises'
import path from 'node:path'

/** Optional setup metadata, used only to decide whether to offer defaults again. */
export async function readDefaultApplicationsInstallationId(applicationDirectory: string): Promise<string | undefined> {
  const file = path.join(applicationDirectory, '.arkdown-installation.ini')
  try {
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) return undefined
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(1025)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 1024) return undefined
      const bytes = buffer.subarray(0, bytesRead)
      const text = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
      let inSection = false
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (line.startsWith('[')) inSection = line === '[ArkdownStartup]'
        else if (inSection) {
          const match = /^Instance=(\d{14}-\d{1,10})$/.exec(line)
          if (match) return match[1]
        }
      }
      return undefined
    } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
