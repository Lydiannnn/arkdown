import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from 'node:fs/promises'
import path from 'node:path'
import type {
  ComponentInstallProgress,
  DocumentConversionComponentDescriptor,
} from '../../shared/document-conversion'
import { parseDocumentConversionComponentDescriptor } from '../../shared/document-conversion'
import { appError, PublicError } from '../../shared/public-errors'

type FetchArtifact = (url: string, init: RequestInit) => Promise<Response>

export interface ComponentArtifactSource {
  readonly kind: 'packaged' | 'https'
  copyTo(
    targetPath: string,
    signal: AbortSignal,
    onProgress: (progress: ComponentInstallProgress) => void,
  ): Promise<void>
}

function equalPath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}

function validatedDescriptor(
  descriptor: DocumentConversionComponentDescriptor,
  source: 'packaged' | 'https',
): DocumentConversionComponentDescriptor {
  const parsed = parseDocumentConversionComponentDescriptor(descriptor)
  if (!parsed || parsed.source !== source) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
  return parsed
}

function packagedResourceUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
}

async function readPackagedResource<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (packagedResourceUnavailable(error)) throw appError('DOCUMENT_CONVERSION_PACKAGE_MISSING')
    throw error
  }
}

function canonicalHttpsUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && parsed.href === value
  } catch {
    return false
  }
}

async function writeChunks(
  chunks: AsyncIterable<Uint8Array>,
  targetPath: string,
  descriptor: DocumentConversionComponentDescriptor,
  phase: 'reading' | 'downloading',
  signal: AbortSignal,
  onProgress: (progress: ComponentInstallProgress) => void,
): Promise<void> {
  signal.throwIfAborted()
  await mkdir(path.dirname(targetPath), { recursive: true })
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let createdTarget = false
  let receivedBytes = 0
  const digest = createHash('sha256')
  try {
    handle = await open(targetPath, 'wx')
    createdTarget = true
    onProgress({ phase, receivedBytes: 0, totalBytes: descriptor.bytes })
    signal.throwIfAborted()
    for await (const value of chunks) {
      signal.throwIfAborted()
      const chunk = Buffer.from(value)
      receivedBytes += chunk.byteLength
      if (receivedBytes > descriptor.bytes) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle.write(chunk, offset)
        if (bytesWritten < 1) throw new Error('Component artifact write failed')
        offset += bytesWritten
        signal.throwIfAborted()
      }
      digest.update(chunk)
      onProgress({ phase, receivedBytes, totalBytes: descriptor.bytes })
      signal.throwIfAborted()
    }
    if (receivedBytes !== descriptor.bytes) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    if (digest.digest('hex') !== descriptor.sha256) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (createdTarget) await rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export class PackagedArtifactSource implements ComponentArtifactSource {
  readonly kind = 'packaged' as const

  constructor(
    private readonly descriptor: DocumentConversionComponentDescriptor,
    private readonly resourcesPath: string = process.resourcesPath,
  ) {}

  async copyTo(
    targetPath: string,
    signal: AbortSignal,
    onProgress: (progress: ComponentInstallProgress) => void,
  ): Promise<void> {
    signal.throwIfAborted()
    const descriptor = validatedDescriptor(this.descriptor, 'packaged')
    const resourceRoot = path.resolve(this.resourcesPath, 'document-conversion')
    const rootMetadata = await readPackagedResource(() => lstat(resourceRoot))
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    const entries = await readPackagedResource(() => readdir(resourceRoot, { withFileTypes: true }))
    const archiveEntry = entries.find((entry) => entry.name === descriptor.archiveName)
    if (!archiveEntry?.isFile() || archiveEntry.isSymbolicLink()) {
      throw archiveEntry
        ? appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
        : appError('DOCUMENT_CONVERSION_PACKAGE_MISSING')
    }
    const archivePath = path.resolve(resourceRoot, descriptor.archiveName)
    const relative = path.relative(resourceRoot, archivePath)
    if (!relative || relative !== descriptor.archiveName || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    const archiveMetadata = await readPackagedResource(() => lstat(archivePath))
    if (!archiveMetadata.isFile() || archiveMetadata.isSymbolicLink() || archiveMetadata.size !== descriptor.bytes) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    const [canonicalRoot, canonicalArchive] = await readPackagedResource(
      () => Promise.all([realpath(resourceRoot), realpath(archivePath)]),
    )
    if (!equalPath(canonicalArchive, path.join(canonicalRoot, descriptor.archiveName))) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    try {
      await writeChunks(
        createReadStream(archivePath, { highWaterMark: 64 * 1024 }),
        targetPath,
        descriptor,
        'reading',
        signal,
        onProgress,
      )
    } catch (error) {
      if (error instanceof PublicError || signal.aborted) throw error
      if (packagedResourceUnavailable(error)) throw appError('DOCUMENT_CONVERSION_PACKAGE_MISSING')
      throw error
    }
  }
}

export class HttpsArtifactSource implements ComponentArtifactSource {
  readonly kind = 'https' as const

  constructor(
    private readonly descriptor: DocumentConversionComponentDescriptor,
    private readonly fetchImpl: FetchArtifact = fetch,
  ) {}

  async copyTo(
    targetPath: string,
    signal: AbortSignal,
    onProgress: (progress: ComponentInstallProgress) => void,
  ): Promise<void> {
    const descriptor = validatedDescriptor(this.descriptor, 'https')
    const url = descriptor.url
    if (!url || !canonicalHttpsUrl(url)) throw new Error('Invalid HTTPS component URL')
    signal.throwIfAborted()
    const response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual', signal })
    if (response.status !== 200 || response.redirected || !response.body) {
      throw new Error('Component artifact download failed')
    }
    if (response.url && response.url !== url) throw new Error('Component artifact URL mismatch')
    const declaredLength = response.headers.get('content-length')
    if (declaredLength === null || !/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)
      || Number(declaredLength) !== descriptor.bytes) {
      throw new Error('Component artifact content length mismatch')
    }
    await writeChunks(
      response.body,
      targetPath,
      descriptor,
      'downloading',
      signal,
      onProgress,
    )
  }
}

/** A pinned COS manifest is evidence, never a new trust root or fallback configuration. */
export class CosComponentArtifactSource implements ComponentArtifactSource {
  readonly kind = 'https' as const

  constructor(
    private readonly descriptor: DocumentConversionComponentDescriptor,
    private readonly releaseBaseUrl: string,
    private readonly fetchImpl: FetchArtifact = fetch,
  ) {}

  private async fetchAsset(url: string, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted()
    const response = await this.fetchImpl(url, { method: 'GET', redirect: 'manual', signal })
    if (response.status !== 200 || response.redirected || !response.body
      || (response.url && response.url !== url)) {
      await response.body?.cancel().catch(() => undefined)
      throw appError('DOCUMENT_CONVERSION_DOWNLOAD_FAILED')
    }
    return response
  }

  async copyTo(
    targetPath: string,
    signal: AbortSignal,
    onProgress: (progress: ComponentInstallProgress) => void,
  ): Promise<void> {
    try {
      signal.throwIfAborted()
      const descriptor = validatedDescriptor(this.descriptor, 'https')
      if (!canonicalHttpsUrl(this.releaseBaseUrl)
        || !/^https:\/\/arkdown-downloads-1257382433\.cos\.ap-guangzhou\.myqcloud\.com\/components\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/$/u.test(this.releaseBaseUrl)
        || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u.test(descriptor.archiveName)
        || !descriptor.url || !canonicalHttpsUrl(descriptor.url)
        || descriptor.url !== `${this.releaseBaseUrl}${descriptor.archiveName}`) {
        throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
      }
      const manifestResponse = await this.fetchAsset(`${this.releaseBaseUrl}manifest.json`, signal)
      const chunks: Buffer[] = []
      let bytes = 0
      try {
        signal.throwIfAborted()
        for await (const chunk of manifestResponse.body!) {
          signal.throwIfAborted()
          bytes += chunk.byteLength
          if (bytes > 16 * 1024) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
          chunks.push(Buffer.from(chunk))
        }
        signal.throwIfAborted()
      } finally {
        if (!manifestResponse.body!.locked) await manifestResponse.body!.cancel().catch(() => undefined)
      }
      let remote: DocumentConversionComponentDescriptor | undefined
      try {
        remote = parseDocumentConversionComponentDescriptor(JSON.parse(
          Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, ''),
        ))
      } catch { throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID') }
      if (!remote || Object.keys(descriptor).some(key => (
        descriptor[key as keyof typeof descriptor] !== remote[key as keyof typeof remote]
      ))) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')

      const response = await this.fetchAsset(descriptor.url, signal)
      try {
        signal.throwIfAborted()
        if (response.headers.get('content-length') !== String(descriptor.bytes)) {
          throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
        }
        await writeChunks(response.body!, targetPath, descriptor, 'downloading', signal, onProgress)
      } finally {
        // Failures before stream iteration must also release the network body.
        if (!response.body!.locked) await response.body!.cancel().catch(() => undefined)
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof PublicError) throw error
      throw appError('DOCUMENT_CONVERSION_DOWNLOAD_FAILED')
    }
  }
}

/** A pinned GitHub Release manifest is evidence, never a new trust root. */
export class GitHubReleaseArtifactSource implements ComponentArtifactSource {
  readonly kind = 'https' as const

  constructor(
    private readonly descriptor: DocumentConversionComponentDescriptor,
    private readonly releaseBaseUrl: string,
    private readonly fetchImpl: FetchArtifact = fetch,
  ) {}

  private async fetchAsset(url: string, signal: AbortSignal): Promise<Response> {
    if (!canonicalHttpsUrl(this.releaseBaseUrl)
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9_.-]+\/$/u.test(this.releaseBaseUrl)
      || !url.startsWith(this.releaseBaseUrl)
      || url.slice(this.releaseBaseUrl.length).includes('/')) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    signal.throwIfAborted()
    let current = url
    let response = await this.fetchImpl(current, { method: 'GET', redirect: 'manual', signal })
    if (response.redirected || (response.url && response.url !== current)) {
      await response.body?.cancel()
      throw new Error('Component asset URL mismatch')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || !canonicalHttpsUrl(location)) throw new Error('Invalid component asset redirect')
      const target = new URL(location)
      if (target.hostname !== 'release-assets.githubusercontent.com' || target.port
        || !/^\/github-production-release-asset\/[0-9]+\/[A-Za-z0-9-]+$/u.test(target.pathname)) {
        throw new Error('Untrusted component asset redirect')
      }
      signal.throwIfAborted()
      current = location
      response = await this.fetchImpl(current, { method: 'GET', redirect: 'manual', signal })
    }
    if (response.status !== 200 || response.redirected || !response.body
      || (response.url && response.url !== current)) {
      await response.body?.cancel()
      throw new Error('Component asset download failed')
    }
    return response
  }

  async copyTo(
    targetPath: string,
    signal: AbortSignal,
    onProgress: (progress: ComponentInstallProgress) => void,
  ): Promise<void> {
    try {
      await this.download(targetPath, signal, onProgress)
    } catch (error) {
      if (signal.aborted || error instanceof PublicError) throw error
      throw appError('DOCUMENT_CONVERSION_DOWNLOAD_FAILED')
    }
  }

  private async download(
    targetPath: string,
    signal: AbortSignal,
    onProgress: (progress: ComponentInstallProgress) => void,
  ): Promise<void> {
    const descriptor = validatedDescriptor(this.descriptor, 'https')
    if (descriptor.url !== `${this.releaseBaseUrl}${descriptor.archiveName}`) {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    const manifestResponse = await this.fetchAsset(`${this.releaseBaseUrl}manifest.json`, signal)
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of manifestResponse.body!) {
      signal.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > 16 * 1024) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
      chunks.push(Buffer.from(chunk))
    }
    let remote: DocumentConversionComponentDescriptor | undefined
    try {
      remote = parseDocumentConversionComponentDescriptor(JSON.parse(
        Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, ''),
      ))
    } catch {
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    if (!remote || Object.keys(descriptor).some((key) => (
      descriptor[key as keyof typeof descriptor] !== remote[key as keyof typeof remote]
    ))) throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    const response = await this.fetchAsset(descriptor.url!, signal)
    const declaredLength = response.headers.get('content-length')
    if (declaredLength !== String(descriptor.bytes)) {
      await response.body?.cancel()
      throw appError('DOCUMENT_CONVERSION_COMPONENT_INVALID')
    }
    try {
      await writeChunks(response.body!, targetPath, descriptor, 'downloading', signal, onProgress)
    } finally {
      // mkdir/open/callback failures can occur before writeChunks acquires the stream iterator.
      if (!response.body!.locked) await response.body!.cancel().catch(() => undefined)
    }
  }
}
