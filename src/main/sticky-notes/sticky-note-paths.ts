import path from 'node:path'
import {
  isCanonicalStickyNoteId,
  type StickyNoteRecord,
} from '../../shared/sticky-notes'
import { parseBackgroundSettings } from '../../shared/background-settings'
import { validateStickyNoteName } from './sticky-note-name'

type StickyNotePathIdentity = Pick<StickyNoteRecord, 'id' | 'name' | 'status'>
type StickyNoteBackgroundPathIdentity = StickyNotePathIdentity & Pick<StickyNoteRecord, 'background'>

const STATIC_BACKGROUND_IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.avif', '.bmp', '.svg',
])

export interface StickyNoteRelativePaths {
  directory: string
  markdown: string
  resources: string
}

export interface StickyNoteAbsolutePaths {
  directory: string
  markdown: string
  resources: string
}

function validateIdentity(note: StickyNotePathIdentity): 'active' | 'archive' {
  if (!isCanonicalStickyNoteId(note.id)) throw new Error('便签 ID 无效')
  if (note.status !== 'active' && note.status !== 'archived') {
    throw new Error('便签状态无效')
  }
  const validated = validateStickyNoteName(note.name, [])
  if (!validated.ok) throw new Error(validated.message)
  return note.status === 'active' ? 'active' : 'archive'
}

export function stickyNotesRoot(dataRoot: string): string {
  if (!path.isAbsolute(dataRoot)) throw new Error('便签数据根目录必须是绝对路径')
  return path.join(path.resolve(dataRoot), 'notes')
}

export function stickyNoteIndexPath(dataRoot: string): string {
  return path.join(stickyNotesRoot(dataRoot), 'index.json')
}

export function stickyNoteRelativePaths(
  note: StickyNotePathIdentity,
): StickyNoteRelativePaths {
  const statusDirectory = validateIdentity(note)
  const directory = `${statusDirectory}/${note.id}`
  return {
    directory,
    markdown: `${directory}/${note.name}.md`,
    resources: `${directory}/resources`,
  }
}

export function stickyNotePaths(
  dataRoot: string,
  note: StickyNotePathIdentity,
): StickyNoteAbsolutePaths {
  const notesRoot = stickyNotesRoot(dataRoot)
  const relative = stickyNoteRelativePaths(note)
  const result = {
    directory: path.resolve(notesRoot, ...relative.directory.split('/')),
    markdown: path.resolve(notesRoot, ...relative.markdown.split('/')),
    resources: path.resolve(notesRoot, ...relative.resources.split('/')),
  }
  const containmentRoot = `${path.resolve(notesRoot)}${path.sep}`
  if (!Object.values(result).every((candidate) => candidate.startsWith(containmentRoot))) {
    throw new Error('便签路径超出数据目录')
  }
  return result
}

export function stickyNoteBackgroundPath(
  dataRoot: string,
  note: StickyNoteBackgroundPathIdentity,
): string | null {
  const background = parseBackgroundSettings(note.background)
  const imageRelativePath = background?.imageRelativePath
  if (imageRelativePath === null) return null
  if (typeof imageRelativePath !== 'string') throw new Error('便签背景路径无效')
  const parts = imageRelativePath.split('/')
  if (
    parts.length !== 2
    || parts[0] !== 'resources'
    || parts[1].length === 0
    || parts[1] === '.'
    || parts[1] === '..'
    || parts[1].includes('\\')
    || !STATIC_BACKGROUND_IMAGE_EXTENSIONS.has(path.extname(parts[1]).toLowerCase())
  ) throw new Error('便签背景路径无效')

  const resources = stickyNotePaths(dataRoot, note).resources
  const resolved = path.resolve(resources, parts[1])
  const containmentRoot = `${path.resolve(resources)}${path.sep}`
  if (!resolved.startsWith(containmentRoot)) throw new Error('便签背景路径超出资源目录')
  return resolved
}
