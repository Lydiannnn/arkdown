import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createPackage } from '@electron/asar'
import { VitePlugin } from '@electron-forge/plugin-vite'
import { copyFile, cp, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScreenshotOcrPackageManifest } from '../../src/shared/screenshot-ocr-manifest'
import { SCREENSHOT_OCR_PACKAGE_MANIFEST } from '../../src/shared/screenshot-ocr-manifest'
import { writePackageProvenance } from '../../scripts/package-provenance'

// Keep filesystem audit fixtures inert; the real PE transform has separate coverage.
const brandingTransform = vi.hoisted(() => vi.fn((source: Uint8Array) =>
  Buffer.concat([source, Buffer.from(':Arknote-icon')])))
vi.mock('../../scripts/package-arknote', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../scripts/package-arknote')>(),
  createArknoteExecutable: brandingTransform,
}))

const roots: string[] = []
const execFileAsync = promisify(execFile)

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })))
})

const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

function manifestFor(sourceFiles: ReadonlyMap<string, Buffer>): ScreenshotOcrPackageManifest {
  return {
    release: 'PaddleOCR-3.7.0' as const,
    artifacts: [...sourceFiles].map(([name, bytes]) => ({
      source: name,
      name,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  }
}

function tarEntry(name: string, typeflag: string, content: Uint8Array = Buffer.alloc(0), linkname = ''): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 'utf8')
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  header.write(typeflag, 156, 'ascii')
  header.write(linkname, 157, 'utf8')
  return Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - (content.length % 512)) % 512)])
}

function validDetectionArchive(options: {
  rootTypeflag?: string
  finalName?: string
  finalContent?: Buffer
  finalTypeflag?: string
  finalLinkname?: string
  terminated?: boolean
  terminator?: Buffer
} = {}): Buffer {
  return Buffer.concat([
    tarEntry('PP-OCRv6_small_det_onnx_infer/', options.rootTypeflag ?? '5'),
    tarEntry('PP-OCRv6_small_det_onnx_infer/inference.onnx', '0', Buffer.from('onnx')),
    tarEntry(
      options.finalName ?? 'PP-OCRv6_small_det_onnx_infer/inference.yml',
      options.finalTypeflag ?? '0',
      options.finalContent ?? Buffer.from('yaml'),
      options.finalLinkname,
    ),
    options.terminated === false ? Buffer.alloc(0) : options.terminator ?? Buffer.alloc(1024),
  ])
}

function validRecognitionArchive(): Buffer {
  return Buffer.concat([
    tarEntry('PP-OCRv6_small_rec_onnx_infer/', '5'),
    tarEntry('PP-OCRv6_small_rec_onnx_infer/inference.onnx', '0', Buffer.from('onnx')),
    tarEntry('PP-OCRv6_small_rec_onnx_infer/inference.yml', '0', Buffer.from('yaml')),
    Buffer.alloc(1024),
  ])
}

async function writeSourceTree(root: string, files: ReadonlyMap<string, Buffer>): Promise<void> {
  for (const [name, bytes] of files) {
    const source = path.join(root, ...name.split('/'))
    await mkdir(path.dirname(source), { recursive: true })
    await writeFile(source, bytes)
  }
}

async function packageTrustedTree(packageRoot: string, sourceRoot: string, manifest: ScreenshotOcrPackageManifest): Promise<void> {
  const helper = await import('../../scripts/package-screenshot-ocr-models')
  await mkdir(path.join(packageRoot, 'resources'), { recursive: true })
  await helper.packageScreenshotOcrModels([packageRoot], { sourceRoot, manifest })
}

async function backupDirectory(packageRoot: string): Promise<string> {
  const resources = path.join(packageRoot, 'resources')
  const name = (await readdir(resources)).find((entry) => entry.startsWith('screenshot-ocr.previous-'))
  if (!name) throw new Error('missing backup')
  return path.join(resources, name)
}

async function backupDirectories(packageRoot: string): Promise<string[]> {
  const resources = path.join(packageRoot, 'resources')
  return (await readdir(resources)).filter((entry) => entry.startsWith('screenshot-ocr.previous-'))
}

async function createMinimalPackage(root: string, asarSource = ''): Promise<void> {
  const { copyBrandingToPackages } = await import('../../scripts/package-branding')
  await copyBrandingToPackages([root])
  if (!asarSource) asarSource = await temporaryRoot('arkdown-ocr-asar-')
  await mkdir(path.join(asarSource, '.vite', 'build'), { recursive: true })
  await mkdir(path.join(asarSource, '.vite', 'renderer', 'main_window', 'assets'), { recursive: true })
  await Promise.all([
    writeFile(path.join(asarSource, '.vite', 'build', 'main.js'), 'console.log("Arkdown")'),
    writeFile(
      path.join(asarSource, '.vite', 'renderer', 'main_window', 'assets', 'mermaid.core-test.js'),
      'export default "Mermaid"',
    ),
    copyFile(path.resolve('THIRD_PARTY_NOTICES.md'), path.join(asarSource, 'THIRD_PARTY_NOTICES.md')),
  ])
  await mkdir(path.join(root, 'resources', 'screenshot-translation'), { recursive: true })
  await Promise.all([
    writeFile(path.join(root, 'Arkdown.exe'), 'launcher'),
    writeFile(path.join(root, 'Arknote.exe'), brandingTransform(Buffer.from('launcher'))),
    copyFile(path.resolve('THIRD_PARTY_NOTICES.md'), path.join(root, 'THIRD_PARTY_NOTICES.md')),
    writeFile(path.join(root, 'version'), '0.1.0\n'),
    copyFile(path.resolve('scripts', 'windows-ocr.ps1'), path.join(root, 'resources', 'screenshot-translation', 'windows-ocr.ps1')),
    copyFile(path.resolve('scripts', 'windows-window-hit-test.ps1'), path.join(root, 'resources', 'screenshot-translation', 'windows-window-hit-test.ps1')),
  ])
  await createPackage(asarSource, path.join(root, 'resources', 'app.asar'))
  await writePackageProvenance([root], { commit: '1'.repeat(40), tree: '2'.repeat(40) })
}

describe('screenshot OCR model packaging', () => {
  it('runs the real raw-Node development entry with an explicit audited offline source', async () => {
    const developmentRoot = await temporaryRoot('arkdown-ocr-development-entry-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-entry-')
    const sourceFiles = new Map([
      ['small-det.tar', validDetectionArchive()],
      ['small-rec.tar', validRecognitionArchive()],
      ['ort/ort.mjs', Buffer.from('ort')],
      ['opencv/opencv.js', Buffer.from('opencv')],
    ])
    await writeSourceTree(sourceRoot, sourceFiles)
    const manifestPath = path.join(await temporaryRoot('arkdown-ocr-manifest-entry-'), 'manifest.json')
    await writeFile(manifestPath, JSON.stringify(manifestFor(sourceFiles)))

    await execFileAsync(process.execPath, [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      path.resolve('scripts', 'prepare-screenshot-ocr-dev.ts'),
      '--development-root', developmentRoot,
      '--source-root', sourceRoot,
      '--manifest', manifestPath,
    ], { cwd: process.cwd(), windowsHide: true })

    const { createScreenshotOcrProtocolHandler, screenshotOcrRuntimeResourcesPath } = await import(
      '../../src/main/screenshot-translation/screenshot-ocr-resources'
    )
    const runtimeResourcesPath = screenshotOcrRuntimeResourcesPath({
      isPackaged: false, resourcesPath: 'ignored', developmentRoot,
    })
    roots.push(path.dirname(runtimeResourcesPath))
    const response = await createScreenshotOcrProtocolHandler({
      resourcesPath: runtimeResourcesPath,
      manifest: manifestFor(sourceFiles),
    })({ url: 'arkdown-ocr://bundle/small-det.tar' })
    expect(response.status).toBe(200)
  })

  it('keeps the prepared non-packaged resource tree through the real Forge Vite preStart cleanup hook', async () => {
    const developmentRoot = await temporaryRoot('arkdown-ocr-development-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const sourceFiles = new Map([
      ['small-det.tar', validDetectionArchive()],
      ['small-rec.tar', validRecognitionArchive()],
      ['ort/ort.mjs', Buffer.from('ort')],
      ['opencv/opencv.js', Buffer.from('opencv')],
    ])
    await writeSourceTree(sourceRoot, sourceFiles)
    const manifest = manifestFor(sourceFiles)
    const helper = await import('../../scripts/package-screenshot-ocr-models')
    const resourcesPath = await helper.prepareScreenshotOcrDevelopmentResources({
      developmentRoot, sourceRoot, manifest,
    })
    const relativeResourcesPath = path.relative(developmentRoot, resourcesPath)
    const isOutsideDevelopmentRoot = relativeResourcesPath === '..' || relativeResourcesPath.startsWith(`..${path.sep}`)
    if (isOutsideDevelopmentRoot) roots.push(path.dirname(resourcesPath))
    expect(isOutsideDevelopmentRoot).toBe(true)
    const { createScreenshotOcrProtocolHandler, screenshotOcrRuntimeResourcesPath } = await import(
      '../../src/main/screenshot-translation/screenshot-ocr-resources'
    )
    expect(resourcesPath).toBe(screenshotOcrRuntimeResourcesPath({
      isPackaged: false, resourcesPath: 'ignored', developmentRoot,
    }))
    await mkdir(path.join(developmentRoot, '.vite'), { recursive: true })
    await writeFile(path.join(developmentRoot, '.vite', 'stale'), 'stale')
    const plugin = new VitePlugin({ build: [], renderer: [] })
    plugin.setDirectories(developmentRoot)
    const viteClass = VitePlugin as unknown as { alreadyStarted?: boolean }
    const previousStarted = viteClass.alreadyStarted
    viteClass.alreadyStarted = false
    try {
      const configuredHook = plugin.getHooks().preStart
      const hook = Array.isArray(configuredHook) ? configuredHook[0] : configuredHook
      if (!hook) throw new Error('Forge Vite preStart hook is unavailable')
      await (hook as unknown as { call(thisArg: undefined): Promise<void> }).call(undefined)
    } finally {
      viteClass.alreadyStarted = previousStarted
    }
    await expect(readFile(path.join(developmentRoot, '.vite', 'stale'))).rejects.toMatchObject({ code: 'ENOENT' })
    const response = await createScreenshotOcrProtocolHandler({ resourcesPath, manifest })({
      url: 'arkdown-ocr://bundle/small-det.tar',
    })
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(sourceFiles.get('small-det.tar'))
  })

  it('copies only the exact verified source artifacts and atomically removes stale targets', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    await mkdir(path.join(packageRoot, 'resources', 'screenshot-ocr'), { recursive: true })
    await writeFile(path.join(packageRoot, 'resources', 'screenshot-ocr', 'stale.bin'), 'stale')

    const sourceFiles = new Map([
      ['det.bin', Buffer.from('det')],
      ['rec.bin', Buffer.from('rec')],
      ['ort/ort.wasm', Buffer.from('ort')],
      ['opencv/opencv.js', Buffer.from('opencv')],
    ])
    for (const [relativePath, bytes] of sourceFiles) {
      const destination = path.join(sourceRoot, ...relativePath.split('/'))
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
    }

    const helper = await import('../../scripts/package-screenshot-ocr-models')
    await helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot,
      manifest: manifestFor(sourceFiles),
    })

    const target = path.join(packageRoot, 'resources', 'screenshot-ocr')
    expect((await readdir(target, { recursive: true })).sort()).toEqual([
      'det.bin',
      'manifest.json',
      'opencv',
      path.join('opencv', 'opencv.js'),
      'ort',
      path.join('ort', 'ort.wasm'),
      'rec.bin',
    ])
    expect(JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'))).toEqual({
      release: 'PaddleOCR-3.7.0',
      artifacts: [...sourceFiles].map(([name, bytes]) => ({ name, bytes: bytes.length, sha256: sha256(bytes) })),
    })
  })

  it('rejects missing, non-file, byte-mismatched, and hash-mismatched sources without replacing a trusted target', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const target = path.join(packageRoot, 'resources', 'screenshot-ocr')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'trusted.txt'), 'previous')
    await mkdir(path.join(sourceRoot, 'small-det.tar'), { recursive: true })

    const helper = await import('../../scripts/package-screenshot-ocr-models')
    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot,
      manifest: {
        release: 'PaddleOCR-3.7.0',
        artifacts: [
          { source: 'small-det.tar', name: 'small-det.tar', bytes: 3, sha256: sha256(Buffer.from('det')) },
          { source: 'missing.tar', name: 'small-rec.tar', bytes: 3, sha256: sha256(Buffer.from('rec')) },
        ],
      },
    })).rejects.toThrow()
    await expect(readFile(path.join(target, 'trusted.txt'), 'utf8')).resolves.toBe('previous')
  })

  it('rejects noncanonical manifest fields and file names before packaging', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    await writeFile(path.join(sourceRoot, 'small-det.tar'), 'det')
    const helper = await import('../../scripts/package-screenshot-ocr-models')

    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot,
      manifest: {
        release: 'PaddleOCR-3.7.0',
        artifacts: [{ source: 'small-det.tar', name: 'SMALL-DET.TAR', bytes: 3, sha256: 'A'.repeat(64) }],
      },
    })).rejects.toThrow()
  })

  it('keeps a trusted backup and leaves no target when recovery copy fails', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const target = path.join(packageRoot, 'resources', 'screenshot-ocr')
    const sourceFiles = new Map([['det.bin', Buffer.from('trusted')]])
    await writeSourceTree(sourceRoot, sourceFiles)
    const manifest = manifestFor(sourceFiles)
    await packageTrustedTree(packageRoot, sourceRoot, manifest)
    const renameFile = async (from: string, to: string) => {
      if (from.includes('.screenshot-ocr-') && !from.includes('.screenshot-ocr-recovery-') && to === target) throw new Error('injected activation failure')
      await rename(from, to)
    }
    const copyDirectory = async (_from: string, to: string) => {
      await mkdir(to, { recursive: true })
      await writeFile(path.join(to, 'partial.txt'), 'partial')
      throw new Error('injected copy failure')
    }

    const helper = await import('../../scripts/package-screenshot-ocr-models')
    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot,
      manifest,
      renameFile,
      copyDirectory,
    })).rejects.toThrow('Screenshot OCR target rollback failed')
    await expect(readdir(target)).rejects.toThrow()
    const { auditScreenshotOcrResourceTree } = await import('../../scripts/audit-arkdown-package')
    await expect(auditScreenshotOcrResourceTree(await backupDirectory(packageRoot), manifest)).resolves.toEqual([])
  })

  it('keeps a trusted backup and leaves no target when recovery activation rename fails', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const target = path.join(packageRoot, 'resources', 'screenshot-ocr')
    const sourceFiles = new Map([['det.bin', Buffer.from('trusted')]])
    await writeSourceTree(sourceRoot, sourceFiles)
    const manifest = manifestFor(sourceFiles)
    await packageTrustedTree(packageRoot, sourceRoot, manifest)
    const renameFile = async (from: string, to: string) => {
      if (from.includes('.screenshot-ocr-') && to === target) throw new Error('injected activation failure')
      await rename(from, to)
    }
    const helper = await import('../../scripts/package-screenshot-ocr-models')

    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot, manifest, renameFile,
    })).rejects.toThrow('Screenshot OCR target rollback failed')
    await expect(readdir(target)).rejects.toThrow()
    const { auditScreenshotOcrResourceTree } = await import('../../scripts/audit-arkdown-package')
    await expect(auditScreenshotOcrResourceTree(await backupDirectory(packageRoot), manifest)).resolves.toEqual([])
  })

  it.each([
    ['extra file', async (root: string) => writeFile(path.join(root, 'extra.bin'), 'extra')],
    ['missing artifact', async (root: string) => rm(path.join(root, 'det.bin'))],
    ['modified artifact', async (root: string) => writeFile(path.join(root, 'det.bin'), 'mutated')],
  ])('keeps the backup when copied recovery tree has a %s', async (_label, mutate) => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const target = path.join(packageRoot, 'resources', 'screenshot-ocr')
    const sourceFiles = new Map([['det.bin', Buffer.from('trusted')]])
    await writeSourceTree(sourceRoot, sourceFiles)
    const manifest = manifestFor(sourceFiles)
    await packageTrustedTree(packageRoot, sourceRoot, manifest)
    const renameFile = async (from: string, to: string) => {
      if (from.includes('.screenshot-ocr-') && !from.includes('.screenshot-ocr-recovery-') && to === target) throw new Error('injected activation failure')
      await rename(from, to)
    }
    const copyDirectory = async (from: string, to: string) => {
      await cp(from, to, { recursive: true })
      await mutate(to)
    }
    const helper = await import('../../scripts/package-screenshot-ocr-models')

    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot, manifest, renameFile, copyDirectory,
    })).rejects.toThrow('Screenshot OCR target rollback failed')
    await expect(readdir(target)).rejects.toThrow()
    const { auditScreenshotOcrResourceTree } = await import('../../scripts/audit-arkdown-package')
    await expect(auditScreenshotOcrResourceTree(await backupDirectory(packageRoot), manifest)).resolves.toEqual([])
  })

  it('restores the complete trusted tree through independent recovery staging after activation fails once', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const target = path.join(packageRoot, 'resources', 'screenshot-ocr')
    const sourceFiles = new Map([['det.bin', Buffer.from('trusted')], ['ort/ort.wasm', Buffer.from('runtime')]])
    await writeSourceTree(sourceRoot, sourceFiles)
    const manifest = manifestFor(sourceFiles)
    await packageTrustedTree(packageRoot, sourceRoot, manifest)
    let stagingActivationAttempts = 0
    let recoveryCopies = 0
    const renameFile = async (from: string, to: string) => {
      if (from.includes('.screenshot-ocr-') && !from.includes('.screenshot-ocr-recovery-') && to === target) {
        stagingActivationAttempts += 1
        if (stagingActivationAttempts === 1) throw new Error('injected activation failure')
      }
      await rename(from, to)
    }
    const copyDirectory = async (from: string, to: string) => {
      recoveryCopies += 1
      await cp(from, to, { recursive: true })
    }
    const helper = await import('../../scripts/package-screenshot-ocr-models')

    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot, manifest, renameFile, copyDirectory,
    })).rejects.toThrow('injected activation failure')
    expect(stagingActivationAttempts).toBe(1)
    expect(recoveryCopies).toBe(1)
    const { auditScreenshotOcrResourceTree } = await import('../../scripts/audit-arkdown-package')
    await expect(auditScreenshotOcrResourceTree(target, manifest)).resolves.toEqual([])
    await expect(auditScreenshotOcrResourceTree(await backupDirectory(packageRoot), manifest)).resolves.toEqual([])
  })

  it('removes preserved rollback backups only after a later target passes an exact manifest audit', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const target = path.join(packageRoot, 'resources', 'screenshot-ocr')
    const sourceFiles = new Map([['det.bin', Buffer.from('trusted')], ['ort/ort.wasm', Buffer.from('runtime')]])
    await writeSourceTree(sourceRoot, sourceFiles)
    const manifest = manifestFor(sourceFiles)
    await packageTrustedTree(packageRoot, sourceRoot, manifest)
    const renameFile = async (from: string, to: string) => {
      if (from.includes('.screenshot-ocr-') && !from.includes('.screenshot-ocr-recovery-') && to === target) throw new Error('injected activation failure')
      await rename(from, to)
    }
    const helper = await import('../../scripts/package-screenshot-ocr-models')
    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot, manifest, renameFile,
    })).rejects.toThrow('injected activation failure')
    expect(await backupDirectories(packageRoot)).toHaveLength(1)

    await helper.packageScreenshotOcrModels([packageRoot], { sourceRoot, manifest })

    expect(await backupDirectories(packageRoot)).toEqual([])
    const { auditScreenshotOcrResources } = await import('../../scripts/audit-arkdown-package')
    await expect(auditScreenshotOcrResources(packageRoot, manifest)).resolves.toEqual([])
  })

  it('does not clean unrelated or malformed rollback-named siblings after successful packaging', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const resources = path.join(packageRoot, 'resources')
    const sourceFiles = new Map([['det.bin', Buffer.from('trusted')]])
    await writeSourceTree(sourceRoot, sourceFiles)
    await mkdir(path.join(resources, 'screenshot-ocr.previous-not-a-uuid'), { recursive: true })
    await writeFile(path.join(resources, 'screenshot-ocr.previous-not-a-uuid', 'evidence.txt'), 'keep')
    const helper = await import('../../scripts/package-screenshot-ocr-models')

    await helper.packageScreenshotOcrModels([packageRoot], { sourceRoot, manifest: manifestFor(sourceFiles) })

    await expect(readFile(path.join(resources, 'screenshot-ocr.previous-not-a-uuid', 'evidence.txt'), 'utf8')).resolves.toBe('keep')
  })

  it.each([
    ['directory represented as a regular file', validDetectionArchive({ rootTypeflag: '0' })],
    ['symbolic-link entry', validDetectionArchive({ finalLinkname: 'elsewhere' })],
    ['truncated final data', validDetectionArchive({ finalContent: Buffer.alloc(600) }).subarray(0, 512 + 512 + 512 + 599)],
    ['missing two-block terminator', validDetectionArchive({ terminated: false })],
    ['single zero-block terminator', validDetectionArchive({ terminator: Buffer.alloc(512) })],
    ['nonzero bytes after two zero blocks', validDetectionArchive({ terminator: Buffer.concat([Buffer.alloc(1024), Buffer.from([1])]) })],
    ['parent-directory member', validDetectionArchive({ finalName: 'PP-OCRv6_small_det_onnx_infer/../inference.yml' })],
    ['dot member', validDetectionArchive({ finalName: 'PP-OCRv6_small_det_onnx_infer/./inference.yml' })],
    ['backslash member', validDetectionArchive({ finalName: 'PP-OCRv6_small_det_onnx_infer\\inference.yml' })],
  ])('rejects a %s in an official model archive', async (_label, archive) => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    await mkdir(path.join(packageRoot, 'resources'), { recursive: true })
    await writeFile(path.join(sourceRoot, 'small-det.tar'), archive)
    const sourceFiles = new Map([['small-det.tar', archive]])
    const helper = await import('../../scripts/package-screenshot-ocr-models')

    await expect(helper.packageScreenshotOcrModels([packageRoot], {
      sourceRoot,
      manifest: manifestFor(sourceFiles),
    })).rejects.toThrow('Invalid screenshot OCR model archive')
  })

  it('produces an audit-clean OCR resource tree with the helper target and manifest', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    await mkdir(path.join(packageRoot, 'resources'), { recursive: true })
    const sourceFiles = new Map([
      ['det.bin', Buffer.from('det')],
      ['ort/ort.wasm', Buffer.from('ort')],
    ])
    for (const [name, bytes] of sourceFiles) {
      const source = path.join(sourceRoot, ...name.split('/'))
      await mkdir(path.dirname(source), { recursive: true })
      await writeFile(source, bytes)
    }
    const helper = await import('../../scripts/package-screenshot-ocr-models')
    const manifest = manifestFor(sourceFiles)
    await helper.packageScreenshotOcrModels([packageRoot], { sourceRoot, manifest })
    const { auditScreenshotOcrResources } = await import('../../scripts/audit-arkdown-package')

    await expect(auditScreenshotOcrResources(packageRoot, manifest)).resolves.toEqual([])
  })

  it('keeps prepared development resources outside the real app.asar and passes the production package audit', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const sourceRoot = await temporaryRoot('arkdown-ocr-source-')
    const applicationSource = await temporaryRoot('arkdown-ocr-application-source-')
    const provenanceRoot = path.join(tmpdir(), 'arkdown-ocrv6-provenance-20260814')
    for (const artifact of SCREENSHOT_OCR_PACKAGE_MANIFEST.artifacts) {
      const source = artifact.name.startsWith('small-')
        ? path.join(provenanceRoot, artifact.name === 'small-det.tar'
          ? 'PP-OCRv6_small_det_onnx_infer.tar'
          : 'PP-OCRv6_small_rec_onnx_infer.tar')
        : artifact.name.startsWith('ort/')
          ? path.resolve('node_modules', 'onnxruntime-web', 'dist', path.basename(artifact.name))
          : path.resolve('node_modules', '@techstark', 'opencv-js', 'dist', path.basename(artifact.name))
      const destination = path.join(sourceRoot, ...artifact.source.split('/'))
      await mkdir(path.dirname(destination), { recursive: true })
      await copyFile(source, destination)
    }
    const helper = await import('../../scripts/package-screenshot-ocr-models')
    const developmentResources = await helper.prepareScreenshotOcrDevelopmentResources({
      developmentRoot: applicationSource,
      sourceRoot,
    })
    roots.push(path.dirname(developmentResources))
    await createMinimalPackage(packageRoot, applicationSource)
    await helper.packageScreenshotOcrModels([packageRoot], { sourceRoot })
    const { auditPackagedApplication } = await import('../../scripts/audit-arkdown-package')

    await expect(auditPackagedApplication(packageRoot, {
      // Retain coverage of the legacy development-only model packager. Full/Lite
      // production inventories are covered by the edition packaging audit suite.
      allowMissingEditionMetadata: true,
      allowMissingDocumentConversionResources: true,
      allowMissingWorkspaceCommitHelperResources: true,
      // This fixture packages OCR resources only; screen-translation inventory has its own audit suite.
      allowMissingScreenTranslationResources: true,
      screenshotBridgeSourceDirectory: path.resolve('scripts'),
    }))
      .resolves.toMatchObject({ findings: [] })
  })

  it('rejects a screenshot OCR root that is a directory link', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const linkedRoot = await temporaryRoot('arkdown-ocr-linked-')
    await mkdir(path.join(packageRoot, 'resources'), { recursive: true })
    await symlink(linkedRoot, path.join(packageRoot, 'resources', 'screenshot-ocr'), 'junction')
    const helper = await import('../../scripts/package-screenshot-ocr-models')
    const { auditScreenshotOcrResources } = await import('../../scripts/audit-arkdown-package')

    await expect(auditScreenshotOcrResources(packageRoot, manifestFor(new Map([['det.bin', Buffer.from('det')]])))).resolves.toEqual([
      'invalid screenshot OCR resource root',
    ])
    void helper
  })

  it('rejects a linked expected nested directory without following it', async () => {
    const packageRoot = await temporaryRoot('arkdown-ocr-package-')
    const linkedRoot = await temporaryRoot('arkdown-ocr-linked-')
    const resourceRoot = path.join(packageRoot, 'resources', 'screenshot-ocr')
    const bytes = Buffer.from('runtime')
    const manifest = manifestFor(new Map([['ort/ort.wasm', bytes]]))
    await mkdir(resourceRoot, { recursive: true })
    await writeFile(path.join(linkedRoot, 'ort.wasm'), bytes)
    await writeFile(path.join(resourceRoot, 'manifest.json'), `${JSON.stringify({
      release: manifest.release,
      artifacts: manifest.artifacts.map(({ name, bytes: length, sha256: digest }) => ({ name, bytes: length, sha256: digest })),
    }, null, 2)}\n`)
    await symlink(linkedRoot, path.join(resourceRoot, 'ort'), 'junction')
    const { auditScreenshotOcrResourceTree } = await import('../../scripts/audit-arkdown-package')

    await expect(auditScreenshotOcrResourceTree(resourceRoot, manifest)).resolves.toEqual(expect.arrayContaining([
      path.join('unexpected screenshot OCR asset', 'ort'),
      path.join('missing screenshot OCR asset', 'ort', 'ort.wasm'),
    ]))
  })
})
