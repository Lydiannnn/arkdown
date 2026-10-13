// @vitest-environment node
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CosComponentArtifactSource } from '../../src/main/document-conversion/component-artifact-source'
import type { DocumentConversionComponentDescriptor } from '../../src/shared/document-conversion'
import { RUNTIME_COMPONENT_DEFINITIONS } from '../../src/shared/optional-component-catalog'
import { DOCUMENT_CONVERSION_COMPONENT_MANIFEST, DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256 } from '../../src/shared/document-conversion-component-manifest'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR, SCREEN_TRANSLATION_COMPONENT_TREE_SHA256 } from '../../src/shared/screen-translation-component-manifest'
import { SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR, SCREENSHOT_OCR_MEDIUM_COMPONENT_TREE_SHA256 } from '../../src/shared/screenshot-ocr-medium-component-manifest'

const origin = 'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com'
const base = `${origin}/components/test-1/`
const bytes = Buffer.from('pinned COS archive')
const pinned: DocumentConversionComponentDescriptor = { source: 'https', version: 'test-1', archiveName: 'component.tar.gz', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), url: `${base}component.tar.gz` }
const roots: string[] = []
async function target() { const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-cos-source-')); roots.push(root); return path.join(root, 'archive') }
const manifest = (value: unknown = pinned) => new Response(JSON.stringify(value))
const archive = (value = bytes, length: string | null = String(bytes.length)) => new Response(value, { headers: length === null ? {} : { 'content-length': length } })
async function missing(file: string) { await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' }) }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('COS component source', () => {
  it('downloads a pinned manifest and archive directly with manual redirects', async () => {
    const calls: string[] = []
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push(url); expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) })
      return url.endsWith('manifest.json') ? manifest() : archive()
    }
    const file = await target()
    await new CosComponentArtifactSource(pinned, base, fetchImpl).copyTo(file, new AbortController().signal, () => undefined)
    expect(await readFile(file)).toEqual(bytes)
    expect(calls).toEqual([`${base}manifest.json`, pinned.url])
  })

  it.each([
    'https://evil.test/components/test-1/',
    'https://arkdown-downloads-1257382433.cos.ap-guangzhou.myqcloud.com.evil.test/components/test-1/',
    `${origin}/releases/test-1/`, `${origin}/components/`, `${origin}/components/a/b/`,
    `${origin}/components/%74est-1/`, `${origin}/components/test-1/?query=1`, `${origin}/components/test-1/#fragment`,
    `${origin}:443/components/test-1/`, `${origin.replace('https://', 'https://user@')}/components/test-1/`,
  ])('rejects an untrusted base without making a request: %s', async untrusted => {
    const fetchImpl = vi.fn(async () => archive())
    const file = await target()
    await expect(new CosComponentArtifactSource({ ...pinned, url: `${untrusted}component.tar.gz` }, untrusted, fetchImpl)
      .copyTo(file, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled(); await missing(file)
  })

  it.each([`${origin}/components/other/component.tar.gz`, `${base}nested/component.tar.gz`, `${base}component.tar.gz?token=1`,
    'https://github.com/Lydiannnn/arkdown-releases/releases/download/test-1/component.tar.gz'])('rejects a descriptor outside its exact pinned object: %s', async url => {
    const fetchImpl = vi.fn(async () => archive()); const file = await target()
    await expect(new CosComponentArtifactSource({ ...pinned, url }, base, fetchImpl).copyTo(file, new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled(); await missing(file)
  })

  it.each(['component.tar.gz?token=1', 'component%2Farchive.tar.gz'])('rejects archive names that encode a query or extra object path: %s', async archiveName => {
    const file = await target(); const fetchImpl = vi.fn(async () => manifest())
    await expect(new CosComponentArtifactSource({ ...pinned, archiveName, url: `${base}${archiveName}` }, base, fetchImpl)
      .copyTo(file, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    expect(fetchImpl).not.toHaveBeenCalled(); await missing(file)
  })

  it.each(['manifest', 'archive'])('rejects and cancels a %s redirect without requesting its target', async phase => {
    const cancel = vi.fn(); const calls: string[] = []; const file = await target()
    const source = new CosComponentArtifactSource(pinned, base, async url => {
      calls.push(url)
      if (phase === 'archive' && url.endsWith('manifest.json')) return manifest()
      return new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: pinned.url! } })
    })
    await expect(source.copyTo(file, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_DOWNLOAD_FAILED' })
    expect(calls).toHaveLength(phase === 'manifest' ? 1 : 2); expect(cancel).toHaveBeenCalledOnce(); await missing(file)
  })

  it.each(['redirected', 'wrong-url', 'partial-status'])('rejects a %s response and releases its body', async failure => {
    const cancel = vi.fn(); const file = await target()
    const response = new Response(new ReadableStream({ cancel }), { status: failure === 'partial-status' ? 206 : 200 })
    if (failure === 'redirected') Object.defineProperty(response, 'redirected', { value: true })
    if (failure === 'wrong-url') Object.defineProperty(response, 'url', { value: `${origin}/components/other/manifest.json` })
    await expect(new CosComponentArtifactSource(pinned, base, async () => response).copyTo(file, new AbortController().signal, () => undefined)).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce(); await missing(file)
  })

  it.each(['source', 'version', 'archiveName', 'bytes', 'sha256', 'url', 'extra'])('rejects manifest %s tampering before downloading', async key => {
    const fetchImpl = vi.fn(async () => manifest({ ...pinned, [key]: key === 'bytes' ? bytes.length + 1 : 'changed' })); const file = await target()
    await expect(new CosComponentArtifactSource(pinned, base, fetchImpl).copyTo(file, new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    expect(fetchImpl).toHaveBeenCalledOnce(); await missing(file)
  })

  it('limits streamed manifest bytes to 16 KiB and cancels the unread body', async () => {
    const cancel = vi.fn(); const file = await target()
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(16 * 1024 + 1)) }, cancel }))
    await expect(new CosComponentArtifactSource(pinned, base, async () => response).copyTo(file, new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    expect(cancel).toHaveBeenCalledOnce(); await missing(file)
  })

  it('accepts a UTF-8 BOM and a manifest exactly at the size limit', async () => {
    const file = await target(); const json = `\uFEFF${JSON.stringify(pinned)}`
    const body = json + ' '.repeat(16 * 1024 - Buffer.byteLength(json))
    await new CosComponentArtifactSource(pinned, base, async url => url.endsWith('manifest.json') ? new Response(body) : archive())
      .copyTo(file, new AbortController().signal, () => undefined)
    expect(await readFile(file)).toEqual(bytes)
  })

  it.each([null, '0', '01', String(bytes.length + 1)])('rejects archive Content-Length %s and cancels its body', async length => {
    const file = await target(); const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { headers: length === null ? {} : { 'content-length': length } })
    await expect(new CosComponentArtifactSource(pinned, base, async url => url.endsWith('manifest.json') ? manifest() : response)
      .copyTo(file, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    expect(cancel).toHaveBeenCalledOnce(); await missing(file)
  })

  it.each([Buffer.alloc(bytes.length), bytes.subarray(1), Buffer.concat([bytes, Buffer.from('extra')])])('removes corrupt or wrong-size downloaded data', async payload => {
    const file = await target()
    await expect(new CosComponentArtifactSource(pinned, base, async url => url.endsWith('manifest.json') ? manifest() : archive(payload))
      .copyTo(file, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
    await missing(file)
  })

  it('makes no request after pre-cancellation and preserves the abort error', async () => {
    const file = await target(); const controller = new AbortController(); controller.abort(); const fetchImpl = vi.fn(async () => manifest())
    await expect(new CosComponentArtifactSource(pinned, base, fetchImpl).copyTo(file, controller.signal, () => undefined)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchImpl).not.toHaveBeenCalled(); await missing(file)
  })

  it.each(['manifest', 'archive'])('cancels during %s streaming and removes partial data', async phase => {
    const file = await target(); const controller = new AbortController(); const cancel = vi.fn()
    const source = new CosComponentArtifactSource(pinned, base, async url => {
      if (url.endsWith('manifest.json')) return phase === 'manifest'
        ? new Response(new ReadableStream({ pull(stream) { stream.enqueue(Buffer.from('chunk')); controller.abort() }, cancel })) : manifest()
      return archive()
    })
    await expect(source.copyTo(file, controller.signal, progress => { if (phase === 'archive' && progress.receivedBytes) controller.abort() }))
      .rejects.toMatchObject({ name: 'AbortError' })
    if (phase === 'manifest') expect(cancel).toHaveBeenCalledOnce()
    await missing(file)
  })

  it.each(['mkdir', 'open', 'callback'])('releases the archive stream after a %s failure', async failure => {
    const file = await target(); const cancel = vi.fn(); await writeFile(file, 'preserve')
    const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(bytes.length) } })
    const destination = failure === 'mkdir' ? path.join(file, 'nested') : failure === 'open' ? file : `${file}-new`
    await expect(new CosComponentArtifactSource(pinned, base, async url => url.endsWith('manifest.json') ? manifest() : response)
      .copyTo(destination, new AbortController().signal, () => { throw new Error('observer failure') })).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce(); expect(await readFile(file, 'utf8')).toBe('preserve')
    if (failure !== 'open') await missing(destination)
  })

  it('reports offline download failure without trying another host', async () => {
    const file = await target(); const fetchImpl = vi.fn(async () => { throw new TypeError('offline') })
    await expect(new CosComponentArtifactSource(pinned, base, fetchImpl).copyTo(file, new AbortController().signal, () => undefined))
      .rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_DOWNLOAD_FAILED' })
    expect(fetchImpl).toHaveBeenCalledOnce(); await missing(file)
  })
})

const production = [
  ['pandoc', RUNTIME_COMPONENT_DEFINITIONS.pandoc.descriptor, RUNTIME_COMPONENT_DEFINITIONS.pandoc.treeManifestSha256, 'pandoc-3.10.1-r2-win-x64', 41_124_621, 'bcffd092628ba660766aa45cfde46041a15f34c408a1a9e660e5d187d3726849', '526dea6b7431aec7479f696a24ee0a0ac053f80610b4d436869282764a035ee5'],
  ['codex-cli', RUNTIME_COMPONENT_DEFINITIONS['codex-cli'].descriptor, RUNTIME_COMPONENT_DEFINITIONS['codex-cli'].treeManifestSha256, 'codex-cli-0.162.1-win-x64', 165_561_447, '687a4486ac386673440f77a68a68ec23430a8a44a55ed2fd2ffab40d3f3e1db3', '717c0db1cc94da352f3cc4ddb5ad3c98dc3eef268267bcf03aec458ac2ab0283'],
  ['ocr-base', RUNTIME_COMPONENT_DEFINITIONS['ocr-base'].descriptor, RUNTIME_COMPONENT_DEFINITIONS['ocr-base'].treeManifestSha256, 'ocr-base-1.0.0-win-x64', 35_849_651, '0b9e75ddcfb7bf5465578f6e4fc99ffdcb6f13c9f1a8eaec9c688d5ba678d26f', '23d32aeadf23b12fdc2f267fc9bd45ef0b70cdd990585d2eff344c4d4731c985'],
  ['markitdown', DOCUMENT_CONVERSION_COMPONENT_MANIFEST, DOCUMENT_CONVERSION_COMPONENT_TREE_SHA256, 'markitdown-0.1.7-py3.12.10', 75_859_983, 'd375e42d98cdecdce653b35f2e94a97a0844cf872da0b1fb629eff9c5bd2edec', 'f3a1dc705f8c76a5fab3d06c9b945ae43a826faab8ae5039759b0f200b979028'],
  ['screen-translation', SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR, SCREEN_TRANSLATION_COMPONENT_TREE_SHA256, 'screen-translation-engine-1.0.0', 108_063_168, '7feff5127df97869e3752130251f58e25be6cd391b57bceeeffbc8f6196d65c7', 'b6c267858992f6fd72e67ed4865f5d22fb6a9c3fc32a9b71813407b3d1dd5cd2'],
  ['ocr-medium', SCREENSHOT_OCR_MEDIUM_COMPONENT_DESCRIPTOR, SCREENSHOT_OCR_MEDIUM_COMPONENT_TREE_SHA256, 'ocr-medium-6.0.0-win-x64', 99_939_102, 'f78616bcb5ad5d08813382606e1767e0765a08cff6cff651cb263a01992bc105', 'aa2518ff96ffea5e3bbd01f5584f05466fa60b20558ffe359afee379029ecf10'],
] as const

it.each(production)('%s downloads only its COS component path and preserves published payload pins', async (_id, descriptor, tree, tag, count, hash, treeHash) => {
  const versions = { pandoc: '3.10.1-r2', 'codex-cli': '0.162.1', 'ocr-base': '1.0.0', markitdown: '0.1.7-py3.12.10', 'screen-translation': '1.0.0', 'ocr-medium': '6.0.0' }
  expect(descriptor.version).toBe(versions[_id])
  expect(descriptor.archiveName).toBe(`arkdown-${tag}${tag.endsWith('win-x64') ? '' : '-win-x64'}.tar.gz`)
  expect(descriptor).toMatchObject({ source: 'https', bytes: count, sha256: hash, url: `${origin}/components/${tag}/${descriptor.archiveName}` })
  expect(tree).toBe(treeHash)
  const calls: string[] = []; const file = await target()
  // An invalid length stops before writing a large production archive; a successful manifest fetch proves URL equality too.
  const source = new CosComponentArtifactSource(descriptor, `${origin}/components/${tag}/`, async url => {
    calls.push(url); return url.endsWith('manifest.json') ? manifest(descriptor) : archive(bytes, '0')
  })
  await expect(source.copyTo(file, new AbortController().signal, () => undefined)).rejects.toMatchObject({ code: 'DOCUMENT_CONVERSION_COMPONENT_INVALID' })
  expect(calls).toEqual([`${origin}/components/${tag}/manifest.json`, `${origin}/components/${tag}/${descriptor.archiveName}`]); await missing(file)
})
