import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { DocumentEncoding, NewlineStyle } from '../../src/shared/contracts'
import {
  DocumentService,
  nodeDocumentIO,
} from '../../src/main/documents/document-service'
import {
  canonicalFileIdentityFromStats,
} from '../../src/main/documents/document-identity'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'

const roots: string[] = []

afterEach(async () => Promise.all(
  roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
))

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function revision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fixture(contents: string | Buffer = '# One\n') {
  const root = await createRoot('arkdown-doc-')
  await writeFile(path.join(root, 'note.md'), contents)
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  return { root, workspace, service: new DocumentService(workspace) }
}

it.each(['source.ts', 'config.cjs', 'config.json', 'icon.svg', '.env.local'])('reads and saves %s as exact source including mixed EOL', async name => {
  const { root, service } = await fixture()
  const text = '\ufeffconst a = `<p>![a](temp/x.png)</p>`;\r\n\t// b\nlast\r'
  await writeFile(path.join(root, name), text, 'utf8')
  const snapshot = await service.read(name)
  expect(snapshot.markdown).toBe(text.slice(1))
  const saved = await service.save({ ...snapshot, expectedRevision: snapshot.revision, markdown: snapshot.markdown.replace('// b', '// changed') })
  expect(saved.revision).not.toBe(snapshot.revision)
  expect(await readFile(path.join(root, name), 'utf8')).toBe(text.replace('// b', '// changed'))
})

it('does not rewrite an unchanged code document', async () => {
  const { root, service } = await fixture()
  const file = path.join(root, 'data.json')
  await writeFile(file, '{\r\n\t"a": 1\n}')
  const before = await stat(file, { bigint: true })
  const snapshot = await service.read('data.json')
  await service.save({ ...snapshot, expectedRevision: snapshot.revision })
  const after = await stat(file, { bigint: true })
  expect(after.ino).toBe(before.ino)
  expect(after.mtimeNs).toBe(before.mtimeNs)
})

it('rejects oversized and binary code files before returning editable content', async () => {
  const { root, service } = await fixture()
  await writeFile(path.join(root, 'big.json'), Buffer.alloc(8 * 1024 * 1024 + 1, 32))
  await expect(service.read('big.json')).rejects.toThrow(/8 MiB/)
  await writeFile(path.join(root, 'binary.json'), Buffer.from([123, 0, 125]))
  await expect(service.read('binary.json')).rejects.toThrow(/binary/i)
})

it('rejects unsafe code save content before touching the original file', async () => {
  const { root, service } = await fixture()
  await writeFile(path.join(root, 'data.json'), '{}')
  const snapshot = await service.read('data.json')
  for (const markdown of ['a\u0000b', ' '.repeat(8 * 1024 * 1024 + 1)]) {
    await expect(service.save({ ...snapshot, expectedRevision: snapshot.revision, markdown })).rejects.toThrow()
    expect(await readFile(path.join(root, 'data.json'), 'utf8')).toBe('{}')
  }
})

async function temporaryArtifacts(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.tmp'))
}

function metadataWithIdentity<T extends object>(
  metadata: T,
  dev: unknown,
  ino: unknown,
): T {
  return new Proxy(metadata, {
    get(target, property, receiver) {
      if (property === 'dev') return dev
      if (property === 'ino') return ino
      return Reflect.get(target, property, receiver)
    },
  })
}

function handleWithIdentity(
  handle: Awaited<ReturnType<typeof nodeDocumentIO.open>>,
  dev: unknown,
  ino: unknown,
): Awaited<ReturnType<typeof nodeDocumentIO.open>> {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'stat') {
        return async (options: Parameters<typeof target.stat>[0]) => metadataWithIdentity(
          await target.stat(options),
          dev,
          ino,
        )
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

it('reads Markdown without changing bytes or modification time', async () => {
  const { root, service } = await fixture()
  const file = path.join(root, 'note.md')
  const beforeBytes = await readFile(file)
  const beforeMtime = (await stat(file)).mtimeMs

  const opened = await service.read('note.md')

  expect(opened.markdown).toBe('# One\n')
  expect(await readFile(file)).toEqual(beforeBytes)
  expect((await stat(file)).mtimeMs).toBe(beforeMtime)
})

it('keeps canonical file identity main-only while preserving the renderer read contract', async () => {
  const { root, service } = await fixture()
  const target = path.join(root, 'note.md')

  const rendererSnapshot = await service.read('note.md')
  const mainSnapshot = await service.readForMain('note.md')

  expect(Object.keys(rendererSnapshot).sort()).toEqual([
    'encoding', 'markdown', 'mtimeMs', 'newline', 'relativePath', 'revision',
  ])
  expect(mainSnapshot.document).toEqual(rendererSnapshot)
  expect(mainSnapshot.identity).toBe(canonicalFileIdentityFromStats(
    await stat(target, { bigint: true }),
  ))
  expect(Object.isFrozen(mainSnapshot)).toBe(true)
  expect(Object.isFrozen(mainSnapshot.document)).toBe(true)
})

it('creates a Save As target using the requested encoding and newline format', async () => {
  const { root, service } = await fixture()

  const created = await service.create('formatted.md', '# First\nSecond\n', {
    encoding: 'utf8-bom',
    newline: 'crlf',
  })

  expect(created).toMatchObject({ encoding: 'utf8-bom', newline: 'crlf' })
  const bytes = await readFile(path.join(root, 'formatted.md'))
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  expect(bytes.toString('utf8')).toContain('# First\r\nSecond\r\n')
})

it('fails closed after creating a target when its write handle does not close cleanly', async () => {
  const root = await createRoot('arkdown-doc-create-close-')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let published = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    open: async (target, flags) => {
      const handle = await nodeDocumentIO.open(target, flags)
      return new Proxy(handle, {
        get(realHandle, property) {
          if (property === 'close') {
            return async () => {
              await realHandle.close()
              throw new Error('created handle close failed')
            }
          }
          const value = Reflect.get(realHandle, property, realHandle)
          return typeof value === 'function' ? value.bind(realHandle) : value
        },
      })
    },
  })

  await expect(service.createForMain(
    'uncertain.md',
    '# uncertain\n',
    { encoding: 'utf8', newline: 'lf' },
    async () => { published = true },
  )).rejects.toThrow('created handle close failed')

  expect(published).toBe(true)
  await expect(readFile(path.join(root, 'uncertain.md'), 'utf8'))
    .resolves.toBe('# uncertain\n')
})

it('removes a just-created target before returning when identity publication fails', async () => {
  const { root, service } = await fixture()
  const publish = vi.fn(async () => { throw new Error('guard failed') })

  await expect(service.createForMain(
    'unpublished.md',
    '# unpublished\n',
    { encoding: 'utf8', newline: 'lf' },
    publish,
  )).rejects.toThrow('guard failed')

  expect(publish).toHaveBeenCalledOnce()
  await expect(stat(path.join(root, 'unpublished.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports rollback-incomplete when an unpublished create cleanup cannot resolve its pathname', async () => {
  const { root, service } = await fixture()

  const failure = service.createForMain(
    'unpublished.md',
    '# unpublished\n',
    { encoding: 'utf8', newline: 'lf' },
    async () => {
      await nodeDocumentIO.unlink(path.join(root, 'unpublished.md'))
      throw new Error('guard failed')
    },
  )

  await expect(failure).rejects.toMatchObject({
    name: 'DocumentRollbackIncompleteError',
    errors: [expect.objectContaining({ message: 'guard failed' }), expect.any(Error)],
  })
  await expect(stat(path.join(root, 'unpublished.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports rollback-incomplete when an unpublished create cleanup cannot stat its pathname', async () => {
  const root = await createRoot('arkdown-doc-create-cleanup-stat-')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let statCalls = 0
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    stat: async (target) => {
      statCalls += 1
      if (statCalls === 2) throw new Error('cleanup stat failed')
      return await nodeDocumentIO.stat(target)
    },
  })

  await expect(service.createForMain(
    'unpublished.md',
    '# unpublished\n',
    { encoding: 'utf8', newline: 'lf' },
    async () => { throw new Error('guard failed') },
  )).rejects.toMatchObject({
    name: 'DocumentRollbackIncompleteError',
    errors: [expect.objectContaining({ message: 'guard failed' }), expect.objectContaining({
      message: 'cleanup stat failed',
    })],
  })
  await expect(readFile(path.join(root, 'unpublished.md'), 'utf8'))
    .resolves.toBe('# unpublished\n')
})

it('reports rollback-incomplete when initial handle identity capture fails before cleanup', async () => {
  const root = await createRoot('arkdown-doc-create-initial-stat-')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let handleStatCalls = 0
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    open: async (target, flags) => {
      const handle = await nodeDocumentIO.open(target, flags)
      return new Proxy(handle, {
        get(realHandle, property) {
          if (property === 'stat') {
            return async (options: Parameters<typeof realHandle.stat>[0]) => {
              handleStatCalls += 1
              if (handleStatCalls === 1) throw new Error('initial handle stat failed')
              return await realHandle.stat(options)
            }
          }
          const value = Reflect.get(realHandle, property, realHandle)
          return typeof value === 'function' ? value.bind(realHandle) : value
        },
      })
    },
  })

  await expect(service.createForMain('unpublished.md', '# unpublished\n'))
    .rejects.toMatchObject({
      name: 'DocumentRollbackIncompleteError',
      errors: [expect.objectContaining({ message: 'initial handle stat failed' }), expect.any(Error)],
    })
  await expect(readFile(path.join(root, 'unpublished.md'), 'utf8'))
    .resolves.toBe('# unpublished\n')
})

it('reports rollback-incomplete and preserves the target when cleanup identity checks fail', async () => {
  const root = await createRoot('arkdown-doc-create-cleanup-identity-')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let handleStatCalls = 0
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    open: async (target, flags) => {
      const handle = await nodeDocumentIO.open(target, flags)
      return new Proxy(handle, {
        get(realHandle, property) {
          if (property === 'stat') {
            return async (options: Parameters<typeof realHandle.stat>[0]) => {
              handleStatCalls += 1
              const metadata = await realHandle.stat(options)
              return handleStatCalls === 2
                ? metadataWithIdentity(metadata, metadata.dev, BigInt(metadata.ino) + 1n)
                : metadata
            }
          }
          const value = Reflect.get(realHandle, property, realHandle)
          return typeof value === 'function' ? value.bind(realHandle) : value
        },
      })
    },
  })

  await expect(service.createForMain(
    'unpublished.md',
    '# unpublished\n',
    { encoding: 'utf8', newline: 'lf' },
    async () => { throw new Error('guard failed') },
  )).rejects.toMatchObject({
    name: 'DocumentRollbackIncompleteError',
    errors: [expect.objectContaining({ message: 'guard failed' }), expect.any(Error)],
  })
  await expect(readFile(path.join(root, 'unpublished.md'), 'utf8'))
    .resolves.toBe('# unpublished\n')
})

it('reports rollback-incomplete when an unpublished create cleanup cannot unlink its pathname', async () => {
  const root = await createRoot('arkdown-doc-create-cleanup-unlink-')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    unlink: async () => { throw new Error('cleanup unlink failed') },
  })

  await expect(service.createForMain(
    'unpublished.md',
    '# unpublished\n',
    { encoding: 'utf8', newline: 'lf' },
    async () => { throw new Error('guard failed') },
  )).rejects.toMatchObject({
    name: 'DocumentRollbackIncompleteError',
    errors: [expect.objectContaining({ message: 'guard failed' }), expect.objectContaining({
      message: 'cleanup unlink failed',
    })],
  })
  await expect(readFile(path.join(root, 'unpublished.md'), 'utf8'))
    .resolves.toBe('# unpublished\n')
})

it('fails closed and retains a newly-created target when identity-bound deletion is unavailable', async () => {
  const { root, service } = await fixture()
  const created = await service.create('saved.md', '# Saved\n')
  const opened = await service.readForMain(created.relativePath)

  await expect(service.removeCreatedForRollback(
    created.relativePath,
    opened.identity,
    opened.document.revision,
  )).rejects.toMatchObject({
    name: 'DocumentRollbackIncompleteError',
    code: 'DOCUMENT_ROLLBACK_INCOMPLETE',
    errors: [
      expect.objectContaining({ message: 'Created document rollback was requested' }),
      expect.objectContaining({ message: expect.stringContaining('safely') }),
    ],
  })

  await expect(readFile(path.join(root, 'saved.md'), 'utf8')).resolves.toBe('# Saved\n')
})

it('never enters a pathname unlink boundary where a same-identity write could win the race', async () => {
  const root = await createRoot('arkdown-doc-rollback-race-')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const unsafeUnlink = vi.fn(async (target: string) => {
    await writeFile(target, '# Raced external write\n')
    await nodeDocumentIO.unlink(target)
  })
  const service = new DocumentService(workspace, { ...nodeDocumentIO, unlink: unsafeUnlink })
  const created = await service.createForMain('saved.md', '# Saved\n')

  await expect(service.removeCreatedForRollback(
    created.document.relativePath,
    created.identity,
    created.document.revision,
  )).rejects.toMatchObject({
    name: 'DocumentRollbackIncompleteError',
    code: 'DOCUMENT_ROLLBACK_INCOMPLETE',
  })

  expect(unsafeUnlink).not.toHaveBeenCalled()
  await expect(readFile(path.join(root, 'saved.md'), 'utf8')).resolves.toBe('# Saved\n')
})

it('refuses Save As rollback deletion after another process replaces the pathname identity', async () => {
  const { root, service } = await fixture()
  const created = await service.create('saved.md', '# Saved\n')
  const opened = await service.readForMain(created.relativePath)
  const replacement = path.join(root, 'replacement.md')
  await writeFile(replacement, '# External replacement\n')
  await rename(replacement, path.join(root, 'saved.md'))

  await expect(service.removeCreatedForRollback(
    created.relativePath,
    opened.identity,
    opened.document.revision,
  ))
    .rejects.toMatchObject({
      name: 'DocumentRollbackIncompleteError',
      code: 'DOCUMENT_ROLLBACK_INCOMPLETE',
      errors: [expect.any(Error), expect.objectContaining({ message: expect.stringContaining('changed') })],
    })
  expect(await readFile(path.join(root, 'saved.md'), 'utf8')).toBe('# External replacement\n')
})

it('refuses Save As rollback deletion after in-place external content mutation', async () => {
  const { root, service } = await fixture()
  const created = await service.create('saved.md', '# Saved\n')
  const opened = await service.readForMain(created.relativePath)
  await writeFile(path.join(root, 'saved.md'), '# External mutation\n')

  await expect(service.removeCreatedForRollback(
    created.relativePath,
    opened.identity,
    opened.document.revision,
  )).rejects.toMatchObject({
    name: 'DocumentRollbackIncompleteError',
    code: 'DOCUMENT_ROLLBACK_INCOMPLETE',
    errors: [expect.any(Error), expect.objectContaining({ message: expect.stringContaining('changed') })],
  })
  expect(await readFile(path.join(root, 'saved.md'), 'utf8')).toBe('# External mutation\n')
})

it('returns the persisted successor identity only from the main save API', async () => {
  const { root, service } = await fixture()
  const target = path.join(root, 'note.md')
  const opened = await service.readForMain('note.md')

  const saved = await service.saveForMain({
    ...opened.document,
    expectedRevision: opened.document.revision,
    markdown: '# Successor\n',
  })

  expect(saved.identity).toBe(canonicalFileIdentityFromStats(
    await stat(target, { bigint: true }),
  ))
  expect(saved.identity).not.toBe(opened.identity)
  expect(Object.keys(saved.result).sort()).toEqual(['mtimeMs', 'revision'])
  expect(Object.isFrozen(saved)).toBe(true)
  expect(Object.isFrozen(saved.result)).toBe(true)
})

it('publishes the atomic successor identity before any post-replace observer can run', async () => {
  const root = await createRoot('arkdown-doc-publish-')
  await writeFile(path.join(root, 'note.md'), '# One\n')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let published = false
  const onStage = vi.fn(async (event: { stage: string }) => {
    if (event.stage === 'save-persisted-bound') expect(published).toBe(true)
  })
  const service = new DocumentService(workspace, nodeDocumentIO, { onStage })
  const opened = await service.readForMain('note.md')

  const saved = await service.saveForMain({
    ...opened.document,
    expectedRevision: opened.document.revision,
    markdown: '# Replaced\n',
  }, async (successor) => {
    published = true
    expect(successor.identity).not.toBe(opened.identity)
  })

  expect(published).toBe(true)
  expect(saved.result.revision).toBe(revision(Buffer.from('# Replaced\n')))
  expect(onStage).toHaveBeenCalledWith(expect.objectContaining({ stage: 'save-persisted-bound' }))
})

it('guards the verified successor before replacement and publishes only after replacement', async () => {
  const { root, workspace } = await fixture()
  const target = path.join(root, 'note.md')
  const events: string[] = []
  let guardedIdentity: string | undefined
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    rename: async (source, destination) => {
      expect(events).toEqual(['guard'])
      expect(canonicalFileIdentityFromStats(await stat(source, { bigint: true }))).toBe(guardedIdentity)
      await nodeDocumentIO.rename(source, destination)
      events.push('replace')
    },
  })
  const opened = await service.readForMain('note.md')
  const saved = await service.saveForMain({
    ...opened.document, expectedRevision: opened.document.revision, markdown: '# Saved\n',
  }, async (successor) => {
    expect(events).toEqual(['guard', 'replace'])
    expect(successor.identity).toBe(guardedIdentity)
    expect(canonicalFileIdentityFromStats(await stat(target, { bigint: true }))).toBe(successor.identity)
    events.push('publish')
  }, async (replacement) => {
    expect(Object.isFrozen(replacement)).toBe(true)
    expect(replacement.sourceIdentity).toBe(opened.identity)
    expect(replacement.successorIdentity).not.toBe(opened.identity)
    expect(canonicalFileIdentityFromStats(await stat(target, { bigint: true }))).toBe(opened.identity)
    guardedIdentity = replacement.successorIdentity
    events.push('guard')
  })
  expect(events).toEqual(['guard', 'replace', 'publish'])
  expect(saved.identity).toBe(guardedIdentity)
})

it('does not replace or publish when the pre-replace identity guard rejects', async () => {
  const { root, service } = await fixture()
  const opened = await service.readForMain('note.md')
  const publish = vi.fn()
  await expect(service.saveForMain({
    ...opened.document, expectedRevision: opened.document.revision, markdown: '# Must not save\n',
  }, publish, async () => { throw new Error('guard unavailable') })).rejects.toThrow('guard unavailable')
  expect(await service.readForMain('note.md')).toEqual(opened)
  expect(publish).not.toHaveBeenCalled()
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('revalidates the source identity after the pre-replace guard even when bytes are unchanged', async () => {
  const { root, service } = await fixture()
  const opened = await service.readForMain('note.md')
  const publish = vi.fn()
  await expect(service.saveForMain({
    ...opened.document, expectedRevision: opened.document.revision, markdown: '# Must not save\n',
  }, publish, async () => {
    const external = path.join(root, 'external.md')
    await writeFile(external, opened.document.markdown, 'utf8')
    await rename(external, path.join(root, 'note.md'))
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })
  const actual = await service.readForMain('note.md')
  expect(actual.identity).not.toBe(opened.identity)
  expect(actual.document.markdown).toBe(opened.document.markdown)
  expect(publish).not.toHaveBeenCalled()
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('accepts supported text files and returns slash-separated relative paths', async () => {
  const root = await createRoot('arkdown-doc-')
  await mkdir(path.join(root, 'docs'))
  await writeFile(path.join(root, 'docs', 'note.markdown'), '# Nested\n', 'utf8')
  await writeFile(path.join(root, 'plain.txt'), 'plain', 'utf8')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const service = new DocumentService(workspace)

  await expect(service.read('docs\\note.markdown')).resolves.toMatchObject({
    relativePath: 'docs/note.markdown',
  })
  await expect(service.read('plain.txt')).resolves.toMatchObject({
    relativePath: 'plain.txt',
    markdown: 'plain',
  })
})

it('replaces an existing file on the real Windows filesystem when the revision matches', async () => {
  expect(process.platform).toBe('win32')
  const { root, service } = await fixture()
  const opened = await service.read('note.md')

  const saved = await service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Two\n',
  })

  const persisted = await readFile(path.join(root, 'note.md'))
  expect(persisted.toString('utf8')).toBe('# Two\n')
  expect(saved.revision).toBe(revision(persisted))
  expect(saved.revision).not.toBe(opened.revision)
  expect(saved.mtimeMs).toBe((await stat(path.join(root, 'note.md'))).mtimeMs)
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('preserves UTF-8 BOM and CRLF when saving an opened document', async () => {
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# One\r\nBody\r\n', 'utf8'),
  ])
  const { root, service } = await fixture(source)
  const opened = await service.read('note.md')

  await service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Two\nBody\n',
  })

  expect(await readFile(path.join(root, 'note.md'))).toEqual(Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# Two\r\nBody\r\n', 'utf8'),
  ]))
})

it('refuses to overwrite an external modification', async () => {
  const { root, service } = await fixture()
  const opened = await service.read('note.md')
  await writeFile(path.join(root, 'note.md'), '# External\n', 'utf8')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# External\n')
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('reports deterministic queue and content stages for save instrumentation', async () => {
  const { workspace } = await fixture()
  const stages: Array<{ stage: string; waiting?: boolean }> = []
  const service = new DocumentService(workspace, nodeDocumentIO, {
    async onStage(event) { stages.push(event) },
  })
  const opened = await service.read('note.md')

  await service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Two\n',
  })

  expect(stages).toEqual([
    expect.objectContaining({ stage: 'save-queued', waiting: false }),
    expect.objectContaining({ stage: 'save-content-start' }),
    expect.objectContaining({ stage: 'save-current-bound' }),
    expect.objectContaining({ stage: 'save-latest-bound' }),
    expect.objectContaining({ stage: 'save-persisted-bound' }),
  ])
})

it('retries a deterministic temporary suffix collision', async () => {
  const { root, workspace } = await fixture()
  const collision = `.note.md.${process.pid}.collision.tmp`
  await writeFile(path.join(root, collision), 'existing', 'utf8')
  const suffixes = ['collision', 'replacement']
  let suffixCalls = 0
  const service = new DocumentService(workspace, nodeDocumentIO, {
    temporarySuffix() {
      const suffix = suffixes[suffixCalls]
      suffixCalls += 1
      return suffix
    },
  })
  const opened = await service.read('note.md')

  await service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Two\n',
  })

  expect(suffixCalls).toBe(2)
  expect(await readFile(path.join(root, collision), 'utf8')).toBe('existing')
  expect(await temporaryArtifacts(root)).toEqual([collision])
})

it('serializes saves through different in-workspace junction aliases of one document', async () => {
  const root = await createRoot('arkdown-doc-')
  const documents = path.join(root, 'documents')
  await mkdir(documents)
  await writeFile(path.join(documents, 'note.md'), '# One\n', 'utf8')
  await symlink(documents, path.join(root, 'alias'), 'junction')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)

  let firstContentReached!: () => void
  let releaseFirstContent!: () => void
  const firstContent = new Promise<void>((resolve) => { firstContentReached = resolve })
  const firstRelease = new Promise<void>((resolve) => { releaseFirstContent = resolve })
  let aliasQueued!: (waiting: boolean) => void
  const queuedAlias = new Promise<boolean>((resolve) => { aliasQueued = resolve })
  let heldFirst = false
  const service = new DocumentService(workspace, nodeDocumentIO, {
    async onStage(event) {
      if (event.stage === 'save-content-start' && !heldFirst) {
        heldFirst = true
        firstContentReached()
        await firstRelease
      }
      if (event.stage === 'save-queued' && event.relativePath === 'alias/note.md') {
        aliasQueued(event.waiting === true)
      }
    },
  })
  const opened = await service.read('documents/note.md')
  const firstSave = service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Same\n',
  })
  await firstContent
  const secondSave = service.save({
    ...opened,
    relativePath: 'alias/note.md',
    expectedRevision: opened.revision,
    markdown: '# Same\n',
  })

  expect(await queuedAlias).toBe(true)
  releaseFirstContent()
  const results = await Promise.allSettled([firstSave, secondSave])

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({ code: 'DOCUMENT_CONFLICT' }),
    }),
  ])
  expect(await readFile(path.join(documents, 'note.md'), 'utf8')).toBe('# Same\n')
})

it('rejects a queued junction save rebound to another canonical target before content I/O', async () => {
  const root = await createRoot('arkdown-doc-')
  const directoryA = path.join(root, 'a')
  const directoryB = path.join(root, 'b')
  const alias = path.join(root, 'alias')
  await mkdir(directoryA)
  await mkdir(directoryB)
  await writeFile(path.join(directoryA, 'note.md'), '# One\n', 'utf8')
  await writeFile(path.join(directoryB, 'note.md'), '# One\n', 'utf8')
  await symlink(directoryA, alias, 'junction')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)

  let firstContentReached!: () => void
  let releaseFirstContent!: () => void
  const firstContent = new Promise<void>((resolve) => { firstContentReached = resolve })
  const firstRelease = new Promise<void>((resolve) => { releaseFirstContent = resolve })
  let aliasQueued!: (waiting: boolean) => void
  const queuedAlias = new Promise<boolean>((resolve) => { aliasQueued = resolve })
  let heldA = false
  let trackReboundContent = false
  let reboundContentOpens = 0
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      if (trackReboundContent && filePath === path.join(directoryB, 'note.md')) {
        reboundContentOpens += 1
      }
      return nodeDocumentIO.open(filePath, flags)
    },
  }, {
    async onStage(event) {
      if (event.stage === 'save-content-start' && event.relativePath === 'a/note.md' && !heldA) {
        heldA = true
        firstContentReached()
        await firstRelease
      }
      if (event.stage === 'save-queued' && event.relativePath === 'alias/note.md') {
        aliasQueued(event.waiting === true)
      }

    },
  })
  const openedA = await service.read('a/note.md')
  const openedB = await service.read('b/note.md')
  const directA = service.save({
    ...openedA,
    expectedRevision: openedA.revision,
    markdown: '# A saved\n',
  })
  await firstContent
  const reboundSave = service.save({
    ...openedA,
    relativePath: 'alias/note.md',
    expectedRevision: openedA.revision,
    markdown: '# Alias saved\n',
  })
  expect(await queuedAlias).toBe(true)

  await rm(alias, { recursive: true, force: true })
  await symlink(directoryB, alias, 'junction')
  const directB = await service.save({
    ...openedB,
    expectedRevision: openedB.revision,
    markdown: '# B saved\n',
  })
  expect(directB.revision).toBe(revision(Buffer.from('# B saved\n')))

  trackReboundContent = true
  releaseFirstContent()
  await expect(directA).resolves.toBeDefined()
  await expect(reboundSave).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })
  expect(reboundContentOpens).toBe(0)
  expect(await readFile(path.join(directoryB, 'note.md'), 'utf8')).toBe('# B saved\n')
})
it('serializes saves so two matching expected revisions cannot both succeed', async () => {
  const { root, service } = await fixture()
  const opened = await service.read('note.md')

  const results = await Promise.allSettled([
    service.save({ ...opened, expectedRevision: opened.revision, markdown: '# First\n' }),
    service.save({ ...opened, expectedRevision: opened.revision, markdown: '# Second\n' }),
  ])

  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((result) => result.status === 'rejected')).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({ code: 'DOCUMENT_CONFLICT' }),
    }),
  ])
  expect(['# First\n', '# Second\n']).toContain(
    await readFile(path.join(root, 'note.md'), 'utf8'),
  )
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('rejects a changed temporary source before replacing the target', async () => {
  const { root, workspace } = await fixture()
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      if (flags === 'r' && filePath.endsWith('.tmp')) {
        await writeFile(filePath, '# Corrupt\n', 'utf8')
      }
      return nodeDocumentIO.open(filePath, flags)
    },
  })
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# One\n')
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('rechecks the temporary source after the final target read before replacement', async () => {
  const { root, workspace } = await fixture()
  const target = path.join(root, 'note.md')
  const original = await readFile(target)
  let targetReads = 0
  let temporaryPath: string | undefined
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      const handle = await nodeDocumentIO.open(filePath, flags)
      if (flags === 'wx') temporaryPath = filePath
      if (flags === 'r' && filePath === target) {
        targetReads += 1
        if (targetReads === 3 && temporaryPath) {
          await rm(temporaryPath, { force: true })
          await writeFile(temporaryPath, '# Replaced temp\n', 'utf8')
        }
      }
      return handle
    },
  })
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(targetReads).toBeGreaterThanOrEqual(3)
  expect(await readFile(target)).toEqual(original)
})

it('cleans its temporary file when a late revision check detects a conflict', async () => {
  const { root, workspace } = await fixture()
  const target = path.join(root, 'note.md')
  let changed = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      const handle = await nodeDocumentIO.open(filePath, flags)
      if (flags === 'wx' && !changed) {
        changed = true
        await writeFile(target, '# External\n', 'utf8')
      }
      return handle
    },
  })
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(await readFile(target, 'utf8')).toBe('# External\n')
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('closes and cleans a temporary file when its first handle stat fails', async () => {
  const { root, workspace } = await fixture()
  let firstStat = true
  let temporaryClosed = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      const handle = await nodeDocumentIO.open(filePath, flags)
      if (flags !== 'wx') return handle
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (options: Parameters<typeof target.stat>[0]) => {
              if (firstStat) {
                firstStat = false
                throw new Error('simulated initial stat failure')
              }
              return target.stat(options)
            }
          }
          if (property === 'close') {
            return async () => {
              await target.close()
              temporaryClosed = true
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    async unlink(filePath) {
      if (!temporaryClosed) throw new Error('temporary handle is still open')
      await nodeDocumentIO.unlink(filePath)
    },
  })
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toThrow('simulated initial stat failure')

  expect(temporaryClosed).toBe(true)
  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# One\n')
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('closes a failed temporary handle before cleaning it up', async () => {
  const { root, workspace } = await fixture()
  let temporaryClosed = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      const handle = await nodeDocumentIO.open(filePath, flags)
      if (flags !== 'wx') return handle
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'writeFile') {
            return async () => { throw new Error('simulated write failure') }
          }
          if (property === 'close') {
            return async () => {
              await target.close()
              temporaryClosed = true
            }
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
    async unlink(filePath) {
      if (!temporaryClosed) throw new Error('temporary handle is still open')
      await nodeDocumentIO.unlink(filePath)
    },
  })
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toThrow('simulated write failure')

  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# One\n')
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('cleans its temporary file when atomic replacement fails', async () => {
  const { root, workspace } = await fixture()
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async rename() {
      throw new Error('simulated replacement failure')
    },
  })
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toThrow('simulated replacement failure')

  expect(await readFile(path.join(root, 'note.md'), 'utf8')).toBe('# One\n')
  expect(await temporaryArtifacts(root)).toEqual([])
})

it('does not report success when another writer changes the target after replacement', async () => {
  const { root, workspace } = await fixture()
  const target = path.join(root, 'note.md')
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async rename(source, destination) {
      await nodeDocumentIO.rename(source, destination)
      await writeFile(target, '# After\n', 'utf8')
    },
  })
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(await readFile(target, 'utf8')).toBe('# After\n')
  expect(await temporaryArtifacts(root)).toEqual([])
})

it.each([
  ['zero', 0n, 0n],
  ['negative', -1n, 9n],
  ['missing', undefined, undefined],
])('rejects read when filesystem identity is %s', async (_label, dev, ino) => {
  const { workspace } = await fixture()
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      return handleWithIdentity(await nodeDocumentIO.open(filePath, flags), dev, ino)
    },
    async stat(filePath) {
      return metadataWithIdentity(await nodeDocumentIO.stat(filePath), dev, ino)
    },
  })

  await expect(service.read('note.md')).rejects.toThrow('Filesystem identity is unavailable')
})

it('rejects save before overwrite when the target identity is zero', async () => {
  const { root, workspace, service: reader } = await fixture()
  const target = path.join(root, 'note.md')
  const original = await readFile(target)
  const opened = await reader.read('note.md')
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      const handle = await nodeDocumentIO.open(filePath, flags)
      return filePath === target ? handleWithIdentity(handle, 0n, 0n) : handle
    },
    async stat(filePath) {
      const metadata = await nodeDocumentIO.stat(filePath)
      return filePath === target ? metadataWithIdentity(metadata, 0n, 0n) : metadata
    },
  })

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toThrow('Filesystem identity is unavailable')
  expect(await readFile(target)).toEqual(original)
})

it('leaves an orphan instead of unlinking a temporary file with zero identity', async () => {
  const { root, workspace, service: reader } = await fixture()
  const target = path.join(root, 'note.md')
  const original = await readFile(target)
  const opened = await reader.read('note.md')
  let unlinkCalls = 0
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      const handle = await nodeDocumentIO.open(filePath, flags)
      return flags === 'wx' ? handleWithIdentity(handle, 0n, 0n) : handle
    },
    async stat(filePath) {
      const metadata = await nodeDocumentIO.stat(filePath)
      return filePath.endsWith('.tmp')
        ? metadataWithIdentity(metadata, 0n, 0n)
        : metadata
    },
    async unlink(filePath) {
      unlinkCalls += 1
      await nodeDocumentIO.unlink(filePath)
    },
  })

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toThrow('Filesystem identity is unavailable')
  expect(unlinkCalls).toBe(0)
  expect(await readFile(target)).toEqual(original)
  expect(await temporaryArtifacts(root)).toHaveLength(1)
})

it('re-resolves the destination after final temp verification before rename', async () => {
  const root = await createRoot('arkdown-doc-')
  const documents = path.join(root, 'documents')
  const movedDocuments = path.join(root, 'moved-documents')
  const outside = await createRoot('arkdown-outside-')
  await mkdir(documents)
  const target = path.join(documents, 'note.md')
  const outsideTarget = path.join(outside, 'note.md')
  const original = Buffer.from('# One\n')
  const outsideOriginal = Buffer.from('# Outside\n')
  await writeFile(target, original)
  await writeFile(outsideTarget, outsideOriginal)
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let temporaryReads = 0
  let rebound = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      const handle = await nodeDocumentIO.open(filePath, flags)
      if (flags !== 'r' || !filePath.endsWith('.tmp')) return handle
      temporaryReads += 1
      if (temporaryReads !== 2) return handle
      return new Proxy(handle, {
        get(openHandle, property) {
          if (property === 'close') {
            return async () => {
              await openHandle.close()
              await rename(documents, movedDocuments)
              await symlink(outside, documents, 'junction')
              await writeFile(path.join(outside, path.basename(filePath)), '# Hostile temp\n')
              rebound = true
            }
          }
          const value = Reflect.get(openHandle, property, openHandle)
          return typeof value === 'function' ? value.bind(openHandle) : value
        },
      })
    },
  })
  const opened = await service.read('documents/note.md')

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(rebound).toBe(true)
  expect(await readFile(path.join(movedDocuments, 'note.md'))).toEqual(original)
  expect(await readFile(outsideTarget)).toEqual(outsideOriginal)
})

it('keeps queue ownership when the queued-stage observer throws', async () => {
  const { workspace, service: reader } = await fixture()
  const opened = await reader.read('note.md')
  let releaseFirst!: () => void
  let firstStarted!: () => void
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve })
  const firstContent = new Promise<void>((resolve) => { firstStarted = resolve })
  let secondObserverReached!: () => void
  const secondObserver = new Promise<void>((resolve) => { secondObserverReached = resolve })
  let thirdQueued!: (waiting: boolean) => void
  const thirdQueue = new Promise<boolean>((resolve) => { thirdQueued = resolve })
  let queuedCount = 0
  let heldFirst = false
  const service = new DocumentService(workspace, nodeDocumentIO, {
    async onStage(event) {
      if (event.stage === 'save-content-start' && !heldFirst) {
        heldFirst = true
        firstStarted()
        await firstRelease
      }
      if (event.stage !== 'save-queued') return
      queuedCount += 1
      if (queuedCount === 2) {
        secondObserverReached()
        throw new Error('simulated observer failure')
      }
      if (queuedCount === 3) thirdQueued(event.waiting === true)
    },
  })
  const firstSave = service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# First\n',
  })
  await firstContent
  const failedObserverSave = service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Second\n',
  })
  void failedObserverSave.catch(() => undefined)
  await secondObserver
  await Promise.resolve()
  const thirdSave = service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Third\n',
  })

  expect(await thirdQueue).toBe(true)
  releaseFirst()
  await expect(firstSave).resolves.toBeDefined()
  await expect(failedObserverSave).rejects.toThrow('simulated observer failure')
  await expect(thirdSave).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })
})

it('rechecks queue binding after the content observer before opening document bytes', async () => {
  const root = await createRoot('arkdown-doc-')
  const directoryA = path.join(root, 'a')
  const directoryB = path.join(root, 'b')
  const alias = path.join(root, 'alias')
  await mkdir(directoryA)
  await mkdir(directoryB)
  await writeFile(path.join(directoryA, 'note.md'), '# One\n', 'utf8')
  await writeFile(path.join(directoryB, 'note.md'), '# Two\n', 'utf8')
  await symlink(directoryA, alias, 'junction')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let openedB = 0
  let rebound = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      if (filePath === path.join(directoryB, 'note.md')) openedB += 1
      return nodeDocumentIO.open(filePath, flags)
    },
  }, {
    async onStage(event) {
      if (event.stage !== 'save-content-start' || rebound) return
      await rm(alias, { recursive: true, force: true })
      await symlink(directoryB, alias, 'junction')
      rebound = true
    },
  })
  const opened = await service.read('alias/note.md')

  await expect(service.save({
    ...opened,
    relativePath: 'alias/note.md',
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })
  expect(rebound).toBe(true)
  expect(openedB).toBe(0)
})

it('does not open rebound content after the current target was canonically bound', async () => {
  const root = await createRoot('arkdown-doc-')
  const directoryA = path.join(root, 'a')
  const directoryB = path.join(root, 'b')
  const alias = path.join(root, 'alias')
  const targetA = path.join(directoryA, 'note.md')
  const targetB = path.join(directoryB, 'note.md')
  await mkdir(directoryA)
  await mkdir(directoryB)
  await writeFile(targetA, '# A\n', 'utf8')
  await writeFile(targetB, '# B\n', 'utf8')
  await symlink(directoryA, alias, 'junction')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let bContentOpens = 0
  let rebound = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      if (filePath === targetB) bContentOpens += 1
      return nodeDocumentIO.open(filePath, flags)
    },
  }, {
    async onStage(event) {
      if (event.stage !== 'save-current-bound' || rebound) return
      await rm(alias, { recursive: true, force: true })
      await symlink(directoryB, alias, 'junction')
      rebound = true
    },
  })
  const opened = await service.read('alias/note.md')
  const originalA = await readFile(targetA)
  const originalB = await readFile(targetB)

  await expect(service.save({
    ...opened,
    relativePath: 'alias/note.md',
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(rebound).toBe(true)
  expect(bContentOpens).toBe(0)
  expect(await readFile(targetA)).toEqual(originalA)
  expect(await readFile(targetB)).toEqual(originalB)
})

it('does not open rebound content after the latest target was canonically bound', async () => {
  const root = await createRoot('arkdown-doc-')
  const directoryA = path.join(root, 'a')
  const directoryB = path.join(root, 'b')
  const alias = path.join(root, 'alias')
  const targetA = path.join(directoryA, 'note.md')
  const targetB = path.join(directoryB, 'note.md')
  await mkdir(directoryA)
  await mkdir(directoryB)
  await writeFile(targetA, '# Same\n', 'utf8')
  await writeFile(targetB, '# Same\n', 'utf8')
  await symlink(directoryA, alias, 'junction')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  let bContentOpens = 0
  let rebound = false
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async open(filePath, flags) {
      if (filePath === targetB) bContentOpens += 1
      return nodeDocumentIO.open(filePath, flags)
    },
  }, {
    async onStage(event) {
      if (event.stage !== 'save-latest-bound' || rebound) return
      await rm(alias, { recursive: true, force: true })
      await symlink(directoryB, alias, 'junction')
      rebound = true
    },
  })
  const opened = await service.read('alias/note.md')
  const originalA = await readFile(targetA)
  const originalB = await readFile(targetB)

  await expect(service.save({
    ...opened,
    relativePath: 'alias/note.md',
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toMatchObject({ code: 'DOCUMENT_CONFLICT' })

  expect(rebound).toBe(true)
  expect(bContentOpens).toBe(0)
  expect(await readFile(targetA)).toEqual(originalA)
  expect(await readFile(targetB)).toEqual(originalB)
})

it('does not unlink a valid temp when cleanup pathname identity becomes unavailable', async () => {
  const { root, workspace, service: reader } = await fixture()
  const target = path.join(root, 'note.md')
  const original = await readFile(target)
  const opened = await reader.read('note.md')
  let cleanupPhase = false
  let cleanupIdentityChecks = 0
  let unlinkCalls = 0
  const service = new DocumentService(workspace, {
    ...nodeDocumentIO,
    async stat(filePath) {
      const metadata = await nodeDocumentIO.stat(filePath)
      if (cleanupPhase && filePath.endsWith('.tmp')) {
        cleanupIdentityChecks += 1
        return metadataWithIdentity(metadata, undefined, undefined)
      }
      return metadata
    },
    async rename() {
      cleanupPhase = true
      throw new Error('simulated replacement failure')
    },
    async unlink(filePath) {
      unlinkCalls += 1
      await nodeDocumentIO.unlink(filePath)
    },
  })

  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    markdown: '# Mine\n',
  })).rejects.toThrow('simulated replacement failure')
  expect(cleanupIdentityChecks).toBeGreaterThanOrEqual(1)
  expect(unlinkCalls).toBe(0)
  expect(await readFile(target)).toEqual(original)
  expect(await temporaryArtifacts(root)).toHaveLength(1)
})

it('rejects invalid runtime save metadata and unsupported paths', async () => {
  const { service } = await fixture()
  const opened = await service.read('note.md')

  await expect(service.save({
    ...opened,
    relativePath: 'note.docx',
    expectedRevision: opened.revision,
  })).rejects.toThrow('不支持的文件类型')
  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    encoding: 'utf16' as DocumentEncoding,
  })).rejects.toThrow('Unsupported document encoding')
  await expect(service.save({
    ...opened,
    expectedRevision: opened.revision,
    newline: 'cr' as NewlineStyle,
  })).rejects.toThrow('Unsupported newline style')
})

it('rejects read and save after the workspace root is rebound to an outside junction', async () => {
  const root = await createRoot('arkdown-doc-')
  const outside = await createRoot('arkdown-outside-')
  const movedRoot = await createRoot('arkdown-moved-')
  await writeFile(path.join(root, 'note.md'), '# Inside\n', 'utf8')
  const outsideBytes = Buffer.from('# Outside\n', 'utf8')
  const outsideTarget = path.join(outside, 'note.md')
  await writeFile(outsideTarget, outsideBytes)
  const beforeMtime = (await stat(outsideTarget)).mtimeMs
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const service = new DocumentService(workspace)
  await rm(movedRoot, { recursive: true, force: true })
  await rename(root, movedRoot)
  await symlink(outside, root, 'junction')

  await expect(service.read('note.md')).rejects.toThrow('Path is outside the workspace')
  await expect(service.save({
    relativePath: 'note.md',
    markdown: '# Mine\n',
    expectedRevision: revision(outsideBytes),
    encoding: 'utf8',
    newline: 'lf',
  })).rejects.toThrow('Path is outside the workspace')

  expect(await readFile(outsideTarget)).toEqual(outsideBytes)
  expect((await stat(outsideTarget)).mtimeMs).toBe(beforeMtime)
})

it('rejects existing final junctions that escape the workspace', async () => {
  const root = await createRoot('arkdown-doc-')
  const outside = await createRoot('arkdown-outside-')
  const outsideTarget = path.join(outside, 'secret.md')
  const outsideBytes = Buffer.from('# Secret\n', 'utf8')
  await writeFile(outsideTarget, outsideBytes)
  await symlink(outside, path.join(root, 'escape.md'), 'junction')
  const workspace = new WorkspaceService()
  await workspace.setRoot(root)
  const service = new DocumentService(workspace)

  await expect(service.read('escape.md')).rejects.toThrow(
    'Path is outside the workspace',
  )
  await expect(service.save({
    relativePath: 'escape.md',
    markdown: '# Mine\n',
    expectedRevision: revision(outsideBytes),
    encoding: 'utf8',
    newline: 'lf',
  })).rejects.toThrow('Path is outside the workspace')
  expect(await readFile(outsideTarget)).toEqual(outsideBytes)
})
