import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const GIT_OBJECT_ID = /^[0-9a-f]{40}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const RECORD_KEYS = ['schemaVersion', 'commit', 'tree', 'appAsarSha256'] as const
const MAX_PROVENANCE_BYTES = 512

export const PACKAGE_PROVENANCE_FILENAME = 'package-provenance.json'

export interface PackageSourceIdentity {
  commit: string
  tree: string
}

export interface PackageProvenance extends PackageSourceIdentity {
  schemaVersion: 1
  appAsarSha256: string
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  return stdout.trim()
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

function isStrictRecord(value: unknown): value is PackageProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...RECORD_KEYS].sort())) return false
  return record.schemaVersion === 1
    && typeof record.commit === 'string' && GIT_OBJECT_ID.test(record.commit)
    && typeof record.tree === 'string' && GIT_OBJECT_ID.test(record.tree)
    && typeof record.appAsarSha256 === 'string' && SHA256.test(record.appAsarSha256)
}

export async function captureCleanPackageSource(repoRoot: string): Promise<PackageSourceIdentity> {
  const status = await git(repoRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
  if (status) throw new Error('Packaging requires a clean Git HEAD')
  const [commit, tree] = await Promise.all([
    git(repoRoot, ['rev-parse', 'HEAD']),
    git(repoRoot, ['rev-parse', 'HEAD^{tree}']),
  ])
  if (!GIT_OBJECT_ID.test(commit) || !GIT_OBJECT_ID.test(tree)) {
    throw new Error('Packaging requires canonical Git source identities')
  }
  return { commit, tree }
}

export async function readPackageProvenance(packageRoot: string): Promise<PackageProvenance> {
  const resources = path.join(packageRoot, 'resources')
  const entries = await readdir(resources, { withFileTypes: true }).catch(() => [])
  const canonical = entries.filter((entry) => entry.name === PACKAGE_PROVENANCE_FILENAME)
  if (canonical.length !== 1 || !canonical[0]?.isFile()) {
    throw new Error('Package provenance is missing or not a regular file')
  }
  const provenancePath = path.join(resources, PACKAGE_PROVENANCE_FILENAME)
  const metadata = await lstat(provenancePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_PROVENANCE_BYTES) {
    throw new Error('Package provenance is not a bounded regular file')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(provenancePath, 'utf8'))
  } catch {
    throw new Error('Package provenance schema is invalid')
  }
  if (!isStrictRecord(parsed)) throw new Error('Package provenance schema is invalid')
  return parsed
}

export async function writePackageProvenance(
  outputPaths: readonly string[],
  source: PackageSourceIdentity,
): Promise<void> {
  if (!GIT_OBJECT_ID.test(source.commit) || !GIT_OBJECT_ID.test(source.tree)) {
    throw new Error('Cannot write noncanonical package source identity')
  }
  await Promise.all(outputPaths.map(async (packageRoot) => {
    const resources = path.join(packageRoot, 'resources')
    const appAsar = path.join(resources, 'app.asar')
    const metadata = await lstat(appAsar).catch(() => undefined)
    if (!metadata?.isFile() || metadata.isSymbolicLink()) {
      throw new Error('Cannot bind package provenance without a regular app.asar')
    }
    const record: PackageProvenance = {
      schemaVersion: 1,
      commit: source.commit,
      tree: source.tree,
      appAsarSha256: await sha256(appAsar),
    }
    const destination = path.join(resources, PACKAGE_PROVENANCE_FILENAME)
    const pending = `${destination}.pending`
    await writeFile(pending, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(pending, destination)
  }))
}

export async function auditPackageProvenance(packageRoot: string): Promise<string[]> {
  const findings: string[] = []
  const resources = path.join(packageRoot, 'resources')
  const entries = await readdir(resources, { withFileTypes: true }).catch(() => [])
  const foldedName = PACKAGE_PROVENANCE_FILENAME.toLocaleLowerCase('en-US')
  for (const entry of entries) {
    if (
      entry.name !== PACKAGE_PROVENANCE_FILENAME
      && entry.name.toLocaleLowerCase('en-US') === foldedName
    ) findings.push(path.join('unexpected package provenance', entry.name))
  }
  const canonical = entries.find((entry) => entry.name === PACKAGE_PROVENANCE_FILENAME)
  if (!canonical) {
    findings.push('missing package provenance')
    return findings.sort()
  }
  if (!canonical.isFile()) {
    findings.push('invalid package provenance file')
    return findings.sort()
  }
  try {
    const record = await readPackageProvenance(packageRoot)
    const appAsar = path.join(resources, 'app.asar')
    const appMetadata = await stat(appAsar).catch(() => undefined)
    if (!appMetadata?.isFile() || await sha256(appAsar) !== record.appAsarSha256) {
      findings.push('package provenance app.asar hash mismatch')
    }
  } catch {
    findings.push('invalid package provenance schema')
  }
  return findings.sort()
}

export async function assertPackageProvenanceMatchesCleanSource(
  packageRoot: string,
  repoRoot: string,
): Promise<PackageProvenance> {
  const source = await captureCleanPackageSource(repoRoot)
  const findings = await auditPackageProvenance(packageRoot)
  if (findings.length > 0) throw new Error(`Package provenance verification failed: ${findings.join('; ')}`)
  const record = await readPackageProvenance(packageRoot)
  if (record.commit !== source.commit || record.tree !== source.tree) {
    throw new Error('Package provenance does not match current clean Git HEAD')
  }
  return record
}
