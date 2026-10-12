// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { UpdateCache } from '../../src/main/updates/update-cache'
import { UpdateDownloadManager } from '../../src/main/updates/update-download'
import type { UpdateArtifact } from '../../src/main/updates/update-protocol'

const data = Buffer.from('a synthetic package, never executable')
const artifact: UpdateArtifact = { version: '1.0.5', channel: 'stable', edition: 'Full', kind: 'portable',
  filename: 'Arkdown.zip', url: 'https://download.cotax.tech/Arkdown.zip', bytes: data.length,
  sha256: createHash('sha256').update(data).digest('hex') }
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-download-test-')); roots.push(root); return new UpdateCache(root) }
it('streams, verifies, persists and revalidates before reusing a package', async () => {
  const cache = await setup(), progress: string[] = []
  const transport = vi.fn(async () => new Response(data))
  const manager = new UpdateDownloadManager(cache, transport, s => progress.push(s.phase))
  const file = await manager.start(artifact)
  expect(await readFile(file)).toEqual(data)
  expect(progress).toContain('verifying'); expect(progress.at(-1)).toBe('ready')
  expect(await cache.getVerified(artifact)).toBe(file)
  expect(await manager.start(artifact)).toBe(file); expect(transport).toHaveBeenCalledTimes(1)
  await writeFile(file, Buffer.alloc(data.length))
  expect(await cache.getVerified(artifact)).toBeUndefined()
})
it.each(['short', 'long', 'hash', 'content-length', 'status'])('rejects %s and never publishes ready', async failure => {
  const cache = await setup(), progress: string[] = []
  const body = failure === 'short' ? data.subarray(1) : failure === 'long' ? Buffer.concat([data, data]) : failure === 'hash' ? Buffer.alloc(data.length) : data
  const manager = new UpdateDownloadManager(cache, async () => new Response(body, { status: failure === 'status' ? 403 : 200,
    headers: failure === 'content-length' ? { 'content-length': '9999999' } : {} }), s => progress.push(s.phase))
  await expect(manager.start(artifact)).rejects.toThrow()
  expect(progress).not.toContain('ready'); expect(await cache.getVerified(artifact)).toBeUndefined()
})
it('follows an approved GitHub asset redirect without credentials', async () => {
  const cache = await setup()
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe('manual'); expect(init.credentials).toBe('omit')
    return url.startsWith('https://release-assets.') ? new Response(data) : new Response(null, { status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=synthetic' } })
  })
  const manager = new UpdateDownloadManager(cache, transport)
  await manager.start({ ...artifact, url: 'https://github.com/Lydiannnn/arkdown-releases/releases/download/v1.0.5/a.zip' })
  expect(transport).toHaveBeenCalledTimes(2)
})
it.each(['http://download.cotax.tech/p', 'https://evil.example/p', 'https://127.0.0.1/p', 'https://github.com/evil/repo/a',
  'https://release-assets.githubusercontent.com.evil.example/a', 'https://user:password@download.cotax.tech/p'])('rejects redirect %s', async location => {
  const cache = await setup(), transport = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
  await expect(new UpdateDownloadManager(cache, transport).start(artifact)).rejects.toThrow()
  expect(transport).toHaveBeenCalledTimes(1)
})
it('coalesces duplicate starts and cancellation removes only its own partial file', async () => {
  const cache = await setup(); await writeFile(path.join(cache.root, 'keep.txt'), 'keep')
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve })
  const transport = vi.fn(async (_url: string, init: RequestInit) => {
    started()
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(data.subarray(0, 4)); init.signal!.addEventListener('abort', () => controller.error(new Error('abort')), { once: true })
    } }))
  })
  const manager = new UpdateDownloadManager(cache, transport)
  const first = manager.start(artifact), second = manager.start(artifact)
  const results = Promise.allSettled([first, second]); await ready; await manager.cancel()
  expect((await results).every(x => x.status === 'rejected')).toBe(true)
  expect(transport).toHaveBeenCalledTimes(1)
  expect(await readdir(cache.root)).toEqual(['keep.txt'])
})
