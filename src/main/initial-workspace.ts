import { constants } from 'node:fs'
import { access, copyFile, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'

export const INITIAL_WORKSPACE_FOLDER = '初始工作区'
export const INITIAL_WORKSPACE_WELCOME = '01-欢迎使用.md'
export const INITIAL_WORKSPACE_MARKER = '.arkdown-initial-workspace.json'

type InitialWorkspaceOptions = {
  templateRoot: string; documentsRoot: string; stateRoot: string; previousWorkspace: string | null
}

// v1 never tracked individual deliveries. v2 adds only this explicitly approved
// release; renamed/removed tutorial chapters are deliberately outside the migration.
const summerArticleFiles = [
  '11-把夏天骑进海风里.md',
  'assets/summer-sea-breeze/01-coastal-ride.png',
  'assets/summer-sea-breeze/02-sand-and-rest.png',
  'assets/summer-sea-breeze/03-postcard-cafe.png',
  'assets/summer-sea-breeze/04-blue-hour.png',
]
const currentMarker = JSON.stringify({ version: 2, appliedMigrations: ['summer-sea-breeze-v1'] })

async function entryInfo(file: string) {
  try { return await lstat(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function checkedDirectory(directory: string, create = false): Promise<boolean> {
  const info = await entryInfo(directory)
  if (info && (!info.isDirectory() || info.isSymbolicLink())) {
    throw new Error('Initial workspace migration requires a regular directory, not a symbolic link')
  }
  if (!info && create) await mkdir(directory)
  return Boolean(info) || create
}

/** Runs independently of welcome-window selection, but only for our marked default workspace. */
export async function migrateInitialWorkspace(options: InitialWorkspaceOptions): Promise<void> {
  const parent = path.join(options.documentsRoot, 'Arkdown')
  const destination = path.join(parent, INITIAL_WORKSPACE_FOLDER)
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  if (options.previousWorkspace && normalize(options.previousWorkspace) !== normalize(destination)) return
  if (!await checkedDirectory(parent) || !await checkedDirectory(destination)) return
  const marker = path.join(destination, INITIAL_WORKSPACE_MARKER)
  const markerInfo = await entryInfo(marker)
  if (!markerInfo?.isFile() || markerInfo.isSymbolicLink()) return
  let state: unknown
  try { state = JSON.parse((await readFile(marker, 'utf8')).replace(/^\uFEFF/, '')) }
  catch (error) { if (error instanceof SyntaxError) return; throw error }
  if (!state || typeof state !== 'object' || !('version' in state) || state.version !== 1) return

  // Validate the full delivery before copying. A missing package file leaves v1
  // retryable, and COPYFILE_EXCL preserves concurrent or pre-existing user edits.
  for (const relative of summerArticleFiles) {
    const info = await lstat(path.join(options.templateRoot, relative))
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Initial workspace migration template is not a regular file')
  }
  await checkedDirectory(path.join(destination, 'assets'), true)
  await checkedDirectory(path.join(destination, 'assets', 'summer-sea-breeze'), true)
  for (const relative of summerArticleFiles) {
    try { await copyFile(path.join(options.templateRoot, relative), path.join(destination, relative), constants.COPYFILE_EXCL) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  // The shared marker travels across portable profiles. Once v2 is recorded,
  // subsequently deleting the article or its images is a user choice, not damage.
  await writeFileAtomic(marker, currentMarker, { encoding: 'utf8' })
}

async function copyMissingFiles(source: string, destination: string): Promise<void> {
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
  await migrateInitialWorkspace(options)
  if (options.previousWorkspace) return null
  const marker = path.join(options.stateRoot, 'initial-workspace-v1.json')
  try { await access(marker); return null }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const template = await stat(path.join(options.templateRoot, INITIAL_WORKSPACE_WELCOME))
  if (!template.isFile()) throw new Error('Initial workspace welcome document is missing')
  const destination = path.join(options.documentsRoot, 'Arkdown', INITIAL_WORKSPACE_FOLDER)
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
