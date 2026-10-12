import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import path from 'node:path'

export interface TempRoot {
  path: string
  portable: boolean
}

export interface TempRootOptions {
  executablePath: string
  fallbackUserDataPath: string
  isPackaged: boolean
  portableExecutableDirectory?: string
  developmentRoot?: string
}

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

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

export async function resolveTempRoot(options: TempRootOptions): Promise<TempRoot> {
  const preferredBase = options.isPackaged
    ? (options.portableExecutableDirectory ?? path.dirname(options.executablePath))
    : path.join(options.developmentRoot ?? process.cwd(), '.arkdown-dev-data')
  const preferred = path.join(preferredBase, 'temp')

  if (await canWrite(preferred)) return { path: preferred, portable: true }

  const fallback = path.join(options.fallbackUserDataPath, 'temp')
  await mkdir(fallback, { recursive: true })
  return { path: fallback, portable: false }
}

export function isDraftId(value: string): boolean {
  return LOWERCASE_UUID.test(value)
}

export function isClipboardAssetName(name: string): boolean {
  return name.startsWith('clipboard-') && name.endsWith('.png') && isDraftId(name.slice(10, -4))
}

export function draftPaths(root: string, draftId: string) {
  if (!isDraftId(draftId)) throw new Error('Invalid draft id')
  const draftDirectory = path.join(root, 'drafts', draftId)
  return {
    draftDirectory,
    bodyPath: path.join(draftDirectory, 'body.md'),
    manifestPath: path.join(draftDirectory, 'manifest.json'),
    assetDirectory: path.join(root, 'assets', draftId),
  }
}
