import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import * as tar from 'tar'
import type { DocumentConversionComponentDescriptor } from '../../shared/document-conversion'
import { parseDocumentConversionComponentDescriptor } from '../../shared/document-conversion'
import {
  SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR,
  SCREENSHOT_OCR_MEDIUM_COMPONENT_TREE_SHA256,
} from '../../shared/screenshot-ocr-medium-component-manifest'
import { GitHubReleaseArtifactSource, type ComponentArtifactSource } from '../document-conversion/component-artifact-source'

const PAYLOAD_FILES = ['medium-det.tar', 'medium-rec.tar', 'manifest.json', 'licenses/PaddleOCR-LICENSE.txt'] as const
const TREE = 'component-manifest.json'
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
const MAX_TREE_BYTES = 160 * 1024 * 1024
const invalid = () => new Error('OCR_MODEL_DOWNLOAD_FAILED')

async function checkPath(target: string, directory: boolean): Promise<void> {
  const info = await lstat(target)
  const canonical = await realpath(target)
  const same = process.platform === 'win32'
    ? canonical.toLowerCase() === path.resolve(target).toLowerCase()
    : canonical === path.resolve(target)
  if (!same || info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) throw invalid()
}

async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function unpack(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  const seen = new Set<string>()
  let rejected = false
  let inflated = 0
  let declared = 0
  const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    inflated += chunk.length
    callback(rejected || inflated > MAX_TREE_BYTES + 1024 * 1024 ? invalid() : null, chunk)
  } })
  const extractor = tar.x({ cwd: destination, strict: true, preservePaths: false, maxMetaEntrySize: 16 * 1024,
    filter(raw, entry) {
      const type = 'type' in entry ? entry.type : undefined
      const directory = type === 'Directory'
      const name = directory && raw.endsWith('/') ? raw.slice(0, -1) : raw
      const size = entry.size ?? 0
      const maxBytes = name.endsWith('.tar') ? 80 * 1024 * 1024 : name.startsWith('licenses/') ? 4 * 1024 * 1024 : 16 * 1024
      const valid = !signal.aborted && 'path' in entry && entry.path === raw
        && 'linkpath' in entry && !entry.linkpath && !seen.has(name)
        && (directory ? name === 'licenses' && size === 0
          : (type === 'File' || type === 'OldFile') && (name === TREE || PAYLOAD_FILES.includes(name as typeof PAYLOAD_FILES[number])))
        && Number.isSafeInteger(size) && size >= 0 && size <= maxBytes
      seen.add(name)
      declared += size
      if (!valid || declared > MAX_TREE_BYTES || seen.size > 6) rejected = true
      return !rejected
    },
  })
  await pipeline(createReadStream(archive), createGunzip(), limiter, extractor, { signal })
  if (rejected) throw invalid()
}

async function auditTree(root: string, version: string, treeHash: string, signal: AbortSignal): Promise<void> {
  await checkPath(root, true)
  await checkPath(path.join(root, 'licenses'), true)
  const names = await readdir(root)
  if (names.length !== 5 || names.some((name) => !['medium-det.tar', 'medium-rec.tar', 'manifest.json', 'licenses', TREE].includes(name))
    || (await readdir(path.join(root, 'licenses'))).join() !== 'PaddleOCR-LICENSE.txt') throw invalid()
  const manifestPath = path.join(root, TREE)
  await checkPath(manifestPath, false)
  if ((await lstat(manifestPath)).size > 16 * 1024) throw invalid()
  const bytes = await readFile(manifestPath)
  if (createHash('sha256').update(bytes).digest('hex') !== treeHash) throw invalid()
  const tree = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, '')) as {
    schemaVersion?: unknown; version?: unknown; entry?: unknown; files?: unknown
  }
  if (tree.schemaVersion !== 1 || tree.version !== version || tree.entry !== 'medium-det.tar'
    || !Array.isArray(tree.files) || tree.files.length !== PAYLOAD_FILES.length) throw invalid()
  const seen = new Set<string>()
  for (const item of tree.files as Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>) {
    signal.throwIfAborted()
    if (!item || typeof item.path !== 'string' || !PAYLOAD_FILES.includes(item.path as typeof PAYLOAD_FILES[number])
      || seen.has(item.path) || typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0
      || item.bytes > 80 * 1024 * 1024 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) throw invalid()
    seen.add(item.path)
    const target = path.join(root, ...item.path.split('/'))
    await checkPath(target, false)
    if ((await lstat(target)).size !== item.bytes || await hashFile(target, signal) !== item.sha256) throw invalid()
  }
}

/** Downloads the pinned GitHub module, then supplies only model archives to the existing transaction. */
export function createGitHubMediumPreparer(options: {
  descriptor?: DocumentConversionComponentDescriptor
  treeManifestSha256?: string
  artifactSource?: ComponentArtifactSource
} = {}): (stagingRoot: string, signal: AbortSignal, onProgress: (progress: { receivedBytes: number; totalBytes: number }) => void) => Promise<void> {
  const descriptor = parseDocumentConversionComponentDescriptor(options.descriptor ?? SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR)
  const treeHash = options.treeManifestSha256 ?? SCREENSHOT_OCR_MEDIUM_COMPONENT_TREE_SHA256
  if (!descriptor || descriptor.source !== 'https' || descriptor.bytes > MAX_ARCHIVE_BYTES || !/^[a-f0-9]{64}$/u.test(treeHash)) throw invalid()
  const source = options.artifactSource ?? new GitHubReleaseArtifactSource(descriptor, descriptor.url!.slice(0, descriptor.url!.lastIndexOf('/') + 1))
  return async (stagingRoot, signal, onProgress) => {
    let temporary: string | undefined
    const created: string[] = []
    try {
      signal.throwIfAborted()
      await checkPath(stagingRoot, true)
      if ((await readdir(stagingRoot)).length !== 0) throw invalid()
      temporary = await mkdtemp(path.join(path.dirname(stagingRoot), '.medium-source-'))
      const archive = path.join(temporary, 'component.tar.gz')
      await source.copyTo(archive, signal, ({ receivedBytes, totalBytes }) => onProgress({ receivedBytes, totalBytes }))
      signal.throwIfAborted()
      await checkPath(archive, false)
      if ((await lstat(archive)).size !== descriptor.bytes || await hashFile(archive, signal) !== descriptor.sha256) throw invalid()
      const tree = path.join(temporary, 'tree')
      await mkdir(tree)
      await unpack(archive, tree, signal)
      await auditTree(tree, descriptor.version, treeHash, signal)
      for (const name of ['medium-det.tar', 'medium-rec.tar']) {
        signal.throwIfAborted()
        const target = path.join(stagingRoot, name)
        await copyFile(path.join(tree, name), target, constants.COPYFILE_EXCL)
        created.push(target)
      }
      signal.throwIfAborted()
    } catch (error) {
      for (const target of created) await rm(target, { force: true }).catch(() => undefined)
      if (signal.aborted) throw signal.reason
      throw invalid()
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true })
    }
  }
}
