import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as tar from 'tar'
import {
  assertAllowedArchiveTree,
  buildLicenseInventory,
  buildMarkItDownComponent,
  canonicalJsonBytes,
  type ComponentBuildOptions,
  type ComponentBuildResult,
  parseComponentLock,
  publicManifest,
  reconcileLockedDistributions,
  normalizeTextBytes,
  smokeTestEmbeddedRuntime,
  type SmokeConversionResult,
  verifyArtifact,
} from './build-markitdown-component.ts'

const SHA256 = /^[a-f0-9]{64}$/u
const REGULAR_TAR_TYPES = new Set(['File', 'OldFile', 'ContiguousFile'])
const WINDOWS_DOS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu
const COMPONENT_SOURCE_FILES = [
  'component-lock.json',
  'arkdown_markitdown.py',
  'create_epub_fixture.py',
  'requirements.in',
] as const
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
let reportSequence = 0

export interface ArchiveEntryIdentity {
  path: string
  type: string
}

export interface BuildComponentTwiceOptions {
  repoRoots: readonly [string, string]
  cacheRoot: string
  runsRoot: string
  allowDownload: boolean
  build?: (options: ComponentBuildOptions) => Promise<ComponentBuildResult>
}

export interface InspectBuiltComponentOptions {
  repoRoot: string
  extractionRoot: string
  smoke?: (
    stageRoot: string,
    fixtureScript: string,
    smokeRoot: string,
  ) => Promise<SmokeConversionResult[]>
}

export interface ComponentArchiveAudit {
  archiveEntries: number
  manifestFiles: number
  distributions: number
  licenseSections: number
  smokeConversions: number
}

export type VerificationReport<Result> = {
  schemaVersion: 1
  createdAt: string
  allowDownload: boolean
} & ({
  ok: true
  result: Result
} | {
  ok: false
  error: string
})

export interface VerifyMarkItDownReleaseOptions {
  repoRoot: string
  componentsRoot: string
  allowDownload: boolean
}

export interface VerifyMarkItDownReleaseDependencies {
  createVariant?: typeof createCrLfSourceVariant
  buildTwice?: typeof buildComponentTwice
  inspect?: typeof inspectBuiltComponent
}

export interface MarkItDownReleaseVerification {
  version: ComponentBuildResult['version']
  archiveName: string
  bytes: number
  sha256: string
  builds: Array<{
    sourceEol: 'lf' | 'crlf'
    bytes: number
    sha256: string
  }>
  audit: ComponentArchiveAudit
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(record).sort(ordinalCompare)) === JSON.stringify([...expected].sort(ordinalCompare))
}

function windowsArchiveKey(entryPath: string): string {
  const segments = entryPath.split('/')
  const normalized = segments.map((segment) => {
    const withoutTrailingDotsOrSpaces = segment.replace(/[ .]+$/gu, '')
    if (withoutTrailingDotsOrSpaces.length === 0) throw new Error(`Unsafe component archive path: ${entryPath}`)
    return withoutTrailingDotsOrSpaces.toLocaleLowerCase('en-US')
  })
  return normalized.join('/')
}

function isWindowsDosDeviceSegment(segment: string): boolean {
  const basename = segment.split('.', 1)[0]!.replace(/ +$/gu, '')
  return WINDOWS_DOS_DEVICE_BASENAME.test(basename)
}

export function assertSafeArchiveEntries(entries: readonly ArchiveEntryIdentity[]): void {
  const keys = new Set<string>()
  for (const entry of entries) {
    const entryPath = entry.path
    const segments = entryPath.split('/')
    if (
      !REGULAR_TAR_TYPES.has(entry.type)
      || entryPath.length === 0
      || entryPath.includes('\\')
      || entryPath.startsWith('/')
      || path.win32.isAbsolute(entryPath)
      || /[\u0000-\u001f\u007f]/u.test(entryPath)
      || segments.some((segment) => (
        segment === ''
        || segment === '.'
        || segment === '..'
        || segment.includes(':')
        || /[ .]$/u.test(segment)
        || isWindowsDosDeviceSegment(segment)
      ))
    ) throw new Error(`Unsafe component archive entry: ${entryPath} (${entry.type})`)
    const key = windowsArchiveKey(entryPath)
    if (keys.has(key)) throw new Error(`Duplicate component archive entry: ${entryPath}`)
    keys.add(key)
  }
  for (const key of keys) {
    const segments = key.split('/')
    for (let index = 1; index < segments.length; index += 1) {
      if (keys.has(segments.slice(0, index).join('/'))) {
        throw new Error(`Conflicting component archive entry: ${key}`)
      }
    }
  }
  assertAllowedArchiveTree(entries.map((entry) => entry.path))
}

export function assertMatchingBuildResults(
  first: ComponentBuildResult,
  second: ComponentBuildResult,
): void {
  if (
    first.version !== second.version
    || first.bytes !== second.bytes
    || first.sha256 !== second.sha256
  ) throw new Error('MarkItDown component build is not reproducible')
}

function ensureDisposableRunsRoot(runsRoot: string, cacheRoot: string): void {
  const resolvedRuns = path.resolve(runsRoot)
  const resolvedCache = path.resolve(cacheRoot)
  if (resolvedRuns === path.parse(resolvedRuns).root) {
    throw new Error('Verification runs root is too broad')
  }
  const cacheRelative = path.relative(resolvedRuns, resolvedCache)
  if (cacheRelative === '' || (!cacheRelative.startsWith('..') && !path.isAbsolute(cacheRelative))) {
    throw new Error('Verification cache must be outside the disposable runs root')
  }
}

export async function buildComponentTwice(options: BuildComponentTwiceOptions): Promise<{
  first: ComponentBuildResult
  second: ComponentBuildResult
}> {
  ensureDisposableRunsRoot(options.runsRoot, options.cacheRoot)
  await rm(options.runsRoot, { recursive: true, force: true })
  await mkdir(options.runsRoot, { recursive: true })
  const build = options.build ?? buildMarkItDownComponent
  const first = await build({
    repoRoot: options.repoRoots[0],
    componentsRoot: path.join(options.runsRoot, 'first'),
    cacheRoot: options.cacheRoot,
    allowDownload: options.allowDownload,
  })
  const second = await build({
    repoRoot: options.repoRoots[1],
    componentsRoot: path.join(options.runsRoot, 'second'),
    cacheRoot: options.cacheRoot,
    allowDownload: options.allowDownload,
  })
  await verifyArtifact(first.archivePath, first)
  await verifyArtifact(second.archivePath, second)
  assertMatchingBuildResults(first, second)
  return { first, second }
}

export async function createCrLfSourceVariant(repoRoot: string, variantRoot: string): Promise<void> {
  assertSafeExtractionRoot(variantRoot)
  await rm(variantRoot, { recursive: true, force: true })
  const destinationRoot = path.join(variantRoot, 'scripts', 'markitdown')
  await mkdir(destinationRoot, { recursive: true })
  for (const filename of COMPONENT_SOURCE_FILES) {
    const source = path.join(repoRoot, 'scripts', 'markitdown', filename)
    const normalized = normalizeTextBytes(await readFile(source)).toString('utf8')
    await writeFile(path.join(destinationRoot, filename), normalized.replaceAll('\n', '\r\n'), 'utf8')
  }
}

export async function runReportedVerification<Result>(
  reportRoot: string,
  allowDownload: boolean,
  operation: () => Promise<Result>,
): Promise<{ reportPath: string; report: VerificationReport<Result> }> {
  await mkdir(reportRoot, { recursive: true })
  const createdAt = new Date().toISOString()
  let report: VerificationReport<Result>
  try {
    report = {
      schemaVersion: 1,
      createdAt,
      ok: true,
      allowDownload,
      result: await operation(),
    }
  } catch (error) {
    report = {
      schemaVersion: 1,
      createdAt,
      ok: false,
      allowDownload,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  reportSequence += 1
  const reportName = `verification-${createdAt.replaceAll(':', '-')}-${process.pid}-${reportSequence}.json`
  const reportPath = path.join(reportRoot, reportName)
  await writeFile(reportPath, normalizeTextBytes(`${JSON.stringify(report, null, 2)}\n`), { flag: 'wx' })
  return { reportPath, report }
}

async function listRegularFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => ordinalCompare(left.name, right.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      const metadata = await lstat(absolute)
      if (metadata.isSymbolicLink()) throw new Error(`Component manifest tree contains a link: ${relative}`)
      if (metadata.isDirectory()) await visit(absolute)
      else if (metadata.isFile()) result.push(relative)
      else throw new Error(`Component manifest tree contains a non-file: ${relative}`)
    }
  }
  await visit(root)
  return result
}

interface InternalManifestFile {
  path: string
  bytes: number
  sha256: string
}

function parseInternalManifest(value: unknown): {
  lockSha256: string
  files: InternalManifestFile[]
} {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'version',
    'pythonVersion',
    'platform',
    'lockSha256',
    'files',
  ])) throw new Error('Invalid component manifest schema')
  if (
    value.schemaVersion !== 1
    || value.version !== '0.1.7-py3.12.10'
    || value.pythonVersion !== '3.12.10'
    || value.platform !== 'win-x64'
    || typeof value.lockSha256 !== 'string'
    || !SHA256.test(value.lockSha256)
    || !Array.isArray(value.files)
  ) throw new Error('Invalid component manifest schema')
  const files: InternalManifestFile[] = value.files.map((entry) => {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ['path', 'bytes', 'sha256'])
      || typeof entry.path !== 'string'
      || !Number.isSafeInteger(entry.bytes)
      || (entry.bytes as number) < 0
      || typeof entry.sha256 !== 'string'
      || !SHA256.test(entry.sha256)
    ) throw new Error('Invalid component manifest file entry')
    return entry as unknown as InternalManifestFile
  })
  return { lockSha256: value.lockSha256, files }
}

export async function verifyInternalManifest(root: string, expectedLockSha256: string): Promise<{ files: number }> {
  let manifest: ReturnType<typeof parseInternalManifest>
  try {
    manifest = parseInternalManifest(JSON.parse(await readFile(path.join(root, 'component-manifest.json'), 'utf8')) as unknown)
  } catch (error) {
    throw new Error('Component manifest cannot be read or parsed', { cause: error })
  }
  if (manifest.lockSha256 !== expectedLockSha256) throw new Error('Component manifest lock hash mismatch')
  const actualFiles = (await listRegularFiles(root)).filter((entry) => entry !== 'component-manifest.json')
  const manifestPaths = manifest.files.map((entry) => entry.path)
  assertSafeArchiveEntries(manifest.files.map((entry) => ({ path: entry.path, type: 'File' })))
  if (
    new Set(manifestPaths).size !== manifestPaths.length
    || JSON.stringify([...manifestPaths].sort(ordinalCompare)) !== JSON.stringify([...actualFiles].sort(ordinalCompare))
  ) throw new Error('Component manifest payload membership mismatch')
  try {
    await Promise.all(manifest.files.map((entry) => verifyArtifact(
      path.join(root, ...entry.path.split('/')),
      entry,
    )))
  } catch (error) {
    throw new Error('Component manifest payload verification failed', { cause: error })
  }
  return { files: manifest.files.length }
}

export async function readVerifiedArchive(result: ComponentBuildResult): Promise<Buffer> {
  const metadata = await lstat(result.archivePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== result.bytes) {
    throw new Error('Component archive byte count mismatch')
  }
  const archive = await readFile(result.archivePath)
  const digest = createHash('sha256').update(archive).digest('hex')
  if (digest !== result.sha256) throw new Error('Component archive SHA-256 mismatch')
  return archive
}

async function listTarEntries(archive: Buffer): Promise<ArchiveEntryIdentity[]> {
  const entries: ArchiveEntryIdentity[] = []
  const parser = tar.list({
    strict: true,
    onReadEntry: (entry) => {
      if (!entry.meta) entries.push({ path: entry.path, type: entry.type })
    },
  })
  const completed = once(parser, 'close')
  parser.end(archive)
  await completed
  return entries
}

function assertSafeExtractionRoot(extractionRoot: string): void {
  const resolved = path.resolve(extractionRoot)
  if (resolved === path.parse(resolved).root) throw new Error('Component extraction root is too broad')
}

export async function inspectBuiltComponent(
  result: ComponentBuildResult,
  options: InspectBuiltComponentOptions,
): Promise<ComponentArchiveAudit> {
  const archive = await readVerifiedArchive(result)
  const expectedPublicManifest = publicManifest(result)
  if (path.basename(result.archivePath) !== expectedPublicManifest.archiveName) {
    throw new Error('Component public manifest archive name mismatch')
  }
  let actualPublicManifest: unknown
  try {
    actualPublicManifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as unknown
  } catch (error) {
    throw new Error('Component public manifest cannot be read or parsed', { cause: error })
  }
  if (!canonicalJsonBytes(actualPublicManifest).equals(canonicalJsonBytes(expectedPublicManifest))) {
    throw new Error('Component public manifest does not match the archive')
  }

  const lockPath = path.join(options.repoRoot, 'scripts', 'markitdown', 'component-lock.json')
  const lock = parseComponentLock(JSON.parse(await readFile(lockPath, 'utf8')) as unknown)
  const expectedLockSha256 = createHash('sha256').update(canonicalJsonBytes(lock)).digest('hex')
  const archiveEntries = await listTarEntries(archive)
  assertSafeArchiveEntries(archiveEntries)

  assertSafeExtractionRoot(options.extractionRoot)
  await rm(options.extractionRoot, { recursive: true, force: true })
  await mkdir(options.extractionRoot, { recursive: true })
  const unpack = tar.extract({
    cwd: options.extractionRoot,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noChmod: true,
    noMtime: true,
    maxDepth: 128,
  })
  const extracted = once(unpack, 'close')
  unpack.end(archive)
  await extracted
  const extractedFiles = await listRegularFiles(options.extractionRoot)
  assertSafeArchiveEntries(extractedFiles.map((entry) => ({ path: entry, type: 'File' })))
  if (
    JSON.stringify(extractedFiles.sort(ordinalCompare))
    !== JSON.stringify(archiveEntries.map((entry) => entry.path).sort(ordinalCompare))
  ) throw new Error('Extracted component tree differs from archive entries')
  if (!extractedFiles.includes('LICENSE.txt')) throw new Error('Component archive is missing the Python license')

  const manifestAudit = await verifyInternalManifest(options.extractionRoot, expectedLockSha256)
  const sitePackages = path.join(options.extractionRoot, 'Lib', 'site-packages')
  const siteEntries = await readdir(sitePackages, { withFileTypes: true })
  const distributions = reconcileLockedDistributions(lock.wheels, await Promise.all(
    siteEntries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith('.dist-info'))
      .map(async (entry) => ({
        directory: entry.name,
        metadata: await readFile(path.join(sitePackages, entry.name, 'METADATA'), 'utf8'),
      })),
  ))
  const expectedLicenses = await buildLicenseInventory(options.extractionRoot, lock)
  const actualLicenses = await readFile(path.join(options.extractionRoot, 'THIRD_PARTY_LICENSES.txt'))
  if (!actualLicenses.equals(Buffer.from(expectedLicenses, 'utf8'))) {
    throw new Error('Component third-party license inventory mismatch')
  }

  const smoke = options.smoke ?? smokeTestEmbeddedRuntime
  const smokeResults = await smoke(
    options.extractionRoot,
    path.join(options.repoRoot, 'scripts', 'markitdown', 'create_epub_fixture.py'),
    `${options.extractionRoot}-smoke`,
  )
  const expectedFormats: SmokeConversionResult['format'][] = ['pdf', 'pptx', 'xlsx', 'epub']
  if (
    smokeResults.length !== expectedFormats.length
    || smokeResults.some((entry, index) => entry.format !== expectedFormats[index] || entry.chars <= 0)
  ) throw new Error('Extracted component four-format smoke verification failed')

  return {
    archiveEntries: archiveEntries.length,
    manifestFiles: manifestAudit.files,
    distributions: distributions.length,
    licenseSections: lock.wheels.length,
    smokeConversions: smokeResults.length,
  }
}

export async function verifyMarkItDownRelease(
  options: VerifyMarkItDownReleaseOptions,
  dependencies: VerifyMarkItDownReleaseDependencies = {},
): Promise<MarkItDownReleaseVerification> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('MarkItDown release verification requires Windows x64')
  }
  const verificationRoot = path.join(options.componentsRoot, 'verification', 'current')
  const variantRoot = path.join(verificationRoot, 'crlf-source')
  const runsRoot = path.join(verificationRoot, 'runs')
  const extractionRoot = path.join(verificationRoot, 'extracted')
  const cacheRoot = path.join(options.componentsRoot, 'cache')
  await (dependencies.createVariant ?? createCrLfSourceVariant)(options.repoRoot, variantRoot)
  const builds = await (dependencies.buildTwice ?? buildComponentTwice)({
    repoRoots: [options.repoRoot, variantRoot],
    cacheRoot,
    runsRoot,
    allowDownload: options.allowDownload,
  })
  const audit = await (dependencies.inspect ?? inspectBuiltComponent)(builds.second, {
    repoRoot: options.repoRoot,
    extractionRoot,
  })
  return {
    version: builds.second.version,
    archiveName: path.basename(builds.second.archivePath),
    bytes: builds.second.bytes,
    sha256: builds.second.sha256,
    builds: [
      { sourceEol: 'lf', bytes: builds.first.bytes, sha256: builds.first.sha256 },
      { sourceEol: 'crlf', bytes: builds.second.bytes, sha256: builds.second.sha256 },
    ],
    audit,
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  const arguments_ = process.argv.slice(2)
  const allowDownload = arguments_.includes('--allow-download')
  const unknown = arguments_.filter((argument) => argument !== '--allow-download')
  if (unknown.length > 0) {
    process.stderr.write('Usage: npm run verify:markitdown -- [--allow-download]\n')
    process.exitCode = 2
  } else {
    const componentsRoot = path.join(DEFAULT_REPO_ROOT, '.components')
    runReportedVerification(
      path.join(componentsRoot, 'verification', 'reports'),
      allowDownload,
      () => verifyMarkItDownRelease({
        repoRoot: DEFAULT_REPO_ROOT,
        componentsRoot,
        allowDownload,
      }),
    ).then(({ reportPath, report }) => {
      process.stdout.write(`${JSON.stringify({ reportPath, ...report })}\n`)
      if (!report.ok) {
        process.stderr.write(`MarkItDown release verification failed: ${report.error}\n`)
        process.exitCode = 1
      }
    }).catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    })
  }
}
