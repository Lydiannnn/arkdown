import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, expect, it } from 'vitest'
import { packageScreenTranslationComponent, packageScreenTranslationThirdPartySources } from '../../scripts/package-screen-translation-component'

const roots: string[] = []
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-engine-artifact-')); roots.push(root)
  const runtime = path.join(root, '.components/screen-translation/runtime/ArkTranslateEngine')
  const files = new Map([
    ['ArkTranslateEngine.exe', 'synthetic engine'],
    ['_internal/python312.dll', 'synthetic python'],
    ['_internal/models/model.onnx', 'identical model'],
    ['_internal/rapidocr/models/model.onnx', 'identical model'],
    ['_internal/rapidocr/models/.gitkeep', ''],
    ['_internal/rapidocr/config.yaml', 'model_root_dir: models'],
    ['_internal/cv2/opencv_videoio_ffmpeg500_64.dll', 'optional video plugin'],
    ['licenses/Python-LICENSE.txt', 'synthetic license'],
  ])
  const records: { path: string; bytes: number; sha256: string }[] = []
  for (const [name, data] of files) {
    await mkdir(path.dirname(path.join(runtime, name)), { recursive: true })
    await writeFile(path.join(runtime, name), data)
    records.push({ path: 'runtime/ArkTranslateEngine/'+name, bytes: Buffer.byteLength(data), sha256: digest(data) })
  }
  await mkdir(path.join(root, 'components/screen-translation'), { recursive: true })
  const saveManifest = () => writeFile(path.join(root, 'components/screen-translation/manifest.json'), JSON.stringify({ protocol: 2, files: records }))
  await saveManifest()
  return { root, runtime, files, records, saveManifest }
}

it('creates a deterministic HTTPS artifact with only hash-identical redundant models removed and a complete inventory', async () => {
  const t = await fixture()
  // Stray files must never enter a public artifact.
  await writeFile(path.join(t.runtime, 'private-credentials.json'), 'must not ship')
  const first = await packageScreenTranslationComponent({ repoRoot: t.root })
  const second = await packageScreenTranslationComponent({ repoRoot: t.root, outputDirectory: path.join(t.root, 'second') })
  expect(first.descriptor).toEqual(second.descriptor)
  const bytes = await readFile(first.archivePath)
  expect(first.descriptor.bytes).toBe(bytes.length)
  expect(first.descriptor.sha256).toBe(digest(bytes))
  expect(first.descriptor.source).toBe('https')
  expect(first.descriptor.url).toBe('https://github.com/Lydiannnn/arkdown-releases/releases/download/screen-translation-engine-1.0.0/arkdown-screen-translation-engine-1.0.0-win-x64.tar.gz')
  expect(JSON.parse(await readFile(first.manifestPath, 'utf8'))).toEqual(first.descriptor)
  const extracted = path.join(t.root, 'extracted'); await mkdir(extracted)
  await tar.x({ file: first.archivePath, cwd: extracted })
  const manifest = JSON.parse(await readFile(path.join(extracted, 'component-manifest.json'), 'utf8'))
  expect(first.treeManifestSha256).toBe(digest(await readFile(path.join(extracted, 'component-manifest.json'))))
  expect(manifest).toMatchObject({ schemaVersion: 1, version: '1.0.0', entry: 'ArkTranslateEngine.exe' })
  expect(manifest.files).toHaveLength(5)
  for (const entry of manifest.files) {
    const payload = await readFile(path.join(extracted, entry.path))
    expect(entry.bytes).toBe(payload.length)
    expect(entry.sha256).toBe(digest(payload))
  }
  expect(await readFile(path.join(extracted, '_internal/models/model.onnx'), 'utf8')).toBe('identical model')
  await expect(access(path.join(extracted, '_internal/rapidocr/models/model.onnx'))).rejects.toThrow()
  await expect(access(path.join(extracted, 'private-credentials.json'))).rejects.toThrow()
  await expect(access(path.join(extracted, '_internal/cv2/opencv_videoio_ffmpeg500_64.dll'))).rejects.toThrow()
  expect(await readFile(path.join(t.runtime, '_internal/rapidocr/models/model.onnx'), 'utf8')).toBe('identical model')
})

it('refuses to remove a rapidocr model whose retained counterpart is not identical', async () => {
  const t = await fixture()
  const data = 'different model'
  await writeFile(path.join(t.runtime, '_internal/rapidocr/models/model.onnx'), data)
  Object.assign(t.records.find(file => file.path.endsWith('rapidocr/models/model.onnx'))!, { bytes: Buffer.byteLength(data), sha256: digest(data) })
  await t.saveManifest()
  await expect(packageScreenTranslationComponent({ repoRoot: t.root })).rejects.toThrow('Redundant model does not match')
})

it('rejects corrupted pinned runtime files before creating public release assets', async () => {
  const t = await fixture()
  await writeFile(path.join(t.runtime, '_internal/python312.dll'), 'tampered runtime')
  await expect(packageScreenTranslationComponent({ repoRoot: t.root })).rejects.toThrow('Screen translation resource mismatch')
  await expect(access(path.join(t.root, '.components/public-screen-translation-release'))).rejects.toThrow()
})

it('publishes only licensed third-party sources and notices, without application source or local extras', async () => {
  const t = await fixture()
  const source = path.join(t.root, 'geos-source.tar.bz2')
  await writeFile(source, 'synthetic upstream source')
  const releaseDocs = path.join(t.root, 'components/screen-translation/release')
  await mkdir(releaseDocs)
  await writeFile(path.join(releaseDocs, 'README.md'), 'public readme')
  await writeFile(path.join(releaseDocs, 'THIRD_PARTY_NOTICES.md'), 'public notices')
  await writeFile(path.join(releaseDocs, 'private-notes.md'), 'must never publish')
  const result = await packageScreenTranslationThirdPartySources({ repoRoot: t.root,
    sourceArchive: { path: source, sha256: digest('synthetic upstream source') } })
  const entries: string[] = []
  await tar.t({ file: result.archivePath, onReadEntry: entry => { entries.push(entry.path) } })
  expect(entries.sort()).toEqual(['geos-3.13.1.tar.bz2', 'licenses/Python-LICENSE.txt'])
  expect(await readFile(path.join(path.dirname(result.archivePath), 'README.md'), 'utf8')).toBe('public readme')
  await expect(access(path.join(path.dirname(result.archivePath), 'private-notes.md'))).rejects.toThrow()
  await writeFile(source, 'tampered source')
  await expect(packageScreenTranslationThirdPartySources({ repoRoot: t.root,
    sourceArchive: { path: source, sha256: digest('synthetic upstream source') } })).rejects.toThrow('Third-party source hash mismatch')
})
