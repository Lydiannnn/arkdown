import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditScreenTranslationResources } from '../../scripts/audit-screen-translation-package'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR } from '../../src/shared/screen-translation-component-manifest'

const roots: string[] = []
const prefix = path.join(os.tmpdir(), 'arkdown-screen-package-audit-')
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(prefix)) throw new Error('Invalid fixture cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})
const digest = (data: string) => createHash('sha256').update(data).digest('hex')
const engineFile = 'Arkdown.ScreenTranslation.exe'
async function fixture() {
  const root = await mkdtemp(prefix); roots.push(root)
  const repoRoot = path.join(root, 'source'), packageRoot = path.join(root, 'package')
  const resources = path.join(packageRoot, 'resources', 'screen-translation')
  const files = ['ArkTranslateEngine.exe', '_internal/model.onnx'].map(name => ({
    path: 'runtime/ArkTranslateEngine/'+name, bytes: Buffer.byteLength(name), sha256: digest(name),
  }))
  const manifest = { ...SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR }
  const put = async (target: string, data: string) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data) }
  await put(path.join(repoRoot, 'components/screen-translation/manifest.json'), JSON.stringify(manifest))
  await put(path.join(resources, 'manifest.json'), JSON.stringify(manifest))
  for (const name of ['Arkdown.ScreenTranslation.exe', 'Arkdown.ScreenTranslation.exe.config']) {
    await put(path.join(repoRoot, '.native-cache/screen-translation', name), name)
    await put(path.join(resources, name), name)
  }
  return { root, repoRoot, packageRoot, resources, manifest, put, audit: () => auditScreenTranslationResources(packageRoot, repoRoot) }
}

describe('screen translation packaged inventory', () => {
  it('approves exactly the native helpers and pinned download descriptor with no engine cache', async () => {
    const state = await fixture(), report = await state.audit()
    expect(report.findings).toEqual([])
    expect([...report.approvedEntries.keys()].sort()).toEqual([
      'resources/screen-translation',
      'resources/screen-translation/Arkdown.ScreenTranslation.exe',
      'resources/screen-translation/Arkdown.ScreenTranslation.exe.config',
      'resources/screen-translation/manifest.json',
    ].sort())
  })
  it.each(['engine', 'native', 'manifest', 'missing', 'extra', 'extra-directory'])('rejects %s tampering without approving the asset', async kind => {
    const state = await fixture()
    const target = kind === 'native' ? 'Arkdown.ScreenTranslation.exe' : kind === 'manifest' ? 'manifest.json' : engineFile
    if (kind === 'missing') await rm(path.join(state.resources, target))
    else if (kind === 'extra') await state.put(path.join(state.resources, 'engine/unlisted.dll'), 'unexpected')
    else if (kind === 'extra-directory') await mkdir(path.join(state.resources, 'engine/unlisted'), { recursive: true })
    else await state.put(path.join(state.resources, target), kind === 'manifest' ? JSON.stringify({ protocol: 2, files: [] }) : 'changed')
    const report = await state.audit()
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.approvedEntries.size).toBe(0)
  })
  it.each(['../outside', '/absolute', 'x\\y', 'x:y', 'x/../y', 'x//y', 'x./y', 'x /y'])('rejects a rewritten descriptor archive path: %s', async unsafe => {
    const state = await fixture()
    state.manifest.archiveName = unsafe
    const data = JSON.stringify(state.manifest)
    await state.put(path.join(state.repoRoot, 'components/screen-translation/manifest.json'), data)
    await state.put(path.join(state.resources, 'manifest.json'), data)
    expect((await state.audit()).findings).toContain('modified screen translation manifest')
  })
  it.each(['url', 'sha256'])('rejects %s descriptor substitution even if a local source manifest is rewritten', async kind => {
    const state = await fixture()
    if (kind === 'url') state.manifest.url = 'https://example.com/untrusted.tar.gz'
    else state.manifest.sha256 = digest('untrusted')
    const data = JSON.stringify(state.manifest)
    await state.put(path.join(state.repoRoot, 'components/screen-translation/manifest.json'), data)
    await state.put(path.join(state.resources, 'manifest.json'), data)
    expect((await state.audit()).findings).toContain('modified screen translation manifest')
  })
  it.each(['root', 'nested'])('rejects %s directory junctions without accepting an external asset tree', async kind => {
    const state = await fixture()
    const link = kind === 'root' ? state.resources : path.join(state.resources, 'engine')
    if (kind === 'nested') await state.put(path.join(link, 'untrusted.exe'), 'external engine')
    const outside = path.join(state.root, 'outside')
    await rename(link, outside)
    await symlink(outside, link, 'junction')
    const report = await state.audit()
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.approvedEntries.size).toBe(0)
  })
  it('does not trust a manifest rewritten to bless a modified engine', async () => {
    const state = await fixture()
    state.manifest.bytes = 7
    await state.put(path.join(state.resources, engineFile), 'changed')
    await state.put(path.join(state.resources, 'manifest.json'), JSON.stringify(state.manifest))
    expect((await state.audit()).findings).toContain('modified screen translation manifest')
    expect(await readFile(path.join(state.repoRoot, '.native-cache/screen-translation/Arkdown.ScreenTranslation.exe'), 'utf8')).toBe('Arkdown.ScreenTranslation.exe')
  })
})
