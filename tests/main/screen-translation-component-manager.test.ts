import { createHash } from 'node:crypto'
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import * as tar from 'tar'
import * as filesystem from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComponentArtifactSource } from '../../src/main/document-conversion/component-artifact-source'
import { createScreenTranslationComponentManager } from '../../src/main/screen-translation/component-manager'
import type { DocumentConversionComponentDescriptor } from '../../src/shared/document-conversion'
import { appError } from '../../src/shared/public-errors'
import type { ScreenTranslationComponentState } from '../../src/shared/screen-translation-component'
import { SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR } from '../../src/shared/screen-translation-component-manifest'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

async function fixture(options: { extra?: boolean; duplicate?: boolean; invalidHash?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-screen-component-'))
  roots.push(root)
  const sourceRoot = path.join(root, 'fixture')
  const files = { 'ArkTranslateEngine.exe': 'MZ engine', '_internal/python313.dll': 'python', 'licenses/LICENSE.txt': 'license' }
  for (const [name, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(sourceRoot, name)), { recursive: true })
    await writeFile(path.join(sourceRoot, name), value)
  }
  await writeFile(path.join(sourceRoot, 'component-manifest.json'), JSON.stringify({
    schemaVersion: 1, version: '1.0.0', entry: 'ArkTranslateEngine.exe',
    files: Object.entries(files).map(([name, value]) => ({
      path: name, bytes: Buffer.byteLength(value), sha256: options.invalidHash ? '0'.repeat(64) : hash(Buffer.from(value)),
    })),
  }))
  if (options.extra) await writeFile(path.join(sourceRoot, 'unlisted.dll'), 'unexpected')
  const archivePath = path.join(root, 'engine.tar.gz')
  const entries = await readdir(sourceRoot)
  if (options.duplicate) entries.push('ArkTranslateEngine.exe')
  await tar.c({ cwd: sourceRoot, file: archivePath, gzip: true, portable: true }, entries)
  const archive = await readFile(archivePath)
  const descriptor: DocumentConversionComponentDescriptor = {
    source: 'https', version: '1.0.0', archiveName: 'engine.tar.gz', bytes: archive.length,
    sha256: hash(archive), url: 'https://github.com/example/releases/releases/download/engine/engine.tar.gz',
  }
  const artifactSource: ComponentArtifactSource = {
    kind: 'https',
    async copyTo(target, signal, progress) {
      signal.throwIfAborted()
      progress({ phase: 'downloading', receivedBytes: 0, totalBytes: descriptor.bytes })
      await copyFile(archivePath, target)
      signal.throwIfAborted()
      progress({ phase: 'downloading', receivedBytes: descriptor.bytes, totalBytes: descriptor.bytes })
    },
  }
  const treeManifestSha256 = hash(await readFile(path.join(sourceRoot, 'component-manifest.json')))
  return { root, sourceRoot, archivePath, descriptor, artifactSource, treeManifestSha256 }
}

describe('screen translation component manager', () => {
  it.runIf(Boolean(process.env.ARKDOWN_SCREEN_COMPONENT_ARCHIVE))('installs and reopens the actual pinned release archive', async () => {
    const item = await fixture()
    const artifactSource: ComponentArtifactSource = {
      kind: 'https', async copyTo(target, signal) {
        signal.throwIfAborted()
        await copyFile(process.env.ARKDOWN_SCREEN_COMPONENT_ARCHIVE!, target)
        signal.throwIfAborted()
      },
    }
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, artifactSource })
    expect(manager.getState().downloadBytes).toBe(SCREEN_TRANSLATION_COMPONENT_DESCRIPTOR.bytes)
    await manager.install()
    expect(manager.getState()).toMatchObject({ status: 'installed', error: null })
    const runtime = (await manager.ensureRuntime())!
    expect((await readFile(runtime)).subarray(0, 2).toString()).toBe('MZ')
    await manager.dispose()
    const reopened = await createScreenTranslationComponentManager({ dataRoot: item.root, artifactSource })
    expect(reopened.getState().status).toBe('installed')
    expect(await reopened.ensureRuntime()).toBe(runtime)
    await reopened.dispose()
  }, 60_000)

  it('waits for explicit install, then returns an audited persistent runtime and immutable progress', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    expect(manager.getState()).toMatchObject({ status: 'absent', version: '1.0.0', progress: null, error: null })
    expect(await manager.ensureRuntime()).toBeUndefined()
    const states: ScreenTranslationComponentState[] = []
    const unsubscribe = manager.subscribe((state) => { states.push(state) })
    manager.subscribe(() => { throw new Error('subscriber failure') })
    await manager.install()
    const runtime = await manager.ensureRuntime()
    expect(runtime).toBe(path.join(item.root, 'components', 'screen-translation', 'active', 'ArkTranslateEngine.exe'))
    expect(await readFile(runtime!, 'utf8')).toBe('MZ engine')
    expect(manager.getState().status).toBe('installed')
    expect(states.filter((state) => state.progress).map((state) => state.progress!.phase))
      .toEqual(expect.arrayContaining(['downloading', 'verifying', 'extracting']))
    for (const state of states) {
      expect(Object.isFrozen(state)).toBe(true)
      if (state.progress) expect(Object.isFrozen(state.progress)).toBe(true)
    }
    unsubscribe()
    await manager.cancel()
    await manager.dispose()
    expect(await manager.ensureRuntime()).toBeUndefined()
    const restarted = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    expect(restarted.getState().status).toBe('installed')
    expect(await restarted.ensureRuntime()).toBe(runtime)
    await restarted.dispose()
  })

  it.each([{ extra: true }, { duplicate: true }, { invalidHash: true }])('rejects an invalid tree %j without activation', async (options) => {
    const item = await fixture(options)
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    expect(manager.getState().error).toMatch(/悬浮翻译.*校验/u)
    expect(await manager.ensureRuntime()).toBeUndefined()
    expect(await readdir(path.join(item.root, 'components', 'screen-translation', 'staging'))).toEqual([])
    await manager.dispose()
  })

  it('rejects downloaded bytes that differ from the pinned archive', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item, descriptor: { ...item.descriptor, sha256: 'f'.repeat(64) } })
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    expect(await manager.ensureRuntime()).toBeUndefined()
    await manager.dispose()
  })

  it('cancels partial downloads, coalesces repeated install calls, and permits a clean retry', async () => {
    const item = await fixture()
    let started!: () => void
    const downloading = new Promise<void>((resolve) => { started = resolve })
    let first = true
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item, artifactSource: {
      kind: 'https',
      async copyTo(target, signal, progress) {
        if (!first) return item.artifactSource.copyTo(target, signal, progress)
        first = false
        await writeFile(target, 'partial')
        started()
        await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      },
    } })
    const pending = manager.install()
    expect(manager.install()).toBe(pending)
    await downloading
    await manager.cancel()
    await pending
    expect(manager.getState()).toMatchObject({ status: 'absent', error: null, progress: null })
    expect(await readdir(path.join(item.root, 'components', 'screen-translation', 'staging'))).toEqual([])
    await manager.install()
    expect(manager.getState().status).toBe('installed')
    await manager.dispose()
  })

  it('refuses a modified runtime and repairs it only after explicit reinstall', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    await manager.install()
    const runtime = await manager.ensureRuntime()
    await writeFile(runtime!, 'MZ hacked')
    expect(await manager.ensureRuntime()).toBeUndefined()
    expect(manager.getState().status).toBe('failed')
    await manager.install()
    expect(await readFile((await manager.ensureRuntime())!, 'utf8')).toBe('MZ engine')
    await manager.dispose()
  })

  it('rejects coordinated executable and local inventory tampering against the compiled tree anchor', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    await manager.install()
    const runtime = (await manager.ensureRuntime())!
    const replacement = Buffer.from('MZ tampered engine')
    await writeFile(runtime, replacement)
    const manifestPath = path.join(path.dirname(runtime), 'component-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    Object.assign(manifest.files.find((file: { path: string }) => file.path === 'ArkTranslateEngine.exe'), {
      bytes: replacement.length, sha256: hash(replacement),
    })
    await writeFile(manifestPath, JSON.stringify(manifest))
    expect(await manager.ensureRuntime()).toBeUndefined()
    expect(manager.getState().status).toBe('failed')
    await manager.dispose()
    const restarted = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    expect(await restarted.ensureRuntime()).toBeUndefined()
    await restarted.dispose()
  })

  it('retains the previous tree when activation and rollback both fail', async () => {
    const item = await fixture()
    let failActivation = false
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item,
      async rename(from, to) {
        if (failActivation && path.basename(to) === 'active') throw Object.assign(new Error('synthetic activation and rollback failure'), { code: 'EACCES' })
        return filesystem.rename(from, to)
      },
    })
    await manager.install()
    const runtime = (await manager.ensureRuntime())!
    await writeFile(runtime, 'old damaged data to preserve')
    failActivation = true
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    const backups = path.join(item.root, 'components', 'screen-translation', 'backup')
    const saved = await readdir(backups)
    expect(saved).toHaveLength(1)
    expect(await readFile(path.join(backups, saved[0], 'ArkTranslateEngine.exe'), 'utf8')).toBe('old damaged data to preserve')
    await manager.dispose()
    const restarted = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    expect(await restarted.ensureRuntime()).toBeUndefined()
    expect(await readFile(path.join(backups, saved[0], 'ArkTranslateEngine.exe'), 'utf8')).toBe('old damaged data to preserve')
    await restarted.dispose()
  }, 15_000)

  it('recovers a verified backup after an interrupted activation without downloading', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    await manager.install()
    const runtime = (await manager.ensureRuntime())!
    await manager.dispose()
    const backup = path.join(item.root, 'components', 'screen-translation', 'backup', '12345678-1234-4234-8234-123456789abc')
    await mkdir(path.dirname(backup), { recursive: true })
    await filesystem.rename(path.dirname(runtime), backup)
    const restarted = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item, artifactSource: {
      kind: 'https', async copyTo() { throw new Error('must not download') },
    } })
    expect(restarted.getState().status).toBe('installed')
    expect(await restarted.ensureRuntime()).toBe(runtime)
    await restarted.dispose()
  })

  it('never traverses a junction at the component root', async () => {
    const item = await fixture()
    await mkdir(path.join(item.root, 'components'))
    await symlink(item.sourceRoot, path.join(item.root, 'components', 'screen-translation'), 'junction')
    await expect(createScreenTranslationComponentManager({ dataRoot: item.root, ...item })).rejects.toThrow(/悬浮翻译/u)
    expect(await readFile(path.join(item.sourceRoot, 'ArkTranslateEngine.exe'), 'utf8')).toBe('MZ engine')
  })

  it('rejects a hard-linked installed executable even when its contents match', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    await manager.install()
    const runtime = (await manager.ensureRuntime())!
    await rm(runtime)
    await link(path.join(item.sourceRoot, 'ArkTranslateEngine.exe'), runtime)
    expect(await manager.ensureRuntime()).toBeUndefined()
    expect(manager.getState().status).toBe('failed')
    await manager.dispose()
  })

  it('rejects an installed internal directory replaced with a junction', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    await manager.install()
    const runtime = (await manager.ensureRuntime())!
    const internal = path.join(path.dirname(runtime), '_internal')
    await rm(internal, { recursive: true })
    await symlink(path.join(item.sourceRoot, '_internal'), internal, 'junction')
    expect(await manager.ensureRuntime()).toBeUndefined()
    expect(manager.getState().status).toBe('failed')
    await manager.dispose()
    expect(await readFile(path.join(item.sourceRoot, '_internal', 'python313.dll'), 'utf8')).toBe('python')
  })

  it('cancels verification before extraction and leaves no active tree', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    let cancelled: Promise<void> | undefined
    manager.subscribe((state) => {
      if (state.progress?.phase === 'verifying') cancelled = manager.cancel()
    })
    await manager.install()
    await cancelled
    expect(manager.getState()).toMatchObject({ status: 'absent', error: null })
    expect(await manager.ensureRuntime()).toBeUndefined()
    expect(await readdir(path.join(item.root, 'components', 'screen-translation', 'staging'))).toEqual([])
    await manager.dispose()
  })

  it('allows an installed event observer to resolve the completed runtime', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item })
    let resolved: Promise<string | undefined> | undefined
    manager.subscribe((state) => {
      if (state.status === 'installed') resolved = manager.ensureRuntime()
    })
    await manager.install()
    expect(await resolved).toBe(path.join(item.root, 'components', 'screen-translation', 'active', 'ArkTranslateEngine.exe'))
    await manager.dispose()
  })

  it.each(['../escaped.exe', 'C:/escaped.exe', '_internal/../../escaped.exe', '_internal/CON', '_internal/evil.'])('rejects unsafe archive path %s', async (name) => {
    const item = await fixture()
    const header = new tar.Header({ path: name, type: 'File', mode: 0o644, size: 1 })
    header.encode()
    const archive = gzipSync(Buffer.concat([header.block!, Buffer.from('x'), Buffer.alloc(511 + 1024)]))
    await writeFile(item.archivePath, archive)
    const descriptor = { ...item.descriptor, bytes: archive.length, sha256: hash(archive) }
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item, descriptor })
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    expect(await manager.ensureRuntime()).toBeUndefined()
    await manager.dispose()
  })

  it.each(['SymbolicLink', 'Link'] as const)('rejects archive %s entries', async (type) => {
    const item = await fixture()
    const header = new tar.Header({ path: 'ArkTranslateEngine.exe', type, linkpath: '../../outside', mode: 0o644, size: 0 })
    header.encode()
    const archive = gzipSync(Buffer.concat([header.block!, Buffer.alloc(1024)]))
    await writeFile(item.archivePath, archive)
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item, descriptor: { ...item.descriptor, bytes: archive.length, sha256: hash(archive) } })
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    await manager.dispose()
  })

  it('rejects an oversized declared entry before writing its payload', async () => {
    const item = await fixture()
    const header = new tar.Header({ path: '_internal/huge.dll', type: 'File', mode: 0o644, size: 4 * 1024 ** 3 })
    header.encode()
    const archive = gzipSync(Buffer.concat([header.block!, Buffer.alloc(1024)]))
    await writeFile(item.archivePath, archive)
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item, descriptor: { ...item.descriptor, bytes: archive.length, sha256: hash(archive) } })
    await manager.install()
    expect(manager.getState().status).toBe('failed')
    await manager.dispose()
  })

  it('maps shared download errors without leaking document names, paths, or remote diagnostics', async () => {
    const item = await fixture()
    const manager = await createScreenTranslationComponentManager({ dataRoot: item.root, ...item, artifactSource: {
      kind: 'https', async copyTo() { throw appError('DOCUMENT_CONVERSION_DOWNLOAD_FAILED') },
    } })
    await manager.install()
    expect(manager.getState().error).toMatch(/悬浮翻译.*下载.*网络/u)
    expect(JSON.stringify(manager.getState())).not.toMatch(/文档转换|document-conversion|https:|C:\\/u)
    await manager.dispose()
  })
})
