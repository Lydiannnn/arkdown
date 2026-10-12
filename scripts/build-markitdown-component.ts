import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { inflateRawSync } from 'node:zlib'
import * as tar from 'tar'

const COMPONENT_VERSION = '0.1.7-py3.12.10' as const
const ARCHIVE_NAME = `arkdown-markitdown-${COMPONENT_VERSION}-win-x64.tar.gz`
const SHA256 = /^[a-f0-9]{64}$/u
const ARTIFACT_HOSTS = new Set([
  'www.python.org',
  'bootstrap.pypa.io',
  'files.pythonhosted.org',
])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_ARTIFACT_REDIRECTS = 5
const execFileAsync = promisify(execFile)
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')

export interface LockedArtifact {
  filename: string
  url: string
  bytes: number
  sha256: string
}

export interface LockedWheel extends LockedArtifact {
  name: string
  version: string
}

export interface ComponentLock {
  schemaVersion: 1
  componentVersion: '0.1.7'
  pythonVersion: '3.12.10'
  platform: 'win-x64'
  python: LockedArtifact
  pipBootstrap: LockedArtifact
  pipWheel: LockedArtifact
  wheels: LockedWheel[]
}

export interface ComponentBuildResult {
  archivePath: string
  manifestPath: string
  version: typeof COMPONENT_VERSION
  bytes: number
  sha256: string
}

export interface ComponentBuildOptions {
  repoRoot?: string
  componentsRoot?: string
  cacheRoot?: string
  allowDownload?: boolean
}

export interface ObtainLockedArtifactOptions {
  allowDownload?: boolean
  request?: typeof fetch
}

export interface InstalledDistributionSource {
  directory: string
  metadata: string
}

export interface InstalledDistribution extends InstalledDistributionSource {
  name: string
  version: string
}

export interface SmokeConversionResult {
  format: 'pdf' | 'pptx' | 'xlsx' | 'epub'
  chars: number
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(record).sort()) === JSON.stringify([...expected].sort())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => ordinalCompare(left, right))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    )
  }
  return value
}

export function normalizeTextBytes(value: string | Buffer): Buffer {
  const text = (typeof value === 'string' ? value : value.toString('utf8'))
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
  return Buffer.from(text, 'utf8')
}

export function normalizeInstalledCommandWrapperBytes(value: Buffer): Buffer {
  const newline = value.indexOf(0x0a)
  if (newline < 0) return value
  const shebang = value.subarray(0, newline).toString('utf8').replace(/\r$/u, '')
  if (!/^#!"?.*[\\/]python\.exe"?$/iu.test(shebang)) return value
  return Buffer.concat([Buffer.from('#!python.exe\n', 'utf8'), value.subarray(newline + 1)])
}

export function canonicalJsonBytes(value: unknown): Buffer {
  return normalizeTextBytes(`${JSON.stringify(canonicalJsonValue(value))}\n`)
}

function isLockedArtifact(value: unknown): value is LockedArtifact {
  if (!isRecord(value) || !hasExactKeys(value, ['filename', 'url', 'bytes', 'sha256'])) return false
  return typeof value.filename === 'string' && value.filename.length > 0
    && path.basename(value.filename) === value.filename
    && typeof value.url === 'string'
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0
    && typeof value.sha256 === 'string' && SHA256.test(value.sha256)
}

function isLockedWheel(value: unknown): value is LockedWheel {
  if (!isRecord(value) || !hasExactKeys(value, ['name', 'version', 'filename', 'url', 'bytes', 'sha256'])) {
    return false
  }
  const { name, version, ...artifact } = value
  return typeof name === 'string' && name.length > 0
    && typeof version === 'string' && version.length > 0
    && isLockedArtifact(artifact)
    && artifact.filename.endsWith('.whl')
}

export function assertAllowedArtifactUrl(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`Artifact URL is invalid: ${value}`)
  }
  if (
    url.protocol !== 'https:'
    || !ARTIFACT_HOSTS.has(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.port !== ''
    || url.hash !== ''
  ) throw new Error(`Artifact URL is not allowlisted: ${value}`)
}

export async function fetchAllowlistedArtifact(
  initialUrl: string,
  request: typeof fetch = fetch,
): Promise<Response> {
  let current: URL
  try {
    current = new URL(initialUrl)
  } catch {
    throw new Error(`Artifact URL is invalid: ${initialUrl}`)
  }
  const visited = new Set<string>()
  let redirects = 0
  while (true) {
    const currentUrl = current.toString()
    assertAllowedArtifactUrl(currentUrl)
    if (visited.has(currentUrl)) throw new Error(`Artifact redirect loop detected: ${currentUrl}`)
    visited.add(currentUrl)

    const response = await request(currentUrl, { redirect: 'manual' })
    if (!REDIRECT_STATUSES.has(response.status)) return response
    const location = response.headers.get('location')
    if (location === null || location.trim() === '') {
      throw new Error(`Artifact redirect Location is missing: ${currentUrl}`)
    }
    if (redirects >= MAX_ARTIFACT_REDIRECTS) {
      throw new Error(`Artifact download has too many redirects: ${initialUrl}`)
    }
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      throw new Error(`Artifact redirect Location is invalid: ${location}`)
    }
    const nextUrl = next.toString()
    assertAllowedArtifactUrl(nextUrl)
    if (visited.has(nextUrl)) throw new Error(`Artifact redirect loop detected: ${nextUrl}`)
    current = next
    redirects += 1
  }
}

export function parseComponentLock(value: unknown): ComponentLock {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'componentVersion',
    'pythonVersion',
    'platform',
    'python',
    'pipBootstrap',
    'pipWheel',
    'wheels',
  ])) throw new Error('Invalid component lock schema')
  if (
    value.schemaVersion !== 1
    || value.componentVersion !== '0.1.7'
    || value.pythonVersion !== '3.12.10'
    || value.platform !== 'win-x64'
    || !isLockedArtifact(value.python)
    || !isLockedArtifact(value.pipBootstrap)
    || !isLockedArtifact(value.pipWheel)
    || !(value.pipWheel as LockedArtifact).filename.endsWith('.whl')
    || !Array.isArray(value.wheels)
    || value.wheels.length === 0
    || !value.wheels.every(isLockedWheel)
  ) throw new Error('Invalid component lock schema')
  const lock = value as unknown as ComponentLock
  for (const artifact of [lock.python, lock.pipBootstrap, lock.pipWheel, ...lock.wheels]) {
    assertAllowedArtifactUrl(artifact.url)
  }
  const filenames = [lock.python.filename, lock.pipBootstrap.filename, lock.pipWheel.filename, ...lock.wheels.map((wheel) => wheel.filename)]
  if (new Set(filenames).size !== filenames.length) throw new Error('Invalid component lock: duplicate filename')
  return lock
}

export async function verifyArtifact(
  filePath: string,
  expected: Pick<LockedArtifact, 'bytes' | 'sha256'>,
): Promise<void> {
  const metadata = await stat(filePath)
  if (!metadata.isFile() || metadata.size !== expected.bytes) {
    throw new Error(`Artifact byte count mismatch for ${path.basename(filePath)}`)
  }
  const actual = createHash('sha256').update(await readFile(filePath)).digest('hex')
  if (actual !== expected.sha256) throw new Error(`Artifact SHA-256 mismatch for ${path.basename(filePath)}`)
}

export function assertAllowedArchiveTree(entries: readonly string[]): void {
  for (const rawEntry of entries) {
    const entry = rawEntry.replaceAll('\\', '/')
    const segments = entry.split('/')
    const rootRuntime = entry === 'python.exe'
      || entry === 'LICENSE.txt'
      || /^python\d+(?:\.dll|\.zip|\._pth)$/u.test(entry)
      || new Set([
        'vcruntime140.dll',
        'vcruntime140_1.dll',
        'libcrypto-3.dll',
        'libffi-8.dll',
        'libssl-3.dll',
        'sqlite3.dll',
      ]).has(entry)
      || /^[A-Za-z0-9_]+\.pyd$/u.test(entry)
    const componentFile = new Set([
      'arkdown_markitdown.py',
      'THIRD_PARTY_LICENSES.txt',
      'component-manifest.json',
    ]).has(entry)
    const sitePackage = entry.startsWith('Lib/site-packages/')
    const forbidden = entry.length === 0
      || entry.startsWith('/')
      || entry.includes(':')
      || segments.includes('..')
      || segments.some((segment) => /^tests?$/iu.test(segment))
      || segments.some((segment) => /^(?:examples?|samples?)$/iu.test(segment))
      || segments.includes('__pycache__')
      || entry.endsWith('.pyc')
      || (entry.toLocaleLowerCase('en-US').endsWith('.exe') && entry !== 'python.exe')
      || entry.toLocaleLowerCase('en-US').includes('markitdown_plugin')
      || entry.toLocaleLowerCase('en-US').includes('pip-cache')
    if (forbidden || (!rootRuntime && !componentFile && !sitePackage)) {
      throw new Error(`Forbidden component archive tree entry: ${rawEntry}`)
    }
  }
}

export function publicManifest(result: ComponentBuildResult): {
  version: typeof COMPONENT_VERSION
  archiveName: typeof ARCHIVE_NAME
  bytes: number
  sha256: string
} {
  if (!Number.isSafeInteger(result.bytes) || result.bytes <= 0 || !SHA256.test(result.sha256)) {
    throw new Error('Cannot serialize invalid component result')
  }
  return {
    version: COMPONENT_VERSION,
    archiveName: ARCHIVE_NAME,
    bytes: result.bytes,
    sha256: result.sha256,
  }
}

function ensureWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Component path escapes its root: ${candidate}`)
  }
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeAtomic(filePath: string, content: string | Buffer): Promise<void> {
  const pending = `${filePath}.pending-${process.pid}`
  await rm(pending, { force: true })
  await writeFile(pending, content, { flag: 'wx' })
  await rm(filePath, { force: true })
  await rename(pending, filePath)
}

export async function obtainLockedArtifact(
  cacheRoot: string,
  artifact: LockedArtifact,
  options: ObtainLockedArtifactOptions = {},
): Promise<string> {
  assertAllowedArtifactUrl(artifact.url)
  const destination = path.join(cacheRoot, artifact.filename)
  ensureWithin(cacheRoot, destination)
  try {
    await verifyArtifact(destination, artifact)
    return destination
  } catch (error) {
    // A missing or invalid cache entry is replaced only after the locked download verifies.
    if (options.allowDownload === false) {
      throw new Error(`Artifact is unavailable in the verified cache and downloads are disabled: ${artifact.filename}`, {
        cause: error,
      })
    }
  }
  const response = await fetchAllowlistedArtifact(artifact.url, options.request ?? fetch)
  if (!response.ok) throw new Error(`Artifact download failed (${response.status}): ${artifact.filename}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== artifact.bytes) throw new Error(`Artifact byte count mismatch for ${artifact.filename}`)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== artifact.sha256) throw new Error(`Artifact SHA-256 mismatch for ${artifact.filename}`)
  await writeAtomic(destination, bytes)
  await verifyArtifact(destination, artifact)
  return destination
}

function findZipEnd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  throw new Error('ZIP end-of-central-directory record is missing')
}

async function extractZip(archivePath: string, destinationRoot: string): Promise<void> {
  const archive = await readFile(archivePath)
  const end = findZipEnd(archive)
  const entryCount = archive.readUInt16LE(end + 10)
  let centralOffset = archive.readUInt32LE(end + 16)
  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('Invalid ZIP central directory')
    const flags = archive.readUInt16LE(centralOffset + 8)
    const method = archive.readUInt16LE(centralOffset + 10)
    const compressedBytes = archive.readUInt32LE(centralOffset + 20)
    const uncompressedBytes = archive.readUInt32LE(centralOffset + 24)
    const nameBytes = archive.readUInt16LE(centralOffset + 28)
    const extraBytes = archive.readUInt16LE(centralOffset + 30)
    const commentBytes = archive.readUInt16LE(centralOffset + 32)
    const localOffset = archive.readUInt32LE(centralOffset + 42)
    const entryName = archive.subarray(centralOffset + 46, centralOffset + 46 + nameBytes).toString('utf8').replaceAll('\\', '/')
    if ((flags & 1) !== 0) throw new Error(`Encrypted ZIP entry is forbidden: ${entryName}`)
    const segments = entryName.split('/')
    if (!entryName || entryName.startsWith('/') || entryName.includes(':') || segments.includes('..')) {
      throw new Error(`Unsafe ZIP entry: ${entryName}`)
    }
    const destination = path.join(destinationRoot, ...segments)
    ensureWithin(destinationRoot, destination)
    if (entryName.endsWith('/')) {
      await mkdir(destination, { recursive: true })
    } else {
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Invalid ZIP local entry: ${entryName}`)
      const localNameBytes = archive.readUInt16LE(localOffset + 26)
      const localExtraBytes = archive.readUInt16LE(localOffset + 28)
      const dataOffset = localOffset + 30 + localNameBytes + localExtraBytes
      const compressed = archive.subarray(dataOffset, dataOffset + compressedBytes)
      const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined
      if (!content || content.length !== uncompressedBytes) throw new Error(`Unsupported or corrupt ZIP entry: ${entryName}`)
      await mkdir(path.dirname(destination), { recursive: true })
      await writeFile(destination, content)
    }
    centralOffset += 46 + nameBytes + extraBytes + commentBytes
  }
}

export function embeddedPythonEnvironment(
  cwd: string,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const controlledEnvironment = Object.fromEntries(
    Object.entries(baseEnvironment).filter(([key]) => {
      const normalized = key.toUpperCase()
      return !normalized.startsWith('PIP_')
        && !normalized.startsWith('PYTHON')
        && normalized !== 'VIRTUAL_ENV'
        && normalized !== 'VIRTUAL_ENV_PROMPT'
        && normalized !== '__PYVENV_LAUNCHER__'
    }),
  )
  return {
    ...controlledEnvironment,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_CACHE_DIR: '1',
    PIP_NO_INDEX: '1',
    WIN_PD_OVERRIDE_LOCAL_APPDATA: path.resolve(cwd),
  }
}

async function runEmbeddedPython(pythonPath: string, args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(pythonPath, [...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: embeddedPythonEnvironment(cwd),
  })
  return stdout
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => ordinalCompare(left.name, right.name))
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).replaceAll('\\', '/')
      if (entry.isSymbolicLink()) throw new Error(`Component tree contains a symbolic link: ${relative}`)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`Component tree contains a non-file entry: ${relative}`)
    }
  }
  await visit(root)
  return files
}

async function normalizeInstalledCommandWrappers(sitePackages: string): Promise<void> {
  const commandRoot = path.join(sitePackages, 'bin')
  let entries: Dirent[]
  try {
    entries = await readdir(commandRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  entries.sort((left, right) => ordinalCompare(left.name, right.name))
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Installed command wrapper is not a regular file: ${entry.name}`)
    }
    const wrapperPath = path.join(commandRoot, entry.name)
    const original = await readFile(wrapperPath)
    const normalized = normalizeInstalledCommandWrapperBytes(original)
    if (!normalized.equals(original)) await writeFile(wrapperPath, normalized)
  }
}

async function removeBuildOnlyFiles(root: string): Promise<void> {
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      const removeEntry = entry.name === '__pycache__'
        || /^(?:tests?|examples?|samples?)$/iu.test(entry.name)
        || entry.name.endsWith('.pyc')
        || (entry.name.toLocaleLowerCase('en-US').endsWith('.exe') && absolute !== path.join(root, 'python.exe'))
        || entry.name === 'direct_url.json'
        || (entry.name === 'RECORD' && path.basename(directory).endsWith('.dist-info'))
      if (removeEntry) {
        await rm(absolute, { recursive: true, force: true })
      } else if (entry.isDirectory()) {
        await visit(absolute)
      }
    }
  }
  await visit(root)
}

function metadataField(metadata: string, field: string): string {
  const prefix = `${field}: `
  return metadata.split(/\r?\n/u).find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() || 'Not declared'
}

function requiredMetadataField(metadata: string, field: 'Name' | 'Version'): string {
  const prefix = `${field}: `
  const matches = metadata
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter(Boolean)
  if (matches.length !== 1) {
    throw new Error(`Invalid installed distributions: METADATA must contain one ${field}`)
  }
  return matches[0]!
}

function normalizeDistributionName(value: string): string {
  return value.toLocaleLowerCase('en-US').replace(/[-_.]+/gu, '-')
}

export function reconcileLockedDistributions(
  locked: readonly Pick<LockedWheel, 'name' | 'version'>[],
  sources: readonly InstalledDistributionSource[],
): InstalledDistribution[] {
  const installed = sources.map((source) => ({
    ...source,
    name: requiredMetadataField(source.metadata, 'Name'),
    version: requiredMetadataField(source.metadata, 'Version'),
  }))
  const used = new Set<number>()
  const result = locked.map((wheel) => {
    const expectedName = normalizeDistributionName(wheel.name)
    const matches = installed
      .map((distribution, index) => ({ distribution, index }))
      .filter(({ distribution }) => (
        normalizeDistributionName(distribution.name) === expectedName
        && distribution.version === wheel.version
      ))
    if (matches.length !== 1 || used.has(matches[0]!.index)) {
      throw new Error(`Invalid installed distributions for ${wheel.name}==${wheel.version}`)
    }
    used.add(matches[0]!.index)
    return matches[0]!.distribution
  })
  if (used.size !== installed.length) {
    throw new Error('Invalid installed distributions: unexpected distribution metadata')
  }
  return result
}

export async function buildLicenseInventory(stageRoot: string, lock: ComponentLock): Promise<string> {
  const sitePackages = path.join(stageRoot, 'Lib', 'site-packages')
  const entries = await readdir(sitePackages, { withFileTypes: true })
  const distInfos = entries.filter((entry) => entry.isDirectory() && entry.name.endsWith('.dist-info'))
  const distributions = reconcileLockedDistributions(lock.wheels, await Promise.all(distInfos.map(async (entry) => ({
    directory: entry.name,
    metadata: await readFile(path.join(sitePackages, entry.name, 'METADATA'), 'utf8'),
  }))))
  const sections = [
    'Arkdown MarkItDown component third-party license inventory',
    `Component: ${COMPONENT_VERSION}`,
    `Python: ${lock.pythonVersion} (${lock.python.url}; SHA-256 ${lock.python.sha256})`,
    '',
  ]
  for (const [index, wheel] of lock.wheels.entries()) {
    const distribution = distributions[index]!
    const distInfo = path.join(sitePackages, distribution.directory)
    const metadata = distribution.metadata
    sections.push(`=== ${wheel.name} ${wheel.version} ===`)
    sections.push(`Source: ${wheel.url}`)
    sections.push(`SHA-256: ${wheel.sha256}`)
    sections.push(`License-Expression: ${metadataField(metadata, 'License-Expression')}`)
    sections.push(`License: ${metadataField(metadata, 'License')}`)
    const licenseFiles = (await listFiles(distInfo)).filter((entry) => /(^|\/)(?:licen[cs]e|copying|notice)/iu.test(entry))
    for (const licenseFile of licenseFiles) {
      const text = (await readFile(path.join(distInfo, ...licenseFile.split('/')), 'utf8')).replaceAll('\r\n', '\n').trimEnd()
      sections.push(`--- ${distribution.directory}/${licenseFile} ---`)
      sections.push(text)
    }
    sections.push('')
  }
  return `${sections.join('\n').trimEnd()}\n`
}

function minimalPdf(text: string): Buffer {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
  ]
  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(body, 'ascii'))
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(body, 'ascii')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'ascii')
}

export async function smokeTestEmbeddedRuntime(
  stageRoot: string,
  fixtureScript: string,
  smokeRoot: string,
): Promise<SmokeConversionResult[]> {
  await rm(smokeRoot, { recursive: true, force: true })
  await mkdir(smokeRoot, { recursive: true })
  const pythonPath = path.join(stageRoot, 'python.exe')
  const pdf = path.join(smokeRoot, 'fixture.pdf')
  const pptx = path.join(smokeRoot, 'fixture.pptx')
  const xlsx = path.join(smokeRoot, 'fixture.xlsx')
  const epub = path.join(smokeRoot, 'fixture.epub')
  await writeFile(pdf, minimalPdf('Arkdown PDF Fixture'))
  const creationCode = [
    'import sys',
    'from openpyxl import Workbook',
    'from pptx import Presentation',
    'book = Workbook()',
    'book.active["A1"] = "Arkdown XLSX Fixture"',
    'book.save(sys.argv[1])',
    'deck = Presentation()',
    'slide = deck.slides.add_slide(deck.slide_layouts[5])',
    'slide.shapes.title.text = "Arkdown PPTX Fixture"',
    'deck.save(sys.argv[2])',
  ].join('\n')
  await runEmbeddedPython(pythonPath, ['-c', creationCode, xlsx, pptx], stageRoot)
  await runEmbeddedPython(pythonPath, [fixtureScript, epub], stageRoot)
  const expectations = new Map([
    [pdf, 'Arkdown PDF Fixture'],
    [pptx, 'Arkdown PPTX Fixture'],
    [xlsx, 'Arkdown XLSX Fixture'],
    [epub, 'First Chapter'],
  ])
  const results: SmokeConversionResult[] = []
  for (const [input, expected] of expectations) {
    const extension = path.extname(input).slice(1) as SmokeConversionResult['format']
    const taskRoot = path.join(smokeRoot, extension)
    await mkdir(taskRoot)
    const output = path.join(taskRoot, 'output.md')
    const statusPath = path.join(taskRoot, 'status.json')
    await runEmbeddedPython(pythonPath, [
      path.join(stageRoot, 'arkdown_markitdown.py'),
      '--input', input,
      '--output', output,
      '--status', statusPath,
    ], taskRoot)
    const markdown = await readFile(output, 'utf8')
    const statusRecord = JSON.parse(await readFile(statusPath, 'utf8')) as { ok?: unknown; chars?: unknown }
    if (!markdown.includes(expected) || statusRecord.ok !== true || statusRecord.chars !== markdown.length) {
      throw new Error(`Embedded runtime smoke conversion failed for .${extension}`)
    }
    results.push({ format: extension, chars: markdown.length })
  }
  return results
}

async function auditStage(stageRoot: string): Promise<string[]> {
  const files = await listFiles(stageRoot)
  assertAllowedArchiveTree(files)
  const secretPatterns = [
    /(?<![0-9A-Za-z])AKIA[0-9A-Z]{16}(?![0-9A-Za-z])/u,
    /(?<![0-9A-Za-z])sk-[A-Za-z0-9]{24,}(?![0-9A-Za-z])/u,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  ]
  for (const entry of files) {
    const absolute = path.join(stageRoot, ...entry.split('/'))
    const metadata = await stat(absolute)
    if (metadata.size <= 4 * 1024 * 1024) {
      const content = await readFile(absolute)
      const text = content.toString('utf8')
      if (secretPatterns.some((pattern) => pattern.test(text))) {
        throw new Error(`Component archive contains secret-like content: ${entry}`)
      }
    }
  }
  return files
}

export async function buildMarkItDownComponent(options: ComponentBuildOptions = {}): Promise<ComponentBuildResult> {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('MarkItDown component builds require Windows x64')
  }
  const repoRoot = path.resolve(options.repoRoot ?? DEFAULT_REPO_ROOT)
  const componentsRoot = path.resolve(options.componentsRoot ?? path.join(repoRoot, '.components'))
  const cacheRoot = path.resolve(options.cacheRoot ?? path.join(componentsRoot, 'cache'))
  if (cacheRoot === path.parse(cacheRoot).root) throw new Error('Component cache root is too broad')
  const outputRoot = path.join(componentsRoot, 'markitdown')
  const workRoot = path.join(componentsRoot, 'work', 'markitdown')
  const stageRoot = path.join(workRoot, 'stage')
  const smokeRoot = path.join(workRoot, 'smoke')
  for (const target of [outputRoot, workRoot, stageRoot, smokeRoot]) ensureWithin(componentsRoot, target)
  await mkdir(cacheRoot, { recursive: true })
  await mkdir(outputRoot, { recursive: true })
  await rm(workRoot, { recursive: true, force: true })
  await mkdir(stageRoot, { recursive: true })

  const lockPath = path.join(repoRoot, 'scripts', 'markitdown', 'component-lock.json')
  const lock = parseComponentLock(JSON.parse(await readFile(lockPath, 'utf8')) as unknown)
  const artifacts = await Promise.all([
    obtainLockedArtifact(cacheRoot, lock.python, { allowDownload: options.allowDownload }),
    obtainLockedArtifact(cacheRoot, lock.pipBootstrap, { allowDownload: options.allowDownload }),
    obtainLockedArtifact(cacheRoot, lock.pipWheel, { allowDownload: options.allowDownload }),
    ...lock.wheels.map((wheel) => obtainLockedArtifact(cacheRoot, wheel, { allowDownload: options.allowDownload })),
  ])
  const [pythonArchive, pipBootstrap, _pipWheel, ...wheelPaths] = artifacts
  await extractZip(pythonArchive!, stageRoot)
  await rm(path.join(stageRoot, 'pythonw.exe'), { force: true })
  await rm(path.join(stageRoot, 'python.cat'), { force: true })
  const pthPath = path.join(stageRoot, 'python312._pth')
  const pth = (await readFile(pthPath, 'utf8'))
    .replace(/^#import site\s*$/mu, 'import site')
    .replaceAll('\r\n', '\n')
  const pthLines = pth.trimEnd().split('\n')
  if (!pthLines.includes('Lib/site-packages')) pthLines.splice(pthLines.length - 1, 0, 'Lib/site-packages')
  await writeFile(pthPath, `${pthLines.join('\n')}\n`, 'utf8')
  const sitePackages = path.join(stageRoot, 'Lib', 'site-packages')
  await mkdir(sitePackages, { recursive: true })

  const pythonPath = path.join(stageRoot, 'python.exe')
  await runEmbeddedPython(pythonPath, [
    pipBootstrap!, '--no-index', '--find-links', cacheRoot, 'pip==26.2.1', '--disable-pip-version-check',
  ], stageRoot)
  await runEmbeddedPython(pythonPath, [
    '-m', 'pip', 'install', '--no-index', '--no-deps', '--no-compile', '--disable-pip-version-check',
    '--no-warn-script-location', '--target', sitePackages, ...wheelPaths,
  ], stageRoot)
  const siteEntries = await readdir(sitePackages, { withFileTypes: true })
  for (const entry of siteEntries) {
    if (/^(?:pip|setuptools)(?:-|$)/iu.test(entry.name) || entry.name === '_distutils_hack') {
      await rm(path.join(sitePackages, entry.name), { recursive: true, force: true })
    }
  }
  await normalizeInstalledCommandWrappers(sitePackages)
  await rm(path.join(stageRoot, 'Scripts'), { recursive: true, force: true })
  await writeFile(
    path.join(stageRoot, 'arkdown_markitdown.py'),
    normalizeTextBytes(await readFile(path.join(repoRoot, 'scripts', 'markitdown', 'arkdown_markitdown.py'))),
  )
  await writeFile(
    path.join(stageRoot, 'THIRD_PARTY_LICENSES.txt'),
    await buildLicenseInventory(stageRoot, lock),
    'utf8',
  )
  await removeBuildOnlyFiles(stageRoot)
  await smokeTestEmbeddedRuntime(
    stageRoot,
    path.join(repoRoot, 'scripts', 'markitdown', 'create_epub_fixture.py'),
    smokeRoot,
  )
  await removeBuildOnlyFiles(stageRoot)

  const beforeManifest = await auditStage(stageRoot)
  const lockSha256 = sha256Bytes(canonicalJsonBytes(lock))
  const internalFiles = await Promise.all(beforeManifest.map(async (entry) => {
    const absolute = path.join(stageRoot, ...entry.split('/'))
    const metadata = await stat(absolute)
    return { path: entry, bytes: metadata.size, sha256: await sha256(absolute) }
  }))
  const internalManifest = {
    schemaVersion: 1,
    version: COMPONENT_VERSION,
    pythonVersion: lock.pythonVersion,
    platform: lock.platform,
    lockSha256,
    files: internalFiles,
  }
  await writeFile(
    path.join(stageRoot, 'component-manifest.json'),
    normalizeTextBytes(`${JSON.stringify(internalManifest)}\n`),
  )
  const archiveEntries = await auditStage(stageRoot)

  const archivePath = path.join(outputRoot, ARCHIVE_NAME)
  const pendingArchive = `${archivePath}.pending-${process.pid}`
  await rm(pendingArchive, { force: true })
  await tar.create({
    cwd: stageRoot,
    file: pendingArchive,
    gzip: { level: 9 },
    mtime: new Date(0),
    noDirRecurse: true,
    portable: true,
  }, archiveEntries)
  await rm(archivePath, { force: true })
  await rename(pendingArchive, archivePath)
  const archiveMetadata = await lstat(archivePath)
  if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink()) throw new Error('Component archive is not a regular file')
  const result: ComponentBuildResult = {
    archivePath,
    manifestPath: path.join(outputRoot, 'manifest.json'),
    version: COMPONENT_VERSION,
    bytes: archiveMetadata.size,
    sha256: await sha256(archivePath),
  }
  await writeAtomic(result.manifestPath, normalizeTextBytes(`${JSON.stringify(publicManifest(result))}\n`))
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  buildMarkItDownComponent()
    .then((result) => process.stdout.write(`${JSON.stringify(publicManifest(result))}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
