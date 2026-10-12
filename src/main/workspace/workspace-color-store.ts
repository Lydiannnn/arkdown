import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import writeFileAtomic from 'write-file-atomic'
import {
  WORKSPACE_COLOR_FILE_MAX_BYTES,
  WORKSPACE_COLOR_MARK_LIMIT,
  canonicalWorkspaceColorPath,
  parseWorkspaceColorFile,
  type WorkspaceColorFile,
  type WorkspaceColorId,
  type WorkspaceColorMarksSnapshot,
} from '../../shared/workspace-color-marks'
import { resolveExistingInside } from './workspace-path'

export interface WorkspaceColorStoreDependencies {
  ensureDirectory(directory: string): Promise<void>
  fileSize(filePath: string): Promise<number>
  readTextFile(filePath: string): Promise<string>
  realpath(filePath: string): Promise<string>
  resolveExistingInside(root: string, relativePath: string): Promise<string>
  writeTextFileAtomic(filePath: string, contents: string): Promise<void>
}

const defaultDependencies: WorkspaceColorStoreDependencies = {
  ensureDirectory: async (directory) => { await mkdir(directory, { recursive: true }) },
  fileSize: async (filePath) => (await stat(filePath)).size,
  readTextFile: (filePath) => readFile(filePath, 'utf8'),
  realpath,
  resolveExistingInside,
  writeTextFileAtomic: (filePath, contents) =>
    writeFileAtomic(filePath, contents, { encoding: 'utf8', fsync: true }),
}

function sameWindowsPath(first: string, second: string): boolean {
  return path.normalize(first).toLocaleLowerCase('en-US')
    === path.normalize(second).toLocaleLowerCase('en-US')
}

function canonicalWorkspaceKey(value: string): string {
  const normalized = path.normalize(value)
  const root = path.parse(normalized).root
  return (normalized === root ? normalized : normalized.replace(/[\\/]+$/u, ''))
    .toLocaleLowerCase('en-US')
}

function sortedMarks(marks: Record<string, WorkspaceColorId>): Record<string, WorkspaceColorId> {
  return Object.fromEntries(Object.entries(marks).sort(([first], [second]) => first.localeCompare(second)))
}

function isWithinSubtree(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`)
}

function moveMarks(
  file: WorkspaceColorFile,
  from: string,
  to: string,
): { changed: boolean; file: WorkspaceColorFile } {
  const marks = Object.create(null) as Record<string, WorkspaceColorId>
  let changed = false
  for (const [candidate, color] of Object.entries(file.marks)) {
    if (!isWithinSubtree(candidate, from)) marks[candidate] = color
    else changed = true
  }
  for (const [candidate, color] of Object.entries(file.marks)) {
    if (isWithinSubtree(candidate, from)) marks[`${to}${candidate.slice(from.length)}`] = color
  }
  return { changed, file: { ...file, marks } }
}

function deleteMarks(
  file: WorkspaceColorFile,
  relativePath: string,
): { changed: boolean; file: WorkspaceColorFile } {
  const marks = Object.create(null) as Record<string, WorkspaceColorId>
  let changed = false
  for (const [candidate, color] of Object.entries(file.marks)) {
    if (isWithinSubtree(candidate, relativePath)) changed = true
    else marks[candidate] = color
  }
  return { changed, file: { ...file, marks } }
}

export interface WorkspaceColorBoundOperationResult<T> {
  value: T
  colorMarks: WorkspaceColorMarksSnapshot
}

export class WorkspaceColorStore {
  private readonly dependencies: WorkspaceColorStoreDependencies
  private readonly directory: string
  private readonly writes = new Map<string, Promise<void>>()

  constructor(
    dataRoot: string,
    dependencies: Partial<WorkspaceColorStoreDependencies> = {},
  ) {
    this.directory = path.join(dataRoot, 'workspace-color-marks')
    this.dependencies = { ...defaultDependencies, ...dependencies }
  }

  filePathForWorkspace(workspaceRoot: string): string {
    const digest = createHash('sha256').update(canonicalWorkspaceKey(workspaceRoot), 'utf8').digest('hex')
    return path.join(this.directory, `${digest}.json`)
  }

  private async identify(workspaceRoot: string): Promise<{
    canonicalRoot: string
    workspaceKey: string
    filePath: string
  }> {
    const canonicalRoot = await this.dependencies.realpath(workspaceRoot)
    if (!sameWindowsPath(workspaceRoot, canonicalRoot)) throw new Error('Workspace path changed')
    const workspaceKey = canonicalWorkspaceKey(canonicalRoot)
    return {
      canonicalRoot,
      workspaceKey,
      filePath: this.filePathForWorkspace(canonicalRoot),
    }
  }

  private async load(filePath: string, workspaceKey: string): Promise<WorkspaceColorFile> {
    try {
      if (await this.dependencies.fileSize(filePath) > WORKSPACE_COLOR_FILE_MAX_BYTES) {
        return { schemaVersion: 1, workspaceKey, marks: {} }
      }
      const source = await this.dependencies.readTextFile(filePath)
      if (Buffer.byteLength(source, 'utf8') > WORKSPACE_COLOR_FILE_MAX_BYTES) {
        return { schemaVersion: 1, workspaceKey, marks: {} }
      }
      const parsed = parseWorkspaceColorFile(JSON.parse(source) as unknown)
      return parsed?.workspaceKey === workspaceKey
        ? parsed
        : { schemaVersion: 1, workspaceKey, marks: {} }
    } catch {
      return { schemaVersion: 1, workspaceKey, marks: {} }
    }
  }

  private snapshot(file: WorkspaceColorFile): WorkspaceColorMarksSnapshot {
    return { marks: { ...file.marks } }
  }

  private async exclusive<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.writes.get(filePath) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = prior.catch(() => undefined).then(() => current)
    this.writes.set(filePath, tail)
    await prior.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.writes.get(filePath) === tail) this.writes.delete(filePath)
    }
  }

  private async save(filePath: string, file: WorkspaceColorFile): Promise<void> {
    if (Object.keys(file.marks).length > WORKSPACE_COLOR_MARK_LIMIT) {
      throw new Error('Too many workspace color marks')
    }
    await this.dependencies.ensureDirectory(this.directory)
    const contents = `${JSON.stringify({ ...file, marks: sortedMarks(file.marks) }, null, 2)}\n`
    if (Buffer.byteLength(contents, 'utf8') > WORKSPACE_COLOR_FILE_MAX_BYTES) {
      throw new Error('Workspace color file is too large')
    }
    await this.dependencies.writeTextFileAtomic(filePath, contents)
  }

  async get(workspaceRoot: string): Promise<WorkspaceColorMarksSnapshot> {
    const identity = await this.identify(workspaceRoot)
    return this.snapshot(await this.load(identity.filePath, identity.workspaceKey))
  }

  async set(
    workspaceRoot: string,
    relativePath: string,
    color: WorkspaceColorId | null,
  ): Promise<WorkspaceColorMarksSnapshot> {
    const canonicalPath = canonicalWorkspaceColorPath(relativePath)
    if (!canonicalPath) throw new Error('Invalid workspace color path')
    const identity = await this.identify(workspaceRoot)
    return await this.exclusive(identity.filePath, async () => {
      const file = await this.load(identity.filePath, identity.workspaceKey)
      if (color !== null && !Object.hasOwn(file.marks, canonicalPath)) {
        await this.dependencies.resolveExistingInside(identity.canonicalRoot, relativePath)
      }
      const marks = Object.assign(
        Object.create(null) as Record<string, WorkspaceColorId>,
        file.marks,
      )
      if (color === null) delete marks[canonicalPath]
      else marks[canonicalPath] = color
      const next = { ...file, marks }
      await this.save(identity.filePath, next)
      return this.snapshot(next)
    })
  }

  async move(
    workspaceRoot: string,
    fromRelativePath: string,
    toRelativePath: string,
  ): Promise<WorkspaceColorMarksSnapshot> {
    const from = canonicalWorkspaceColorPath(fromRelativePath)
    const to = canonicalWorkspaceColorPath(toRelativePath)
    if (!from || !to || isWithinSubtree(to, from)) throw new Error('Invalid workspace color move')
    const identity = await this.identify(workspaceRoot)
    return await this.exclusive(identity.filePath, async () => {
      const file = await this.load(identity.filePath, identity.workspaceKey)
      const next = moveMarks(file, from, to)
      if (next.changed) await this.save(identity.filePath, next.file)
      return this.snapshot(next.file)
    })
  }

  async delete(
    workspaceRoot: string,
    relativePath: string,
  ): Promise<WorkspaceColorMarksSnapshot> {
    const canonicalPath = canonicalWorkspaceColorPath(relativePath)
    if (!canonicalPath) throw new Error('Invalid workspace color path')
    const identity = await this.identify(workspaceRoot)
    return await this.exclusive(identity.filePath, async () => {
      const file = await this.load(identity.filePath, identity.workspaceKey)
      const next = deleteMarks(file, canonicalPath)
      if (next.changed) await this.save(identity.filePath, next.file)
      return this.snapshot(next.file)
    })
  }

  async withMovedMarks<T>(
    workspaceRoot: string,
    fromRelativePath: string,
    toRelativePath: string,
    operation: () => Promise<T>,
    compensate: (value: T) => Promise<void>,
  ): Promise<WorkspaceColorBoundOperationResult<T>> {
    const from = canonicalWorkspaceColorPath(fromRelativePath)
    const to = canonicalWorkspaceColorPath(toRelativePath)
    if (!from || !to || isWithinSubtree(to, from)) throw new Error('Invalid workspace color move')
    const identity = await this.identify(workspaceRoot)
    return await this.exclusive(identity.filePath, async () => {
      const file = await this.load(identity.filePath, identity.workspaceKey)
      const next = moveMarks(file, from, to)
      const value = await operation()
      if (next.changed) {
        try {
          await this.save(identity.filePath, next.file)
        } catch (metadataError) {
          try {
            await compensate(value)
          } catch (compensationError) {
            throw new AggregateError(
              [metadataError, compensationError],
              'Workspace rename metadata and filesystem compensation failed',
            )
          }
          throw metadataError
        }
      }
      return { value, colorMarks: this.snapshot(next.file) }
    })
  }

  async withDeletedMarks<T>(
    workspaceRoot: string,
    relativePath: string,
    operation: () => Promise<T>,
  ): Promise<WorkspaceColorBoundOperationResult<T>> {
    const canonicalPath = canonicalWorkspaceColorPath(relativePath)
    if (!canonicalPath) throw new Error('Invalid workspace color path')
    const identity = await this.identify(workspaceRoot)
    return await this.exclusive(identity.filePath, async () => {
      const file = await this.load(identity.filePath, identity.workspaceKey)
      const next = deleteMarks(file, canonicalPath)
      if (next.changed) await this.save(identity.filePath, next.file)
      try {
        const value = await operation()
        return { value, colorMarks: this.snapshot(next.file) }
      } catch (operationError) {
        if (next.changed) {
          try {
            await this.save(identity.filePath, file)
          } catch (compensationError) {
            throw new AggregateError(
              [operationError, compensationError],
              'Workspace trash filesystem operation and metadata compensation failed',
            )
          }
        }
        throw operationError
      }
    })
  }
}
