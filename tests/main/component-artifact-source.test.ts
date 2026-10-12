import { createHash } from 'node:crypto'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentConversionComponentDescriptor } from '../../src/shared/document-conversion'
import {
  HttpsArtifactSource,
  GitHubReleaseArtifactSource,
  PackagedArtifactSource,
} from '../../src/main/document-conversion/component-artifact-source'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('GitHubReleaseArtifactSource', () => {
  const base = 'https://github.com/Lydiannnn/arkdown-releases/releases/download/markitdown-0.1.7-py3.12.10/'
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/123/abc-123?token=test'
  const bytes = Buffer.from('pinned archive')
  const pinned = descriptor(bytes, { source: 'https', url: `${base}component.tar.gz` })
  const manifestResponse = (value: unknown = pinned) => new Response(JSON.stringify(value))
  const archiveResponse = (value = bytes) => new Response(value, { headers: { 'content-length': String(bytes.length) } })

  it('compares the pinned remote manifest and follows only a single official asset redirect per request', async () => {
    const calls: string[] = []
    const source = new GitHubReleaseArtifactSource(pinned, base, async (url, init) => {
      calls.push(url)
      expect(init.redirect).toBe('manual')
      if (url === `${base}manifest.json`) return new Response(null, { status: 302, headers: { location: `${cdn}&manifest=1` } })
      if (url === `${cdn}&manifest=1`) return manifestResponse()
      if (url === pinned.url) return new Response(null, { status: 302, headers: { location: cdn } })
      return archiveResponse()
    })
    const root = await temporaryRoot('arkdown-github-source-')
    const target = path.join(root, 'archive.tar.gz')
    await source.copyTo(target, new AbortController().signal, vi.fn())
    expect(await readFile(target)).toEqual(bytes)
    expect(calls).toEqual([`${base}manifest.json`, `${cdn}&manifest=1`, pinned.url, cdn])
  })

  it.each(['https://evil.test/archive', 'http://release-assets.githubusercontent.com/github-production-release-asset/123/abc',
    'https://release-assets.githubusercontent.com.evil.test/github-production-release-asset/123/abc',
    'https://user@release-assets.githubusercontent.com/github-production-release-asset/123/abc',
    'https://release-assets.githubusercontent.com/unknown/abc', `${cdn}#fragment`])(
    'rejects an untrusted redirect before requesting it: %s', async (location) => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
      const root = await temporaryRoot('arkdown-github-redirect-')
      await expect(new GitHubReleaseArtifactSource(pinned, base, fetchImpl)
        .copyTo(path.join(root, 'archive'), new AbortController().signal, vi.fn())).rejects.toThrow()
      expect(fetchImpl).toHaveBeenCalledOnce()
    },
  )

  it('rejects a second redirect without following it', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: cdn } }))
    const root = await temporaryRoot('arkdown-github-loop-')
    await expect(new GitHubReleaseArtifactSource(pinned, base, fetchImpl)
      .copyTo(path.join(root, 'archive'), new AbortController().signal, vi.fn())).rejects.toThrow()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each(['version', 'bytes', 'sha256', 'url', 'source', 'extra'])('rejects a changed manifest %s before archive download', async (key) => {
    const fetchImpl = vi.fn(async () => manifestResponse({ ...pinned, [key]: key === 'bytes' ? bytes.length + 1 : 'changed' }))
    const root = await temporaryRoot('arkdown-github-manifest-')
    await expect(new GitHubReleaseArtifactSource(pinned, base, fetchImpl)
      .copyTo(path.join(root, 'archive'), new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('bounds the remote manifest and accepts an optional UTF-8 BOM', async () => {
    const root = await temporaryRoot('arkdown-github-manifest-bounds-')
    const oversized = vi.fn(async () => new Response(' '.repeat(16 * 1024 + 1)))
    await expect(new GitHubReleaseArtifactSource(pinned, base, oversized)
      .copyTo(path.join(root, 'large'), new AbortController().signal, vi.fn())).rejects.toThrow()
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('manifest.json')
      ? new Response(`\uFEFF${JSON.stringify(pinned)}`) : archiveResponse())
    await new GitHubReleaseArtifactSource(pinned, base, fetchImpl)
      .copyTo(path.join(root, 'bom'), new AbortController().signal, vi.fn())
    expect(await readFile(path.join(root, 'bom'))).toEqual(bytes)
  })

  it('removes checksum failures and supports an explicit retry', async () => {
    const root = await temporaryRoot('arkdown-github-retry-')
    const target = path.join(root, 'archive')
    let corrupt = true
    const source = new GitHubReleaseArtifactSource(pinned, base, async (url) => (
      url.endsWith('manifest.json') ? manifestResponse() : archiveResponse(corrupt ? Buffer.alloc(bytes.length) : bytes)
    ))
    await expect(source.copyTo(target, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    await expectMissing(target)
    corrupt = false
    await source.copyTo(target, new AbortController().signal, vi.fn())
    expect(await readFile(target)).toEqual(bytes)
  })

  it('honors cancellation in download and leaves no partial artifact', async () => {
    const root = await temporaryRoot('arkdown-github-cancel-')
    const target = path.join(root, 'archive')
    const controller = new AbortController()
    const source = new GitHubReleaseArtifactSource(pinned, base, async url => (
      url.endsWith('manifest.json') ? manifestResponse() : archiveResponse()
    ))
    await expect(source.copyTo(target, controller.signal, progress => {
      if (progress.receivedBytes > 0) controller.abort()
    })).rejects.toMatchObject({ name: 'AbortError' })
    await expectMissing(target)
  })

  it('makes no request after pre-cancellation and reports offline failures', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed') })
    const source = new GitHubReleaseArtifactSource(pinned, base, fetchImpl)
    const root = await temporaryRoot('arkdown-github-offline-')
    const target = path.join(root, 'archive')
    const controller = new AbortController()
    controller.abort()
    await expect(source.copyTo(target, controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled()
    await expect(source.copyTo(target, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_DOWNLOAD_FAILED' })
    await expectMissing(target)
  })

  it.each(['mkdir', 'open'])('cancels the response body when %s fails before stream iteration', async (failure) => {
    const root = await temporaryRoot('arkdown-github-filesystem-failure-')
    const blocker = path.join(root, 'existing-file')
    await writeFile(blocker, 'preserve')
    const cancel = vi.fn()
    const source = new GitHubReleaseArtifactSource(pinned, base, async url => (
      url.endsWith('manifest.json') ? manifestResponse() : new Response(new ReadableStream({ cancel }), {
        headers: { 'content-length': String(bytes.length) },
      })
    ))
    const target = failure === 'mkdir' ? path.join(blocker, 'archive') : blocker
    await expect(source.copyTo(target, new AbortController().signal, vi.fn())).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce()
    expect(await readFile(blocker, 'utf8')).toBe('preserve')
  })
})

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function descriptor(
  bytes: Uint8Array,
  overrides: Partial<DocumentConversionComponentDescriptor> = {},
): DocumentConversionComponentDescriptor {
  return {
    source: 'packaged',
    version: 'test-1',
    archiveName: 'component.tar.gz',
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    url: null,
    ...overrides,
  }
}

async function packagedFixture(bytes: Uint8Array): Promise<{
  resourcesPath: string
  target: string
}> {
  const root = await temporaryRoot('arkdown-component-source-')
  const resourcesPath = path.join(root, 'resources')
  const componentRoot = path.join(resourcesPath, 'document-conversion')
  await mkdir(componentRoot, { recursive: true })
  await writeFile(path.join(componentRoot, 'component.tar.gz'), bytes)
  return { resourcesPath, target: path.join(root, 'copy', 'component.tar.gz') }
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('PackagedArtifactSource', () => {
  it('honors an already-aborted signal before touching packaged resources', async () => {
    const bytes = Buffer.from('archive')
    const root = await temporaryRoot('arkdown-component-pre-abort-')
    const target = path.join(root, 'copy.tar.gz')
    const controller = new AbortController()
    controller.abort()

    await expect(new PackagedArtifactSource(descriptor(bytes), path.join(root, 'missing-resources'))
      .copyTo(target, controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
    await expectMissing(target)
  })

  it('copies only the exact manifest archive and reports monotonic reading progress', async () => {
    const bytes = Buffer.alloc(256 * 1024 + 17, 0x5a)
    const fixture = await packagedFixture(bytes)
    const seen: number[] = []
    const progress = vi.fn((value: { phase: string; receivedBytes: number; totalBytes: number }) => {
      seen.push(value.receivedBytes)
      expect(value.phase).toBe('reading')
      expect(value.totalBytes).toBe(bytes.byteLength)
    })

    await new PackagedArtifactSource(descriptor(bytes), fixture.resourcesPath)
      .copyTo(fixture.target, new AbortController().signal, progress)

    expect(seen).toEqual([...seen].sort((left, right) => left - right))
    expect(seen.at(0)).toBe(0)
    expect(seen.at(-1)).toBe(bytes.byteLength)
    expect(sha256(await readFile(fixture.target))).toBe(sha256(bytes))
  })

  it('reports a stable missing-package code when packaged resources are unavailable', async () => {
    const bytes = Buffer.from('archive')
    const root = await temporaryRoot('arkdown-component-missing-')
    const target = path.join(root, 'copy.tar.gz')

    await expect(new PackagedArtifactSource(descriptor(bytes), path.join(root, 'missing-resources'))
      .copyTo(target, new AbortController().signal, vi.fn())).rejects.toMatchObject({
        code: 'DOCUMENT_CONVERSION_PACKAGE_MISSING',
      })
    await expectMissing(target)
  })

  it('rejects traversal and noncanonical filename casing without reading an adjacent file', async () => {
    const bytes = Buffer.from('trusted')
    const root = await temporaryRoot('arkdown-component-canonical-')
    const resourcesPath = path.join(root, 'resources')
    const componentRoot = path.join(resourcesPath, 'document-conversion')
    await mkdir(componentRoot, { recursive: true })
    await writeFile(path.join(resourcesPath, 'escape.tar.gz'), bytes)
    await writeFile(path.join(componentRoot, 'COMPONENT.TAR.GZ'), bytes)

    const traversal = descriptor(bytes, { archiveName: '../escape.tar.gz' })
    const wrongCase = descriptor(bytes)
    const firstTarget = path.join(root, 'first.tar.gz')
    const secondTarget = path.join(root, 'second.tar.gz')

    await expect(new PackagedArtifactSource(traversal, resourcesPath)
      .copyTo(firstTarget, new AbortController().signal, vi.fn())).rejects.toThrow()
    await expect(new PackagedArtifactSource(wrongCase, resourcesPath)
      .copyTo(secondTarget, new AbortController().signal, vi.fn())).rejects.toThrow()
    await expectMissing(firstTarget)
    await expectMissing(secondTarget)
  })

  it('rejects a document-conversion reparse escape', async () => {
    const bytes = Buffer.from('outside')
    const root = await temporaryRoot('arkdown-component-reparse-')
    const resourcesPath = path.join(root, 'resources')
    const outside = await temporaryRoot('arkdown-component-outside-')
    await mkdir(resourcesPath, { recursive: true })
    await writeFile(path.join(outside, 'component.tar.gz'), bytes)
    await symlink(outside, path.join(resourcesPath, 'document-conversion'), process.platform === 'win32' ? 'junction' : 'dir')
    const target = path.join(root, 'copy.tar.gz')

    await expect(new PackagedArtifactSource(descriptor(bytes), resourcesPath)
      .copyTo(target, new AbortController().signal, vi.fn())).rejects.toThrow()
    await expectMissing(target)
  })

  it.each([
    ['wrong byte count', Buffer.from('short'), { bytes: 100 }],
    ['wrong hash', Buffer.from('same-size'), { sha256: '0'.repeat(64) }],
  ])('rejects a packaged archive with %s and removes the target', async (_label, bytes, override) => {
    const fixture = await packagedFixture(bytes)
    await expect(new PackagedArtifactSource(descriptor(bytes, override), fixture.resourcesPath)
      .copyTo(fixture.target, new AbortController().signal, vi.fn())).rejects.toMatchObject({
        code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID',
      })
    await expectMissing(fixture.target)
  })

  it('aborts an in-flight copy and removes the partial target', async () => {
    const bytes = Buffer.alloc(512 * 1024, 0x31)
    const fixture = await packagedFixture(bytes)
    const controller = new AbortController()

    await expect(new PackagedArtifactSource(descriptor(bytes), fixture.resourcesPath)
      .copyTo(fixture.target, controller.signal, (progress) => {
        if (progress.receivedBytes > 0) controller.abort()
      })).rejects.toMatchObject({ name: 'AbortError' })
    await expectMissing(fixture.target)
  })
})

describe('HttpsArtifactSource', () => {
  it('requests only the exact descriptor URL with manual redirects and reports download progress', async () => {
    const bytes = Buffer.from('downloaded archive')
    const url = 'https://downloads.example.test/exact/component.tar.gz'
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    }))
    const root = await temporaryRoot('arkdown-component-https-')
    const target = path.join(root, 'component.tar.gz')
    const seen: number[] = []

    await new HttpsArtifactSource(descriptor(bytes, { source: 'https', url }), fetchImpl)
      .copyTo(target, new AbortController().signal, (progress) => {
        expect(progress.phase).toBe('downloading')
        seen.push(progress.receivedBytes)
      })

    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledWith(url, {
      method: 'GET',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    })
    expect(seen).toEqual([...seen].sort((left, right) => left - right))
    expect(seen.at(0)).toBe(0)
    expect(seen.at(-1)).toBe(bytes.byteLength)
    expect(await readFile(target)).toEqual(bytes)
  })

  it('rejects a descriptor whose injected URL is not the exact canonical HTTPS URL', async () => {
    const bytes = Buffer.from('archive')
    const fetchImpl = vi.fn(async () => new Response(bytes))
    const root = await temporaryRoot('arkdown-component-url-')
    const variants = [
      'http://downloads.example.test/component.tar.gz',
      'https://user@downloads.example.test/component.tar.gz',
      'https://downloads.example.test/component.tar.gz#fragment',
    ]

    for (const [index, url] of variants.entries()) {
      const candidate = descriptor(bytes, { source: 'https', url })
      await expect(new HttpsArtifactSource(candidate, fetchImpl)
        .copyTo(path.join(root, String(index)), new AbortController().signal, vi.fn())).rejects.toThrow()
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    ['redirect', 302, { location: 'https://downloads.example.test/other.tar.gz', 'content-length': '0' }],
    ['non-success status', 503, { 'content-length': '0' }],
  ])('rejects an HTTP %s and removes the target', async (_label, status, headers) => {
    const bytes = Buffer.from('archive')
    const url = 'https://downloads.example.test/component.tar.gz'
    const fetchImpl = vi.fn(async () => new Response(null, { status, headers }))
    const root = await temporaryRoot('arkdown-component-http-status-')
    const target = path.join(root, 'component.tar.gz')

    await expect(new HttpsArtifactSource(descriptor(bytes, { source: 'https', url }), fetchImpl)
      .copyTo(target, new AbortController().signal, vi.fn())).rejects.toThrow()
    await expectMissing(target)
  })

  it.each([undefined, 'not-a-number', '6', '8'])(
    'rejects missing, malformed, or mismatched content-length %s',
    async (declaredLength) => {
      const bytes = Buffer.from('archive')
      const url = 'https://downloads.example.test/component.tar.gz'
      const headers = declaredLength === undefined ? undefined : { 'content-length': declaredLength }
      const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200, headers }))
      const root = await temporaryRoot('arkdown-component-http-length-')
      const target = path.join(root, 'component.tar.gz')

      await expect(new HttpsArtifactSource(descriptor(bytes, { source: 'https', url }), fetchImpl)
        .copyTo(target, new AbortController().signal, vi.fn())).rejects.toThrow()
      await expectMissing(target)
    },
  )

  it('aborts a download and removes the partial target', async () => {
    const bytes = Buffer.alloc(128 * 1024, 0x41)
    const url = 'https://downloads.example.test/component.tar.gz'
    const fetchImpl = vi.fn(async () => new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.byteLength) },
    }))
    const root = await temporaryRoot('arkdown-component-http-abort-')
    const target = path.join(root, 'component.tar.gz')
    const controller = new AbortController()

    await expect(new HttpsArtifactSource(descriptor(bytes, { source: 'https', url }), fetchImpl)
      .copyTo(target, controller.signal, (progress) => {
        if (progress.receivedBytes > 0) controller.abort()
      })).rejects.toMatchObject({ name: 'AbortError' })
    await expectMissing(target)
  })
})
