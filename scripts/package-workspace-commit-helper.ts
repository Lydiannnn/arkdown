import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceCommitHelperArtifact } from './build-workspace-commit-helper.ts'
import { verifyWorkspaceCommitHelperSnapshot } from './build-workspace-commit-helper.ts'

async function assertForgePackageRoot(packageRoot: string): Promise<void> {
  const entries = await readdir(packageRoot, { withFileTypes: true })
  const executable = entries.find((entry) => entry.name === 'Arkdown.exe')
  const resources = entries.find((entry) => entry.name === 'resources')
  if (!executable?.isFile() || executable.isSymbolicLink()
    || !resources?.isDirectory() || resources.isSymbolicLink()) {
    throw new Error('Invalid Forge package output')
  }
  const resourceEntries = await readdir(path.join(packageRoot, 'resources'), { withFileTypes: true })
  const archive = resourceEntries.find((entry) => entry.name === 'app.asar')
  if (!archive?.isFile() || archive.isSymbolicLink()) throw new Error('Invalid Forge package output')
}

async function assertManagedDirectory(directory: string): Promise<void> {
  const metadata = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) {
    throw new Error('Invalid workspace commit helper package target')
  }
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid workspace commit helper package target')
  }
}

async function assertNoReparseDescendant(root: string, target: string): Promise<void> {
  assertContained(root, target)
  const canonicalRoot = await realpath(root)
  let current = root
  for (const component of path.relative(root, target).split(path.sep)) {
    current = path.join(current, component)
    const metadata = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!metadata) break
    if (metadata.isSymbolicLink()) throw new Error('Invalid workspace commit helper package target')
    const canonical = await realpath(current)
    if (canonical !== canonicalRoot) assertContained(canonicalRoot, canonical)
  }
}

export async function copyWorkspaceCommitHelperToPackages(
  outputPaths: readonly string[],
  artifact: WorkspaceCommitHelperArtifact,
): Promise<void> {
  // Build-time boundary: Node cannot handle-bind every publish syscall against
  // a same-user junction swap. Forge's package output/ACL is therefore trusted;
  // private staging, whole-directory publish, and final anchored byte checks
  // detect ordinary/static replacement without pretending to close that race.
  const snapshot = verifyWorkspaceCommitHelperSnapshot(artifact)
  const packageRoots = outputPaths.map((value) => path.resolve(value))
  if (packageRoots.length === 0
    || new Set(packageRoots.map((value) => value.toLocaleLowerCase('en-US'))).size !== packageRoots.length) {
    throw new Error('Invalid Forge package outputs')
  }
  await Promise.all(packageRoots.map(assertForgePackageRoot))

  await Promise.all(packageRoots.map(async (packageRoot) => {
    const nativeRoot = path.join(packageRoot, 'resources', 'native', 'workspace-commit')
    await assertNoReparseDescendant(packageRoot, nativeRoot)
    await assertManagedDirectory(path.dirname(nativeRoot))
    await assertManagedDirectory(nativeRoot)
    await mkdir(nativeRoot, { recursive: true })
    await assertNoReparseDescendant(packageRoot, nativeRoot)
    await assertManagedDirectory(path.dirname(nativeRoot))
    await assertManagedDirectory(nativeRoot)
    const staging = await mkdtemp(path.join(nativeRoot, `.pending-${artifact.arch}-`))
    const target = path.join(nativeRoot, artifact.arch)
    try {
      const executable = path.join(staging, artifact.fileName)
      const manifest = path.join(staging, 'manifest.json')
      await assertNoReparseDescendant(packageRoot, staging)
      await writeFile(executable, snapshot.executableBytes, { flag: 'wx' })
      await writeFile(manifest, snapshot.manifestBytes, { flag: 'wx' })
      const [copiedExecutable, copiedManifest] = await Promise.all([
        lstat(executable),
        lstat(manifest),
      ])
      if (!copiedExecutable.isFile() || copiedExecutable.isSymbolicLink()
        || !copiedManifest.isFile() || copiedManifest.isSymbolicLink()
        || !(await readFile(executable)).equals(snapshot.executableBytes)
        || !(await readFile(manifest)).equals(snapshot.manifestBytes)) {
        throw new Error('Workspace commit helper package verification failed')
      }
      const existingTarget = await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (existingTarget) throw new Error('Workspace commit helper package target already exists')
      await rename(staging, target)
      await assertNoReparseDescendant(packageRoot, target)
      if (!(await readFile(path.join(target, artifact.fileName))).equals(snapshot.executableBytes)
        || !(await readFile(path.join(target, 'manifest.json'))).equals(snapshot.manifestBytes)) {
        throw new Error('Workspace commit helper package verification failed')
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }))
}
