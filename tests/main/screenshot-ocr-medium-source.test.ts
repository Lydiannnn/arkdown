// @vitest-environment node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import { createGitHubMediumPreparer } from '../../src/main/screenshot-translation/screenshot-ocr-medium-source'

const roots: string[] = []
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

async function fixture(extra = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-medium-source-'))
  roots.push(root)
  const payload = path.join(root, 'payload')
  const staging = path.join(root, 'staging')
  await mkdir(path.join(payload, 'licenses'), { recursive: true })
  await mkdir(staging)
  const files = ['medium-det.tar', 'medium-rec.tar', 'manifest.json', 'licenses/PaddleOCR-LICENSE.txt']
  for (const name of files) await writeFile(path.join(payload, name), name)
  const tree = Buffer.from(JSON.stringify({ schemaVersion: 1, version: '6.0.0', entry: 'medium-det.tar',
    files: files.map((name) => ({ path: name, bytes: Buffer.byteLength(name), sha256: hash(Buffer.from(name)) })) }))
  await writeFile(path.join(payload, 'component-manifest.json'), tree)
  if (extra) { files.push('unlisted.exe'); await writeFile(path.join(payload, 'unlisted.exe'), 'untrusted') }
  const archive = path.join(root, 'medium.tar.gz')
  await tar.c({ cwd: payload, file: archive, gzip: true, portable: true }, [...files, 'component-manifest.json'])
  const bytes = await readFile(archive)
  const descriptor = { source: 'https' as const, version: '6.0.0', archiveName: 'medium.tar.gz', bytes: bytes.length,
    sha256: hash(bytes), url: 'https://github.com/Lydiannnn/arkdown-releases/releases/download/ocr-medium-6.0.0-win-x64/medium.tar.gz' }
  return { root, staging, archive, descriptor, treeManifestSha256: hash(tree),
    artifactSource: { kind: 'https' as const, copyTo: async (target: string) => { await copyFile(archive, target) } } }
}

it('prepares only the two archives after authenticating the archive and every tree entry', async () => {
  const h = await fixture()
  await createGitHubMediumPreparer(h)(h.staging, new AbortController().signal, () => undefined)
  expect((await readdir(h.staging)).sort()).toEqual(['medium-det.tar', 'medium-rec.tar'])
  expect(await readFile(path.join(h.staging, 'medium-det.tar'), 'utf8')).toBe('medium-det.tar')
  expect((await readdir(h.root)).filter((name) => name.startsWith('.medium-source-'))).toEqual([])
})

it('uses the production GitHub source to verify the remote manifest before fetching its archive', async () => {
  const h = await fixture()
  const bytes = await readFile(h.archive)
  const fetch = vi.fn(async (url: string) => url.endsWith('/manifest.json')
    ? new Response(JSON.stringify(h.descriptor))
    : new Response(bytes, { headers: { 'content-length': String(bytes.length) } }))
  vi.stubGlobal('fetch', fetch)
  await createGitHubMediumPreparer({ descriptor: h.descriptor, treeManifestSha256: h.treeManifestSha256 })(h.staging, new AbortController().signal, () => undefined)
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    h.descriptor.url.replace(/medium\.tar\.gz$/u, 'manifest.json'), h.descriptor.url,
  ])
  expect((await readdir(h.staging)).sort()).toEqual(['medium-det.tar', 'medium-rec.tar'])
})

it('rejects an unexpected archive file even with a matching archive digest', async () => {
  const h = await fixture(true)
  await expect(createGitHubMediumPreparer(h)(h.staging, new AbortController().signal, () => undefined)).rejects.toThrow('OCR_MODEL_DOWNLOAD_FAILED')
  expect(await readdir(h.staging)).toEqual([])
})

it('does not accept a tampered tree or retain private download files after cancellation', async () => {
  const h = await fixture()
  await expect(createGitHubMediumPreparer({ ...h, treeManifestSha256: '0'.repeat(64) })(h.staging, new AbortController().signal, () => undefined)).rejects.toThrow('OCR_MODEL_DOWNLOAD_FAILED')
  const controller = new AbortController()
  const preparer = createGitHubMediumPreparer({ ...h, artifactSource: { kind: 'https', copyTo: async () => { controller.abort() } } })
  await expect(preparer(h.staging, controller.signal, () => undefined)).rejects.toThrow()
  expect(await readdir(h.staging)).toEqual([])
  expect((await readdir(h.root)).filter((name) => name.startsWith('.medium-source-'))).toEqual([])
})
