import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCREENSHOT_OCR_PROTOCOL,
  SCREENSHOT_OCR_RESOURCE_URLS,
  createScreenshotOcrResourceResolver,
  createScreenshotOcrProtocolHandler,
  registerScreenshotOcrScheme,
} from '../../src/main/screenshot-translation/screenshot-ocr-resources'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function fixture() {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), 'arkdown-ocr-resource-'))
  roots.push(resourcesPath)
  const root = path.join(resourcesPath, 'screenshot-ocr')
  await mkdir(path.join(root, 'ort'), { recursive: true })
  const artifacts = [
    ['small-det.tar', new Uint8Array([1, 2, 3])],
    ['small-rec.tar', new Uint8Array([4, 5])],
    ['ort/ort-wasm-simd-threaded.jsep.mjs', new TextEncoder().encode('export default 1')],
    ['ort/ort-wasm-simd-threaded.jsep.wasm', new Uint8Array([0, 97, 115, 109])],
  ] as const
  for (const [name, bytes] of artifacts) await writeFile(path.join(root, ...name.split('/')), bytes)
  const manifest = {
    release: 'test',
    artifacts: artifacts.map(([name, bytes]) => ({
      source: name,
      name,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })),
  }
  const resolver = createScreenshotOcrResourceResolver({ resourcesPath, manifest })
  return { resourcesPath, root, manifest, resolve: resolver.resolve }
}

describe('screenshot OCR local resources', () => {
  it('treats a missing verified Lite component as unavailable without bundled fallback', async () => {
    const h = await fixture()
    const resolveBaseRoot = vi.fn(async () => undefined)
    const handler = createScreenshotOcrProtocolHandler({ ...h, resolveBaseRoot })
    expect((await handler({ url: SCREENSHOT_OCR_RESOURCE_URLS.smallDetection })).status).toBe(404)
    expect(resolveBaseRoot).toHaveBeenCalledOnce()
  })

  it('serves the external worker only from the verified component root', async () => {
    const h = await fixture()
    await writeFile(path.join(h.root, 'worker.js'), 'export const ready = true')
    const resolver = createScreenshotOcrResourceResolver({ ...h, resolveBaseRoot: async () => h.root })
    expect((await resolver.resolve('arkdown-ocr://bundle/worker.js')).contentType).toBe('text/javascript; charset=utf-8')
    await expect(h.resolve('arkdown-ocr://bundle/worker.js')).rejects.toThrow('OCR_RESOURCE_UNAVAILABLE')
    await expect(resolver.resolve('arkdown-ocr://bundle/other.js')).rejects.toThrow('OCR_RESOURCE_UNAVAILABLE')
    await expect(resolver.resolve(SCREENSHOT_OCR_RESOURCE_URLS.smallDetection)).resolves.toHaveProperty('bytes')
  })

  it('registers one fixed secure standard fetch-capable scheme and publishes fixed URLs', () => {
    const protocol = { registerSchemesAsPrivileged: vi.fn() }
    registerScreenshotOcrScheme(protocol)
    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([{
      scheme: SCREENSHOT_OCR_PROTOCOL,
      privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    }])
    expect(SCREENSHOT_OCR_RESOURCE_URLS).toEqual({
      smallDetection: 'arkdown-ocr://bundle/small-det.tar',
      smallRecognition: 'arkdown-ocr://bundle/small-rec.tar',
      mediumDetection: 'arkdown-ocr://bundle/medium-det.tar',
      mediumRecognition: 'arkdown-ocr://bundle/medium-rec.tar',
      ortPrefix: 'arkdown-ocr://bundle/ort/',
    })
  })

  it('serves Medium only through an independently audited active resolver and never an arbitrary user-data path', async () => {
    const h = await fixture()
    const medium = vi.fn(async (name: string) => name === 'medium-det.tar'
      ? { bytes: new Uint8Array([8, 9]), contentType: 'application/x-tar' }
      : undefined)
    const resolver = createScreenshotOcrResourceResolver({
      resourcesPath: h.resourcesPath, manifest: h.manifest, resolveActiveMedium: medium,
    })
    await expect(resolver.resolve(SCREENSHOT_OCR_RESOURCE_URLS.mediumDetection)).resolves.toEqual({
      bytes: new Uint8Array([8, 9]), contentType: 'application/x-tar',
    })
    await expect(resolver.resolve(SCREENSHOT_OCR_RESOURCE_URLS.mediumRecognition)).rejects.toThrow('OCR_RESOURCE_UNAVAILABLE')
    expect(medium.mock.calls).toEqual([['medium-det.tar'], ['medium-rec.tar']])
  })

  it('serves only an exact manifest file after identity verification', async () => {
    const h = await fixture()
    const response = await h.resolve(SCREENSHOT_OCR_RESOURCE_URLS.smallDetection)
    expect(response).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: 'application/x-tar' })
  })

  it('builds a fixed no-store response without exposing the resource URL', async () => {
    const h = await fixture()
    const handler = createScreenshotOcrProtocolHandler({ resourcesPath: h.resourcesPath, manifest: h.manifest })
    const response = await handler({ url: SCREENSHOT_OCR_RESOURCE_URLS.smallDetection })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/x-tar')
    expect(response.headers.get('content-length')).toBe('3')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    await expect(response.arrayBuffer()).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer)

    const unavailable = await handler({ url: 'arkdown-ocr://bundle/not-listed.wasm' })
    expect(unavailable.status).toBe(404)
    expect(unavailable.headers.get('content-type')).toBe('application/octet-stream')
    expect(unavailable.headers.get('content-length')).toBe('0')
    expect(unavailable.headers.get('cache-control')).toBe('no-store')
    expect(unavailable.headers.get('access-control-allow-origin')).toBe('*')
    expect(unavailable.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    await expect(unavailable.arrayBuffer()).resolves.toHaveProperty('byteLength', 0)
  })

  it.each([
    'arkdown-ocr://bundle/SMALL-det.tar',
    'arkdown-ocr://bundle/small-det.tar?x=1',
    'arkdown-ocr://bundle/small-det.tar#x',
    'arkdown-ocr://bundle/%73mall-det.tar',
    'arkdown-ocr://bundle/../small-det.tar',
    'arkdown-ocr://other/small-det.tar',
    'https://bundle/small-det.tar',
    'arkdown-ocr://bundle/ort/',
  ])('rejects ambiguous or unlisted URL %s', async (url) => {
    const h = await fixture()
    await expect(h.resolve(url)).rejects.toThrow('OCR_RESOURCE_UNAVAILABLE')
  })

  it('rejects a link, non-file, wrong size, and wrong digest without disclosing a path', async () => {
    const linked = await fixture()
    const linkedDirectory = await mkdtemp(path.join(tmpdir(), 'arkdown-ocr-linked-'))
    roots.push(linkedDirectory)
    await writeFile(path.join(linkedDirectory, 'ort-wasm-simd-threaded.jsep.mjs'), 'export default 1')
    await rm(path.join(linked.root, 'ort'), { recursive: true })
    await symlink(linkedDirectory, path.join(linked.root, 'ort'), 'junction')
    await expect(linked.resolve(`${SCREENSHOT_OCR_RESOURCE_URLS.ortPrefix}ort-wasm-simd-threaded.jsep.mjs`))
      .rejects.toThrow('OCR_RESOURCE_UNAVAILABLE')

    const directory = await fixture()
    await rm(path.join(directory.root, 'small-det.tar'))
    await mkdir(path.join(directory.root, 'small-det.tar'))
    await expect(directory.resolve(SCREENSHOT_OCR_RESOURCE_URLS.smallDetection)).rejects.toThrow('OCR_RESOURCE_UNAVAILABLE')

    const size = await fixture()
    await writeFile(path.join(size.root, 'small-det.tar'), new Uint8Array([1, 2]))
    await expect(size.resolve(SCREENSHOT_OCR_RESOURCE_URLS.smallDetection)).rejects.toThrow('OCR_RESOURCE_UNAVAILABLE')

    const digest = await fixture()
    await writeFile(path.join(digest.root, 'small-det.tar'), new Uint8Array([3, 2, 1]))
    let error: unknown
    try { await digest.resolve(SCREENSHOT_OCR_RESOURCE_URLS.smallDetection) } catch (caught) { error = caught }
    expect(String(error)).toBe('Error: OCR_RESOURCE_UNAVAILABLE')
    expect(String(error)).not.toContain(digest.resourcesPath)
  })
})
