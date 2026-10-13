import { validateStickyNoteNativeSurfaceManifest } from './package-sticky-note-native-surface.ts'
import { auditApplicationUpdate } from './audit-application-update.ts'
import { auditEditionResources } from './package-editions.ts'
import { componentTreeFiles } from './package-optional-components.ts'
import { auditScreenTranslationResources } from './audit-screen-translation-package.ts'
import { extractFile, listPackage, statFile } from '@electron/asar'
import { BRANDING_RUNTIME_FILES } from '../src/shared/branding.ts'
import { auditBrandingResources } from './package-branding.ts'
import { arknoteIconPath, createArknoteExecutable } from './package-arknote.ts'
import { createHash } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { SCREENSHOT_TRANSLATION_BRIDGE_FILES } from './package-screenshot-translation-bridges.ts'
import {
  auditPackageProvenance,
  PACKAGE_PROVENANCE_FILENAME,
} from './package-provenance.ts'
import {
  SCREENSHOT_OCR_PACKAGE_MANIFEST,
  toPublicScreenshotOcrPackageManifest,
} from '../src/shared/screenshot-ocr-manifest.ts'
import type { ScreenshotOcrPackageManifest } from '../src/shared/screenshot-ocr-manifest.ts'
import type { DocumentConversionComponentDescriptor } from '../src/shared/document-conversion.ts'
import { DOCUMENT_CONVERSION_COMPONENT_MANIFEST } from '../src/shared/document-conversion-component-manifest.ts'

const workspaceCommitHelperFile = 'arkdown-workspace-commit.exe'
const workspaceCommitHelperManifest = 'manifest.json'
const workspaceCommitHelperArchitectures = new Set(['x64', 'arm64'])
const workspaceCommitHelperMaxBytes = 2 * 1024 * 1024

const legacyBrands = [['ty', 'pora'].join(''), ['local', 'md'].join('')]
const forbiddenAscii = legacyBrands.map((brand) => Buffer.from(brand, 'ascii'))
const forbiddenUtf16 = legacyBrands.map((brand) => Buffer.from(brand, 'utf16le'))
const forbiddenSegments = new Set(['.superpowers', 'portable-data', 'test-results', 'tests'])
const forbiddenNames = new Set([
  'service-token',
  'task-11-brief.md',
  'task-11-report.md',
  '便签功能黑盒测试手册.md',
  '便签功能用户说明书.md',
  '待测试项目.md',
])
const thirdPartyNoticesFile = 'THIRD_PARTY_NOTICES.md'
const mermaidRendererChunk = /^\.vite[\\/]renderer[\\/]main_window[\\/]assets[\\/]mermaid\.core-[A-Za-z0-9_-]+\.js$/u
const approvedAsarRoots = new Set(['.vite', 'node_modules', 'package.json'])
const approvedPackageFiles = new Set([
  'arkdown.exe',
  'arknote.exe',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'd3dcompiler_47.dll',
  'dxcompiler.dll',
  'dxil.dll',
  'ffmpeg.dll',
  'icudtl.dat',
  'libegl.dll',
  'libglesv2.dll',
  'license',
  'license.electron.txt',
  'licenses.chromium.html',
  'third_party_notices.md',
  'resources.pak',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin',
  'version',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
  '使用说明书.html',
])

export interface PackageExecutableAudit {
  name: 'Arkdown.exe' | 'Arknote.exe'
  sha256: string
  size: number
}

export interface PackageAuditReport {
  root: string
  version: string
  executables: PackageExecutableAudit[]
  findings: string[]
}

function containsForbiddenBrand(buffer: Buffer): boolean {
  const ascii = Buffer.from(buffer.toString('latin1').toLowerCase(), 'latin1')
  const utf16 = Buffer.from(buffer.toString('utf16le').toLowerCase(), 'utf16le')
  return (
    forbiddenAscii.some((needle) => ascii.includes(needle))
    || forbiddenUtf16.some((needle) => utf16.includes(needle))
  )
}

function normalizeArchivePath(value: string): string {
  return value.replace(/^[\\/]+/u, '').split(/[\\/]+/u).join(path.sep)
}

function forbiddenEntry(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean)
  const folded = segments.map((segment) => segment.toLocaleLowerCase('en-US'))
  const name = folded.at(-1) ?? ''
  return folded.some((segment) => forbiddenSegments.has(segment))
    || forbiddenNames.has(name)
}

function approvedAsarEntry(relativePath: string): boolean {
  if (relativePath === thirdPartyNoticesFile) return true
  const [topLevel = ''] = relativePath.split(/[\\/]+/u).filter(Boolean)
  return approvedAsarRoots.has(topLevel.toLocaleLowerCase('en-US'))
}

function hasExactAsarFile(asarPath: string, relativePath: string): boolean {
  try {
    const entry = statFile(asarPath, relativePath)
    return !('files' in entry) && !('link' in entry)
  } catch {
    return false
  }
}

function approvedPackageEntry(
  relativePath: string,
  directory: boolean,
  documentConversionDescriptor: DocumentConversionComponentDescriptor,
  screenTranslationEntries: ReadonlyMap<string, 'file' | 'directory'>,
): boolean {
  if (screenTranslationEntries.get(relativePath.replace(/\\/gu, '/')) === (directory ? 'directory' : 'file')) return true
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean)
  const folded = segments.map((segment) => segment.toLocaleLowerCase('en-US'))
  const [topLevel = ''] = folded
  if (segments.length === 1 && directory) {
    return ['locales', 'pandoc', 'resources', '使用说明书', '初始工作区'].includes(topLevel)
  }
  if (segments.length === 1) return approvedPackageFiles.has(topLevel)
  if (topLevel === '使用说明书') return true
  if (topLevel === '初始工作区') {
    return segments.length === 2 && !directory && /^(?:0[1-9]|10)-.+\.md$/u.test(segments[1] ?? '')
  }
  if (topLevel === 'locales') {
    return segments.length === 2 && !directory && folded[1]?.endsWith('.pak') === true
  }
  if (topLevel === 'pandoc') {
    return segments.length === 2 && !directory && folded[1] === 'pandoc.exe'
  }
  if (topLevel === 'resources') {
    if (segments.length === 2 && !directory && segments[1] === 'update-managed-files.json') return true
    if (segments.length === 2 && directory && segments[1] === 'application-updater') return true
    if (segments.length === 3 && !directory && segments[1] === 'application-updater' && segments[2] === 'Arkdown.Update.exe') return true
    if (segments[1] === 'sticky-note-native-surface') {
      if (segments.length === 2) return directory
      if (segments[2] !== 'x64') return false
      return segments.length === 3 ? directory
        : segments.length === 4 && !directory && ['surface.node', 'manifest.json', 'NOTICE'].includes(segments[3] ?? '')
    }
    if (segments.length === 2 && directory && segments[1] === 'branding') return true
    if (segments.length === 3 && !directory && segments[1] === 'branding') {
      return BRANDING_RUNTIME_FILES.some((file) => file === segments[2])
    }
    if (segments.length === 2 && !directory && folded[1] === 'app.asar') return true
    if (segments.length === 2 && !directory && segments[1] === PACKAGE_PROVENANCE_FILENAME) return true
    if (segments.length === 2 && directory && folded[1] === 'screenshot-translation') return true
    if (segments.length >= 2 && folded[1] === 'screenshot-ocr') return true
    if (segments.length === 2 && directory && segments[1] === 'document-conversion') return documentConversionDescriptor.source === 'packaged'
    if (segments.length === 2 && directory && segments[1] === 'native') return true
    if (segments.length === 3 && directory
      && segments[1] === 'native' && segments[2] === 'workspace-commit') return true
    if (segments.length === 4 && directory
      && segments[1] === 'native' && segments[2] === 'workspace-commit'
      && workspaceCommitHelperArchitectures.has(segments[3]!)) return true
    if (segments.length === 5 && !directory
      && segments[1] === 'native' && segments[2] === 'workspace-commit'
      && workspaceCommitHelperArchitectures.has(segments[3]!)
      && (segments[4] === workspaceCommitHelperFile || segments[4] === workspaceCommitHelperManifest)) return true
    if (segments.length === 3 && !directory && segments[1] === 'document-conversion') {
      return documentConversionDescriptor.source === 'packaged'
        && (segments[2] === documentConversionDescriptor.archiveName || segments[2] === 'manifest.json')
    }
    return segments.length === 3 && !directory
      && folded[1] === 'screenshot-translation'
      && SCREENSHOT_TRANSLATION_BRIDGE_FILES.some((name) => name === segments[2])
  }
  return false
}

function workspaceCommitPeMachine(bytes: Buffer): number | undefined {
  if (bytes.byteLength < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ') return undefined
  const offset = bytes.readUInt32LE(0x3c)
  if (offset < 0x40 || offset + 6 > bytes.byteLength
    || bytes.subarray(offset, offset + 4).toString('binary') !== 'PE\0\0') return undefined
  return bytes.readUInt16LE(offset + 4)
}

export async function auditWorkspaceCommitHelperResources(
  packageRoot: string,
  arch: 'x64' | 'arm64',
): Promise<string[]> {
  const findings: string[] = []
  const nativeRoot = path.join(path.resolve(packageRoot), 'resources', 'native')
  const commitRoot = path.join(nativeRoot, 'workspace-commit')
  const artifactRoot = path.join(commitRoot, arch)
  const rootMetadata = await lstat(artifactRoot).catch(() => undefined)
  if (!rootMetadata) return ['missing workspace commit helper resources']
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    return ['workspace commit helper resource root is not a regular directory']
  }
  const nativeEntries = await readdir(nativeRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of nativeEntries) {
    if (entry.name !== 'workspace-commit' || !entry.isDirectory() || entry.isSymbolicLink()) {
      findings.push(path.join('unexpected workspace commit helper resource', entry.name))
    }
  }
  const architectureEntries = await readdir(commitRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of architectureEntries) {
    if (entry.name !== arch || !entry.isDirectory() || entry.isSymbolicLink()) {
      findings.push(path.join('unexpected workspace commit helper resource', entry.name))
    }
  }
  const entries = await readdir(artifactRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()
      || (entry.name !== workspaceCommitHelperFile && entry.name !== workspaceCommitHelperManifest)) {
      findings.push(path.join('unexpected workspace commit helper resource', entry.name))
    }
  }
  const executablePath = path.join(artifactRoot, workspaceCommitHelperFile)
  const manifestPath = path.join(artifactRoot, workspaceCommitHelperManifest)
  const executableMetadata = await lstat(executablePath).catch(() => undefined)
  if (!executableMetadata?.isFile() || executableMetadata.isSymbolicLink()
    || executableMetadata.size <= 0 || executableMetadata.size > workspaceCommitHelperMaxBytes) {
    findings.push(executableMetadata?.isFile() && !executableMetadata.isSymbolicLink()
      ? 'workspace commit helper executable is invalid'
      : 'workspace commit helper is not a regular file')
    return [...new Set(findings)].sort()
  }
  const manifestMetadata = await lstat(manifestPath).catch(() => undefined)
  if (!manifestMetadata?.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > 1024) {
    findings.push('workspace commit helper manifest is invalid')
    return [...new Set(findings)].sort()
  }
  let manifest: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.getPrototypeOf(parsed) === Object.prototype) manifest = parsed as Record<string, unknown>
  } catch {
    // The stable finding below is sufficient for package acceptance.
  }
  const expectedKeys = ['arch', 'bytes', 'fileName', 'peMachine', 'protocolVersion', 'schemaVersion', 'sha256']
  const expectedMachine = arch === 'x64' ? 0x8664 : 0xaa64
  if (!manifest || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys)
    || manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1
    || manifest.arch !== arch || manifest.fileName !== workspaceCommitHelperFile
    || !Number.isSafeInteger(manifest.bytes) || (manifest.bytes as number) <= 0
    || (manifest.bytes as number) > workspaceCommitHelperMaxBytes
    || typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(manifest.sha256)
    || manifest.peMachine !== expectedMachine) {
    findings.push('workspace commit helper manifest is invalid')
    return [...new Set(findings)].sort()
  }
  const executable = await readFile(executablePath)
  if (executableMetadata.size !== manifest.bytes
    || createHash('sha256').update(executable).digest('hex') !== manifest.sha256) {
    findings.push('workspace commit helper hash mismatch')
  }
  if (workspaceCommitPeMachine(executable) !== expectedMachine) {
    findings.push('workspace commit helper architecture mismatch')
  }
  return [...new Set(findings)].sort()
}

function packagedDocumentConversionDescriptor(
  value: DocumentConversionComponentDescriptor,
): DocumentConversionComponentDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || JSON.stringify(Reflect.ownKeys(value).sort())
      !== JSON.stringify(['archiveName', 'bytes', 'sha256', 'source', 'url', 'version'])
    || (value.source === 'packaged'
      ? value.url !== null
      : value.source !== 'https' || typeof value.url !== 'string'
        || !URL.canParse(value.url) || new URL(value.url).protocol !== 'https:')
    || typeof value.version !== 'string'
    || !/^[0-9A-Za-z](?:[0-9A-Za-z._-]{0,127})$/u.test(value.version)
    || typeof value.archiveName !== 'string'
    || path.basename(value.archiveName) !== value.archiveName
    || !value.archiveName.endsWith('.tar.gz')
    || !Number.isSafeInteger(value.bytes)
    || value.bytes <= 0
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error('Invalid document conversion component descriptor')
  }
  return value
}

export async function auditScreenshotOcrResources(
  packageRoot: string,
  manifest: ScreenshotOcrPackageManifest = SCREENSHOT_OCR_PACKAGE_MANIFEST,
): Promise<string[]> {
  return auditScreenshotOcrResourceTree(path.join(packageRoot, 'resources', 'screenshot-ocr'), manifest)
}

function exactDocumentConversionManifest(
  value: unknown,
  descriptor: DocumentConversionComponentDescriptor,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return JSON.stringify(keys) === JSON.stringify(['archiveName', 'bytes', 'sha256', 'version'])
    && record.version === descriptor.version
    && record.archiveName === descriptor.archiveName
    && record.bytes === descriptor.bytes
    && record.sha256 === descriptor.sha256
}

interface DocumentConversionAuditFileSystem {
  lstat(filePath: string): Promise<Stats>
  open(filePath: string): Promise<FileHandle>
  readdir(filePath: string): Promise<Dirent[]>
}

const documentConversionAuditFileSystem: DocumentConversionAuditFileSystem = {
  lstat: (filePath) => lstat(filePath),
  open: (filePath) => open(filePath, 'r'),
  readdir: (filePath) => readdir(filePath, { withFileTypes: true }),
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.size === right.size
    && left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs
}

function sameDirectoryIdentity(left: Stats, right: Stats): boolean {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.birthtimeMs === right.birthtimeMs
}

async function isOriginalDocumentConversionRoot(
  resourceRoot: string,
  originalMetadata: Stats,
  fileSystem: DocumentConversionAuditFileSystem,
): Promise<boolean> {
  try {
    const currentMetadata = await fileSystem.lstat(resourceRoot)
    return currentMetadata.isDirectory()
      && !currentMetadata.isSymbolicLink()
      && sameDirectoryIdentity(originalMetadata, currentMetadata)
  } catch {
    return false
  }
}

async function readStableDocumentConversionFile(
  filePath: string,
  fileSystem: DocumentConversionAuditFileSystem,
): Promise<{ bytes: Buffer; metadata: Stats } | null> {
  let pathMetadata: Stats
  try {
    pathMetadata = await fileSystem.lstat(filePath)
  } catch {
    return null
  }
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) return null

  let handle: FileHandle | null = null
  try {
    handle = await fileSystem.open(filePath)
    const openedMetadata = await handle.stat()
    if (!openedMetadata.isFile() || !sameFileSnapshot(pathMetadata, openedMetadata)) return null
    const bytes = await handle.readFile()
    const finalHandleMetadata = await handle.stat()
    const finalPathMetadata = await fileSystem.lstat(filePath)
    if (!finalHandleMetadata.isFile()
      || !finalPathMetadata.isFile()
      || finalPathMetadata.isSymbolicLink()
      || !sameFileSnapshot(openedMetadata, finalHandleMetadata)
      || !sameFileSnapshot(finalHandleMetadata, finalPathMetadata)) return null
    return { bytes, metadata: finalHandleMetadata }
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }
}

export async function auditDocumentConversionResources(
  packageRoot: string,
  descriptorInput: DocumentConversionComponentDescriptor = DOCUMENT_CONVERSION_COMPONENT_MANIFEST,
  fileSystem: DocumentConversionAuditFileSystem = documentConversionAuditFileSystem,
): Promise<string[]> {
  const descriptor = packagedDocumentConversionDescriptor(descriptorInput)
  const findings: string[] = []
  const resourceRoot = path.join(packageRoot, 'resources', 'document-conversion')
  const rootMetadata = await fileSystem.lstat(resourceRoot).catch(() => undefined)
  if (descriptor.source === 'https') {
    return rootMetadata ? ['unexpected bundled document conversion resources for HTTPS component'] : []
  }
  if (!rootMetadata) return ['missing document conversion resources']
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    return ['invalid document conversion resource root']
  }

  let entries: Dirent[]
  try {
    entries = await fileSystem.readdir(resourceRoot)
  } catch {
    return ['invalid document conversion resource root']
  }
  if (!await isOriginalDocumentConversionRoot(resourceRoot, rootMetadata, fileSystem)) {
    return ['invalid document conversion resource root']
  }
  const expected = new Set([descriptor.archiveName, 'manifest.json'])
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!expected.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      findings.push(path.join('unexpected document conversion asset', entry.name))
      continue
    }
    seen.add(entry.name)
  }
  for (const name of expected) {
    if (!seen.has(name)) findings.push(path.join('missing document conversion asset', name))
  }

  if (seen.has(descriptor.archiveName)) {
    const archivePath = path.join(resourceRoot, descriptor.archiveName)
    const archive = await readStableDocumentConversionFile(archivePath, fileSystem)
    if (!archive
      || archive.metadata.size !== descriptor.bytes
      || archive.bytes.byteLength !== descriptor.bytes
      || createHash('sha256').update(archive.bytes).digest('hex') !== descriptor.sha256) {
      findings.push(path.join('modified document conversion archive', descriptor.archiveName))
    }
  }
  if (seen.has('manifest.json')) {
    try {
      const manifestFile = await readStableDocumentConversionFile(
        path.join(resourceRoot, 'manifest.json'),
        fileSystem,
      )
      if (!manifestFile) throw new Error('Invalid document conversion manifest file')
      const manifest = JSON.parse(manifestFile.bytes.toString('utf8')) as unknown
      if (!exactDocumentConversionManifest(manifest, descriptor)) {
        findings.push('invalid document conversion manifest')
      }
    } catch {
      findings.push('invalid document conversion manifest')
    }
  }
  if (!await isOriginalDocumentConversionRoot(resourceRoot, rootMetadata, fileSystem)) {
    return ['invalid document conversion resource root']
  }
  return [...new Set(findings)].sort()
}

export async function auditScreenshotOcrResourceTree(
  resourceRoot: string,
  manifest: ScreenshotOcrPackageManifest = SCREENSHOT_OCR_PACKAGE_MANIFEST,
): Promise<string[]> {
  const findings: string[] = []
  const rootMetadata = await lstat(resourceRoot).catch(() => undefined)
  if (!rootMetadata) {
    findings.push('missing screenshot OCR resources')
    return findings
  }
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    findings.push('invalid screenshot OCR resource root')
    return findings
  }
  const expected = new Map([
    ['manifest.json', undefined],
    ...manifest.artifacts.map((artifact) => [artifact.name, artifact] as const),
  ])
  const seen = new Set<string>()
  async function visit(directory: string, relativeDirectory = ''): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true })
    for (const child of children) {
      const relative = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name
      const canonical = relative.replace(/\\/gu, '/')
      if (child.isDirectory()) {
        const hasDescendant = [...expected.keys()].some((name) => name.startsWith(`${canonical}/`))
        if (!hasDescendant) findings.push(path.join('unexpected screenshot OCR asset', relative))
        else await visit(path.join(directory, child.name), relative)
        continue
      }
      const artifact = expected.get(canonical)
      if (!child.isFile() || (canonical !== 'manifest.json' && !artifact)) {
        findings.push(path.join('unexpected screenshot OCR asset', relative))
        continue
      }
      seen.add(canonical)
      if (canonical === 'manifest.json') continue
      if (!artifact) throw new Error('Invalid screenshot OCR audit state')
      const metadata = await stat(path.join(directory, child.name)).catch(() => undefined)
      if (!metadata || metadata.size !== artifact.bytes || await sha256(path.join(directory, child.name)) !== artifact.sha256) {
        findings.push(path.join('modified screenshot OCR asset', relative))
      }
    }
  }
  await visit(resourceRoot)
  for (const name of expected.keys()) {
    if (!seen.has(name)) findings.push(path.join('missing screenshot OCR asset', name))
  }
  const manifestPath = path.join(resourceRoot, 'manifest.json')
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (JSON.stringify(parsed) !== JSON.stringify(toPublicScreenshotOcrPackageManifest(manifest))) {
      findings.push('invalid screenshot OCR manifest')
    }
  } catch {
    findings.push('invalid screenshot OCR manifest')
  }
  return findings.sort()
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

export async function auditArkdownPackage(root: string, verifiedThirdPartyFiles: ReadonlySet<string> = new Set()): Promise<string[]> {
  const findings: string[] = []

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      if (verifiedThirdPartyFiles.has(path.relative(root, absolutePath).replace(/\\/gu, '/'))) continue
      if (containsForbiddenBrand(await readFile(absolutePath))) {
        findings.push(path.relative(root, absolutePath))
      }
    }
  }

  await visit(root)
  return findings.sort()
}

export async function auditStickyNoteNativeSurfaceResources(packageRoot: string): Promise<string[]> {
  const surfaceRoot = path.join(packageRoot, 'resources', 'sticky-note-native-surface')
  const rootMetadata = await lstat(surfaceRoot).catch(() => undefined)
  if (!rootMetadata) return ['missing sticky note native surface resources']
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) return ['invalid sticky note native surface root']
  const findings: string[] = []
  const architectures = await readdir(surfaceRoot, { withFileTypes: true })
  if (architectures.length !== 1 || architectures[0]?.name !== 'x64'
    || !architectures[0].isDirectory() || architectures[0].isSymbolicLink()) {
    return ['invalid sticky note native surface architecture']
  }
  const directory = path.join(surfaceRoot, 'x64')
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !['surface.node', 'manifest.json', 'NOTICE'].includes(entry.name)) {
      findings.push(`unexpected sticky note native surface asset: ${entry.name}`)
    }
  }
  for (const name of ['surface.node', 'manifest.json', 'NOTICE']) {
    if (!entries.some((entry) => entry.name === name && entry.isFile() && !entry.isSymbolicLink())) {
      findings.push(`missing sticky note native surface asset: ${name}`)
    }
  }
  if (findings.some((finding) => finding.startsWith('missing '))) return findings
  const notice = await readStableDocumentConversionFile(path.join(directory, 'NOTICE'), documentConversionAuditFileSystem)
  if (!notice || notice.bytes.length === 0 || notice.bytes.length > 65536) {
    findings.push('invalid sticky note native surface notice')
  }
  let manifest: ReturnType<typeof validateStickyNoteNativeSurfaceManifest>
  try {
    manifest = validateStickyNoteNativeSurfaceManifest(JSON.parse(
      (await readFile(path.join(directory, 'manifest.json'), 'utf8')).replace(/^\uFEFF/u, ''),
    ))
  } catch {
    findings.push('invalid sticky note native surface manifest')
    return findings
  }
  const binary = await readStableDocumentConversionFile(path.join(directory, 'surface.node'), documentConversionAuditFileSystem)
  if (!binary || binary.bytes.length !== manifest.bytes
    || createHash('sha256').update(binary.bytes).digest('hex') !== manifest.sha256) {
    findings.push('modified sticky note native surface binary')
  }
  return findings
}

export async function auditPackagedApplication(root: string, options: {
  allowMissingEditionMetadata?: boolean
  allowMissingDocumentConversionResources?: boolean
  allowMissingScreenTranslationResources?: boolean
  screenTranslationSourceRoot?: string
  screenshotBridgeSourceDirectory?: string
  allowMissingScreenshotOcrResources?: boolean
  allowMissingWorkspaceCommitHelperResources?: boolean
  workspaceCommitHelperArch?: 'x64' | 'arm64'
  documentConversionDescriptor?: DocumentConversionComponentDescriptor
} = {}): Promise<PackageAuditReport> {
  const packageRoot = path.resolve(root)
  const documentConversionDescriptor = packagedDocumentConversionDescriptor(
    options.documentConversionDescriptor ?? DOCUMENT_CONVERSION_COMPONENT_MANIFEST,
  )
  const findings: string[] = []
  const executables: PackageExecutableAudit[] = []
  const edition = await auditEditionResources(packageRoot)
  const legacy = options.allowMissingEditionMetadata && !await lstat(path.join(packageRoot, 'resources/package-edition.json')).catch(() => null)
  if (!legacy) findings.push(...edition.findings)
  if (!legacy) findings.push(...await auditApplicationUpdate(packageRoot))
  if (!legacy && edition.edition) {
    try {
      const expected = await componentTreeFiles(path.resolve(import.meta.dirname, '../initial-workspace'))
      const actual = await componentTreeFiles(path.join(packageRoot, '初始工作区'))
      if (expected.filter(file => file.path.endsWith('.md')).length !== 10
        || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('mismatch')
    } catch { findings.push('initial workspace must contain exactly the ten unchanged guide documents') }
  }
  const screenTranslation = await auditScreenTranslationResources(packageRoot, options.screenTranslationSourceRoot, edition.approvedEntries)
  const approvedComponentEntries = new Map([...screenTranslation.approvedEntries, ...edition.approvedEntries])
  findings.push(...screenTranslation.findings.filter(finding => (
    !options.allowMissingScreenTranslationResources || finding !== 'missing screen translation resources'
  )))
  findings.push(...await auditBrandingResources(path.join(packageRoot, 'resources', 'branding')))
  const executableNames = ['Arkdown.exe', 'Arknote.exe'] as const
  for (const name of executableNames) {
    const executablePath = path.join(packageRoot, name)
    const metadata = await stat(executablePath).catch(() => undefined)
    if (!metadata?.isFile()) {
      findings.push(`missing package file: ${name}`)
      continue
    }
    executables.push({ name, sha256: await sha256(executablePath), size: metadata.size })
  }
  if (executables.length === 2) {
    try {
      const expected = createArknoteExecutable(await readFile(path.join(packageRoot, 'Arkdown.exe')), await readFile(arknoteIconPath))
      if (createHash('sha256').update(expected).digest('hex') !== executables[1]?.sha256) {
        findings.push('Arknote executable differs from the approved branding transform')
      }
    } catch {
      findings.push('invalid branded Electron executable')
    }
  }

  const bridgeSourceDirectory = options.screenshotBridgeSourceDirectory ?? path.resolve('scripts')
  const bridgeDirectory = path.join(packageRoot, 'resources', 'screenshot-translation')
  const bridgeEntries = await readdir(bridgeDirectory, { withFileTypes: true }).catch(() => [])
  for (const name of SCREENSHOT_TRANSLATION_BRIDGE_FILES) {
    const packaged = path.join(bridgeDirectory, name)
    const source = path.join(bridgeSourceDirectory, name)
    const canonicalEntry = bridgeEntries.find((entry) => entry.name === name && entry.isFile())
    if (!canonicalEntry) {
      findings.push(path.join('missing screenshot translation bridge', name))
      continue
    }
    const sourceMetadata = await stat(source).catch(() => undefined)
    if (!sourceMetadata?.isFile() || await sha256(packaged) !== await sha256(source)) {
      findings.push(path.join('modified screenshot translation bridge', name))
    }
  }
  for (const entry of bridgeEntries) {
    if (!entry.isFile() || !SCREENSHOT_TRANSLATION_BRIDGE_FILES.includes(entry.name as never)) {
      findings.push(path.join('unexpected screenshot translation bridge', entry.name))
    }
  }
  const ocrFindings = legacy || !edition.edition ? await auditScreenshotOcrResources(packageRoot) : []
  findings.push(...(options.allowMissingScreenshotOcrResources
    ? ocrFindings.filter((finding) => finding !== 'missing screenshot OCR resources')
    : ocrFindings))
  const documentConversionFindings = legacy || !edition.edition ? await auditDocumentConversionResources(
    packageRoot,
    documentConversionDescriptor,
  ) : []
  findings.push(...(options.allowMissingDocumentConversionResources
    ? documentConversionFindings.filter((finding) => finding !== 'missing document conversion resources')
    : documentConversionFindings))
  const workspaceCommitFindings = options.workspaceCommitHelperArch
    ? await auditWorkspaceCommitHelperResources(packageRoot, options.workspaceCommitHelperArch)
    : ['workspace commit helper target architecture is unspecified']
  findings.push(...(options.allowMissingWorkspaceCommitHelperResources
    ? workspaceCommitFindings.filter((finding) => finding !== 'missing workspace commit helper resources'
      && finding !== 'workspace commit helper target architecture is unspecified')
    : workspaceCommitFindings))
  if (options.workspaceCommitHelperArch === 'x64') {
    findings.push(...await auditStickyNoteNativeSurfaceResources(packageRoot))
  }
  findings.push(...await auditPackageProvenance(packageRoot))

  const asarPath = path.join(packageRoot, 'resources', 'app.asar')
  const asarMetadata = await stat(asarPath).catch(() => undefined)
  if (!asarMetadata?.isFile()) {
    findings.push(`missing package file: ${path.join('resources', 'app.asar')}`)
  } else {
    try {
      const entries = listPackage(asarPath, { isPack: false }).map(normalizeArchivePath)
      for (const entry of entries) {
        if (entry && !approvedAsarEntry(entry)) {
          findings.push(path.join('unapproved asar entry', entry))
        }
        if (entry && forbiddenEntry(entry)) {
          findings.push(path.join('forbidden asar entry', entry))
        }
      }
      if (!hasExactAsarFile(asarPath, thirdPartyNoticesFile)) {
        findings.push(`missing asar entry: ${thirdPartyNoticesFile}`)
      } else {
        const noticePath = path.join(packageRoot, thirdPartyNoticesFile)
        const noticeMetadata = await lstat(noticePath).catch(() => undefined)
        if (!noticeMetadata?.isFile()) {
          findings.push(`missing package file: ${thirdPartyNoticesFile}`)
        } else if (!(await readFile(noticePath)).equals(extractFile(asarPath, thirdPartyNoticesFile))) {
          findings.push(`modified package file: ${thirdPartyNoticesFile}`)
        }
      }
      if (!entries.some((entry) => mermaidRendererChunk.test(entry))) {
        findings.push('missing Mermaid renderer chunk')
      }
    } catch (error) {
      findings.push(`invalid app.asar: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function visitEntries(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.relative(packageRoot, absolutePath)
      if (!approvedPackageEntry(relativePath, entry.isDirectory(), documentConversionDescriptor, approvedComponentEntries)) {
        findings.push(path.join('unapproved package entry', relativePath))
      }
      if (
        entry.isFile()
        && entry.name.toLocaleLowerCase('en-US') === 'app.asar'
        && relativePath.toLocaleLowerCase('en-US') !== path.join('resources', 'app.asar').toLocaleLowerCase('en-US')
      ) findings.push(path.join('unexpected app.asar', relativePath))
      if (forbiddenEntry(relativePath) && !edition.approvedEntries.has(relativePath.replace(/\\/gu, '/'))) {
        findings.push(path.join('forbidden package entry', relativePath))
      }
      if (entry.isDirectory()) await visitEntries(absolutePath)
    }
  }
  await visitEntries(packageRoot)
  const trustedThirdPartyFiles = new Set([...edition.approvedEntries].filter(([name, kind]) => kind === 'file'
    && name !== 'resources/package-edition.json').map(([name]) => name))
  for (const branded of await auditArkdownPackage(packageRoot, trustedThirdPartyFiles)) {
    findings.push(path.join('forbidden legacy brand', branded))
  }

  const versionPath = path.join(packageRoot, 'version')
  const version = await readFile(versionPath, 'utf8').then((value) => value.trim(), () => '')
  if (!version) findings.push('missing package version')

  return {
    root: packageRoot,
    version,
    executables,
    findings: [...new Set(findings)].sort(),
  }
}

async function main(): Promise<void> {
  const root = process.argv[2] ?? path.resolve('out', 'Arkdown-win32-x64')
  const arch = process.argv[3]
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error('Package audit requires an explicit target architecture: x64 or arm64')
  }
  const report = await auditPackagedApplication(root, { workspaceCommitHelperArch: arch })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (report.findings.length > 0) process.exitCode = 1
}

if (
  process.argv[1]
  && path.basename(process.argv[1]).toLocaleLowerCase('en-US') === 'audit-arkdown-package.ts'
) {
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
