import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  TreeEntry,
  WorkspaceEntryProperties,
} from '../../shared/contracts'
import type { WorkspaceColorMarksSnapshot } from '../../shared/workspace-color-marks'
import {
  isVisibleWorkspacePath,
} from '../../shared/document-types'
import { appError } from '../../shared/public-errors'
import { resolveExistingInside, resolveNewInside } from './workspace-path'
import type { WorkspaceService } from './workspace-service'
import type { WorkspaceColorStore } from './workspace-color-store'

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const ILLEGAL_NAME = /[<>:"/\\|?*\u0000-\u001f]/

function slashSeparated(root: string, target: string): string {
  return path.relative(root, target).split(/[\\/]+/).join('/')
}

function sameWindowsPath(first: string, second: string): boolean {
  return path.normalize(first).toLocaleLowerCase('en-US')
    === path.normalize(second).toLocaleLowerCase('en-US')
}

export function isValidWorkspaceEntryName(name: string): boolean {
  return (
    typeof name === 'string'
    && name.length > 0
    && name.length <= 255
    && name !== '.'
    && name !== '..'
    && !ILLEGAL_NAME.test(name)
    && !WINDOWS_RESERVED_NAME.test(name)
    && !/[ .]$/.test(name)
  )
}

export interface WorkspaceEntryRenameOperation {
  entry: TreeEntry
  absolutePath: string
  colorMarks: WorkspaceColorMarksSnapshot
}

export interface WorkspaceEntryTrashOperation {
  colorMarks: WorkspaceColorMarksSnapshot
}

export class WorkspaceEntryService {
  constructor(private readonly options: {
    workspace: WorkspaceService
    trashItem(absolutePath: string): Promise<void>
    revealItem(absolutePath: string): void
    openWindow(absolutePath: string): Promise<void>
    renameItem?(source: string, target: string): Promise<void>
    workspaceColors?: Pick<WorkspaceColorStore, 'withMovedMarks' | 'withDeletedMarks'>
  }) {}

  private async canonicalRoot(): Promise<string> {
    const root = this.options.workspace.getRoot()
    const canonical = await realpath(root)
    if (!sameWindowsPath(root, canonical)) throw appError('PATH_OUTSIDE_WORKSPACE')
    return canonical
  }

  private validateRelative(relativePath: string, allowRoot = false): void {
    if (
      typeof relativePath !== 'string'
      || path.isAbsolute(relativePath)
      || relativePath.includes('\0')
      || (!allowRoot && relativePath === '')
    ) throw appError('INVALID_INPUT')
  }

  private async resolveExisting(root: string, relativePath: string): Promise<string> {
    try {
      return await resolveExistingInside(root, relativePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw appError('FILE_NOT_FOUND')
      }
      throw appError('PATH_OUTSIDE_WORKSPACE')
    }
  }

  private async resolveNew(root: string, relativePath: string): Promise<string> {
    try {
      return await resolveNewInside(root, relativePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EACCES') {
        throw appError('PERMISSION_DENIED')
      }
      throw appError('INVALID_INPUT')
    }
  }

  private async existing(relativePath: string): Promise<{
    root: string
    absolutePath: string
    kind: TreeEntry['kind']
  }> {
    this.validateRelative(relativePath)
    const root = await this.canonicalRoot()
    const absolutePath = await this.resolveExisting(root, relativePath)
    const metadata = await lstat(absolutePath)
    if (metadata.isSymbolicLink()) throw appError('PATH_OUTSIDE_WORKSPACE')
    const kind = metadata.isDirectory()
      ? 'directory'
      : metadata.isFile() && isVisibleWorkspacePath(absolutePath)
        ? 'document'
        : null
    if (!kind) throw appError('UNSUPPORTED_FILE_TYPE')
    return { root, absolutePath, kind }
  }

  async createFolder(parentRelativePath: string, name: string): Promise<TreeEntry> {
    this.validateRelative(parentRelativePath, true)
    if (!isValidWorkspaceEntryName(name)) throw appError('INVALID_INPUT')
    const root = await this.canonicalRoot()
    const parent = await this.resolveExisting(root, parentRelativePath)
    if (!(await stat(parent)).isDirectory()) throw appError('INVALID_INPUT')
    const relativePath = slashSeparated(root, path.join(parent, name))
    const target = await this.resolveNew(root, relativePath)
    try {
      await mkdir(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw appError('INVALID_INPUT')
      throw error
    }
    return { name, relativePath, kind: 'directory' }
  }

  async renameEntry(relativePath: string, newName: string): Promise<WorkspaceEntryRenameOperation> {
    if (!isValidWorkspaceEntryName(newName)) throw appError('INVALID_INPUT')
    const source = await this.existing(relativePath)
    if (source.kind === 'document' && !isVisibleWorkspacePath(newName)) {
      throw appError('UNSUPPORTED_FILE_TYPE')
    }
    const targetRelativePath = slashSeparated(
      source.root,
      path.join(path.dirname(source.absolutePath), newName),
    )
    const target = await this.resolveNew(source.root, targetRelativePath)
    await lstat(target).then(
      () => { throw appError('INVALID_INPUT') },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      },
    )
    const renameItem = this.options.renameItem ?? rename
    const entry = { name: newName, relativePath: targetRelativePath, kind: source.kind }
    if (!this.options.workspaceColors) {
      await renameItem(source.absolutePath, target)
      return { entry, absolutePath: target, colorMarks: { marks: {} } }
    }
    const result = await this.options.workspaceColors.withMovedMarks(
      source.root,
      relativePath,
      targetRelativePath,
      async () => { await renameItem(source.absolutePath, target) },
      async () => { await renameItem(target, source.absolutePath) },
    )
    return { entry, absolutePath: target, colorMarks: result.colorMarks }
  }

  async duplicateDocument(relativePath: string): Promise<TreeEntry> {
    const source = await this.existing(relativePath)
    if (source.kind !== 'document') throw appError('UNSUPPORTED_FILE_TYPE')
    const extension = path.extname(source.absolutePath)
    const stem = path.basename(source.absolutePath, extension)
    const directory = path.dirname(source.absolutePath)
    for (let index = 1; index <= 10_000; index += 1) {
      const suffix = index === 1 ? ' - 副本' : ` - 副本 (${index})`
      const name = `${stem}${suffix}${extension}`
      const target = path.join(directory, name)
      try {
        await copyFile(source.absolutePath, target, constants.COPYFILE_EXCL)
        return {
          name,
          relativePath: slashSeparated(source.root, target),
          kind: 'document',
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw appError('OPERATION_FAILED')
  }

  async trashEntry(relativePath: string): Promise<WorkspaceEntryTrashOperation> {
    const entry = await this.existing(relativePath)
    if (!this.options.workspaceColors) {
      await this.options.trashItem(entry.absolutePath)
      return { colorMarks: { marks: {} } }
    }
    const result = await this.options.workspaceColors.withDeletedMarks(
      entry.root,
      relativePath,
      async () => { await this.options.trashItem(entry.absolutePath) },
    )
    return { colorMarks: result.colorMarks }
  }

  async revealEntry(relativePath: string): Promise<void> {
    const entry = await this.existing(relativePath)
    this.options.revealItem(entry.absolutePath)
  }

  async openEntryWindow(relativePath: string): Promise<void> {
    const entry = await this.existing(relativePath)
    await this.options.openWindow(entry.absolutePath)
  }

  async properties(relativePath: string): Promise<WorkspaceEntryProperties> {
    const entry = await this.existing(relativePath)
    const metadata = await stat(entry.absolutePath)
    const itemCount = entry.kind === 'directory'
      ? (await readdir(entry.absolutePath)).length
      : null
    return {
      name: path.basename(entry.absolutePath),
      relativePath: slashSeparated(entry.root, entry.absolutePath),
      absolutePath: entry.absolutePath,
      kind: entry.kind,
      size: metadata.size,
      createdAt: metadata.birthtime.toISOString(),
      modifiedAt: metadata.mtime.toISOString(),
      itemCount,
    }
  }

  async rootProperties(): Promise<WorkspaceEntryProperties> {
    const root = await this.canonicalRoot()
    const metadata = await stat(root)
    return {
      name: path.basename(root),
      relativePath: '',
      absolutePath: root,
      kind: 'directory',
      size: metadata.size,
      createdAt: metadata.birthtime.toISOString(),
      modifiedAt: metadata.mtime.toISOString(),
      itemCount: (await readdir(root)).length,
    }
  }
}
