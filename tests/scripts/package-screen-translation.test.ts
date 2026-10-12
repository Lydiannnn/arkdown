import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyScreenTranslationToPackages, verifyScreenTranslationRuntime } from '../../scripts/package-screen-translation'

interface FileRecord { path: string; bytes: number; sha256: string }
const roots: string[] = []
const prefix = 'runtime/ArkTranslateEngine/'
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function write(filename: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, bytes)
}
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-screen-package-test-'))
  roots.push(root); return root
}
afterEach(async () => {
  // Each target is the exact absolute directory returned by mkdtemp above.
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await temporaryRoot()
  const component = path.join(root, 'components/screen-translation')
  const runtimeRoot = path.join(root, '.components/screen-translation/runtime/ArkTranslateEngine')
  const helperRoot = path.join(root, '.native-cache/screen-translation')
  const runtime = new Map([
    ['ArkTranslateEngine.exe', Buffer.from([77, 90, 0, 255, 1])],
    ['_internal/python312.dll', Buffer.from([77, 90, 2, 254, 3])],
    ['_internal/models/PP-OCRv6_det_small.onnx', Buffer.from([8, 1, 18, 3])],
    ['licenses/Python-LICENSE.txt', Buffer.from('Synthetic Python license\r\n', 'utf8')],
    ['licenses/RapidOCR-LICENSE.txt', Buffer.from('Synthetic OCR license\n', 'utf8')],
  ])
  const helpers = new Map([
    ['Arkdown.ScreenTranslation.exe', Buffer.from([77, 90, 4, 253])],
    ['Arkdown.ScreenTranslation.exe.config', Buffer.from('<configuration>合成测试</configuration>\n', 'utf8')],
  ])
  const source = Buffer.from('print("synthetic OCR worker")\n', 'utf8')
  const files: FileRecord[] = [{ path: 'engine/worker.py', bytes: source.length, sha256: digest(source) }]
  await write(path.join(component, 'engine/worker.py'), source)
  for (const [relative, bytes] of runtime) {
    await write(path.join(runtimeRoot, relative), bytes)
    files.push({ path: prefix + relative, bytes: bytes.length, sha256: digest(bytes) })
  }
  for (const [relative, bytes] of helpers) await write(path.join(helperRoot, relative), bytes)
  const saveManifest = () => write(path.join(component, 'manifest.json'), JSON.stringify({ protocol: 2, files }))
  await saveManifest()
  const output = async (name: string, markers: 'both' | 'executable' | 'resources' = 'both') => {
    const directory = path.join(root, name); await mkdir(directory, { recursive: true })
    if (markers !== 'resources') await write(path.join(directory, 'Arkdown.exe'), 'synthetic application')
    if (markers !== 'executable') await mkdir(path.join(directory, 'resources'))
    return directory
  }
  return { root, component, runtimeRoot, helperRoot, runtime, helpers, files, saveManifest, output }
}

describe('screen translation component packaging', () => {
  it('ships only native helpers and the pinned HTTPS descriptor to each output', async () => {
    const t = await fixture()
    expect(await verifyScreenTranslationRuntime(t.root)).toEqual(t.files.filter(file => file.path.startsWith(prefix)))
    const outputs = [await t.output('package-a'), await t.output('package-b')]
    await copyScreenTranslationToPackages(outputs, t.root)
    for (const output of outputs) {
      const target = path.join(output, 'resources/screen-translation')
      expect((await readdir(target)).sort()).toEqual(['Arkdown.ScreenTranslation.exe', 'Arkdown.ScreenTranslation.exe.config', 'manifest.json'].sort())
      for (const [relative, original] of t.helpers) expect(await readFile(path.join(target, relative))).toEqual(original)
      const descriptor = JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'))
      expect(descriptor.source).toBe('https')
      expect(new URL(descriptor.url).hostname).toBe('github.com')
      expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(descriptor.bytes).toBeGreaterThan(0)
      await expect(access(path.join(target, 'engine'))).rejects.toThrow()
    }
  })

  it('packages without the optional developer runtime cache', async () => {
    const t = await fixture(); const output = await t.output('package')
    await rm(t.runtimeRoot, { recursive: true })
    await copyScreenTranslationToPackages([output], t.root)
    expect((await readdir(path.join(output, 'resources/screen-translation'))).length).toBe(3)
  })

  it('replaces stale bundled engines when repackaging', async () => {
    const t = await fixture(); const output = await t.output('package')
    await write(path.join(output, 'resources/screen-translation/engine/obsolete.dll'), 'old engine')
    await copyScreenTranslationToPackages([output], t.root)
    await expect(access(path.join(output, 'resources/screen-translation/engine'))).rejects.toThrow()
  })

  it('rejects equal-size tampering by hash, not only by byte count', async () => {
    const t = await fixture()
    const bytes = Buffer.from(t.runtime.get('_internal/python312.dll')!); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1
    await write(path.join(t.runtimeRoot, '_internal/python312.dll'), bytes)
    await expect(verifyScreenTranslationRuntime(t.root)).rejects.toThrow('Screen translation resource mismatch')
  })

  it('rejects a manifest byte count mismatch even when the hash is correct', async () => {
    const t = await fixture(); t.files.find(file => file.path === prefix + 'ArkTranslateEngine.exe')!.bytes += 1
    await t.saveManifest()
    await expect(verifyScreenTranslationRuntime(t.root)).rejects.toThrow('Screen translation resource mismatch')
  })

  it('rejects changed source even when the frozen runtime hashes still match', async () => {
    const t = await fixture(); await write(path.join(t.component, 'engine/worker.py'), 'changed source')
    await expect(verifyScreenTranslationRuntime(t.root)).rejects.toThrow('Screen translation source changed')
  })

  it('rejects a manifest without the engine executable', async () => {
    const t = await fixture(); t.files.splice(t.files.findIndex(file => file.path === prefix + 'ArkTranslateEngine.exe'), 1)
    await t.saveManifest()
    await expect(verifyScreenTranslationRuntime(t.root)).rejects.toThrow('Screen translation engine missing')
  })

  it.each(['../outside.bin', '_internal/../../outside.bin', '_internal\\..\\..\\outside.bin', '/absolute.bin', '_internal//empty.bin'])(
    'rejects the runtime traversal or noncanonical path %s', async relative => {
      const t = await fixture()
      t.files.push({ path: prefix + relative, bytes: 1, sha256: digest(Buffer.from('x')) })
      await t.saveManifest()
      await expect(verifyScreenTranslationRuntime(t.root)).rejects.toThrow('Invalid screen translation resource path')
    },
  )

  it('rejects traversal in source manifest entries instead of trusting a matching outside file', async () => {
    const t = await fixture(); const outside = Buffer.from('controlled file outside the source directory')
    await write(path.join(t.component, '..', 'outside.py'), outside)
    t.files.push({ path: 'engine/../../outside.py', bytes: outside.length, sha256: digest(outside) })
    await t.saveManifest()
    await expect(verifyScreenTranslationRuntime(t.root)).rejects.toThrow()
  })

  it.each(['executable', 'resources'] as const)('rejects an output containing only the %s marker', async markers => {
    const t = await fixture(); const output = await t.output('invalid-package', markers)
    await expect(copyScreenTranslationToPackages([output], t.root)).rejects.toThrow('Invalid Arkdown package output')
    await expect(access(path.join(output, 'resources/screen-translation'))).rejects.toThrow()
  })

  it.each(['Arkdown.ScreenTranslation.exe', 'Arkdown.ScreenTranslation.exe.config'])('rejects a missing helper resource %s', async name => {
    const t = await fixture(); const output = await t.output('package')
    await rm(path.join(t.helperRoot, name))
    await expect(copyScreenTranslationToPackages([output], t.root)).rejects.toThrow()
  })
})
