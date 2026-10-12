import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UserConfigFn } from 'vite'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import viteMainConfig from '../../vite.main.config'
import {
  buildWorkspaceCommitHelper,
  parseWorkspaceCommitHelperTrustEnvironment,
  WORKSPACE_COMMIT_HELPER_TRUST_ENV,
  workspaceCommitHelperTrustRecord,
  type WorkspaceCommitHelperArtifact,
} from '../../scripts/build-workspace-commit-helper'
import {
  copyWorkspaceCommitHelperToPackages,
} from '../../scripts/package-workspace-commit-helper'
import { auditWorkspaceCommitHelperResources } from '../../scripts/audit-arkdown-package'

const roots: string[] = []
let artifact: WorkspaceCommitHelperArtifact

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

async function forgePackageRoot(): Promise<string> {
  const root = await temporaryRoot('arkdown-native-package-')
  await mkdir(path.join(root, 'resources'), { recursive: true })
  await writeFile(path.join(root, 'Arkdown.exe'), 'launcher')
  await writeFile(path.join(root, 'resources', 'app.asar'), 'archive')
  return root
}

beforeAll(async () => {
  artifact = await buildWorkspaceCommitHelper({
    repoRoot: path.resolve('.'),
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  })
}, 120_000)

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('workspace commit helper build and packaging', () => {
  it('embeds Windows-readable identity and matching numeric and string versions before hashing', async () => {
    const resource = NtExecutableResource.from(NtExecutable.from(artifact.executableBytes))
    const versions = Resource.VersionInfo.fromEntries(resource.entries)
    expect(versions).toHaveLength(1)
    const version = versions[0]
    expect(version.fixedInfo).toMatchObject({ fileVersionMS: 65536, fileVersionLS: 262144, productVersionMS: 65536, productVersionLS: 262144 })
    expect(version.getStringValues(version.getAllLanguagesForStringValues()[0])).toMatchObject({
      ProductName: 'Arkdown', FileDescription: 'Arkdown 文档保存与工作区文件提交组件',
      InternalName: 'arkdown-workspace-commit', OriginalFilename: 'arkdown-workspace-commit.exe',
      FileVersion: '1.0.4.0', ProductVersion: '1.0.4.0', CompanyName: 'Miterh', LegalCopyright: 'Copyright (c) 2026 Miterh',
    })
    expect(createHash('sha256').update(artifact.executableBytes).digest('hex')).toBe(artifact.sha256)
  })

  it('builds a bounded PE helper and an exact hash-bound manifest in the ignored component root', async () => {
    const bytes = await readFile(artifact.executablePath)
    const manifest = JSON.parse(await readFile(artifact.manifestPath, 'utf8'))

    expect(path.relative(path.resolve('.components'), artifact.executablePath)).not.toMatch(/^\.\./u)
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('MZ')
    expect(bytes.byteLength).toBeGreaterThan(8_192)
    expect(bytes.byteLength).toBeLessThan(2 * 1024 * 1024)
    expect(manifest).toEqual({
      schemaVersion: 1,
      protocolVersion: 1,
      arch: artifact.arch,
      fileName: 'arkdown-workspace-commit.exe',
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      peMachine: artifact.arch === 'x64' ? 0x8664 : 0xaa64,
    })
    expect(artifact.executableBytes).toEqual(bytes)
    expect(artifact.manifestBytes).toEqual(Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'))
    expect(workspaceCommitHelperTrustRecord(artifact)).toEqual(manifest)
    expect(JSON.stringify(workspaceCommitHelperTrustRecord(artifact))).not.toContain(artifact.executablePath)
  })

  it('keeps native race-test commands out of the production helper', async () => {
    const child = spawn(artifact.executablePath, [
      '--test-set-mount-point-v1',
      'C:\\not-used',
      'C:\\not-used',
    ], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })

    expect(code).toBe(2)
    expect(Buffer.concat(stdout).byteLength).toBe(0)
    expect(Buffer.concat(stderr).byteLength).toBe(0)
  })

  it('serializes only exact helper trust fields for main-bundle compile-time anchoring', () => {
    const trust = workspaceCommitHelperTrustRecord(artifact)
    expect(WORKSPACE_COMMIT_HELPER_TRUST_ENV).toBe('ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST_JSON')
    expect(parseWorkspaceCommitHelperTrustEnvironment(JSON.stringify(trust))).toEqual(trust)
    expect(() => parseWorkspaceCommitHelperTrustEnvironment(JSON.stringify({ ...trust, executablePath: artifact.executablePath })))
      .toThrow('Invalid workspace commit helper trust environment')
    expect(() => parseWorkspaceCommitHelperTrustEnvironment(undefined))
      .toThrow('Missing workspace commit helper trust environment')
  })

  it('injects the exact prePackage trust record as a main-bundle compile-time constant', async () => {
    const trust = workspaceCommitHelperTrustRecord(artifact)
    const previous = process.env[WORKSPACE_COMMIT_HELPER_TRUST_ENV]
    process.env[WORKSPACE_COMMIT_HELPER_TRUST_ENV] = JSON.stringify(trust)
    try {
      const configure = viteMainConfig as UserConfigFn
      const config = await configure({ command: 'build', mode: 'production', isSsrBuild: false, isPreview: false })
      expect(config.define?.__ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST__).toBe(JSON.stringify(trust))
    } finally {
      if (previous === undefined) delete process.env[WORKSPACE_COMMIT_HELPER_TRUST_ENV]
      else process.env[WORKSPACE_COMMIT_HELPER_TRUST_ENV] = previous
    }
  })

  it('copies only the verified helper and manifest into every Forge package output', async () => {
    const first = await forgePackageRoot()
    const second = await forgePackageRoot()

    await copyWorkspaceCommitHelperToPackages([first, second], artifact)

    for (const packageRoot of [first, second]) {
      const target = path.join(packageRoot, 'resources', 'native', 'workspace-commit', artifact.arch)
      expect(await readdir(target)).toEqual(['arkdown-workspace-commit.exe', 'manifest.json'])
      expect(await readFile(path.join(target, 'arkdown-workspace-commit.exe')))
        .toEqual(await readFile(artifact.executablePath))
      await expect(auditWorkspaceCommitHelperResources(packageRoot, artifact.arch)).resolves.toEqual([])
    }
  })

  it('rejects a modified binary, wrong architecture, and extra executable', async () => {
    const modified = await forgePackageRoot()
    await copyWorkspaceCommitHelperToPackages([modified], artifact)
    const target = path.join(modified, 'resources', 'native', 'workspace-commit', artifact.arch)
    await writeFile(path.join(target, 'arkdown-workspace-commit.exe'), 'tampered')
    expect(await auditWorkspaceCommitHelperResources(modified, artifact.arch))
      .toEqual(expect.arrayContaining(['workspace commit helper hash mismatch']))

    const wrongArchitecture = await forgePackageRoot()
    await copyWorkspaceCommitHelperToPackages([wrongArchitecture], artifact)
    expect(await auditWorkspaceCommitHelperResources(
      wrongArchitecture,
      artifact.arch === 'x64' ? 'arm64' : 'x64',
    )).toEqual(expect.arrayContaining(['missing workspace commit helper resources']))

    const extra = await forgePackageRoot()
    await copyWorkspaceCommitHelperToPackages([extra], artifact)
    const extraRoot = path.join(extra, 'resources', 'native', 'workspace-commit', artifact.arch)
    await writeFile(path.join(extraRoot, 'other.exe'), 'unapproved')
    expect(await auditWorkspaceCommitHelperResources(extra, artifact.arch))
      .toEqual(expect.arrayContaining([path.join('unexpected workspace commit helper resource', 'other.exe')]))

  })

  it('rejects oversized executable metadata and manifest byte declarations before artifact reads', async () => {
    const oversizedExecutable = await forgePackageRoot()
    await copyWorkspaceCommitHelperToPackages([oversizedExecutable], artifact)
    const executableRoot = path.join(
      oversizedExecutable,
      'resources',
      'native',
      'workspace-commit',
      artifact.arch,
    )
    await writeFile(path.join(executableRoot, 'arkdown-workspace-commit.exe'), Buffer.alloc(2 * 1024 * 1024 + 1))
    await expect(auditWorkspaceCommitHelperResources(oversizedExecutable, artifact.arch))
      .resolves.toContain('workspace commit helper executable is invalid')

    const oversizedDeclaration = await forgePackageRoot()
    await copyWorkspaceCommitHelperToPackages([oversizedDeclaration], artifact)
    const manifestPath = path.join(
      oversizedDeclaration,
      'resources',
      'native',
      'workspace-commit',
      artifact.arch,
      'manifest.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    await writeFile(manifestPath, JSON.stringify({ ...manifest, bytes: 2 * 1024 * 1024 + 1 }))
    await expect(auditWorkspaceCommitHelperResources(oversizedDeclaration, artifact.arch))
      .resolves.toContain('workspace commit helper manifest is invalid')
  })

  it('rejects a reparse helper artifact', async ({ skip }) => {
    const linked = await forgePackageRoot()
    const linkedRoot = path.join(linked, 'resources', 'native', 'workspace-commit', artifact.arch)
    await mkdir(linkedRoot, { recursive: true })
    try {
      await symlink(artifact.executablePath, path.join(linkedRoot, 'arkdown-workspace-commit.exe'), 'file')
    } catch {
      skip()
      return
    }
    await writeFile(path.join(linkedRoot, 'manifest.json'), await readFile(artifact.manifestPath))
    expect(await auditWorkspaceCommitHelperResources(linked, artifact.arch))
      .toEqual(expect.arrayContaining(['workspace commit helper is not a regular file']))
  })

  it('copies the build-returned stable bytes even if source pathnames are replaced before packaging', async () => {
    const sourceRoot = await temporaryRoot('arkdown-native-source-copy-')
    const copiedExecutable = path.join(sourceRoot, 'arkdown-workspace-commit.exe')
    const copiedManifest = path.join(sourceRoot, 'manifest.json')
    await writeFile(copiedExecutable, await readFile(artifact.executablePath))
    await writeFile(copiedManifest, await readFile(artifact.manifestPath))
    await writeFile(copiedExecutable, Buffer.concat([await readFile(copiedExecutable), Buffer.from('tamper')]))
    await writeFile(copiedManifest, JSON.stringify({ replaced: true }))
    const packageRoot = await forgePackageRoot()

    await expect(copyWorkspaceCommitHelperToPackages([packageRoot], {
      ...artifact,
      executablePath: copiedExecutable,
      manifestPath: copiedManifest,
    })).resolves.toBeUndefined()
    const packagedRoot = path.join(packageRoot, 'resources', 'native', 'workspace-commit', artifact.arch)
    await expect(readFile(path.join(packagedRoot, 'arkdown-workspace-commit.exe')))
      .resolves.toEqual(artifact.executableBytes)
    await expect(readFile(path.join(packagedRoot, 'manifest.json')))
      .resolves.toEqual(artifact.manifestBytes)
  })

  it('refuses a reparse managed target without touching its external destination', async ({ skip }) => {
    const packageRoot = await forgePackageRoot()
    const outside = await temporaryRoot('arkdown-native-package-outside-')
    const nativeRoot = path.join(packageRoot, 'resources', 'native')
    await mkdir(nativeRoot)
    try {
      await symlink(outside, path.join(nativeRoot, 'workspace-commit'), 'junction')
    } catch {
      skip()
      return
    }
    await writeFile(path.join(outside, 'sentinel.txt'), 'outside')

    await expect(copyWorkspaceCommitHelperToPackages([packageRoot], artifact))
      .rejects.toThrow('Invalid workspace commit helper package target')
    await expect(readFile(path.join(outside, 'sentinel.txt'), 'utf8')).resolves.toBe('outside')
    await expect(readdir(outside)).resolves.toEqual(['sentinel.txt'])
  })
})
