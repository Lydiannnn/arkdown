import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentConversionComponentDescriptor } from '../../src/shared/document-conversion'
import { DOCUMENT_CONVERSION_COMPONENT_MANIFEST } from '../../src/shared/document-conversion-component-manifest'
import { copyMarkItDownComponentToPackages } from '../../scripts/package-markitdown-component'

const provenance = vi.hoisted(() => ({
  capture: vi.fn(async () => ({ commit: '1'.repeat(40), tree: '2'.repeat(40) })),
  write: vi.fn(async () => undefined),
}))

vi.mock('../../scripts/package-arknote.ts', () => ({ copyArknoteExecutable: async () => undefined }))
vi.mock('../../scripts/build-screen-translation.ts', () => ({ buildScreenTranslation: async () => undefined }))
vi.mock('../../scripts/package-screen-translation.ts', () => ({ verifyScreenTranslationRuntime: async () => [], copyScreenTranslationToPackages: async () => undefined }))
vi.mock('../../scripts/build-sticky-note-native-surface.ts', () => ({ buildStickyNoteNativeSurface: async () => undefined }))
vi.mock('../../scripts/package-sticky-note-native-surface.ts', () => ({ copyStickyNoteNativeSurface: async () => undefined }))
vi.mock('../../scripts/package-user-guide.ts', () => ({ copyUserGuideToPackages: async () => undefined }))
vi.mock('../../scripts/package-pandoc.ts', () => ({ copyPandocToPackages: async () => undefined }))
vi.mock('../../scripts/package-screenshot-translation-bridges.ts', () => ({ copyScreenshotTranslationBridges: async () => undefined }))
vi.mock('../../scripts/package-screenshot-ocr-models.ts', () => ({ packageScreenshotOcrModels: async () => undefined }))
vi.mock('../../scripts/build-workspace-commit-helper.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../scripts/build-workspace-commit-helper')>(),
  buildWorkspaceCommitHelper: async () => ({
    schemaVersion: 1,
    protocolVersion: 1,
    arch: 'x64',
    fileName: 'arkdown-workspace-commit.exe',
    bytes: 512,
    sha256: 'a'.repeat(64),
    peMachine: 0x8664,
    executablePath: 'C:\\controlled\\arkdown-workspace-commit.exe',
    manifestPath: 'C:\\controlled\\manifest.json',
  }),
}))
vi.mock('../../scripts/package-workspace-commit-helper.ts', () => ({
  copyWorkspaceCommitHelperToPackages: async () => undefined,
}))
vi.mock('../../scripts/package-provenance.ts', () => ({
  captureCleanPackageSource: provenance.capture,
  writePackageProvenance: provenance.write,
}))

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function descriptor(bytes: Uint8Array): DocumentConversionComponentDescriptor {
  return {
    source: 'packaged',
    version: 'test-1',
    archiveName: 'component.tar.gz',
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    url: null,
  }
}

function publicManifest(component: DocumentConversionComponentDescriptor): Record<string, unknown> {
  return {
    version: component.version,
    archiveName: component.archiveName,
    bytes: component.bytes,
    sha256: component.sha256,
  }
}

async function sourceFixture(bytes: Uint8Array, component = descriptor(bytes)): Promise<string> {
  const source = await temporaryRoot('arkdown-markitdown-package-source-')
  await writeFile(path.join(source, component.archiveName), bytes)
  await writeFile(path.join(source, 'manifest.json'), `${JSON.stringify(publicManifest(component))}\n`)
  return source
}

async function forgePackageRoot(prefix: string): Promise<string> {
  const root = await temporaryRoot(prefix)
  await mkdir(path.join(root, 'resources'), { recursive: true })
  await writeFile(path.join(root, 'Arkdown.exe'), 'launcher')
  await writeFile(path.join(root, 'resources', 'app.asar'), 'asar')
  return root
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('MarkItDown component packaging', () => {
  it('copies the verified archive and public manifest byte-for-byte to every Forge package output', async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255])
    const component = descriptor(bytes)
    const sourceDirectory = await sourceFixture(bytes, component)
    const packages = [
      await forgePackageRoot('arkdown-markitdown-package-a-'),
      await forgePackageRoot('arkdown-markitdown-package-b-'),
    ]

    await copyMarkItDownComponentToPackages(packages, { sourceDirectory, descriptor: component })

    for (const packageRoot of packages) {
      const target = path.join(packageRoot, 'resources', 'document-conversion')
      expect((await readdir(target)).sort()).toEqual([component.archiveName, 'manifest.json'].sort())
      expect(await readFile(path.join(target, component.archiveName))).toEqual(bytes)
      expect(await readFile(path.join(target, 'manifest.json'))).toEqual(await readFile(path.join(sourceDirectory, 'manifest.json')))
      await expect(readFile(path.join(packageRoot, 'resources', 'app.asar'), 'utf8')).resolves.toBe('asar')
      await expectMissing(path.join(target, 'python.exe'))
    }
  })

  it.each([
    ['archive byte count', Buffer.from('short'), (component: DocumentConversionComponentDescriptor) => ({ ...component, bytes: component.bytes + 1 })],
    ['archive hash', Buffer.from('same-size'), (component: DocumentConversionComponentDescriptor) => ({ ...component, sha256: '0'.repeat(64) })],
  ])('rejects a source with the wrong %s before modifying package outputs', async (_label, bytes, mutate) => {
    const original = descriptor(bytes)
    const expected = mutate(original)
    const sourceDirectory = await sourceFixture(bytes, expected)
    const packageRoot = await forgePackageRoot('arkdown-markitdown-invalid-package-')

    await expect(copyMarkItDownComponentToPackages([packageRoot], {
      sourceDirectory,
      descriptor: expected,
    })).rejects.toThrow()
    await expectMissing(path.join(packageRoot, 'resources', 'document-conversion'))
  })

  it('rejects a public manifest that does not exactly match the descriptor', async () => {
    const bytes = Buffer.from('archive')
    const component = descriptor(bytes)
    const sourceDirectory = await sourceFixture(bytes, component)
    const packageRoot = await forgePackageRoot('arkdown-markitdown-manifest-package-')
    await writeFile(path.join(sourceDirectory, 'manifest.json'), JSON.stringify({
      ...publicManifest(component),
      archiveName: 'other.tar.gz',
    }))

    await expect(copyMarkItDownComponentToPackages([packageRoot], {
      sourceDirectory,
      descriptor: component,
    })).rejects.toThrow()
    await expectMissing(path.join(packageRoot, 'resources', 'document-conversion'))
  })

  it('rejects a non-Forge output before modifying any valid output', async () => {
    const bytes = Buffer.from('archive')
    const component = descriptor(bytes)
    const sourceDirectory = await sourceFixture(bytes, component)
    const valid = await forgePackageRoot('arkdown-markitdown-valid-package-')
    const invalid = await temporaryRoot('arkdown-markitdown-not-package-')

    await expect(copyMarkItDownComponentToPackages([valid, invalid], {
      sourceDirectory,
      descriptor: component,
    })).rejects.toThrow()
    await expectMissing(path.join(valid, 'resources', 'document-conversion'))
  })

  it('omits the optional remote component from the explicit Lite Forge postPackage hook', async () => {
    vi.stubEnv('ARKDOWN_PACKAGE_EDITION', 'lite')
    const packageRoot = await forgePackageRoot('arkdown-markitdown-forge-package-')
    const { default: config } = await import('../../forge.config')
    const preHook = config.hooks?.prePackage as unknown as (
      (forgeConfig: unknown, platform: string, arch: string) => Promise<void>
    )
    const postHook = config.hooks?.postPackage as unknown as (
      (forgeConfig: unknown, result: { outputPaths: string[]; platform: string; arch: string }) => Promise<void>
    )

    await preHook(config, 'win32', 'x64')
    await postHook(config, { outputPaths: [packageRoot], platform: 'win32', arch: 'x64' })
    expect(JSON.parse(await readFile(path.join(packageRoot, 'resources/package-edition.json'), 'utf8')))
      .toEqual({ schemaVersion: 1, edition: 'lite', components: [] })

    const target = path.join(packageRoot, 'resources', 'document-conversion')
    await expect(readFile(path.join(target, DOCUMENT_CONVERSION_COMPONENT_MANIFEST.archiveName)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect(provenance.capture).toHaveBeenCalledTimes(2)
    expect(provenance.write).toHaveBeenCalledWith(
      [packageRoot],
      { commit: '1'.repeat(40), tree: '2'.repeat(40) },
    )
  })
})
