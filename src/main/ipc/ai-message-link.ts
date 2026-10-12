import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { AiMessageLinkTarget } from '../../shared/link-target'
import { PublicError } from '../../shared/public-errors'
import { queryWindowsReparsePoint } from '../workspace/windows-reparse-point'

type LocalAiMessageLinkTarget = Extract<AiMessageLinkTarget, { kind: 'local' }>

interface AiMessageLinkMetadata {
  readonly dev?: number | bigint
  readonly ino?: number | bigint
  readonly size?: number | bigint
  readonly mtimeMs?: number | bigint
  readonly ctimeMs?: number | bigint
  readonly mtimeNs?: bigint
  readonly ctimeNs?: bigint
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface AiMessageLinkIo {
  lstat(target: string): Promise<AiMessageLinkMetadata>
  realpath(target: string): Promise<string>
  queryWindowsReparsePoint(target: string): Promise<boolean>
}

export interface ResolvedAiMessageLocalTarget {
  readonly absolutePath: string
  readonly insideWorkspace: boolean
  readonly kind: 'directory' | 'file'
}

const nodeAiMessageLinkIo: AiMessageLinkIo = {
  lstat: async (target) => await lstat(target, { bigint: true }),
  realpath,
  queryWindowsReparsePoint,
}

interface PathSnapshot {
  readonly kind: 'directory' | 'file'
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly size: number | bigint
  readonly modified: number | bigint
  readonly changed: number | bigint
}

function invalidPath(): never {
  throw new PublicError('INVALID_INPUT')
}

function missingPath(): never {
  throw new PublicError('FILE_NOT_FOUND')
}

function sameWindowsPath(first: string, second: string): boolean {
  return path.win32.normalize(first).toLocaleLowerCase('en-US')
    === path.win32.normalize(second).toLocaleLowerCase('en-US')
}

function isInsideWorkspace(root: string, target: string): boolean {
  const relative = path.win32.relative(root, target)
  return relative === ''
    || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'))
}

function requireScalar(value: unknown): number | bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value)) return value
  return invalidPath()
}

function snapshot(metadata: AiMessageLinkMetadata): PathSnapshot {
  if (metadata.isSymbolicLink()) return invalidPath()
  const kind = metadata.isFile() ? 'file' : metadata.isDirectory() ? 'directory' : invalidPath()
  return Object.freeze({
    kind,
    dev: requireScalar(metadata.dev),
    ino: requireScalar(metadata.ino),
    size: requireScalar(metadata.size),
    modified: requireScalar(metadata.mtimeNs ?? metadata.mtimeMs),
    changed: requireScalar(metadata.ctimeNs ?? metadata.ctimeMs),
  })
}

function sameSnapshot(first: PathSnapshot, second: PathSnapshot): boolean {
  return first.kind === second.kind
    && first.dev === second.dev
    && first.ino === second.ino
    && first.size === second.size
    && first.modified === second.modified
    && first.changed === second.changed
}

function componentPaths(absolutePath: string): readonly string[] {
  const root = path.win32.parse(absolutePath).root
  if (!/^[a-z]:\\$/i.test(root)) return invalidPath()
  const relative = path.win32.relative(root, absolutePath)
  if (path.win32.isAbsolute(relative) || relative === '..' || relative.startsWith('..\\')) {
    return invalidPath()
  }
  const components = relative === '' ? [] : relative.split('\\')
  const result = [path.win32.normalize(root)]
  let current = result[0]
  for (const component of components) {
    current = path.win32.join(current, component)
    result.push(current)
  }
  return result
}

function mapFileSystemFailure(error: unknown, initial: boolean): never {
  if (error instanceof PublicError) throw error
  if (initial && (error as NodeJS.ErrnoException)?.code === 'ENOENT') return missingPath()
  return invalidPath()
}

async function inspectComponents(
  components: readonly string[],
  io: AiMessageLinkIo,
  initial: boolean,
): Promise<readonly PathSnapshot[]> {
  const snapshots: PathSnapshot[] = []
  try {
    for (let index = 0; index < components.length; index += 1) {
      const target = components[index]
      const current = snapshot(await io.lstat(target))
      if (index < components.length - 1 && current.kind !== 'directory') return invalidPath()
      if (await io.queryWindowsReparsePoint(target)) return invalidPath()
      snapshots.push(current)
    }
  } catch (error) {
    return mapFileSystemFailure(error, initial)
  }
  return snapshots
}

async function requireStableCanonicalPath(
  absolutePath: string,
  io: AiMessageLinkIo,
  initial: boolean,
): Promise<string> {
  try {
    const canonical = await io.realpath(absolutePath)
    if (!sameWindowsPath(canonical, absolutePath)) invalidPath()
    return path.win32.normalize(canonical)
  } catch (error) {
    return mapFileSystemFailure(error, initial)
  }
}

export async function resolveAiMessageLocalTarget(
  target: LocalAiMessageLinkTarget,
  workspaceRoot: string,
  io: AiMessageLinkIo = nodeAiMessageLinkIo,
): Promise<ResolvedAiMessageLocalTarget> {
  if (!/^[a-z]:\\/i.test(workspaceRoot) || workspaceRoot.startsWith('\\\\')) return invalidPath()
  const normalizedRoot = path.win32.normalize(workspaceRoot)
  const absolutePath = target.scope === 'workspace-relative'
    ? path.win32.resolve(normalizedRoot, target.path)
    : path.win32.normalize(target.path)
  if (!/^[a-z]:\\/i.test(absolutePath) || absolutePath.startsWith('\\\\')) return invalidPath()

  const components = componentPaths(absolutePath)
  const first = await inspectComponents(components, io, true)
  await requireStableCanonicalPath(absolutePath, io, true)
  const second = await inspectComponents(components, io, false)
  const canonicalPath = await requireStableCanonicalPath(absolutePath, io, false)
  if (first.length !== second.length
    || first.some((value, index) => !sameSnapshot(value, second[index]))) return invalidPath()
  const final = second.at(-1)
  if (!final) return invalidPath()
  return Object.freeze({
    absolutePath: canonicalPath,
    insideWorkspace: isInsideWorkspace(normalizedRoot, canonicalPath),
    kind: final.kind,
  })
}
