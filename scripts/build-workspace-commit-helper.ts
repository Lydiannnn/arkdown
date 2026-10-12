import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const HELPER_FILE_NAME = 'arkdown-workspace-commit.exe'
const MANIFEST_FILE_NAME = 'manifest.json'
const SHA256 = /^[0-9a-f]{64}$/u
const MAX_HELPER_BYTES = 2 * 1024 * 1024
const MAX_MANIFEST_BYTES = 4 * 1024
export const WORKSPACE_COMMIT_HELPER_TRUST_ENV = 'ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST_JSON'

export type WorkspaceCommitHelperArch = 'x64' | 'arm64'

export interface WorkspaceCommitHelperManifest {
  readonly schemaVersion: 1
  readonly protocolVersion: 1
  readonly arch: WorkspaceCommitHelperArch
  readonly fileName: typeof HELPER_FILE_NAME
  readonly bytes: number
  readonly sha256: string
  readonly peMachine: 0x8664 | 0xaa64
}

export interface WorkspaceCommitHelperArtifact extends WorkspaceCommitHelperManifest {
  readonly executablePath: string
  readonly manifestPath: string
  /** Stable build-returned bytes. Packaging must never re-read replaceable source pathnames. */
  readonly executableBytes: Buffer
  readonly manifestBytes: Buffer
}

export interface BuildWorkspaceCommitHelperOptions {
  readonly repoRoot: string
  readonly arch: WorkspaceCommitHelperArch
  readonly testHooks?: boolean
}

function expectedMachine(arch: WorkspaceCommitHelperArch): 0x8664 | 0xaa64 {
  return arch === 'x64' ? 0x8664 : 0xaa64
}

function canonicalArch(value: unknown): WorkspaceCommitHelperArch {
  if (value !== 'x64' && value !== 'arm64') throw new Error('Unsupported workspace commit helper architecture')
  return value
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function peMachine(bytes: Buffer): number | undefined {
  if (bytes.byteLength < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return undefined
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset < 0x40 || peOffset + 6 > bytes.byteLength) return undefined
  if (bytes.subarray(peOffset, peOffset + 4).toString('binary') !== 'PE\0\0') return undefined
  return bytes.readUInt16LE(peOffset + 4)
}

function exactManifest(value: unknown): WorkspaceCommitHelperManifest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined
  const record = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([
    'arch', 'bytes', 'fileName', 'peMachine', 'protocolVersion', 'schemaVersion', 'sha256',
  ])) return undefined
  if ((record.arch !== 'x64' && record.arch !== 'arm64')
    || record.schemaVersion !== 1
    || record.protocolVersion !== 1
    || record.fileName !== HELPER_FILE_NAME
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) <= 0 || (record.bytes as number) > MAX_HELPER_BYTES
    || typeof record.sha256 !== 'string' || !SHA256.test(record.sha256)
    || record.peMachine !== expectedMachine(record.arch)) return undefined
  return record as unknown as WorkspaceCommitHelperManifest
}

async function regularCanonicalFile(filePath: string): Promise<boolean> {
  try {
    const metadata = await lstat(filePath)
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false
    await realpath(filePath)
    return true
  } catch {
    return false
  }
}

export async function verifyWorkspaceCommitHelperArtifact(
  artifact: WorkspaceCommitHelperArtifact,
): Promise<WorkspaceCommitHelperManifest> {
  const manifestMetadata = await lstat(artifact.manifestPath).catch(() => undefined)
  if (!path.isAbsolute(artifact.executablePath) || !path.isAbsolute(artifact.manifestPath)
    || path.basename(artifact.executablePath) !== HELPER_FILE_NAME
    || path.basename(artifact.manifestPath) !== MANIFEST_FILE_NAME
    || path.dirname(artifact.executablePath) !== path.dirname(artifact.manifestPath)
    || !await regularCanonicalFile(artifact.executablePath)
    || !await regularCanonicalFile(artifact.manifestPath)
    || !manifestMetadata || manifestMetadata.size <= 0 || manifestMetadata.size > MAX_MANIFEST_BYTES) {
    throw new Error('Workspace commit helper artifact verification failed')
  }
  let manifest: WorkspaceCommitHelperManifest | undefined
  try {
    manifest = exactManifest(JSON.parse(await readFile(artifact.manifestPath, 'utf8')))
  } catch {
    // The stable verification error below intentionally hides local parser details.
  }
  if (!manifest) throw new Error('Workspace commit helper artifact verification failed')
  const bytes = await readFile(artifact.executablePath)
  if (bytes.byteLength !== manifest.bytes
    || sha256(bytes) !== manifest.sha256
    || peMachine(bytes) !== manifest.peMachine
    || manifest.arch !== artifact.arch
    || manifest.sha256 !== artifact.sha256
    || manifest.bytes !== artifact.bytes
    || manifest.peMachine !== artifact.peMachine
    || artifact.schemaVersion !== 1
    || artifact.protocolVersion !== 1
    || artifact.fileName !== HELPER_FILE_NAME) {
    throw new Error('Workspace commit helper artifact verification failed')
  }
  return manifest
}

export function workspaceCommitHelperTrustRecord(
  artifact: WorkspaceCommitHelperArtifact,
): WorkspaceCommitHelperManifest {
  return {
    schemaVersion: artifact.schemaVersion,
    protocolVersion: artifact.protocolVersion,
    arch: artifact.arch,
    fileName: artifact.fileName,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    peMachine: artifact.peMachine,
  }
}

export function parseWorkspaceCommitHelperTrustEnvironment(value: string | undefined): WorkspaceCommitHelperManifest {
  if (value === undefined) throw new Error('Missing workspace commit helper trust environment')
  let parsed: WorkspaceCommitHelperManifest | undefined
  try {
    if (Buffer.byteLength(value, 'utf8') <= MAX_MANIFEST_BYTES) parsed = exactManifest(JSON.parse(value))
  } catch {
    // The stable error below intentionally hides parser details.
  }
  if (!parsed) throw new Error('Invalid workspace commit helper trust environment')
  return parsed
}

export function verifyWorkspaceCommitHelperSnapshot(
  artifact: WorkspaceCommitHelperArtifact,
): { readonly executableBytes: Buffer; readonly manifestBytes: Buffer; readonly manifest: WorkspaceCommitHelperManifest } {
  const executableBytes = Buffer.from(artifact.executableBytes)
  const manifestBytes = Buffer.from(artifact.manifestBytes)
  if (executableBytes.byteLength <= 0 || executableBytes.byteLength > MAX_HELPER_BYTES
    || manifestBytes.byteLength <= 0 || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Workspace commit helper artifact snapshot verification failed')
  }
  let manifest: WorkspaceCommitHelperManifest | undefined
  try {
    manifest = exactManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)))
  } catch {
    // The stable verification error below intentionally hides parser details.
  }
  const expected = workspaceCommitHelperTrustRecord(artifact)
  if (!manifest || JSON.stringify(manifest) !== JSON.stringify(expected)
    || executableBytes.byteLength !== manifest.bytes
    || sha256(executableBytes) !== manifest.sha256
    || peMachine(executableBytes) !== manifest.peMachine) {
    throw new Error('Workspace commit helper artifact snapshot verification failed')
  }
  return { executableBytes, manifestBytes, manifest }
}

async function locateVisualStudio(): Promise<{ installation: string; cmake: string }> {
  const programFilesX86 = process.env['ProgramFiles(x86)']
  if (!programFilesX86) throw new Error('Visual Studio Build Tools are unavailable')
  const vswhere = path.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const metadata = await lstat(vswhere).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error('Visual Studio Build Tools are unavailable')
  const { stdout } = await execFileAsync(vswhere, [
    '-latest',
    '-products', '*',
    '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '-property', 'installationPath',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 })
  const installation = path.resolve(stdout.trim())
  const cmake = path.join(
    installation,
    'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe',
  )
  if (!stdout.trim() || !await regularCanonicalFile(cmake)) throw new Error('Visual Studio CMake is unavailable')
  return { installation, cmake }
}

function windowsBuildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  const names = new Set<string>()
  for (const [name, value] of Object.entries(process.env)) {
    const folded = name.toLocaleLowerCase('en-US')
    if (names.has(folded)) continue
    names.add(folded)
    environment[folded === 'path' ? 'Path' : name] = value
  }
  environment.CL = '/utf-8'
  environment.VSLANG = '1033'
  return environment
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid workspace commit helper build path')
  }
}

export async function buildWorkspaceCommitHelper(
  options: BuildWorkspaceCommitHelperOptions,
): Promise<WorkspaceCommitHelperArtifact> {
  if (process.platform !== 'win32') throw new Error('Workspace commit helper requires Windows')
  const arch = canonicalArch(options.arch)
  const repoRoot = path.resolve(options.repoRoot)
  const sourceRoot = path.join(repoRoot, 'native', 'workspace-commit-helper')
  const componentRoot = path.join(repoRoot, '.components', options.testHooks ? 'workspace-commit-test' : 'workspace-commit')
  const buildRoot = path.join(componentRoot, 'build', arch)
  const outputRoot = path.join(componentRoot, arch)
  for (const target of [sourceRoot, componentRoot, buildRoot, outputRoot]) assertInside(repoRoot, target)
  const { cmake } = await locateVisualStudio()
  const environment = windowsBuildEnvironment()
  await execFileAsync(cmake, [
    '-S', sourceRoot,
    '-B', buildRoot,
    '-G', 'Visual Studio 17 2022',
    '-A', arch === 'x64' ? 'x64' : 'ARM64',
    `-DARKDOWN_HELPER_OUTPUT_DIR=${outputRoot.replaceAll('\\', '/')}`,
    `-DARKDOWN_HELPER_TEST_HOOKS=${options.testHooks ? 'ON' : 'OFF'}`,
  ], { cwd: repoRoot, env: environment, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })
  await execFileAsync(cmake, [
    '--build', buildRoot,
    '--config', 'Release',
    '--target', 'arkdown-workspace-commit',
    '--parallel', '2',
  ], { cwd: repoRoot, env: environment, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 })

  const executablePath = path.join(outputRoot, HELPER_FILE_NAME)
  const bytes = await readFile(executablePath)
  const machine = peMachine(bytes)
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_HELPER_BYTES || machine !== expectedMachine(arch)) {
    throw new Error('Workspace commit helper build produced an invalid artifact')
  }
  const manifest: WorkspaceCommitHelperManifest = {
    schemaVersion: 1,
    protocolVersion: 1,
    arch,
    fileName: HELPER_FILE_NAME,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    peMachine: expectedMachine(arch),
  }
  const manifestPath = path.join(outputRoot, MANIFEST_FILE_NAME)
  const pending = `${manifestPath}.${randomUUID()}.pending`
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8')
  await writeFile(pending, manifestBytes, { flag: 'wx' })
  await rm(manifestPath, { force: true })
  await rename(pending, manifestPath)
  const artifact: WorkspaceCommitHelperArtifact = {
    ...manifest,
    executablePath,
    manifestPath,
    executableBytes: Buffer.from(bytes),
    manifestBytes: Buffer.from(manifestBytes),
  }
  await verifyWorkspaceCommitHelperArtifact(artifact)
  verifyWorkspaceCommitHelperSnapshot(artifact)
  return artifact
}

async function main(): Promise<void> {
  const artifact = await buildWorkspaceCommitHelper({
    repoRoot: process.cwd(),
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  })
  process.stdout.write(`${JSON.stringify({
    ...workspaceCommitHelperTrustRecord(artifact),
    executablePath: artifact.executablePath,
    manifestPath: artifact.manifestPath,
  })}\n`)
}

if (process.argv[1] && path.basename(process.argv[1]) === 'build-workspace-commit-helper.ts') {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
