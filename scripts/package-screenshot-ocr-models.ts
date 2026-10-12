import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  SCREENSHOT_OCR_PACKAGE_MANIFEST,
  toPublicScreenshotOcrPackageManifest,
  type ScreenshotOcrPackageArtifact,
  type ScreenshotOcrPackageManifest,
} from '../src/shared/screenshot-ocr-manifest.ts'
import { screenshotOcrDevelopmentResourcesPath } from '../src/main/screenshot-translation/screenshot-ocr-development-resources.ts'
import { auditScreenshotOcrResourceTree } from './audit-arkdown-package.ts'

const MAX_MODEL_DOWNLOAD_BYTES = 64 * 1024 * 1024
const modelDownloads = new Map([
  ['small-det.tar', 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_det_onnx_infer.tar'],
  ['small-rec.tar', 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_small_rec_onnx_infer.tar'],
])

export interface PackageScreenshotOcrModelsOptions {
  sourceRoot?: string
  cacheDirectory?: string
  manifest?: ScreenshotOcrPackageManifest
  renameFile?: (from: string, to: string) => Promise<void>
  copyDirectory?: (from: string, to: string) => Promise<void>
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function defaultCopyDirectory(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
}

function tarMembers(bytes: Uint8Array): string[] {
  const names: string[] = []
  let offset = 0
  let terminated = false
  while (offset < bytes.byteLength) {
    if (offset + 512 > bytes.byteLength) throw new Error('Invalid screenshot OCR model archive')
    const header = bytes.subarray(offset, offset + 512)
    if (header.every((value) => value === 0)) {
      const second = bytes.subarray(offset + 512, offset + 1024)
      if (second.byteLength !== 512 || !second.every((value) => value === 0) || !bytes.subarray(offset + 1024).every((value) => value === 0)) {
        throw new Error('Invalid screenshot OCR model archive')
      }
      terminated = true
      break
    }
    const readField = (start: number, length: number) => Buffer.from(header.subarray(start, start + length))
      .toString('utf8').replace(/\0+$/u, '')
    const name = readField(0, 100)
    const prefix = readField(345, 155)
    const sizeText = readField(124, 12).trim()
    const typeflag = readField(156, 1) || '0'
    const linkname = readField(157, 100)
    if (!name || !/^[0-7]*$/u.test(sizeText) || !['0', '5'].includes(typeflag) || linkname) {
      throw new Error('Invalid screenshot OCR model archive')
    }
    const size = Number.parseInt(sizeText || '0', 8)
    const fullName = prefix ? `${prefix}/${name}` : name
    if (!Number.isSafeInteger(size) || size < 0 || (typeflag === '5') !== fullName.endsWith('/') || !isCanonicalTarName(fullName)) {
      throw new Error('Invalid screenshot OCR model archive')
    }
    const dataSize = Math.ceil(size / 512) * 512
    if (offset + 512 + dataSize > bytes.byteLength) throw new Error('Invalid screenshot OCR model archive')
    names.push(fullName)
    offset += 512 + dataSize
  }
  if (!terminated) throw new Error('Invalid screenshot OCR model archive')
  return names
}

function isCanonicalTarName(value: string): boolean {
  return !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((segment, index, segments) => (
      (index === segments.length - 1 && segment === '') || (segment.length > 0 && segment !== '.' && segment !== '..')
    ))
}

function validateOfficialModelArchive(artifact: ScreenshotOcrPackageArtifact, bytes: Uint8Array): void {
  const modelDirectory = artifact.name === 'small-det.tar'
    ? 'PP-OCRv6_small_det_onnx_infer'
    : artifact.name === 'small-rec.tar'
      ? 'PP-OCRv6_small_rec_onnx_infer'
      : undefined
  if (!modelDirectory) return
  const expected = [
    `${modelDirectory}/`,
    `${modelDirectory}/inference.onnx`,
    `${modelDirectory}/inference.yml`,
  ]
  const members = tarMembers(bytes)
  if (members.length !== expected.length || members.some((member, index) => member !== expected[index])) {
    throw new Error('Invalid screenshot OCR model archive')
  }
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
}

function isCanonicalArtifactName(value: string): boolean {
  return /^(?:[a-z0-9][a-z0-9.-]*)(?:\/[a-z0-9][a-z0-9.-]*)*$/u.test(value)
    && value === value.toLocaleLowerCase('en-US')
    && !value.includes('..')
}

function isScreenshotOcrPackageArtifact(value: unknown): value is ScreenshotOcrPackageArtifact {
  return isExactObject(value, ['source', 'name', 'bytes', 'sha256'])
    && typeof value.source === 'string'
    && typeof value.name === 'string'
    && Number.isSafeInteger(value.bytes)
    && typeof value.sha256 === 'string'
}

export function validateScreenshotOcrPackageManifest(manifest: unknown): asserts manifest is ScreenshotOcrPackageManifest {
  if (!isExactObject(manifest, ['release', 'artifacts'])
    || manifest.release !== 'PaddleOCR-3.7.0'
    || !Array.isArray(manifest.artifacts)
    || manifest.artifacts.length === 0
  ) throw new Error('Invalid screenshot OCR manifest')
  const names = new Set<string>()
  for (const artifact of manifest.artifacts) {
    if (!isScreenshotOcrPackageArtifact(artifact)
      || artifact.source !== artifact.name
      || !isCanonicalArtifactName(artifact.name)
      || !Number.isSafeInteger(artifact.bytes)
      || artifact.bytes < 1
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      || names.has(artifact.name)
    ) throw new Error('Invalid screenshot OCR manifest')
    names.add(artifact.name)
  }
}

async function verifySource(root: string, artifact: ScreenshotOcrPackageArtifact): Promise<Buffer> {
  const source = path.resolve(root, ...artifact.source.split('/'))
  if (path.relative(root, source).startsWith('..')) throw new Error('Invalid screenshot OCR source')
  const metadata = await lstat(source).catch(() => undefined)
  if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.bytes) {
    throw new Error('Invalid screenshot OCR source')
  }
  const bytes = await readFile(source)
  if (sha256(bytes) !== artifact.sha256) throw new Error('Invalid screenshot OCR source')
  return bytes
}

async function replaceTarget(
  staging: string,
  target: string,
  manifest: ScreenshotOcrPackageManifest,
  renameFile: (from: string, to: string) => Promise<void>,
  copyDirectory: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const backup = `${target}.previous-${randomUUID()}`
  const prior = await lstat(target).catch(() => undefined)
  let movedPrior = false
  try {
    if (prior) {
      await renameFile(target, backup)
      movedPrior = true
    }
    await renameFile(staging, target)
    if ((await auditScreenshotOcrResourceTree(target, manifest)).length > 0) {
      throw new Error('Screenshot OCR target verification failed')
    }
  } catch (error) {
    if (movedPrior || !prior) await rm(target, { recursive: true, force: true })
    if (movedPrior) {
      if ((await auditScreenshotOcrResourceTree(backup, manifest)).length > 0) {
        throw new Error('Screenshot OCR target rollback failed', { cause: error })
      }
      const recoveryRoot = await mkdtemp(path.join(path.dirname(target), '.screenshot-ocr-recovery-'))
      const recoveryTarget = path.join(recoveryRoot, 'screenshot-ocr')
      try {
        await copyDirectory(backup, recoveryTarget)
        if ((await auditScreenshotOcrResourceTree(recoveryTarget, manifest)).length > 0) throw new Error('invalid recovery target')
        await renameFile(recoveryTarget, target)
        if ((await auditScreenshotOcrResourceTree(target, manifest)).length > 0) throw new Error('invalid restored target')
      } catch {
        await rm(target, { recursive: true, force: true })
        throw new Error('Screenshot OCR target rollback failed', { cause: error })
      } finally {
        await rm(recoveryRoot, { recursive: true, force: true })
      }
    }
    throw error
  }
  if (movedPrior) await rm(backup, { recursive: true, force: true })
  const staleBackupPattern = /^screenshot-ocr\.previous-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  const resources = path.dirname(target)
  for (const entry of await readdir(resources, { withFileTypes: true })) {
    if (!staleBackupPattern.test(entry.name)) continue
    const staleBackup = path.join(resources, entry.name)
    await rm(staleBackup, { recursive: entry.isDirectory(), force: true })
  }
}

async function packageFromSource(
  outputPaths: readonly string[],
  sourceRoot: string,
  manifest: ScreenshotOcrPackageManifest,
  renameFile: (from: string, to: string) => Promise<void>,
  copyDirectory: (from: string, to: string) => Promise<void>,
): Promise<void> {
  validateScreenshotOcrPackageManifest(manifest)
  const trustedSources = await Promise.all(manifest.artifacts.map(async (artifact) => {
    const bytes = await verifySource(sourceRoot, artifact)
    validateOfficialModelArchive(artifact, bytes)
    return { artifact, bytes }
  }))
  const roots = outputPaths.map((output) => path.resolve(output))
  if (roots.length === 0 || new Set(roots.map((root) => root.toLocaleLowerCase('en-US'))).size !== roots.length) {
    throw new Error('Invalid Forge package outputs')
  }
  for (const root of roots) {
    const metadata = await lstat(path.join(root, 'resources')).catch(() => undefined)
    if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error('Invalid Forge package output')
  }
  await Promise.all(roots.map(async (root) => {
    const resources = path.join(root, 'resources')
    const staging = await mkdtemp(path.join(resources, '.screenshot-ocr-'))
    try {
      for (const { artifact, bytes } of trustedSources) {
        const target = path.join(staging, ...artifact.name.split('/'))
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, bytes, { flag: 'wx' })
        if (sha256(await readFile(target)) !== artifact.sha256) throw new Error('Screenshot OCR verification failed')
      }
      await writeFile(
        path.join(staging, 'manifest.json'),
        `${JSON.stringify(toPublicScreenshotOcrPackageManifest(manifest), null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx' },
      )
      await replaceTarget(staging, path.join(resources, 'screenshot-ocr'), manifest, renameFile, copyDirectory)
    } catch (error) {
      await rm(staging, { force: true, recursive: true })
      throw error
    }
  }))
}

async function downloadVerifiedModel(cacheDirectory: string, artifact: ScreenshotOcrPackageArtifact): Promise<void> {
  const target = path.join(cacheDirectory, artifact.name)
  if (await lstat(target).then((metadata) => metadata.isFile(), () => false)) {
    validateOfficialModelArchive(artifact, await verifySource(cacheDirectory, artifact))
    return
  }
  const url = modelDownloads.get(artifact.name)
  if (!url) throw new Error('Invalid screenshot OCR model')
  await mkdir(cacheDirectory, { recursive: true })
  const response = await fetch(url, { redirect: 'error' }).catch(() => undefined)
  if (!response?.ok || !response.body) throw new Error('Screenshot OCR model download failed')
  const declaredLength = Number(response.headers.get('content-length'))
  if (!Number.isSafeInteger(declaredLength) || declaredLength !== artifact.bytes || declaredLength > MAX_MODEL_DOWNLOAD_BYTES) {
    throw new Error('Screenshot OCR model download failed')
  }
  const temporary = path.join(cacheDirectory, `.${artifact.name}.${randomUUID()}.download`)
  let total = 0
  const chunks: Uint8Array[] = []
  try {
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength
      if (total > artifact.bytes || total > MAX_MODEL_DOWNLOAD_BYTES) throw new Error('Screenshot OCR model download failed')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks)
    if (total !== artifact.bytes || sha256(bytes) !== artifact.sha256) throw new Error('Screenshot OCR model download failed')
    validateOfficialModelArchive(artifact, bytes)
    await writeFile(temporary, bytes, { flag: 'wx' })
    await rename(temporary, target).catch(async () => {
      await rm(temporary, { force: true })
      await verifySource(cacheDirectory, artifact)
    })
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function prepareTrustedSource(
  cacheDirectory: string,
  manifest: ScreenshotOcrPackageManifest,
): Promise<string> {
  const modelArtifacts = manifest.artifacts.filter((artifact) => artifact.name === 'small-det.tar' || artifact.name === 'small-rec.tar')
  await Promise.all(modelArtifacts.map((artifact) => downloadVerifiedModel(cacheDirectory, artifact)))
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'arkdown-screenshot-ocr-source-'))
  try {
    for (const artifact of manifest.artifacts) {
      const destination = path.join(sourceRoot, ...artifact.source.split('/'))
      await mkdir(path.dirname(destination), { recursive: true })
      const source = artifact.name.startsWith('ort/')
        ? path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist', path.basename(artifact.name))
        : artifact.name.startsWith('opencv/')
          ? path.join(process.cwd(), 'node_modules', '@techstark', 'opencv-js', 'dist', path.basename(artifact.name))
          : path.join(cacheDirectory, artifact.name)
      await copyFile(source, destination)
    }
    await Promise.all(manifest.artifacts.map((artifact) => verifySource(sourceRoot, artifact)))
    return sourceRoot
  } catch (error) {
    await rm(sourceRoot, { recursive: true, force: true })
    throw error
  }
}

export async function packageScreenshotOcrModels(
  outputPaths: readonly string[],
  options: PackageScreenshotOcrModelsOptions = {},
): Promise<void> {
  const manifest = options.manifest ?? SCREENSHOT_OCR_PACKAGE_MANIFEST
  if (options.sourceRoot) {
    await packageFromSource(outputPaths, options.sourceRoot, manifest, options.renameFile ?? rename, options.copyDirectory ?? defaultCopyDirectory)
    return
  }
  const cacheDirectory = options.cacheDirectory ?? path.join(os.tmpdir(), 'arkdown-screenshot-ocr-cache-v1')
  const sourceRoot = await prepareTrustedSource(cacheDirectory, manifest)
  try {
    await packageFromSource(outputPaths, sourceRoot, manifest, options.renameFile ?? rename, options.copyDirectory ?? defaultCopyDirectory)
  } finally {
    await rm(sourceRoot, { recursive: true, force: true })
  }
}

export async function prepareScreenshotOcrDevelopmentResources(
  options: PackageScreenshotOcrModelsOptions & { developmentRoot?: string } = {},
): Promise<string> {
  const developmentRoot = path.resolve(options.developmentRoot ?? process.cwd())
  const resourcesPath = screenshotOcrDevelopmentResourcesPath(developmentRoot)
  const outputRoot = path.dirname(resourcesPath)
  await mkdir(resourcesPath, { recursive: true })
  await packageScreenshotOcrModels([outputRoot], options)
  const findings = await auditScreenshotOcrResourceTree(
    path.join(resourcesPath, 'screenshot-ocr'),
    options.manifest ?? SCREENSHOT_OCR_PACKAGE_MANIFEST,
  )
  if (findings.length > 0) throw new Error('Screenshot OCR development resource verification failed')
  return resourcesPath
}
