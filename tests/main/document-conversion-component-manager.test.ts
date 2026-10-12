import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentArtifactSource } from '../../src/main/document-conversion/component-artifact-source'
import { GitHubReleaseArtifactSource } from '../../src/main/document-conversion/component-artifact-source'
import {
  createDocumentConversionComponentManager,
  type DocumentConversionComponentManager,
} from '../../src/main/document-conversion/component-manager'
import type {
  DocumentConversionComponentDescriptor,
  DocumentConversionComponentState,
} from '../../src/shared/document-conversion'
import { parseDocumentConversionComponentState } from '../../src/shared/document-conversion'
import { appError } from '../../src/shared/public-errors'

const roots: string[] = []

it('rejects a modified cached executable even when its local manifest was also replaced', async () => {
  const root = await temporaryRoot()
  const active = path.join(root, 'document-conversion', 'active')
  await writeComponentTree(active, { version: '1.0.0' })
  const pin = sha256(await readFile(path.join(active, 'component-manifest.json')))
  const fixture = await archiveFixture(root, { version: '1.0.0' })
  await writeComponentTree(active, { version: '1.0.0', files: {
    'python.exe': 'changed interpreter', 'arkdown_markitdown.py': 'changed entry',
  } })
  const manager = await createDocumentConversionComponentManager({ userData: root,
    descriptor: fixture.descriptor, source: { kind: 'packaged', copyTo: vi.fn() }, treeManifestSha256: pin })
  expect(manager.resolveRuntime()).toBeUndefined()
  await expect(manager.ensureVerified()).rejects.toThrow()
  expect(() => manager.acquireLease()).toThrow()
  await manager.dispose()
})

it('uses a pinned bundled runtime offline and refuses to remove program files', async () => {
  const root = await temporaryRoot()
  const bundle = path.join(root, 'bundle')
  await writeComponentTree(bundle, { version: '1.0.0' })
  const fixture = await archiveFixture(root, { version: '1.0.0' })
  const copyTo = vi.fn(async () => { throw new Error('must stay offline') })
  const manager = await createDocumentConversionComponentManager({ userData: root,
    descriptor: fixture.descriptor, source: { kind: 'packaged', copyTo }, bundledRoot: bundle,
    bundledTreeManifestSha256: sha256(await readFile(path.join(bundle, 'component-manifest.json'))) })
  expect(manager.getState().status).toBe('installed')
  await manager.ensureVerified()
  const lease = manager.acquireLease()
  expect(lease.runtime.root).toBe(bundle)
  lease.release()
  await expect(manager.remove()).rejects.toThrow()
  expect(await readFile(path.join(bundle, 'python.exe'), 'utf8')).toBe('python-1.0.0')
  expect(copyTo).not.toHaveBeenCalled()
  await manager.dispose()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-component-manager-'))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface TreeFixture {
  version: string
  files?: Readonly<Record<string, string>>
  manifestFiles?: Readonly<Record<string, string>>
  manifestOrder?: readonly string[]
  extraFiles?: Readonly<Record<string, string>>
}

async function writeComponentTree(root: string, fixture: TreeFixture): Promise<void> {
  const files = fixture.files ?? {
    'arkdown_markitdown.py': 'print("ok")\n',
    'Lib/site-packages/markitdown.py': `VERSION = "${fixture.version}"\n`,
    'python.exe': `python-${fixture.version}`,
  }
  const declared = fixture.manifestFiles ?? files
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  for (const [relative, contents] of Object.entries(fixture.extraFiles ?? {})) {
    const target = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents)
  }
  const manifest = {
    schemaVersion: 1,
    version: fixture.version,
    pythonVersion: '3.12.10',
    platform: 'win-x64',
    lockSha256: 'a'.repeat(64),
    files: (fixture.manifestOrder ?? Object.keys(declared).sort())
      .map((relative) => {
        const contents = declared[relative]
        if (contents === undefined) throw new Error(`Missing manifest fixture contents: ${relative}`)
        return {
          path: relative,
          bytes: Buffer.byteLength(contents),
          sha256: sha256(Buffer.from(contents)),
        }
      }),
  }
  await writeFile(path.join(root, 'component-manifest.json'), `${JSON.stringify(manifest)}\n`)
}

async function archiveFixture(
  userData: string,
  fixture: TreeFixture,
): Promise<{ archivePath: string; descriptor: DocumentConversionComponentDescriptor }> {
  const sourceRoot = path.join(userData, `archive-source-${fixture.version}-${Math.random()}`)
  await mkdir(sourceRoot, { recursive: true })
  await writeComponentTree(sourceRoot, fixture)
  const archiveName = `component-${fixture.version}.tar.gz`
  const archivePath = path.join(userData, archiveName)
  const entries = await readdir(sourceRoot)
  await tar.c({ cwd: sourceRoot, file: archivePath, gzip: true, portable: true }, entries)
  const bytes = await readFile(archivePath)
  return {
    archivePath,
    descriptor: {
      source: 'packaged',
      version: fixture.version,
      archiveName,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      url: null,
    },
  }
}

function artifactSource(archivePath: string): ComponentArtifactSource {
  return {
    kind: 'packaged',
    async copyTo(targetPath, signal, onProgress) {
      signal.throwIfAborted()
      const info = await lstat(archivePath)
      onProgress({ phase: 'reading', receivedBytes: 0, totalBytes: info.size })
      await copyFile(archivePath, targetPath)
      signal.throwIfAborted()
      onProgress({ phase: 'reading', receivedBytes: info.size, totalBytes: info.size })
    },
  }
}

function gatedArtifactSource(archivePath: string): ComponentArtifactSource & {
  calls: number
  started: Promise<void>
  release(): void
} {
  let notifyStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { notifyStarted = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  return {
    kind: 'packaged',
    calls: 0,
    started,
    release,
    async copyTo(targetPath, signal, onProgress) {
      this.calls += 1
      const info = await lstat(archivePath)
      onProgress({ phase: 'reading', receivedBytes: 0, totalBytes: info.size })
      notifyStarted()
      await Promise.race([
        gate,
        new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
      ])
      signal.throwIfAborted()
      await copyFile(archivePath, targetPath)
      onProgress({ phase: 'reading', receivedBytes: info.size, totalBytes: info.size })
    },
  }
}

async function manager(
  userData: string,
  descriptor: DocumentConversionComponentDescriptor,
  source: ComponentArtifactSource,
  overrides: Record<string, unknown> = {},
): Promise<DocumentConversionComponentManager> {
  return createDocumentConversionComponentManager({ userData, descriptor, source, ...overrides })
}

function expectPublicSnapshot(state: DocumentConversionComponentState): void {
  expect(parseDocumentConversionComponentState(state)).toEqual(state)
  expect(Object.isFrozen(state)).toBe(true)
  if (state.progress) expect(Object.isFrozen(state.progress)).toBe(true)
  expect(JSON.stringify(state)).not.toContain('document-conversion')
}

describe('document conversion component manager', () => {
  it('installs from a pinned remote manifest, preserves the old runtime offline, and retries an update', async () => {
    const userData = await temporaryRoot()
    const first = await archiveFixture(userData, { version: '1.0.0' })
    const second = await archiveFixture(userData, { version: '2.0.0' })
    const base = 'https://github.com/Lydiannnn/arkdown-releases/releases/download/test/'
    let offline = false
    const remote = async (fixture: typeof first) => {
      const descriptor = { ...fixture.descriptor, source: 'https' as const, url: `${base}${fixture.descriptor.archiveName}` }
      const source = new GitHubReleaseArtifactSource(descriptor, base, async (url) => {
        if (offline) throw new TypeError('network unavailable')
        return url.endsWith('manifest.json') ? new Response(JSON.stringify(descriptor))
          : new Response(await readFile(fixture.archivePath), { headers: { 'content-length': String(descriptor.bytes) } })
      })
      return manager(userData, descriptor, source)
    }
    const old = await remote(first)
    await expect(old.install('install')).resolves.toMatchObject({ source: 'https', status: 'installed', installedVersion: '1.0.0' })
    await old.dispose()
    const current = await remote(second)
    expect(current.getState()).toMatchObject({ status: 'update-available', installedVersion: '1.0.0' })
    offline = true
    await expect(current.install('offline')).resolves.toMatchObject({ status: 'failed', installedVersion: '1.0.0', errorCode: 'DOCUMENT_CONVERSION_DOWNLOAD_FAILED' })
    expect(current.resolveRuntime()?.version).toBe('1.0.0')
    offline = false
    await expect(current.install('retry')).resolves.toMatchObject({ status: 'installed', installedVersion: '2.0.0', errorCode: null })
    expect(current.resolveRuntime()?.version).toBe('2.0.0')
    await current.dispose()
  })

  it('emits immutable absent, installing, and installed state snapshots', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const source = gatedArtifactSource(fixture.archivePath)
    const value = await manager(userData, fixture.descriptor, source)
    const observed: DocumentConversionComponentState[] = []
    const unsubscribe = value.subscribe((state) => observed.push(state))

    expect(value.getState()).toMatchObject({
      revision: 0,
      status: 'absent',
      installedVersion: null,
      busy: false,
    })
    const installing = value.install('window-a')
    await source.started
    expect(value.getState()).toMatchObject({ status: 'installing', busy: true })
    source.release()
    await expect(installing).resolves.toMatchObject({ status: 'installed', installedVersion: '2.0.0' })

    expect(observed.map((state) => state.status)).toContain('installing')
    expect(observed.at(-1)?.status).toBe('installed')
    expect(observed.map((state) => state.revision)).toEqual(
      observed.map((_state, index) => index + 1),
    )
    expect(observed.every((state) => Number.isSafeInteger(state.revision))).toBe(true)
    expect(value.getState().revision).toBe(observed.at(-1)?.revision)
    for (const snapshot of [value.getState(), ...observed]) expectPublicSnapshot(snapshot)
    unsubscribe()
    await value.dispose()
  })

  it('shares one install while cancelling only one of two owners', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const source = gatedArtifactSource(fixture.archivePath)
    const value = await manager(userData, fixture.descriptor, source)

    const first = value.install('window-a')
    const second = value.install('window-b')
    await source.started
    await value.cancelInstall('window-a')
    expect(value.getState().status).toBe('installing')
    source.release()

    await expect(first).resolves.not.toMatchObject({ status: 'failed' })
    await expect(second).resolves.toMatchObject({ status: 'installed' })
    expect(source.calls).toBe(1)
    await value.dispose()
  })

  it('aborts shared work without a public failure when every owner cancels', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const source = gatedArtifactSource(fixture.archivePath)
    const value = await manager(userData, fixture.descriptor, source)

    const first = value.install('window-a')
    const second = value.install('window-b')
    await source.started
    await value.cancelInstall('window-a')
    await value.cancelInstall('window-b')

    await expect(first).resolves.not.toMatchObject({ status: 'failed' })
    await expect(second).resolves.toMatchObject({ status: 'absent', errorCode: null, busy: false })
    expect(value.getState()).toMatchObject({ status: 'absent', errorCode: null })
    await expect(readdir(path.join(userData, 'document-conversion', 'staging'))).resolves.toEqual([])
    await value.dispose()
  })

  it.each([
    { label: 'the final owner cancels', action: 'cancel' as const },
    { label: 'the manager is disposed', action: 'dispose' as const },
  ])('preserves the old active tree when $label during the final staging audit', async ({ action }) => {
    const userData = await temporaryRoot()
    const oldFixture = await archiveFixture(userData, { version: '1.0.0' })
    const old = await manager(userData, oldFixture.descriptor, artifactSource(oldFixture.archivePath))
    await old.install('setup')
    await old.dispose()
    const nextFixture = await archiveFixture(userData, { version: '2.0.0' })
    const value = await manager(userData, nextFixture.descriptor, artifactSource(nextFixture.archivePath))
    let raceAction: Promise<unknown> | undefined
    let notifyRaceStarted!: () => void
    const raceStarted = new Promise<void>((resolve) => { notifyRaceStarted = resolve })
    let scheduled = false
    value.subscribe((state) => {
      if (scheduled || state.progress?.phase !== 'extracting'
        || state.progress.receivedBytes !== state.progress.totalBytes) return
      scheduled = true
      queueMicrotask(() => {
        raceAction = action === 'cancel' ? value.cancelInstall('update') : value.dispose()
        notifyRaceStarted()
      })
    })

    const installing = value.install('update')
    await raceStarted
    await expect(installing).resolves.toMatchObject({
      status: 'update-available', installedVersion: '1.0.0', errorCode: null, busy: false,
    })
    await raceAction
    expect(await readFile(path.join(userData, 'document-conversion', 'active', 'python.exe'), 'utf8')).toBe('python-1.0.0')
    if (action === 'cancel') await value.dispose()
  })

  it('rejects a same-kind source archive that does not match the pinned descriptor', async () => {
    const userData = await temporaryRoot()
    const pinned = await archiveFixture(userData, { version: '2.0.0' })
    const attackerData = await temporaryRoot()
    const substitutedBytes = Buffer.from(await readFile(pinned.archivePath))
    expect([...substitutedBytes.subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08])
    substitutedBytes[9] = (substitutedBytes[9]! + 1) % 256
    const substitutedPath = path.join(attackerData, pinned.descriptor.archiveName)
    await writeFile(substitutedPath, substitutedBytes)
    const substitutedDescriptor = {
      ...pinned.descriptor,
      bytes: substitutedBytes.byteLength,
      sha256: sha256(substitutedBytes),
    }
    expect(substitutedDescriptor).toMatchObject({
      source: pinned.descriptor.source,
      version: pinned.descriptor.version,
      bytes: pinned.descriptor.bytes,
    })
    expect(substitutedDescriptor.sha256).not.toBe(pinned.descriptor.sha256)
    const value = await manager(userData, pinned.descriptor, artifactSource(substitutedPath))

    await expect(value.install('window')).resolves.toMatchObject({
      status: 'failed', installedVersion: null, errorCode: 'DOCUMENT_CONVERSION_COMPONENT_INVALID',
    })
    await expect(lstat(path.join(userData, 'document-conversion', 'active'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(path.join(userData, 'document-conversion', 'staging'))).resolves.toEqual([])
    await value.dispose()
  })

  it('rejects undeclared, missing, and hash-mismatched component tree files', async () => {
    for (const [name, fixture] of [
      ['undeclared', { version: '2.0.0', extraFiles: { 'surprise.txt': 'private' } }],
      ['missing', { version: '2.0.0', files: { 'python.exe': 'python-2.0.0', 'arkdown_markitdown.py': 'ok' }, manifestFiles: { 'python.exe': 'python-2.0.0', 'arkdown_markitdown.py': 'ok', 'missing.dat': 'absent' } }],
      ['hash mismatch', { version: '2.0.0', files: { 'python.exe': 'changed', 'arkdown_markitdown.py': 'ok' }, manifestFiles: { 'python.exe': 'expected', 'arkdown_markitdown.py': 'ok' } }],
    ] as const) {
      const userData = await temporaryRoot()
      const archived = await archiveFixture(userData, fixture)
      const value = await manager(userData, archived.descriptor, artifactSource(archived.archivePath))
      await expect(value.install(name)).resolves.toMatchObject({
        status: 'failed', errorCode: 'DOCUMENT_CONVERSION_COMPONENT_INVALID',
      })
      expect(value.resolveRuntime()).toBeUndefined()
      await value.dispose()
    }
  })

  it('accepts the deterministic builder DFS manifest order for nested sibling names', async () => {
    const userData = await temporaryRoot()
    const files = {
      'arkdown_markitdown.py': 'print("ok")\n',
      'foo/bar.py': 'VALUE = 1\n',
      'foo-1.dist-info/METADATA': 'Name: foo\nVersion: 1\n',
      'python.exe': 'python-2.0.0',
    }
    const archived = await archiveFixture(userData, {
      version: '2.0.0',
      files,
      manifestOrder: [
        'arkdown_markitdown.py',
        'foo/bar.py',
        'foo-1.dist-info/METADATA',
        'python.exe',
      ],
    })
    const value = await manager(userData, archived.descriptor, artifactSource(archived.archivePath))

    await expect(value.install('builder-dfs')).resolves.toMatchObject({
      status: 'installed',
      installedVersion: '2.0.0',
    })
    expect(value.resolveRuntime()).toMatchObject({ version: '2.0.0' })
    await value.dispose()
  })

  it.each([
    {
      label: 'duplicate path',
      manifestFiles: {
        'arkdown_markitdown.py': 'ok',
        'python.exe': 'python-2.0.0',
      },
      manifestOrder: ['arkdown_markitdown.py', 'python.exe', 'python.exe'],
    },
    {
      label: 'case-alias path',
      manifestFiles: {
        'PYTHON.EXE': 'python-2.0.0',
        'arkdown_markitdown.py': 'ok',
        'python.exe': 'python-2.0.0',
      },
      manifestOrder: ['PYTHON.EXE', 'arkdown_markitdown.py', 'python.exe'],
    },
  ] as ReadonlyArray<{
    label: string
    manifestFiles: Readonly<Record<string, string>>
    manifestOrder: readonly string[]
  }>)('continues to reject a $label in the component manifest', async ({ manifestFiles, manifestOrder }) => {
    const userData = await temporaryRoot()
    const archived = await archiveFixture(userData, {
      version: '2.0.0',
      files: {
        'arkdown_markitdown.py': 'ok',
        'python.exe': 'python-2.0.0',
      },
      manifestFiles,
      manifestOrder,
    })
    const value = await manager(userData, archived.descriptor, artifactSource(archived.archivePath))

    await expect(value.install('invalid-manifest-name')).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'DOCUMENT_CONVERSION_COMPONENT_INVALID',
    })
    expect(value.resolveRuntime()).toBeUndefined()
    await value.dispose()
  })

  it('rejects an extracted symlink or reparse-point entry', async ({ skip }) => {
    const userData = await temporaryRoot()
    const sourceRoot = path.join(userData, 'symlink-source')
    const outsideRoot = path.join(userData, 'outside-tree')
    await mkdir(sourceRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await writeFile(path.join(outsideRoot, 'private.txt'), 'private')
    await writeComponentTree(sourceRoot, { version: '2.0.0' })
    try {
      await symlink(outsideRoot, path.join(sourceRoot, 'linked-tree'), 'junction')
    } catch {
      skip()
      return
    }
    const archivePath = path.join(userData, 'component-2.0.0.tar.gz')
    await tar.c({ cwd: sourceRoot, file: archivePath, gzip: true, portable: true }, await readdir(sourceRoot))
    const bytes = await readFile(archivePath)
    const descriptor: DocumentConversionComponentDescriptor = {
      source: 'packaged', version: '2.0.0', archiveName: path.basename(archivePath),
      bytes: bytes.byteLength, sha256: sha256(bytes), url: null,
    }
    const value = await manager(userData, descriptor, artifactSource(archivePath))
    await expect(value.install('window')).resolves.toMatchObject({ status: 'failed' })
    await value.dispose()
  })

  it('refuses a staging-root reparse escape without deleting outside data', async ({ skip }) => {
    const userData = await temporaryRoot()
    const componentRoot = path.join(userData, 'document-conversion')
    const outsideRoot = path.join(userData, 'outside-staging')
    await mkdir(componentRoot, { recursive: true })
    await mkdir(outsideRoot, { recursive: true })
    await writeFile(path.join(outsideRoot, 'keep.txt'), 'keep')
    try {
      await symlink(outsideRoot, path.join(componentRoot, 'staging'), 'junction')
    } catch {
      skip()
      return
    }
    const fixture = await archiveFixture(userData, { version: '2.0.0' })

    await expect(manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))).rejects.toThrow()
    await expect(readFile(path.join(outsideRoot, 'keep.txt'), 'utf8')).resolves.toBe('keep')
  })

  it('removes partial staging on startup and reports update-available for a fully audited old active tree', async () => {
    const userData = await temporaryRoot()
    const componentRoot = path.join(userData, 'document-conversion')
    await writeComponentTree(path.join(componentRoot, 'active'), { version: '1.0.0' })
    await mkdir(path.join(componentRoot, 'staging', '00000000-0000-4000-8000-000000000001'), { recursive: true })
    await writeFile(path.join(componentRoot, 'staging', '00000000-0000-4000-8000-000000000001', 'partial'), 'partial')
    const fixture = await archiveFixture(userData, { version: '2.0.0' })

    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))

    expect(value.getState()).toMatchObject({ status: 'update-available', installedVersion: '1.0.0' })
    await expect(readdir(path.join(componentRoot, 'staging'))).resolves.toEqual([])
    await value.dispose()
  })

  it('restores a valid old backup only when active is absent or invalid', async () => {
    const userData = await temporaryRoot()
    const componentRoot = path.join(userData, 'document-conversion')
    const backup = path.join(componentRoot, 'backup', '00000000-0000-4000-8000-000000000001')
    await writeComponentTree(backup, { version: '1.0.0' })
    await mkdir(path.join(componentRoot, 'active'), { recursive: true })
    await writeFile(path.join(componentRoot, 'active', 'component-manifest.json'), JSON.stringify({ version: '2.0.0' }))
    const fixture = await archiveFixture(userData, { version: '2.0.0' })

    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))

    expect(value.getState()).toMatchObject({ status: 'update-available', installedVersion: '1.0.0' })
    expect(await readFile(path.join(componentRoot, 'active', 'python.exe'), 'utf8')).toBe('python-1.0.0')
    await expect(readdir(path.join(componentRoot, 'backup'))).resolves.toEqual([])
    await value.dispose()
  })

  it('does not restore a component tree from a non-UUID backup directory', async () => {
    const userData = await temporaryRoot()
    const componentRoot = path.join(userData, 'document-conversion')
    await writeComponentTree(path.join(componentRoot, 'backup', 'attacker-controlled'), { version: '1.0.0' })
    const fixture = await archiveFixture(userData, { version: '2.0.0' })

    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))

    expect(value.getState()).toMatchObject({ status: 'absent', installedVersion: null })
    await expect(readdir(path.join(componentRoot, 'backup'))).resolves.toEqual([])
    await value.dispose()
  })

  it('does not replace or delete an active tree while a runtime lease exists', async () => {
    const userData = await temporaryRoot()
    const oldFixture = await archiveFixture(userData, { version: '1.0.0' })
    const old = await manager(userData, oldFixture.descriptor, artifactSource(oldFixture.archivePath))
    await old.install('setup')
    await old.dispose()
    const nextFixture = await archiveFixture(userData, { version: '2.0.0' })
    const value = await manager(userData, nextFixture.descriptor, artifactSource(nextFixture.archivePath))
    await value.ensureVerified()
    const lease = value.acquireLease()

    expect(lease.runtime.version).toBe('1.0.0')
    await expect(value.install('update')).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(value.remove()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    lease.release()
    lease.release()
    await expect(value.install('update')).resolves.toMatchObject({ status: 'installed', installedVersion: '2.0.0' })
    await value.dispose()
  })

  it('publishes busy only for the first overlapping runtime lease and clears it on final release', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const setup = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))
    await setup.install('setup')
    await setup.dispose()
    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))
    const observed: DocumentConversionComponentState[] = []
    value.subscribe((state) => observed.push(state))

    expect(value.getState()).toMatchObject({ revision: 0, status: 'installed', busy: false })
    await value.ensureVerified()
    const first = value.acquireLease()
    expect(value.getState()).toMatchObject({ revision: 1, status: 'installed', busy: true })
    const second = value.acquireLease()
    expect(value.getState()).toMatchObject({ revision: 1, status: 'installed', busy: true })
    expect(observed).toHaveLength(1)

    first.release()
    first.release()
    expect(value.getState()).toMatchObject({ revision: 1, status: 'installed', busy: true })
    second.release()
    second.release()

    expect(value.getState()).toMatchObject({ revision: 2, status: 'installed', busy: false })
    expect(observed.map((state) => ({ revision: state.revision, busy: state.busy }))).toEqual([
      { revision: 1, busy: true },
      { revision: 2, busy: false },
    ])
    await value.dispose()
  })

  it('defers full installed-tree hashing until conversion verification is requested', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const setup = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))
    await setup.install('setup')
    await setup.dispose()
    const hashedFiles: string[] = []

    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath), {
      beforeHashFile: (filePath: string) => hashedFiles.push(filePath),
    })

    expect(value.getState()).toMatchObject({ status: 'installed', installedVersion: '2.0.0' })
    expect(hashedFiles).toEqual([])
    await expect(value.ensureVerified()).resolves.toBeUndefined()
    expect(hashedFiles.map((filePath) => path.basename(filePath)).sort()).toEqual([
      'arkdown_markitdown.py',
      'markitdown.py',
      'python.exe',
    ])
    await value.ensureVerified()
    expect(hashedFiles).toHaveLength(3)
    await value.dispose()
  })

  it('does not grant a new runtime lease after update activation begins', async () => {
    const userData = await temporaryRoot()
    const oldFixture = await archiveFixture(userData, { version: '1.0.0' })
    const old = await manager(userData, oldFixture.descriptor, artifactSource(oldFixture.archivePath))
    await old.install('setup')
    await old.dispose()
    const nextFixture = await archiveFixture(userData, { version: '2.0.0' })
    const { rename } = await import('node:fs/promises')
    let notifyActivation!: () => void
    const activationStarted = new Promise<void>((resolve) => { notifyActivation = resolve })
    let continueActivation!: () => void
    const activationGate = new Promise<void>((resolve) => { continueActivation = resolve })
    const value = await manager(userData, nextFixture.descriptor, artifactSource(nextFixture.archivePath), {
      rename: async (from: string, to: string) => {
        if (from.endsWith(`${path.sep}active`) && to.includes(`${path.sep}backup${path.sep}`)) {
          notifyActivation()
          await activationGate
        }
        await rename(from, to)
      },
    })
    const update = value.install('update')
    await activationStarted
    let unexpectedLease: ReturnType<typeof value.acquireLease> | undefined
    try {
      expect(() => { unexpectedLease = value.acquireLease() }).toThrow(expect.objectContaining({ code: 'OPERATION_FAILED' }))
    } finally {
      unexpectedLease?.release()
      continueActivation()
      await update
      await value.dispose()
    }
  })

  it('rolls a failed update activation back to the fully audited old version', async () => {
    const userData = await temporaryRoot()
    const oldFixture = await archiveFixture(userData, { version: '1.0.0' })
    const old = await manager(userData, oldFixture.descriptor, artifactSource(oldFixture.archivePath))
    await old.install('setup')
    await old.dispose()
    const nextFixture = await archiveFixture(userData, { version: '2.0.0' })
    const { rename } = await import('node:fs/promises')
    let failed = false
    const value = await manager(userData, nextFixture.descriptor, artifactSource(nextFixture.archivePath), {
      rename: async (from: string, to: string) => {
        if (!failed && from.includes(`${path.sep}staging${path.sep}`) && to.endsWith(`${path.sep}active`)) {
          failed = true
          throw new Error('private activation failure')
        }
        await rename(from, to)
      },
    })

    await expect(value.install('update')).resolves.toMatchObject({
      status: 'failed', installedVersion: '1.0.0', errorCode: 'DOCUMENT_CONVERSION_INSTALL_FAILED',
    })
    expect(value.resolveRuntime()?.version).toBe('1.0.0')
    expect(await readFile(path.join(userData, 'document-conversion', 'active', 'python.exe'), 'utf8')).toBe('python-1.0.0')
    await value.dispose()
  })

  it.each([
    ['missing package', appError('DOCUMENT_CONVERSION_PACKAGE_MISSING'), 'DOCUMENT_CONVERSION_PACKAGE_MISSING'],
    ['invalid component', appError('DOCUMENT_CONVERSION_COMPONENT_INVALID'), 'DOCUMENT_CONVERSION_COMPONENT_INVALID'],
    ['generic install failure', new Error('private install failure'), 'DOCUMENT_CONVERSION_INSTALL_FAILED'],
  ] as const)('publishes the stable %s error code', async (_label, failure, errorCode) => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const source: ComponentArtifactSource = {
      kind: 'packaged',
      async copyTo() { throw failure },
    }
    const value = await manager(userData, fixture.descriptor, source)

    await expect(value.install('window')).resolves.toMatchObject({ status: 'failed', errorCode })
    await expect(readdir(path.join(userData, 'document-conversion', 'staging'))).resolves.toEqual([])
    await value.dispose()
  })

  it('removes an idle component and is idempotent', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))
    await value.install('setup')

    await expect(value.remove()).resolves.toMatchObject({ status: 'absent', installedVersion: null })
    await expect(value.remove()).resolves.toMatchObject({ status: 'absent' })
    expect(value.resolveRuntime()).toBeUndefined()
    await value.dispose()
  })

  it('waits for an in-flight remove before dispose returns or cleans staging', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const setup = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))
    await setup.install('setup')
    await setup.dispose()
    const { rename } = await import('node:fs/promises')
    let notifyRemoveAwait!: () => void
    const removeAwait = new Promise<void>((resolve) => { notifyRemoveAwait = resolve })
    let continueRemove!: () => void
    const removeGate = new Promise<void>((resolve) => { continueRemove = resolve })
    const stagingRoot = path.join(userData, 'document-conversion', 'staging')
    let observeDisposeCleanup = false
    let removeSettled = false
    let cleanupObservedRemoveSettled: boolean | undefined
    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath), {
      rename: async (from: string, to: string) => {
        if (from.endsWith(`${path.sep}active`) && to.endsWith(`${path.sep}removed`)) {
          notifyRemoveAwait()
          await removeGate
        }
        await rename(from, to)
      },
      beforeReadDirectory: (root: string) => {
        if (observeDisposeCleanup && root === stagingRoot) {
          cleanupObservedRemoveSettled = removeSettled
        }
      },
    })
    const order: string[] = []
    const removing = value.remove()
    const removalOutcome = removing.then(
      (state) => {
        removeSettled = true
        order.push('remove')
        return { state }
      },
      (error: unknown) => {
        removeSettled = true
        order.push('remove')
        return { error }
      },
    )
    await removeAwait

    observeDisposeCleanup = true
    const disposing = value.dispose().then(() => { order.push('dispose') })
    continueRemove()
    const [removed] = await Promise.all([removalOutcome, disposing])

    expect(removed).toMatchObject({ state: { status: 'absent', installedVersion: null } })
    expect(cleanupObservedRemoveSettled).toBe(true)
    expect(order).toEqual(['remove', 'dispose'])
    await expect(lstat(path.join(userData, 'document-conversion', 'active'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(stagingRoot)).resolves.toEqual([])
  })

  it('prevents a remove that has not reached its commit gate when dispose begins', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const setup = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath))
    await setup.install('setup')
    await setup.dispose()
    const { rename } = await import('node:fs/promises')
    const removalRenames: string[] = []
    const value = await manager(userData, fixture.descriptor, artifactSource(fixture.archivePath), {
      rename: async (from: string, to: string) => {
        if (from.endsWith(`${path.sep}active`) && to.endsWith(`${path.sep}removed`)) {
          removalRenames.push(`${from} -> ${to}`)
        }
        await rename(from, to)
      },
    })

    const removing = value.remove()
    const disposing = value.dispose()

    await expect(removing).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await disposing
    expect(removalRenames).toEqual([])
    expect(await readFile(path.join(userData, 'document-conversion', 'active', 'python.exe'), 'utf8')).toBe('python-2.0.0')
  })

  it('dispose aborts owned work, cleans staging, unsubscribes listeners, and stops future mutations', async () => {
    const userData = await temporaryRoot()
    const fixture = await archiveFixture(userData, { version: '2.0.0' })
    const source = gatedArtifactSource(fixture.archivePath)
    const listener = vi.fn()
    const value = await manager(userData, fixture.descriptor, source)
    value.subscribe(listener)
    const installing = value.install('window')
    await source.started

    await value.dispose()
    await expect(installing).resolves.not.toMatchObject({ status: 'failed' })
    const callsAfterDispose = listener.mock.calls.length
    await expect(value.install('later')).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    await expect(value.remove()).rejects.toMatchObject({ code: 'OPERATION_FAILED' })
    expect(() => value.acquireLease()).toThrow(expect.objectContaining({ code: 'OPERATION_FAILED' }))
    expect(listener).toHaveBeenCalledTimes(callsAfterDispose)
    await expect(readdir(path.join(userData, 'document-conversion', 'staging'))).resolves.toEqual([])
  })
})
