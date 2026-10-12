import { lstat } from 'node:fs/promises'
import path from 'node:path'

export interface PandocLocatorOptions {
  executablePath: string
  resourcesPath: string
  env?: NodeJS.ProcessEnv
}

async function isSafeExecutable(candidate: string): Promise<boolean> {
  try {
    const metadata = await lstat(candidate)
    return metadata.isFile() && !metadata.isSymbolicLink()
  } catch {
    return false
  }
}

export async function resolvePandocExecutable(
  options: PandocLocatorOptions,
): Promise<string> {
  const env = options.env ?? process.env
  const configured = env.ARKDOWN_PANDOC_PATH
  const candidates = [
    configured && path.isAbsolute(configured) ? configured : null,
    path.join(path.dirname(options.executablePath), 'pandoc', 'pandoc.exe'),
    path.join(options.resourcesPath, 'pandoc', 'pandoc.exe'),
  ]

  for (const candidate of candidates) {
    if (candidate && await isSafeExecutable(candidate)) return candidate
  }

  return 'pandoc.exe'
}
