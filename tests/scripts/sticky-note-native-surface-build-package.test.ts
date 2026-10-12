import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import * as tar from 'tar'
import { extractNativeSurfaceHeaders, nativeSurfaceBuildArguments, obtainNativeSurfaceArtifact, nativeSurfaceSourceHash, NATIVE_SURFACE_INPUTS, ELECTRON_NATIVE_SURFACE_VERSION } from '../../scripts/build-sticky-note-native-surface'
import { copyStickyNoteNativeSurface, validateStickyNoteNativeSurfaceManifest } from '../../scripts/package-sticky-note-native-surface'
import { auditPackagedApplication, auditStickyNoteNativeSurfaceResources } from '../../scripts/audit-arkdown-package'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'native-surface-test-')); roots.push(root)
  for (const file of NATIVE_SURFACE_INPUTS) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), file) }
  const sourceDirectory = path.join(root, 'native/sticky-note-surface/dist/x64')
  const packaged = path.join(root, 'package')
  await mkdir(sourceDirectory, { recursive: true }); await mkdir(path.join(packaged, 'resources'), { recursive: true })
  await writeFile(path.join(packaged, 'Arkdown.exe'), 'exe'); await writeFile(path.join(packaged, 'resources/app.asar'), 'asar')
  const bytes = Buffer.from('native binary fixture')
  const manifest = { schemaVersion: 1, platform: 'win32', arch: 'x64', electronVersion: ELECTRON_NATIVE_SURFACE_VERSION, file: 'surface.node', bytes: bytes.length, sha256: sha(bytes), sourceSha256: await nativeSurfaceSourceHash(root), windowsSdkVersion: '10.0.26100.0' }
  await writeFile(path.join(sourceDirectory, 'surface.node'), bytes)
  await writeFile(path.join(sourceDirectory, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(path.join(sourceDirectory, 'NOTICE'), await readFile(path.join(root, 'native/sticky-note-surface/NOTICE')))
  return { root, sourceDirectory, packaged, bytes, manifest }
}
it('uses explicit x64 MSBuild arguments with unescaped paths and rejects other targets', () => {
  const args = nativeSurfaceBuildArguments({ repoRoot: 'C:/project with spaces', headersDirectory: 'C:/cache/include/node', nodeLib: 'C:/cache/x64/node.lib', sdkVersion: '10.0.26100.0', architecture: 'x64' })
  expect(args).toContain('/p:NodeLibPath=C:/cache/x64/node.lib')
  expect(args).toContain('/p:NodeHeadersDir=C:/cache/include/node')
  expect(args).toContain('/p:Platform=x64')
  expect(() => nativeSurfaceBuildArguments({ repoRoot: '.', headersDirectory: '.', nodeLib: '.', sdkVersion: '10.0.26100.0', architecture: 'arm64' })).toThrow(/x64/)
})
it('rejects corrupt cached bytes and does not accept a bad official download', async () => {
  const { root } = await fixture(), file = path.join(root, 'artifact')
  await writeFile(file, 'wrong')
  await expect(obtainNativeSurfaceArtifact({ file, url: 'https://electronjs.org/headers/v43.2.0/x64/node.lib', sha256: sha(Buffer.from('right')), allowDownload: false })).rejects.toThrow(/verified|hash/i)
  await expect(obtainNativeSurfaceArtifact({ file, url: 'https://electronjs.org/headers/v43.2.0/x64/node.lib', sha256: sha(Buffer.from('right')), request: async () => new Response('still wrong') })).rejects.toThrow(/hash/i)
})
it('reuses verified cached bytes without making a request', async () => {
  const { root } = await fixture(), file = path.join(root, 'artifact'), bytes = Buffer.from('right')
  await writeFile(file, bytes)
  await expect(obtainNativeSurfaceArtifact({ file, url: 'https://electronjs.org/headers/v43.2.0/x64/node.lib', sha256: sha(bytes), request: async () => { throw Error('must not download') } })).resolves.toEqual(bytes)
})
it('copies only the fixed binary and manifest and binds matching bytes/source', async () => {
  const f = await fixture()
  await writeFile(path.join(f.sourceDirectory, 'unrelated.dll'), 'not shipped')
  await copyStickyNoteNativeSurface([f.packaged], { repoRoot: f.root, sourceDirectory: f.sourceDirectory })
  const destination = path.join(f.packaged, 'resources/sticky-note-native-surface/x64')
  expect((await readdir(destination)).sort()).toEqual(['NOTICE', 'manifest.json', 'surface.node'])
  expect(await readFile(path.join(destination, 'surface.node'))).toEqual(f.bytes)
  expect(JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'))).toEqual(f.manifest)
})
it('rejects missing source, changed binary and stale native source before copying', async () => {
  const f = await fixture()
  await expect(copyStickyNoteNativeSurface([f.packaged], { repoRoot: f.root, sourceDirectory: path.join(f.root, 'absent') })).rejects.toThrow()
  await writeFile(path.join(f.sourceDirectory, 'surface.node'), 'changed')
  await expect(copyStickyNoteNativeSurface([f.packaged], { repoRoot: f.root, sourceDirectory: f.sourceDirectory })).rejects.toThrow(/hash|binary/i)
  await writeFile(path.join(f.sourceDirectory, 'surface.node'), f.bytes)
  await writeFile(path.join(f.root, NATIVE_SURFACE_INPUTS[0]), 'changed source')
  await expect(copyStickyNoteNativeSurface([f.packaged], { repoRoot: f.root, sourceDirectory: f.sourceDirectory })).rejects.toThrow(/source/i)
})
it('rejects traversal, architecture/version drift and unexpected manifest fields', async () => {
  const { manifest } = await fixture()
  for (const change of [{ file: '../surface.node' }, { arch: 'arm64' }, { electronVersion: '43.1.0' }, { extra: true }]) expect(() => validateStickyNoteNativeSurfaceManifest({ ...manifest, ...change })).toThrow()
})
it('extracts official Electron node_headers layout and excludes unrelated archive files', async () => {
  const { root } = await fixture()
  await mkdir(path.join(root, 'node_headers/include/node'), { recursive: true })
  await writeFile(path.join(root, 'node_headers/include/node/node_api.h'), 'header')
  await writeFile(path.join(root, 'node_headers/unexpected.txt'), 'ignore')
  const archive = path.join(root, 'headers.tar.gz'), extracted = path.join(root, 'extracted')
  await tar.c({ gzip: true, cwd: root, file: archive }, ['node_headers'])
  await mkdir(extracted)
  const headers = await extractNativeSurfaceHeaders(archive, extracted)
  expect(await readFile(path.join(headers, 'node_api.h'), 'utf8')).toBe('header')
  expect(await readdir(extracted)).toEqual(['include'])
})
it('rejects resources junctions before writing outside the package', async () => {
  const f = await fixture(), elsewhere = path.join(f.root, 'elsewhere')
  await mkdir(elsewhere); await writeFile(path.join(elsewhere, 'app.asar'), 'outside')
  await rm(path.join(f.packaged, 'resources'), { recursive: true })
  await symlink(elsewhere, path.join(f.packaged, 'resources'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(copyStickyNoteNativeSurface([f.packaged], { repoRoot: f.root, sourceDirectory: f.sourceDirectory })).rejects.toThrow(/directory|destination/i)
  expect(await readdir(elsewhere)).toEqual(['app.asar'])
})

it('audits packaged native bytes and requires them for the x64 application audit', async () => {
  const f = await fixture()
  await expect(auditStickyNoteNativeSurfaceResources(f.packaged)).resolves.toEqual(['missing sticky note native surface resources'])
  const missing = await auditPackagedApplication(f.packaged, { workspaceCommitHelperArch: 'x64' })
  expect(missing.findings).toContain('missing sticky note native surface resources')
  const arm = await auditPackagedApplication(f.packaged, { workspaceCommitHelperArch: 'arm64' })
  expect(arm.findings).not.toContain('missing sticky note native surface resources')
  await copyStickyNoteNativeSurface([f.packaged], { repoRoot: f.root })
  await expect(auditStickyNoteNativeSurfaceResources(f.packaged)).resolves.toEqual([])
  const valid = await auditPackagedApplication(f.packaged, { workspaceCommitHelperArch: 'x64' })
  expect(valid.findings.some(finding => finding.includes('sticky-note-native-surface'))).toBe(false)
  await writeFile(path.join(f.packaged, 'resources/sticky-note-native-surface/x64/surface.node'), 'changed')
  await expect(auditStickyNoteNativeSurfaceResources(f.packaged)).resolves.toContain('modified sticky note native surface binary')
})
