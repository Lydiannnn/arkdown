import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyScreenshotTranslationBridges } from '../../scripts/package-screenshot-translation-bridges'

const provenance = vi.hoisted(() => ({
  capture: vi.fn(async () => ({ commit: '1'.repeat(40), tree: '2'.repeat(40) })),
  write: vi.fn(async () => undefined),
}))
const workspaceCommitPackaging = vi.hoisted(() => ({
  build: vi.fn(async () => ({
    schemaVersion: 1 as const,
    protocolVersion: 1 as const,
    arch: 'x64' as const,
    fileName: 'arkdown-workspace-commit.exe' as const,
    bytes: 512,
    sha256: 'a'.repeat(64),
    peMachine: 0x8664 as const,
    executablePath: 'C:\\controlled\\arkdown-workspace-commit.exe',
    manifestPath: 'C:\\controlled\\manifest.json',
  })),
  copy: vi.fn(async () => undefined),
}))

vi.mock('../../scripts/package-arknote.ts', () => ({ copyArknoteExecutable: async () => undefined }))
vi.mock('../../scripts/build-screen-translation.ts', () => ({ buildScreenTranslation: async () => undefined }))
vi.mock('../../scripts/package-screen-translation.ts', () => ({ verifyScreenTranslationRuntime: async () => [], copyScreenTranslationToPackages: async () => undefined }))
vi.mock('../../scripts/build-sticky-note-native-surface.ts', () => ({ buildStickyNoteNativeSurface: async () => undefined }))
vi.mock('../../scripts/package-sticky-note-native-surface.ts', () => ({ copyStickyNoteNativeSurface: async () => undefined }))
vi.mock('../../scripts/package-user-guide.ts', () => ({ copyUserGuideToPackages: async () => undefined }))
vi.mock('../../scripts/package-pandoc.ts', () => ({ copyPandocToPackages: async () => undefined }))
vi.mock('../../scripts/package-screenshot-ocr-models.ts', () => ({ packageScreenshotOcrModels: async () => undefined }))
vi.mock('../../scripts/package-provenance.ts', () => ({
  captureCleanPackageSource: provenance.capture,
  writePackageProvenance: provenance.write,
}))
vi.mock('../../scripts/build-workspace-commit-helper.ts', () => ({
  WORKSPACE_COMMIT_HELPER_TRUST_ENV: 'ARKDOWN_WORKSPACE_COMMIT_HELPER_TRUST_JSON',
  buildWorkspaceCommitHelper: workspaceCommitPackaging.build,
  workspaceCommitHelperTrustRecord: (artifact: Record<string, unknown>) => ({
    schemaVersion: artifact.schemaVersion,
    protocolVersion: artifact.protocolVersion,
    arch: artifact.arch,
    fileName: artifact.fileName,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    peMachine: artifact.peMachine,
  }),
}))
vi.mock('../../scripts/package-workspace-commit-helper.ts', () => ({
  copyWorkspaceCommitHelperToPackages: workspaceCommitPackaging.copy,
}))

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function root(prefix: string) { const value = await mkdtemp(path.join(tmpdir(), prefix)); roots.push(value); return value }
async function forgePackageRoot(prefix: string) {
  const value = await root(prefix)
  await mkdir(path.join(value, 'resources'), { recursive: true })
  await writeFile(path.join(value, 'Arkdown.exe'), 'launcher')
  await writeFile(path.join(value, 'resources', 'app.asar'), 'archive')
  return value
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

describe('screenshot translation bridge packaging', () => {
  it('copies exactly both trusted bridge scripts byte-for-byte to every package', async () => {
    const source = await root('arkdown-bridge-source-')
    const packages = [await forgePackageRoot('arkdown-bridge-package-a-'), await forgePackageRoot('arkdown-bridge-package-b-')]
    await writeFile(path.join(source, 'windows-ocr.ps1'), Buffer.from([0, 1, 2, 255]))
    await writeFile(path.join(source, 'windows-window-hit-test.ps1'), Buffer.from('hit-test'))

    await copyScreenshotTranslationBridges(packages, source)

    for (const packageRoot of packages) {
      const target = path.join(packageRoot, 'resources', 'screenshot-translation')
      expect(await readdir(target)).toEqual(['windows-ocr.ps1', 'windows-window-hit-test.ps1'])
      expect(digest(await readFile(path.join(target, 'windows-ocr.ps1')))).toBe(digest(await readFile(path.join(source, 'windows-ocr.ps1'))))
      expect(digest(await readFile(path.join(target, 'windows-window-hit-test.ps1')))).toBe(digest(await readFile(path.join(source, 'windows-window-hit-test.ps1'))))
    }
  })

  it('replaces the managed directory without touching unrelated package resources', async () => {
    const source = await root('arkdown-bridge-source-'); const packageRoot = await forgePackageRoot('arkdown-bridge-package-')
    await writeFile(path.join(source, 'windows-ocr.ps1'), 'ocr-v1'); await writeFile(path.join(source, 'windows-window-hit-test.ps1'), 'hit')
    const target = path.join(packageRoot, 'resources', 'screenshot-translation'); await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'unexpected.ps1'), 'bad'); await writeFile(path.join(packageRoot, 'resources', 'keep.bin'), 'keep')
    await copyScreenshotTranslationBridges([packageRoot], source)
    expect(await readdir(target)).toEqual(['windows-ocr.ps1', 'windows-window-hit-test.ps1'])
    await expect(readFile(path.join(packageRoot, 'resources', 'keep.bin'), 'utf8')).resolves.toBe('keep')
  })

  it('rejects a missing source without creating a partial trusted directory', async () => {
    const source = await root('arkdown-bridge-source-'); const packageRoot = await forgePackageRoot('arkdown-bridge-package-')
    await writeFile(path.join(source, 'windows-ocr.ps1'), 'ocr')
    await expect(copyScreenshotTranslationBridges([packageRoot], source)).rejects.toThrow()
    await expect(readdir(path.join(packageRoot, 'resources', 'screenshot-translation'))).rejects.toThrow()
  })

  it('rejects a non-Forge output before modifying any valid package output', async () => {
    const source = await root('arkdown-bridge-source-')
    const valid = await forgePackageRoot('arkdown-bridge-valid-')
    const invalid = await root('arkdown-bridge-invalid-')
    await writeFile(path.join(source, 'windows-ocr.ps1'), 'ocr')
    await writeFile(path.join(source, 'windows-window-hit-test.ps1'), 'hit')
    await expect(copyScreenshotTranslationBridges([valid, invalid], source)).rejects.toThrow()
    await expect(readdir(path.join(valid, 'resources', 'screenshot-translation'))).rejects.toThrow()
    await expect(readdir(path.join(invalid, 'resources', 'screenshot-translation'))).rejects.toThrow()
  })

  it.each([
    ['noncanonical executable case', 'ARKDOWN.EXE', 'app.asar'],
    ['noncanonical archive case', 'Arkdown.exe', 'APP.ASAR'],
  ])('rejects Forge markers with %s before modifying valid outputs', async (_label, executableName, archiveName) => {
    const source = await root('arkdown-bridge-source-')
    const valid = await forgePackageRoot('arkdown-bridge-valid-')
    const invalid = await root('arkdown-bridge-invalid-case-')
    await mkdir(path.join(invalid, 'resources'), { recursive: true })
    await writeFile(path.join(invalid, executableName), 'launcher')
    await writeFile(path.join(invalid, 'resources', archiveName), 'archive')
    await writeFile(path.join(source, 'windows-ocr.ps1'), 'ocr')
    await writeFile(path.join(source, 'windows-window-hit-test.ps1'), 'hit')

    await expect(copyScreenshotTranslationBridges([valid, invalid], source)).rejects.toThrow()
    await expect(readdir(path.join(valid, 'resources', 'screenshot-translation'))).rejects.toThrow()
    await expect(readdir(path.join(invalid, 'resources', 'screenshot-translation'))).rejects.toThrow()
  })

  it('runs the real bridge copy through the Forge postPackage hook', async () => {
    vi.stubEnv('ARKDOWN_PACKAGE_EDITION', 'lite')
    const packageRoot = await forgePackageRoot('arkdown-bridge-forge-package-')
    const { default: config } = await import('../../forge.config')
    const preHook = config.hooks?.prePackage as unknown as ((forgeConfig: unknown, platform: string, arch: string) => Promise<void>)
    const hook = config.hooks?.postPackage as unknown as ((forgeConfig: unknown, result: { platform: string; arch: string; outputPaths: string[] }) => Promise<void>)
    await preHook(config, 'win32', 'x64')
    await hook(config, { platform: 'win32', arch: 'x64', outputPaths: [packageRoot] })
    expect(await readdir(path.join(packageRoot, 'resources', 'screenshot-translation')))
      .toEqual(['windows-ocr.ps1', 'windows-window-hit-test.ps1'])
    expect(provenance.capture).toHaveBeenCalledTimes(2)
    expect(provenance.write).toHaveBeenCalledWith(
      [packageRoot],
      { commit: '1'.repeat(40), tree: '2'.repeat(40) },
    )
    expect(workspaceCommitPackaging.build).toHaveBeenCalledWith({ repoRoot: process.cwd(), arch: 'x64' })
    expect(workspaceCommitPackaging.copy).toHaveBeenCalledWith(
      [packageRoot],
      expect.objectContaining({ executablePath: 'C:\\controlled\\arkdown-workspace-commit.exe' }),
    )
  })
})
