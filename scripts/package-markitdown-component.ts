import { createHash } from 'node:crypto'
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { DocumentConversionComponentDescriptor } from '../src/shared/document-conversion.ts'
import { parseDocumentConversionComponentDescriptor } from '../src/shared/document-conversion.ts'
import { DOCUMENT_CONVERSION_COMPONENT_MANIFEST } from '../src/shared/document-conversion-component-manifest.ts'

export interface PackageMarkItDownComponentOptions {
  sourceDirectory?: string
  descriptor?: DocumentConversionComponentDescriptor
}

interface PublicComponentManifest {
  version: string
  archiveName: string
  bytes: number
  sha256: string
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function equalPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}

function publicManifest(descriptor: DocumentConversionComponentDescriptor): PublicComponentManifest {
  return {
    version: descriptor.version,
    archiveName: descriptor.archiveName,
    bytes: descriptor.bytes,
    sha256: descriptor.sha256,
  }
}

function exactPublicManifest(value: unknown, expected: PublicComponentManifest): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return JSON.stringify(keys) === JSON.stringify(['archiveName', 'bytes', 'sha256', 'version'])
    && record.version === expected.version
    && record.archiveName === expected.archiveName
    && record.bytes === expected.bytes
    && record.sha256 === expected.sha256
}

async function validateForgeOutputs(outputPaths: readonly string[]): Promise<string[]> {
  const roots = outputPaths.map((outputPath) => path.resolve(outputPath))
  if (roots.length === 0
    || new Set(roots.map((root) => root.toLocaleLowerCase('en-US'))).size !== roots.length) {
    throw new Error('Invalid Forge package outputs')
  }
  await Promise.all(roots.map(async (root) => {
    const entries = await readdir(root, { withFileTypes: true })
    const executable = entries.find((entry) => entry.name === 'Arkdown.exe')
    const resources = entries.find((entry) => entry.name === 'resources')
    if (!executable?.isFile() || executable.isSymbolicLink()
      || !resources?.isDirectory() || resources.isSymbolicLink()) {
      throw new Error('Invalid Forge package output')
    }
    const resourceEntries = await readdir(path.join(root, 'resources'), { withFileTypes: true })
    const asar = resourceEntries.find((entry) => entry.name === 'app.asar')
    if (!asar?.isFile() || asar.isSymbolicLink()) throw new Error('Invalid Forge package output')
  }))
  return roots
}

async function trustedSource(
  sourceDirectory: string,
  descriptor: DocumentConversionComponentDescriptor,
): Promise<{ archiveBytes: Buffer; manifestBytes: Buffer }> {
  const sourceRoot = path.resolve(sourceDirectory)
  const sourceMetadata = await lstat(sourceRoot)
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error('Invalid MarkItDown component source')
  }
  const entries = await readdir(sourceRoot, { withFileTypes: true })
  const archiveEntry = entries.find((entry) => entry.name === descriptor.archiveName)
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!archiveEntry?.isFile() || archiveEntry.isSymbolicLink()
    || !manifestEntry?.isFile() || manifestEntry.isSymbolicLink()) {
    throw new Error('Invalid MarkItDown component source')
  }
  const archivePath = path.join(sourceRoot, descriptor.archiveName)
  const manifestPath = path.join(sourceRoot, 'manifest.json')
  const [archiveMetadata, manifestMetadata, canonicalRoot, canonicalArchive, canonicalManifest] = await Promise.all([
    lstat(archivePath),
    lstat(manifestPath),
    realpath(sourceRoot),
    realpath(archivePath),
    realpath(manifestPath),
  ])
  if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()
    || archiveMetadata.size !== descriptor.bytes
    || !manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()
    || !equalPath(canonicalArchive, path.join(canonicalRoot, descriptor.archiveName))
    || !equalPath(canonicalManifest, path.join(canonicalRoot, 'manifest.json'))) {
    throw new Error('Invalid MarkItDown component source')
  }
  const [archiveBytes, manifestBytes] = await Promise.all([readFile(archivePath), readFile(manifestPath)])
  if (sha256(archiveBytes) !== descriptor.sha256) throw new Error('Invalid MarkItDown component archive')
  try {
    const parsed = JSON.parse(manifestBytes.toString('utf8')) as unknown
    if (!exactPublicManifest(parsed, publicManifest(descriptor))) {
      throw new Error('Invalid MarkItDown component public manifest')
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid MarkItDown component public manifest') throw error
    throw new Error('Invalid MarkItDown component public manifest', { cause: error })
  }
  return { archiveBytes, manifestBytes }
}

export async function copyMarkItDownComponentToPackages(
  outputPaths: readonly string[],
  options: PackageMarkItDownComponentOptions = {},
): Promise<void> {
  const descriptor = parseDocumentConversionComponentDescriptor(
    options.descriptor ?? DOCUMENT_CONVERSION_COMPONENT_MANIFEST,
  )
  if (!descriptor || descriptor.source !== 'packaged') throw new Error('Invalid packaged component descriptor')
  const sourceDirectory = options.sourceDirectory
    ?? path.join(process.cwd(), '.components', 'markitdown')
  const [{ archiveBytes, manifestBytes }, packageRoots] = await Promise.all([
    trustedSource(sourceDirectory, descriptor),
    validateForgeOutputs(outputPaths),
  ])
  await Promise.all(packageRoots.map(async (packageRoot) => {
    const resources = path.join(packageRoot, 'resources')
    const staging = await mkdtemp(path.join(resources, '.document-conversion-'))
    const target = path.join(resources, 'document-conversion')
    try {
      await Promise.all([
        writeFile(path.join(staging, descriptor.archiveName), archiveBytes, { flag: 'wx' }),
        writeFile(path.join(staging, 'manifest.json'), manifestBytes, { flag: 'wx' }),
      ])
      const stagedArchive = await readFile(path.join(staging, descriptor.archiveName))
      if (stagedArchive.byteLength !== descriptor.bytes || sha256(stagedArchive) !== descriptor.sha256) {
        throw new Error('MarkItDown component package verification failed')
      }
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }))
}
