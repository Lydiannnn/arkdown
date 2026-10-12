import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

const OUTSIDE_WORKSPACE = 'Path is outside the workspace'
const NEW_PATH_EXISTS = 'New workspace path already exists'
const INVALID_WIN32_CHARACTER = /[<>:"|?*\0]/
const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
  'COM\u00B9', 'COM\u00B2', 'COM\u00B3', 'LPT\u00B9', 'LPT\u00B2', 'LPT\u00B3',
])

function outsideWorkspace(): never {
  throw new Error(OUTSIDE_WORKSPACE)
}

function sameWindowsPath(first: string, second: string): boolean {
  return path.normalize(first).toLocaleLowerCase('en-US') === path.normalize(second).toLocaleLowerCase('en-US')
}

function assertRelative(relativePath: string): void {
  if (
    typeof relativePath !== 'string' ||
    relativePath.includes('\0') ||
    path.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.parse(relativePath).root !== ''
  ) outsideWorkspace()

  for (const component of relativePath.split(/[\\/]+/)) {
    if (!component) continue
    const baseName = component.split('.', 1)[0].toUpperCase()
    if (
      component === '.' ||
      component === '..' ||
      component.endsWith('.') ||
      component.endsWith(' ') ||
      INVALID_WIN32_CHARACTER.test(component) ||
      RESERVED_DEVICE_NAMES.has(baseName)
    ) outsideWorkspace()
  }
}

/** Validates an untrusted file path without resolving or touching the filesystem. */
export function assertWorkspaceRelativePath(relativePath: string): void {
  if (relativePath.length === 0) outsideWorkspace()
  assertRelative(relativePath)
}

function assertInside(anchor: string, candidate: string): void {
  const relative = path.relative(anchor, candidate)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) outsideWorkspace()
}

function assertSameCanonicalPath(first: string, second: string): void {
  if (!sameWindowsPath(first, second)) outsideWorkspace()
}

async function assertAnchor(anchor: string): Promise<void> {
  try {
    assertSameCanonicalPath(anchor, await realpath(anchor))
  } catch {
    outsideWorkspace()
  }
}

/**
 * Resolves only at the instant of validation. The returned string is not a persistent authorization
 * token; read, write, rename, and delete operations must resolve and validate again immediately before use.
 */
export async function resolveExistingInside(anchor: string, relativePath: string): Promise<string> {
  assertRelative(relativePath)
  await assertAnchor(anchor)
  const lexicalTarget = path.resolve(anchor, relativePath)
  assertInside(anchor, lexicalTarget)
  const canonicalTarget = await realpath(lexicalTarget)
  await assertAnchor(anchor)
  assertInside(anchor, canonicalTarget)
  await assertAnchor(anchor)
  return canonicalTarget
}

/**
 * Resolves a previously absent path only at the instant of validation. The returned string is not a
 * persistent authorization token; callers must validate again at the actual filesystem operation.
 */
export async function resolveNewInside(anchor: string, relativePath: string): Promise<string> {
  assertRelative(relativePath)
  await assertAnchor(anchor)
  const lexicalTarget = path.resolve(anchor, relativePath)
  assertInside(anchor, lexicalTarget)
  const lexicalParent = path.dirname(lexicalTarget)
  const canonicalParent = await realpath(lexicalParent)
  await assertAnchor(anchor)
  assertInside(anchor, canonicalParent)

  let targetExists = false
  try {
    await lstat(lexicalTarget)
    targetExists = true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await assertAnchor(anchor)
  if (targetExists) throw new Error(NEW_PATH_EXISTS)

  const verifiedParent = await realpath(lexicalParent)
  await assertAnchor(anchor)
  assertInside(anchor, verifiedParent)
  assertSameCanonicalPath(canonicalParent, verifiedParent)
  const target = path.join(verifiedParent, path.basename(lexicalTarget))
  assertInside(anchor, target)
  await assertAnchor(anchor)
  return target
}
