import { lstat, mkdir, mkdtemp, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  validateResolvedConvertibleDocument,
  WorkspaceService,
} from '../../src/main/workspace/workspace-service'
import { resolveExistingInside } from '../../src/main/workspace/workspace-path'

const roots: string[] = []

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

it('keeps an explicit empty Save As activation and never treats an invalid active root as empty', async () => {
  const service = new WorkspaceService()
  expect(await service.getSaveAsActivationSnapshot()).toEqual({ root: null, epoch: 0 })
  const root = await createRoot('arkdown-save-as-activation-')
  await service.setRoot(root)
  const selected = await service.getSaveAsActivationSnapshot()
  expect(selected.root).toBe(await realpath(root))
  await rename(root, root + '-moved')
  roots.push(root + '-moved')
  await expect(service.getSaveAsActivationSnapshot()).rejects.toThrow()
  await service.restoreCanonicalRoot(null)
  expect(await service.getSaveAsActivationSnapshot()).toEqual({ root: null, epoch: 2 })
})

function directoryMetadata(dev?: unknown, ino?: unknown) {
  const metadata: { dev?: unknown; ino?: unknown; isDirectory: () => boolean } = {
    isDirectory: () => true,
  }
  if (dev !== undefined) metadata.dev = dev
  if (ino !== undefined) metadata.ino = ino
  return metadata
}

function validationIo(...metadata: ReturnType<typeof directoryMetadata>[]) {
  return {
    realpath: vi.fn(async (root: string) => root),
    stat: vi.fn(async () => {
      const next = metadata.shift()
      if (!next) throw new Error('Unexpected stat call')
      return next
    }),
    resolveExistingInside: vi.fn(async (root: string) => root),
  }
}

it('lists directories first, Markdown documents only, and stable slash-separated paths', async () => {
  const root = await createRoot('arkdown-tree-')
  await mkdir(path.join(root, 'zeta'))
  await mkdir(path.join(root, 'alpha'))
  await mkdir(path.join(root, 'alpha', 'nested'))
  await writeFile(path.join(root, 'z.MD'), '', 'utf8')
  await writeFile(path.join(root, 'a.markdown'), '', 'utf8')
  await writeFile(path.join(root, 'ignore.exe'), '', 'utf8')
  const service = new WorkspaceService()
  await service.setRoot(root)

  await expect(service.listDirectory('')).resolves.toEqual([
    { name: 'alpha', relativePath: 'alpha', kind: 'directory' },
    { name: 'zeta', relativePath: 'zeta', kind: 'directory' },
    { name: 'a.markdown', relativePath: 'a.markdown', kind: 'document' },
    { name: 'z.MD', relativePath: 'z.MD', kind: 'document' },
  ])
  await expect(service.listDirectory('alpha')).resolves.toEqual([
    { name: 'nested', relativePath: 'alpha/nested', kind: 'directory' },
  ])
})

it('does not list directory junctions that point outside the workspace', async () => {
  const root = await createRoot('arkdown-tree-')
  const outside = await createRoot('arkdown-outside-')
  await mkdir(path.join(outside, 'private'))
  await symlink(outside, path.join(root, 'escape'), 'junction')
  await writeFile(path.join(root, 'safe.md'), '', 'utf8')
  const service = new WorkspaceService()
  await service.setRoot(root)

  await expect(service.listDirectory('')).resolves.toEqual([
    { name: 'safe.md', relativePath: 'safe.md', kind: 'document' },
  ])
})

it('rejects access before a workspace is opened and refuses file roots', async () => {
  const service = new WorkspaceService()
  const root = await createRoot('arkdown-tree-')
  const file = path.join(root, 'not-a-workspace.md')
  await writeFile(file, '', 'utf8')

  expect(() => service.getRoot()).toThrow('No workspace is open')
  await expect(service.listDirectory('')).rejects.toThrow('No workspace is open')
  await expect(service.setRoot(file)).rejects.toThrow('Workspace must be a directory')
})


it('rejects a file passed to listDirectory', async () => {
  const root = await createRoot('arkdown-tree-')
  await writeFile(path.join(root, 'file.md'), '', 'utf8')
  const service = new WorkspaceService()
  await service.setRoot(root)

  await expect(service.listDirectory('file.md')).rejects.toThrow('Workspace path must be a directory')
})

it('rejects root replacement instead of browsing an outside junction', async () => {
  const root = await createRoot('arkdown-tree-')
  const outside = await createRoot('arkdown-outside-')
  const movedRoot = await createRoot('arkdown-moved-')
  await writeFile(path.join(root, 'inside.md'), '', 'utf8')
  await writeFile(path.join(outside, 'outside.md'), '', 'utf8')
  const service = new WorkspaceService()
  await service.setRoot(root)
  await rm(movedRoot, { recursive: true, force: true })
  await rename(root, movedRoot)
  await symlink(outside, root, 'junction')

  await expect(service.listDirectory('')).rejects.toThrow('Path is outside the workspace')
  await expect(resolveExistingInside(service.getRoot(), 'outside.md')).rejects.toThrow('Path is outside the workspace')
})

it.each([
  ['zero', directoryMetadata(0n, 1n)],
  ['missing', directoryMetadata(undefined, undefined)],
  ['non-bigint', directoryMetadata(1, 1n)],
  ['negative', directoryMetadata(-1n, 1n)],
])('fails closed when initial directory identity is %s', async (_case, invalidMetadata) => {
  const service = new WorkspaceService(validationIo(invalidMetadata))

  await expect(service.validateRoot('C:\\workspace')).rejects.toThrow(
    'Workspace directory identity is unavailable',
  )
  expect(() => service.getRoot()).toThrow('No workspace is open')
})

it.each([
  ['zero', directoryMetadata(1n, 0n)],
  ['missing', directoryMetadata(1n, undefined)],
  ['non-bigint', directoryMetadata(1n, 1)],
  ['negative', directoryMetadata(1n, -1n)],
])('keeps the old root when commit recheck identity is %s', async (_case, invalidMetadata) => {
  const validMetadata = () => directoryMetadata(1n, 1n)
  const service = new WorkspaceService(validationIo(
    validMetadata(),
    validMetadata(),
    validMetadata(),
    validMetadata(),
    validMetadata(),
    validMetadata(),
    validMetadata(),
    invalidMetadata,
  ))
  await service.setRoot('C:\\old-workspace')
  const activation = await service.validateRoot('C:\\new-workspace')

  await expect(activation.commit()).rejects.toThrow('Workspace directory identity is unavailable')
  expect(service.getRoot()).toBe('C:\\old-workspace')
})

it('restores a legitimate persisted canonical workspace', async () => {
  const root = await createRoot('arkdown-persisted-')
  const canonical = await realpath(root)
  const service = new WorkspaceService()

  await expect(service.restoreCanonicalRoot(canonical)).resolves.toEqual({
    name: path.basename(canonical),
    absolutePath: canonical,
  })
  expect(service.getRoot()).toBe(canonical)
})

it('restores the persisted no-workspace state from a null root', async () => {
  const root = await createRoot('arkdown-persisted-')
  const service = new WorkspaceService()
  await service.setRoot(root)

  await expect(service.restoreCanonicalRoot(null)).resolves.toBeNull()
  expect(() => service.getRoot()).toThrow('No workspace is open')
})

it('rejects a persisted canonical workspace redirected through a junction', async () => {
  const savedRoot = await createRoot('arkdown-persisted-')
  const outside = await createRoot('arkdown-outside-')
  const moved = await createRoot('arkdown-moved-')
  await rm(moved, { recursive: true, force: true })
  await rename(savedRoot, moved)
  roots.push(moved)
  await symlink(outside, savedRoot, 'junction')
  const service = new WorkspaceService()

  await expect(service.restoreCanonicalRoot(savedRoot)).rejects.toThrow('Persisted workspace path redirected')
  expect(() => service.getRoot()).toThrow('No workspace is open')
})

it('accepts Windows-equivalent casing and normalization for a persisted canonical workspace', async () => {
  const validMetadata = () => directoryMetadata(1n, 1n)
  const canonical = 'c:\\saved\\notes'
  const io = validationIo(
    validMetadata(), validMetadata(), validMetadata(), validMetadata(),
  )
  io.realpath.mockResolvedValue(canonical)
  const service = new WorkspaceService(io)

  await expect(service.restoreCanonicalRoot('C:\\SAVED\\notes\\.')).resolves.toEqual({
    name: 'notes',
    absolutePath: canonical,
  })
  expect(service.getRoot()).toBe(canonical)
})

it('rejects a relative persisted workspace before resolving it', async () => {
  const io = validationIo()
  const service = new WorkspaceService(io)

  await expect(service.restoreCanonicalRoot('relative\\notes')).rejects.toThrow(
    'Persisted workspace path must be absolute',
  )
  expect(io.realpath).not.toHaveBeenCalled()
  expect(() => service.getRoot()).toThrow('No workspace is open')
})

it('accepts a recreated directory at the same persisted canonical pathname', async () => {
  const root = await createRoot('arkdown-recreated-')
  const canonical = await realpath(root)
  await rm(root, { recursive: true, force: true })
  await mkdir(root)
  const service = new WorkspaceService()

  await expect(service.restoreCanonicalRoot(canonical)).resolves.toMatchObject({
    absolutePath: canonical,
  })
  expect(service.getRoot()).toBe(canonical)
})

it('rejects a vanished persisted canonical workspace', async () => {
  const root = await createRoot('arkdown-vanished-')
  const canonical = await realpath(root)
  await rm(root, { recursive: true, force: true })
  const service = new WorkspaceService()

  await expect(service.restoreCanonicalRoot(canonical)).rejects.toThrow()
  expect(() => service.getRoot()).toThrow('No workspace is open')
})

it('rejects a persisted canonical path that is not a directory', async () => {
  const root = await createRoot('arkdown-persisted-file-')
  const file = path.join(root, 'notes.md')
  await writeFile(file, '# notes', 'utf8')
  const canonical = await realpath(file)
  const service = new WorkspaceService()

  await expect(service.restoreCanonicalRoot(canonical)).rejects.toThrow('Workspace must be a directory')
  expect(() => service.getRoot()).toThrow('No workspace is open')
})

it.each(['pdf', 'pptx', 'xlsx', 'epub'])(
  'resolves an existing canonical workspace %s file to a trusted source token',
  async (extension) => {
    const root = await createRoot('arkdown-convertible-')
    const source = path.join(root, `source.${extension}`)
    await writeFile(source, 'fixture', 'utf8')
    const canonicalPath = await realpath(source)
    const metadata = await lstat(canonicalPath)
    const service = new WorkspaceService()
    await service.setRoot(root)

    const resolved = await service.resolveExistingConvertibleDocument(`source.${extension}`)

    expect(resolved).toEqual({
      canonicalPath,
      fileName: `source.${extension}`,
      format: extension,
      bytes: metadata.size,
      modifiedAtMs: Math.trunc(metadata.mtimeMs),
    })
    expect(Object.isFrozen(resolved)).toBe(true)
    await expect(validateResolvedConvertibleDocument(resolved)).resolves.toMatchObject({
      canonicalPath,
      device: metadata.dev,
      inode: metadata.ino,
      rawModifiedAtMs: metadata.mtimeMs,
    })
    await expect(validateResolvedConvertibleDocument({ ...resolved } as typeof resolved))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  },
)

it.each([
  ['an absolute path', (root: string) => path.join(root, 'source.pdf')],
  ['workspace traversal', () => '..\\outside.pdf'],
  ['a URL', () => 'https://example.test/source.pdf'],
  ['an unsupported hidden double extension', () => 'source.pdf.exe'],
  ['a missing file', () => 'missing.pdf'],
])('rejects %s as a convertible workspace path', async (_label, input) => {
  const root = await createRoot('arkdown-convertible-invalid-')
  await writeFile(path.join(root, 'source.pdf'), 'fixture', 'utf8')
  await writeFile(path.join(root, 'source.pdf.exe'), 'fixture', 'utf8')
  const service = new WorkspaceService()
  await service.setRoot(root)

  await expect(service.resolveExistingConvertibleDocument(input(root))).rejects.toThrow()
})

it('rejects a directory named with a convertible extension', async () => {
  const root = await createRoot('arkdown-convertible-directory-')
  await mkdir(path.join(root, 'folder.pdf'))
  const service = new WorkspaceService()
  await service.setRoot(root)

  await expect(service.resolveExistingConvertibleDocument('folder.pdf')).rejects.toThrow()
})

it('rejects a symlink or junction route even when its target remains inside the workspace', async ({ skip }) => {
  const root = await createRoot('arkdown-convertible-link-')
  const target = path.join(root, 'target')
  await mkdir(target)
  await writeFile(path.join(target, 'source.pdf'), 'fixture', 'utf8')
  try {
    await symlink(target, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    skip()
    return
  }
  const service = new WorkspaceService()
  await service.setRoot(root)

  await expect(service.resolveExistingConvertibleDocument('linked/source.pdf')).rejects.toThrow()
})

it.each(['reported reparse point', 'inspection failure'])(
  'fails closed when the Windows reparse-point check has a %s',
  async (scenario) => {
    const root = await createRoot('arkdown-convertible-reparse-')
    const source = path.join(root, 'source.pdf')
    await writeFile(source, 'fixture', 'utf8')
    const queryWindowsReparsePoint = vi.fn(async () => {
      if (scenario === 'inspection failure') throw new Error('fsutil unavailable')
      return true
    })
    const service = new WorkspaceService({
      realpath,
      stat: async (target) => stat(target, { bigint: true }),
      lstat,
      resolveExistingInside,
      queryWindowsReparsePoint,
    })
    await service.setRoot(root)

    await expect(service.resolveExistingConvertibleDocument('source.pdf'))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(queryWindowsReparsePoint).toHaveBeenCalledWith(await realpath(source))
  },
)

it('rejects a convertible file replaced between identity checks', async () => {
  const root = await createRoot('arkdown-convertible-race-')
  const source = path.join(root, 'source.pdf')
  const replacement = path.join(root, 'replacement.pdf')
  const original = path.join(root, 'original.pdf')
  await writeFile(source, 'first!', 'utf8')
  await writeFile(replacement, 'second', 'utf8')
  let sourceResolutions = 0
  const service = new WorkspaceService({
    realpath,
    stat: async (target) => stat(target, { bigint: true }),
    lstat,
    resolveExistingInside: async (anchor, relativePath) => {
      const resolved = await resolveExistingInside(anchor, relativePath)
      if (relativePath === 'source.pdf') sourceResolutions += 1
      if (sourceResolutions === 2) {
        await rename(source, original)
        await rename(replacement, source)
      }
      return resolved
    },
  })
  await service.setRoot(root)

  await expect(service.resolveExistingConvertibleDocument('source.pdf')).rejects.toThrow()
})

it('fails closed when persisted canonical workspace identity is unavailable', async () => {
  const io = validationIo(directoryMetadata(0n, 1n))
  const service = new WorkspaceService(io)

  await expect(service.restoreCanonicalRoot('C:\\saved\\notes')).rejects.toThrow(
    'Workspace directory identity is unavailable',
  )
  expect(() => service.getRoot()).toThrow('No workspace is open')
})

it('increments the activation epoch for every successful activation including A to B to A', async () => {
  const firstRoot = await createRoot('arkdown-epoch-a-')
  const secondRoot = await createRoot('arkdown-epoch-b-')
  const service = new WorkspaceService()

  await service.setRoot(firstRoot)
  const first = service.getActivationSnapshot()
  await service.setRoot(secondRoot)
  const second = service.getActivationSnapshot()
  await service.setRoot(firstRoot)
  const third = service.getActivationSnapshot()

  expect([first.epoch, second.epoch, third.epoch]).toEqual([1, 2, 3])
  expect(third.root).toBe(first.root)
})

it('holds workspace activation commits behind an active mutation lease', async () => {
  const firstRoot = await createRoot('arkdown-lease-a-')
  const secondRoot = await createRoot('arkdown-lease-b-')
  const service = new WorkspaceService()
  await service.setRoot(firstRoot)
  const expected = service.getActivationSnapshot()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered = false
  const mutation = service.withMutationLease(expected, async (fixedRoot) => {
    entered = true
    expect(fixedRoot).toBe(firstRoot)
    await gate
  })
  await vi.waitFor(() => expect(entered).toBe(true))
  let switched = false
  const switching = service.setRoot(secondRoot).then(() => { switched = true })

  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(switched).toBe(false)
  expect(service.getRoot()).toBe(firstRoot)
  release()
  await mutation
  await switching
  expect(service.getRoot()).toBe(secondRoot)
})
