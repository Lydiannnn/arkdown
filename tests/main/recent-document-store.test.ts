import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecentDocumentStore } from '../../src/main/recent-documents/recent-document-store'
import { recentDocumentsPath } from '../../src/main/settings/portable-paths'

const roots: string[] = []

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-recent-documents-'))
  roots.push(root)
  return root
}

async function createDocument(root: string, name: string): Promise<string> {
  const absolutePath = path.join(root, name)
  await writeFile(absolutePath, `# ${name}\n`, 'utf8')
  return absolutePath
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('RecentDocumentStore', () => {
  it.each(['code.ts', 'config.json', 'icon.svg', 'Dockerfile'])('records explicit source documents %s', async name => {
    const root = await temporaryRoot()
    const target = await createDocument(root, name)
    const store = new RecentDocumentStore(root)
    await store.record(target)
    expect(store.list()).toEqual([target])
  })
  it('keeps the newest spelling when deduplicating Windows paths case-insensitively', async () => {
    const root = await temporaryRoot()
    const original = await createDocument(root, 'One.md')
    const latestSpelling = original.toUpperCase()
    const store = new RecentDocumentStore(root)

    await store.record(original)
    await store.record(latestSpelling)

    expect(store.list()).toEqual([path.normalize(latestSpelling)])
  })

  it('serializes concurrent records without losing newest-first history and caps it at ten', async () => {
    const root = await temporaryRoot()
    const documents = await Promise.all(
      Array.from({ length: 12 }, (_, index) => createDocument(root, `${index}.md`)),
    )
    const store = new RecentDocumentStore(root)

    await Promise.all(documents.map((document) => store.record(document)))

    expect(store.list()).toEqual(documents.slice(2).reverse().map((entry) => path.normalize(entry)))
    const persisted = JSON.parse(await readFile(recentDocumentsPath(root), 'utf8')) as unknown
    expect(persisted).toEqual({ version: 1, paths: store.list() })
  })

  it('loads only regular supported absolute files from the exact versioned shape', async () => {
    const root = await temporaryRoot()
    const documents = await Promise.all(
      Array.from({ length: 12 }, (_, index) => createDocument(root, `valid-${index}.md`)),
    )
    const directory = path.join(root, 'folder.md')
    await mkdir(directory)
    const unsupported = await createDocument(root, 'attachment.pdf')
    await writeFile(recentDocumentsPath(root), JSON.stringify({
      version: 1,
      paths: [
        'relative.md',
        directory,
        unsupported,
        documents[0].toUpperCase(),
        documents[0],
        ...documents.slice(1),
      ],
    }), 'utf8')

    const store = new RecentDocumentStore(root)
    await expect(store.load()).resolves.toEqual([
      path.normalize(documents[0].toUpperCase()),
      ...documents.slice(1, 10).map((entry) => path.normalize(entry)),
    ])
  })

  it.each([
    ['corrupt JSON', '{broken'],
    ['wrong version', JSON.stringify({ version: 2, paths: [] })],
    ['wrong shape', JSON.stringify({ version: 1, paths: 'C:\\Docs\\one.md' })],
  ])('treats %s as empty without crashing startup', async (_label, contents) => {
    const root = await temporaryRoot()
    await writeFile(recentDocumentsPath(root), contents, 'utf8')

    const store = new RecentDocumentStore(root)

    await expect(store.load()).resolves.toEqual([])
    expect(store.list()).toEqual([])
  })

  it('ignores a persisted recent file larger than 64 KiB before validating candidates', async () => {
    const root = await temporaryRoot()
    const document = await createDocument(root, 'bounded.md')
    const isRegularFile = vi.fn(async () => true)
    const contents = `${JSON.stringify({ version: 1, paths: [document] })}${' '.repeat(65 * 1024)}`
    await writeFile(recentDocumentsPath(root), contents, 'utf8')
    const store = new RecentDocumentStore(root, { isRegularFile })

    await expect(store.load()).resolves.toEqual([])
    expect(isRegularFile).not.toHaveBeenCalled()
  })

  it('bounds startup filesystem validation to the first 100 persisted candidates', async () => {
    const root = await temporaryRoot()
    const candidates = Array.from(
      { length: 101 },
      (_, index) => `C:\\Docs\\candidate-${index}.md`,
    )
    await writeFile(recentDocumentsPath(root), JSON.stringify({
      version: 1,
      paths: candidates,
    }), 'utf8')
    const isRegularFile = vi.fn(async () => false)
    const store = new RecentDocumentStore(root, { isRegularFile })

    await expect(store.load()).resolves.toEqual([])
    expect(isRegularFile).toHaveBeenCalledTimes(100)
  })

  it('bounds startup validation by ten operations and a deadline without dropping timed-out paths', async () => {
    vi.useFakeTimers()
    try {
      const root = await temporaryRoot()
      const candidates = Array.from(
        { length: 12 },
        (_, index) => `C:\\Docs\\startup-${index}.md`,
      )
      const persisted = JSON.stringify({
        version: 1,
        paths: candidates,
      })
      const lateValid = deferred<boolean>()
      const lateMissing = deferred<boolean>()
      const never = new Promise<boolean>(() => undefined)
      const isRegularFile = vi.fn((absolutePath: string) => {
        if (absolutePath.endsWith('startup-0.md')) return lateValid.promise
        if (absolutePath.endsWith('startup-1.md')) return lateMissing.promise
        if (absolutePath.endsWith('startup-2.md')) return never
        return Promise.resolve(true)
      })
      const store = new RecentDocumentStore(root, {
        isRegularFile,
        readTextFile: vi.fn(async () => persisted),
      })
      const loadForStartup = (store as unknown as {
        loadForStartup?: (options: {
          maxCandidates: number
          maxConcurrency: number
          overallTimeoutMs: number
          perPathTimeoutMs: number
        }) => Promise<readonly string[]>
      }).loadForStartup

      expect(loadForStartup).toBeTypeOf('function')
      if (!loadForStartup) return
      const loading = loadForStartup.call(store, {
        maxCandidates: 10,
        maxConcurrency: 10,
        overallTimeoutMs: 50,
        perPathTimeoutMs: 25,
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(isRegularFile).toHaveBeenCalledTimes(10)

      lateValid.resolve(true)
      lateMissing.resolve(false)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(25)
      await expect(loading).resolves.toEqual([
        path.win32.normalize(candidates[0]),
        path.win32.normalize(candidates[2]),
        ...candidates.slice(3, 10).map((candidate) => path.win32.normalize(candidate)),
      ])
      expect(store.list()).toHaveLength(9)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores invalid record targets and writes only the recent file under the portable root', async () => {
    const root = await temporaryRoot()
    const unrelated = path.join(root, 'settings.json')
    const directory = path.join(root, 'directory.md')
    const unsupported = await createDocument(root, 'image.png')
    const valid = await createDocument(root, 'note.md')
    await mkdir(directory)
    await writeFile(unrelated, '{"keep":true}\n', 'utf8')
    const writeTextFileAtomic = vi.fn(async (filePath: string, contents: string) => {
      await writeFile(filePath, contents, 'utf8')
    })
    const store = new RecentDocumentStore(root, { writeTextFileAtomic })

    await store.record('relative.md')
    await store.record(directory)
    await store.record(unsupported)
    await store.record(valid)

    expect(store.list()).toEqual([path.normalize(valid)])
    expect(writeTextFileAtomic).toHaveBeenCalledOnce()
    expect(writeTextFileAtomic).toHaveBeenCalledWith(
      recentDocumentsPath(root),
      `${JSON.stringify({ version: 1, paths: [path.normalize(valid)] }, null, 2)}\n`,
    )
    expect(await readFile(unrelated, 'utf8')).toBe('{"keep":true}\n')
  })

  it('serializes remove behind pending records and persists the resulting list', async () => {
    const root = await temporaryRoot()
    const one = await createDocument(root, 'one.md')
    const two = await createDocument(root, 'two.md')
    const store = new RecentDocumentStore(root)

    await Promise.all([
      store.record(one),
      store.record(two),
      store.remove(one.toUpperCase()),
    ])

    expect(store.list()).toEqual([path.normalize(two)])
    expect(JSON.parse(await readFile(recentDocumentsPath(root), 'utf8'))).toEqual({
      version: 1,
      paths: [path.normalize(two)],
    })
  })

  it('rolls back in-memory history when an atomic write fails', async () => {
    const root = await temporaryRoot()
    const one = await createDocument(root, 'one.md')
    const two = await createDocument(root, 'two.md')
    const writeTextFileAtomic = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockImplementation(async (filePath: string, contents: string) => {
        await writeFile(filePath, contents, 'utf8')
      })
    const store = new RecentDocumentStore(root, { writeTextFileAtomic })

    await expect(store.record(one)).rejects.toThrow('disk full')
    expect(store.list()).toEqual([])
    await expect(store.record(two)).resolves.toEqual([path.normalize(two)])
    expect(JSON.parse(await readFile(recentDocumentsPath(root), 'utf8'))).toEqual({
      version: 1,
      paths: [path.normalize(two)],
    })
  })

  it('keeps a recent entry in memory when its atomic removal fails', async () => {
    const root = await temporaryRoot()
    const document = await createDocument(root, 'one.md')
    const store = new RecentDocumentStore(root)
    await store.record(document)
    const failingStore = new RecentDocumentStore(root, {
      writeTextFileAtomic: vi.fn(async () => { throw new Error('disk full') }),
    })
    await failingStore.load()

    await expect(failingStore.remove(document)).rejects.toThrow('disk full')
    expect(failingStore.list()).toEqual([path.normalize(document)])
  })
})
