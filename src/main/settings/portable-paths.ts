import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'

export interface DataRoot {
  path: string
  portable: boolean
}

export function recentDocumentsPath(dataRoot: string): string {
  return path.join(dataRoot, 'recent-documents.json')
}

async function canWrite(directory: string): Promise<boolean> {
  const probe = path.join(directory, `.write-probe-${randomUUID()}`)
  try {
    await mkdir(directory, { recursive: true })
    const handle = await open(probe, 'wx')
    await handle.close()
    return true
  } catch {
    return false
  } finally {
    await rm(probe, { force: true }).catch(() => undefined)
  }
}

export async function resolveDataRoot(options: {
  executablePath: string
  fallbackUserDataPath: string
  isPackaged: boolean
}): Promise<DataRoot> {
  const preferred = options.isPackaged
    ? path.join(path.dirname(options.executablePath), 'portable-data')
    : path.join(process.cwd(), '.arkdown-dev-data')

  if (await canWrite(preferred)) return { path: preferred, portable: true }

  await mkdir(options.fallbackUserDataPath, { recursive: true })
  return { path: options.fallbackUserDataPath, portable: false }
}
