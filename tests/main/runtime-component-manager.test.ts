import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeComponentManager } from '../../src/main/components/runtime-component-manager'

const owned: string[] = []
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-runtime-test-'))
  owned.push(root)
  const bundle = path.join(root, 'bundle')
  await mkdir(path.join(bundle, 'bin'), { recursive: true })
  await mkdir(path.join(bundle, 'licenses'))
  const files = [{ path: 'bin/tool.exe', text: 'verified executable fixture' }, { path: 'licenses/LICENSE', text: 'license' }]
  for (const file of files) await writeFile(path.join(bundle, file.path), file.text)
  const tree = JSON.stringify({ schemaVersion: 1, version: '1.0.0', entry: 'bin/tool.exe', files: files.map(file => ({ path: file.path, bytes: Buffer.byteLength(file.text), sha256: sha(file.text) })) })
  await writeFile(path.join(bundle, 'component-manifest.json'), tree)
  const archive = path.join(root, 'tool.tar.gz')
  await tar.c({ cwd: bundle, gzip: true, file: archive }, ['bin', 'licenses', 'component-manifest.json'])
  const bytes = await readFile(archive)
  const definition = { id: 'tool', label: '测试组件', entry: 'bin/tool.exe', treeManifestSha256: sha(tree), descriptor: { source: 'https' as const, version: '1.0.0', archiveName: 'tool.tar.gz', bytes: bytes.length, sha256: sha(bytes), url: 'https://github.com/Lydiannnn/arkdown-releases/releases/download/test/tool.tar.gz' } }
  const copyTo = vi.fn(async (destination: string) => { await writeFile(destination, bytes) })
  return { root, bundle, definition, source: { kind: 'https' as const, copyTo } }
}
afterEach(async () => { for (const root of owned.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('optional runtime component manager', () => {
  it('retries a transient activation sharing violation without downloading again', async () => {
    const f = await fixture()
    let attempts = 0
    const manager = await createRuntimeComponentManager({ dataRoot: f.root, definition: f.definition, artifactSource: f.source,
      rename: async (from, to) => {
        if (path.basename(from) === 'tree' && attempts++ < 2) throw Object.assign(new Error('shared file'), { code: 'EPERM' })
        await rename(from, to)
      } })
    await manager.install()
    expect(manager.getState().status).toBe('installed')
    expect(attempts).toBe(3)
    expect(f.source.copyTo).toHaveBeenCalledOnce()
    expect(await manager.ensureRuntime()).toBeDefined()
    await manager.dispose()
  })

  it('cancels activation backoff promptly and restores the previous tree', async () => {
    const f = await fixture()
    let blockActivation = false
    let failed!: () => void
    const failure = new Promise<void>(resolve => { failed = resolve })
    let failedAttempts = 0
    const manager = await createRuntimeComponentManager({ dataRoot: f.root, definition: f.definition, artifactSource: f.source,
      rename: async (from, to) => {
        if (blockActivation && path.basename(from) === 'tree') {
          failedAttempts++; failed(); throw Object.assign(new Error('shared file'), { code: 'EACCES' })
        }
        await rename(from, to)
      } })
    await manager.install()
    const entry = (await manager.ensureRuntime())!
    await writeFile(entry, 'previous data must survive')
    blockActivation = true
    const installing = manager.install()
    await failure
    await manager.cancel()
    await installing
    expect(failedAttempts).toBe(1)
    expect(await readFile(entry, 'utf8')).toBe('previous data must survive')
    await manager.dispose()
  })

  it('bounds retries for persistent activation denial', async () => {
    const f = await fixture()
    let attempts = 0
    const manager = await createRuntimeComponentManager({ dataRoot: f.root, definition: f.definition, artifactSource: f.source,
      rename: async () => { attempts++; throw Object.assign(new Error('shared file'), { code: 'EPERM' }) } })
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    expect(attempts).toBeGreaterThan(1)
    expect(attempts).toBeLessThanOrEqual(26)
    expect(await manager.ensureRuntime()).toBeUndefined()
    await manager.dispose()
  }, 10_000)

  it('refuses to overwrite a destination introduced during activation backoff', async () => {
    const f = await fixture()
    let attempts = 0
    const manager = await createRuntimeComponentManager({ dataRoot: f.root, definition: f.definition, artifactSource: f.source,
      rename: async (_from, to) => {
        attempts++
        await mkdir(to)
        await writeFile(path.join(to, 'unrelated.txt'), 'preserve')
        throw Object.assign(new Error('shared file'), { code: 'EPERM' })
      } })
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    expect(attempts).toBe(1)
    expect(await readFile(path.join(f.root, 'components/tool/active/unrelated.txt'), 'utf8')).toBe('preserve')
    await manager.dispose()
  })

  it('uses a verified read-only Full bundle without a download or user-data copy', async () => {
    const f = await fixture()
    const manager = await createRuntimeComponentManager({ dataRoot: f.root, definition: f.definition, bundledRoot: f.bundle, artifactSource: f.source })
    expect(manager.getState().status).toBe('installed')
    expect(await manager.ensureRuntime()).toBe(path.join(f.bundle, 'bin/tool.exe'))
    await manager.install()
    expect(f.source.copyTo).not.toHaveBeenCalled()
    await manager.dispose()
  })
  it('does not download on resolve and installs only after an explicit request', async () => {
    const f = await fixture()
    const manager = await createRuntimeComponentManager({ dataRoot: f.root, definition: f.definition, artifactSource: f.source })
    expect(await manager.ensureRuntime()).toBeUndefined()
    expect(f.source.copyTo).not.toHaveBeenCalled()
    await manager.install()
    expect(manager.getState().status).toBe('installed')
    expect(await manager.ensureRuntime()).toBe(path.join(f.root, 'components', 'tool', 'active', 'bin/tool.exe'))
    await manager.dispose()
  })
  it('rejects a changed bundled executable and repairs into the user cache', async () => {
    const f = await fixture()
    await writeFile(path.join(f.bundle, 'bin/tool.exe'), 'tampered')
    const manager = await createRuntimeComponentManager({ dataRoot: f.root, definition: f.definition, bundledRoot: f.bundle, artifactSource: f.source })
    expect(await manager.ensureRuntime()).toBeUndefined()
    await manager.install()
    expect(await manager.ensureRuntime()).toContain(path.join('tool', 'active', 'bin', 'tool.exe'))
    expect(await readFile(path.join(f.bundle, 'bin/tool.exe'), 'utf8')).toBe('tampered')
    await manager.dispose()
  })
})
