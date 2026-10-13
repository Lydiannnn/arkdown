import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export const INITIAL_WORKSPACE_FOLDER = '初始工作区'
export const INITIAL_WORKSPACE_WELCOME = '01-欢迎使用.md'
export const INITIAL_WORKSPACE_MARKER = '.arkdown-initial-workspace.json'

type InitialWorkspaceOptions = {
  templateRoot: string; documentsRoot: string; stateRoot: string; previousWorkspace: string | null
}

const currentMarker = JSON.stringify({ version: 3 })

// Keep the directory checks formerly provided by the retired sample migration.
async function assertRegularDirectory(directory: string): Promise<void> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error('Initial workspace requires a regular directory, not a symbolic link')
  }
}

async function copyMissingFiles(source: string, destination: string): Promise<void> {
  await assertRegularDirectory(destination)
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name)
    if (entry.isDirectory()) await copyMissingFiles(from, to)
    else if (entry.isFile()) {
      try { await copyFile(from, to, constants.COPYFILE_EXCL) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
  }
}

export async function prepareInitialWorkspace(options: InitialWorkspaceOptions): Promise<string | null> {
  if (options.previousWorkspace) return null
  const marker = path.join(options.stateRoot, 'initial-workspace-v1.json')
  try { await access(marker); return null }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const template = await stat(path.join(options.templateRoot, INITIAL_WORKSPACE_WELCOME))
  if (!template.isFile()) throw new Error('Initial workspace welcome document is missing')
  const destination = path.join(options.documentsRoot, 'Arkdown', INITIAL_WORKSPACE_FOLDER)
  await assertRegularDirectory(path.dirname(destination))
  await assertRegularDirectory(destination)
  const sharedMarker = path.join(destination, INITIAL_WORKSPACE_MARKER)
  let initialized = false
  try { await access(sharedMarker); initialized = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // Different portable versions share this folder, but not their profile marker.
  // Further deliveries must use explicit migrations, never a blanket recopy.
  if (!initialized) {
    await copyMissingFiles(options.templateRoot, destination)
  }
  const welcome = path.join(destination, INITIAL_WORKSPACE_WELCOME)
  const welcomeStat = await stat(welcome).catch((error: NodeJS.ErrnoException) => {
    if (initialized && error.code === 'ENOENT') return null
    throw error
  })
  if (welcomeStat && !welcomeStat.isFile()) throw new Error('Initial workspace welcome is not a file')
  if (!initialized) await writeFileAtomic(sharedMarker, currentMarker, { encoding: 'utf8' })
  await mkdir(options.stateRoot, { recursive: true })
  await writeFile(marker, JSON.stringify({ version: 1 }), 'utf8')
  return welcomeStat ? welcome : null
}
