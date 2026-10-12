import { createHash } from 'node:crypto'
import {
  mkdir,
  link,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiPositiveCursor } from '../../src/shared/ai-conversation'
import {
  DocumentService, nodeDocumentIO, type DocumentIO, type DocumentServiceOptions,
} from '../../src/main/documents/document-service'
import { createAiRendererPortBridge, createIpcOperations } from '../../src/main/ipc/register-ipc'
import { canonicalFileIdentityFromStats } from '../../src/main/documents/document-identity'
import {
  OpenDocumentRegistry,
  type OpenDocumentEditorPort,
  type OpenDocumentRegistration,
} from '../../src/main/documents/open-document-registry'
import {
  RegistryWorkspaceAiEditorBoundary,
  type WorkspaceAiEditorTarget,
} from '../../src/main/documents/workspace-ai-editor-boundary'
import { AiOperationJournal } from '../../src/main/workspace/ai-operation-journal'
import {
  AiOperationOutcomeUnknownError,
} from '../../src/main/workspace/ai-operation-journal'
import {
  WorkspaceAiFileService,
  type WorkspaceAiFileServiceOptions,
  type WorkspaceAiMutationExecution,
  type WindowsWorkspaceCommitAdapter,
  type WorkspaceAiCommitRequest,
} from '../../src/main/workspace/workspace-ai-file-service'
import { WorkspaceService } from '../../src/main/workspace/workspace-service'
import { resolveExistingInside } from '../../src/main/workspace/workspace-path'

const roots: string[] = []
let sequence = 0

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 2_000): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function fileId(metadata: BigIntStats): string {
  return `${metadata.dev.toString(16)}.${metadata.ino.toString(16)}`
}

function contentHash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

function statefulEditor(options: {
  markdown?: string
  revision?: number
  dirty?: boolean
  loseApplyAck?: boolean
  queryResult?: 'recorded' | 'unknown' | 'unavailable' | 'stale' | 'not-applied'
  nonmonotonicApply?: boolean
} = {}) {
  const state = {
    markdown: options.markdown ?? '# Dirty editor',
    revision: options.revision ?? 9,
    dirty: options.dirty ?? true,
    applyCalls: 0,
    queryCalls: 0,
  }
  const outcomes = new Map<string, Awaited<ReturnType<OpenDocumentEditorPort['queryOutcome']>>>()
  const port: OpenDocumentEditorPort = {
    async captureReadSnapshot(input) {
      return {
        status: 'captured', ...input,
        editorRevision: state.revision, contentHash: contentHash(state.markdown),
        markdown: state.markdown, dirty: state.dirty,
      }
    },
    async planReplacement(input) {
      if (input.expectedEditorRevision !== state.revision
        || input.expectedContentHash !== contentHash(state.markdown)) return { status: 'stale' }
      return {
        status: 'planned', registrationToken: input.registrationToken,
        registrationRevision: input.registrationRevision, bindingToken: input.bindingToken,
        bindingRevision: input.bindingRevision, operationId: input.operationId,
        editorRevision: state.revision, contentHash: contentHash(state.markdown),
      }
    },
    async applyTransaction(input) {
      state.applyCalls += 1
      if (input.expectedEditorRevision !== state.revision
        || input.expectedContentHash !== contentHash(state.markdown)) return { status: 'stale' }
      state.markdown = input.replacementMarkdown
      if (!options.nonmonotonicApply) state.revision += 1
      const applied = {
        status: 'applied' as const,
        registrationToken: input.registrationToken,
        registrationRevision: input.registrationRevision,
        bindingToken: input.bindingToken,
        bindingRevision: input.bindingRevision,
        operationId: input.operationId,
        editorRevision: state.revision,
        contentHash: contentHash(state.markdown),
        dirty: true,
      }
      outcomes.set(input.operationId, applied)
      if (options.loseApplyAck) throw new Error('simulated lost ACK')
      return applied
    },
    async queryOutcome(input) {
      state.queryCalls += 1
      if (options.queryResult && options.queryResult !== 'recorded') return { status: options.queryResult }
      return outcomes.get(input.operationId) ?? { status: 'not-applied' }
    },
  }
  return { port, state }
}

async function registerEditor(
  registry: OpenDocumentRegistry,
  target: WorkspaceAiEditorTarget,
  port: OpenDocumentEditorPort,
): Promise<OpenDocumentRegistration> {
  return await registry.register(await registry.reserve(target), port)
}

async function matchesIdentity(expected: {
  absolutePath: string
  fileId: string
  size?: number
  mtimeMs?: number
  ctimeNs?: string
}, directory: boolean): Promise<boolean> {
  try {
    const metadata = await stat(expected.absolutePath, { bigint: true })
    return (directory ? metadata.isDirectory() : metadata.isFile())
      && fileId(metadata) === expected.fileId
      && (expected.size === undefined || Number(metadata.size) === expected.size)
      && (expected.mtimeMs === undefined || Math.trunc(Number(metadata.mtimeNs / 1_000_000n)) === expected.mtimeMs)
      && (expected.ctimeNs === undefined || String(metadata.ctimeNs) === expected.ctimeNs)
      && await realpath(expected.absolutePath) === expected.absolutePath
  } catch {
    return false
  }
}

function testCommitAdapter(options: {
  recycled: string
  beforeCommit?(request: WorkspaceAiCommitRequest): Promise<void>
  unknownAfterCommit?: boolean
}): WindowsWorkspaceCommitAdapter {
  return {
    commit: vi.fn(async (request) => {
      await options.beforeCommit?.(request)
      const rootMetadata = await stat(request.root.rootFinalPath, { bigint: true })
      if (rootMetadata.dev.toString(16) !== request.root.rootVolumeSerial
        || rootMetadata.ino.toString(16) !== request.root.rootFileId
        || await realpath(request.root.rootFinalPath) !== request.root.rootFinalPath) {
        return { status: 'rejected' as const, reason: 'root-changed' as const }
      }
      for (const parent of request.parents) {
        if (!await matchesIdentity(parent, true)) {
          return { status: 'rejected' as const, reason: 'parent-changed' as const }
        }
      }
      if ('source' in request && !await matchesIdentity(request.source, false)) {
        return { status: 'rejected' as const, reason: 'source-changed' as const }
      }

      if (request.kind === 'edit') {
        await writeFile(request.source.absolutePath, request.bytes)
      } else if (request.kind === 'create') {
        let handle
        try {
          handle = await open(request.destination.absolutePath, 'wx')
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            return { status: 'rejected' as const, reason: 'destination-exists' as const }
          }
          throw error
        }
        await handle.writeFile(request.bytes)
        await handle.close()
      } else if (request.kind === 'rename') {
        try {
          await stat(request.destination.absolutePath)
          return { status: 'rejected' as const, reason: 'destination-exists' as const }
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        await rename(request.source.absolutePath, request.destination.absolutePath)
      } else {
        await rename(request.source.absolutePath, path.join(options.recycled, path.basename(request.source.absolutePath)))
      }
      return options.unknownAfterCommit
        ? { status: 'unknown' as const, reason: 'post-commit-verification-failed' as const }
        : { status: 'committed' as const }
    }),
  }
}

async function fixture(options: {
  beforeCommit?(request: WorkspaceAiCommitRequest): Promise<void>
  commitAdapter?: WindowsWorkspaceCommitAdapter | null
  unknownAfterCommit?: boolean
  documentIo?: DocumentIO
  documentOptions?: DocumentServiceOptions
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-files-'))
  const recycled = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-recycled-'))
  roots.push(root, recycled)
  await mkdir(path.join(root, 'notes'))
  await writeFile(path.join(root, 'notes', 'a.md'), '# A', 'utf8')
  await writeFile(path.join(root, 'source.pdf'), 'fake-pdf', 'utf8')
  await writeFile(path.join(root, 'source.docx'), 'fake-docx', 'utf8')
  const workspace = new WorkspaceService({
    realpath,
    stat: async (candidate) => {
      const metadata = await stat(candidate, { bigint: true })
      if (typeof metadata.dev !== 'bigint' || typeof metadata.ino !== 'bigint'
        || metadata.dev <= 0n || metadata.ino <= 0n) {
        // Diagnose the exact validation input without retrying or replacing it.
        console.error('fixture directory identity', {
          devType: typeof metadata.dev,
          inoType: typeof metadata.ino,
          dev: String(metadata.dev),
          ino: String(metadata.ino),
        })
      }
      return metadata
    },
    resolveExistingInside,
  })
  await workspace.setRoot(root)
  const conversions = {
    convertResolved: vi.fn(async (resolved: {
      canonicalPath: string
      fileName: string
      format: 'pdf' | 'pptx' | 'xlsx' | 'epub'
      bytes: number
      modifiedAtMs: number
    }) => ({
      source: {
        absolutePath: resolved.canonicalPath,
        fileName: resolved.fileName,
        format: resolved.format,
        bytes: resolved.bytes,
        modifiedAtMs: resolved.modifiedAtMs,
      },
      markdown: '# Converted\n\nNormalized PDF text.',
      converterVersion: '1.0.0',
      fingerprint: 'b'.repeat(64),
      warnings: [],
    })),
  }
  const docx = {
    import: vi.fn(async (sourceAbsolutePath: string) => ({
      sourceAbsolutePath,
      sourceFileName: path.basename(sourceAbsolutePath),
      markdown: `<img src="${path.join(root, 'temp', 'docx', 'unsafe.png')}" alt="unsafe" />`,
    })),
    importText: vi.fn(async (_sourceAbsolutePath: string) => ({
      text: [
        '# Imported',
        '',
        'Normalized DOCX text.',
        '',
        'User paths: C:\\Notes\\original.txt and file:///C:/Notes/original.txt',
        '',
        '[image omitted]',
      ].join('\n'),
    })),
  }
  const journal = new AiOperationJournal<WorkspaceAiMutationExecution>()
  const documents = new DocumentService(workspace, options.documentIo, options.documentOptions)
  const editorRegistry = new OpenDocumentRegistry()
  const editorBoundary = new RegistryWorkspaceAiEditorBoundary(editorRegistry)
  const commitAdapter = options.commitAdapter === null
    ? undefined
    : options.commitAdapter ?? testCommitAdapter({
      recycled,
      beforeCommit: options.beforeCommit,
      unknownAfterCommit: options.unknownAfterCommit,
    })
  const service = new WorkspaceAiFileService({
    windowId: 7,
    workspace,
    documents,
    editorBoundary,
    conversions,
    docx,
    commitAdapter,
    journal,
    operationId: () => `${String(++sequence).padStart(8, '0')}-1111-4111-8111-111111111111`,
    nonce: () => `nonce-${sequence}`,
  })
  return {
    commitAdapter, conversions, docx, documents, editorBoundary, editorRegistry,
    journal, recycled, root, service, workspace,
  }
}

async function targetFor(
  service: WorkspaceAiFileService,
  absolutePath: string,
): Promise<WorkspaceAiEditorTarget> {
  const capability = await service.getRootCapability()
  return Object.freeze({
    windowId: capability.windowId,
    workspaceId: capability.workspaceId,
    generation: capability.workspaceGeneration,
    fileIdentity: canonicalFileIdentityFromStats(await stat(absolutePath, { bigint: true })),
  })
}

async function readAll(service: WorkspaceAiFileService, relativePath: string) {
  return await service.readDocument({ path: relativePath, cursor: 0, maxChars: 48_000 })
}

async function ordinarySaveFixture(options: {
  documentIo?: DocumentIO
  documentOptions?: DocumentServiceOptions
} = {}) {
  const state = await fixture(options)
  const editor = statefulEditor({ markdown: '# Saved from editor', revision: 17 })
  const responseErrors: unknown[] = []
  const desktopAi = {
    ownerId: 7,
    getWorkspaceAuthority: async () => {
      const capability = await state.service.getRootCapability()
      return { workspaceId: capability.workspaceId, workspaceGeneration: capability.workspaceGeneration }
    },
  }
  const bridge = createAiRendererPortBridge({
    window: {
      isDestroyed: () => false,
      webContents: {
        id: 7, mainFrame: {}, isDestroyed: () => false,
        send: (_channel: string, request: {
          transportRequestId: string
          documentHandle: string
          method: keyof OpenDocumentEditorPort
          payload: never
        }) => {
          void editor.port[request.method](request.payload, new AbortController().signal).then(async (result) => {
            const publicKeys = ['status', 'editorRevision', 'contentHash', 'markdown', 'dirty']
            await bridge.submitOpenDocumentResponse({
              transportRequestId: request.transportRequestId,
              documentHandle: request.documentHandle,
              method: request.method,
              result: Object.fromEntries(Object.entries(result).filter(([key]) => publicKeys.includes(key))),
            })
          }).catch((error) => { responseErrors.push(error) })
        },
      },
    },
    desktopAi,
  } as never)
  const operations = createIpcOperations({
    workspace: state.workspace, documents: state.documents,
    desktopAi, aiRendererPorts: bridge, openDocumentRegistry: state.editorRegistry,
    chooseDirectory: vi.fn(async () => null),
    getLastWorkspace: vi.fn(() => state.root), setLastWorkspace: vi.fn(), reportError: vi.fn(),
  } as never)
  const opened = await operations.readDocument({ relativePath: 'notes/a.md' })
  if (!opened.ok) throw new Error(`ordinary-save open failed: ${opened.error.code}`)
  const registered = await operations.registerAiOpenDocumentPort()
  if (!registered.ok) throw new Error(`ordinary-save registration failed: ${registered.error.code}`)
  const save = () => operations.saveDocument({
    relativePath: 'notes/a.md', markdown: '# Saved from editor',
    expectedRevision: opened.value.revision, encoding: 'utf8', newline: 'lf',
  })
  return { ...state, bridge, editor, operations, registered, responseErrors, save }
}

it('publishes main-only current write authority after ownership and preserves it through ordinary save', async () => {
  const state = await ordinarySaveFixture()
  try {
    const first = state.operations.getCurrentDocumentWriteAuthority()
    expect(first).toMatchObject({ path: 'notes/a.md', session: expect.any(Number) })
    await expect(state.save()).resolves.toMatchObject({ ok: true })
    expect(state.operations.getCurrentDocumentWriteAuthority()).toEqual(first)
    // Reopening even the same path starts a different main-owned selection.
    await expect(state.operations.readDocument({ relativePath: 'notes/a.md' })).resolves.toMatchObject({ ok: true })
    expect(state.operations.getCurrentDocumentWriteAuthority()?.session).toBeGreaterThan(first!.session)
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-authority-'))
    roots.push(otherRoot)
    await state.workspace.setRoot(otherRoot)
    expect(state.operations.getCurrentDocumentWriteAuthority()).toBeNull()
  } finally { await state.bridge.dispose() }
})

it('recognizes only validated awaiting-approval editor edit plans as implicit-current candidates', async () => {
  const state = await fixture()
  const disk = await readAll(state.service, 'notes/a.md')
  const closed = await state.service.planEdit({ path: 'notes/a.md', content: '# B', expectedVersion: disk.version }, 'closed-route')
  expect(state.service.isPlannedEditorEdit(closed)).toBe(false)
  state.service.abandon(closed, 'test-finished')
  const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
  await registerEditor(state.editorRegistry, target, statefulEditor().port)
  const editor = await readAll(state.service, 'notes/a.md')
  const planned = await state.service.planEdit({ path: 'notes/a.md', content: '# B', expectedVersion: editor.version }, 'editor-route')
  expect(state.service.isPlannedEditorEdit(planned)).toBe(true)
  expect(() => state.service.isPlannedEditorEdit({ ...planned, relativePaths: ['notes/other.md'] })).toThrow()
  state.service.authorize(planned, planned.nonce)
  expect(state.service.isPlannedEditorEdit(planned)).toBe(false)
})

it('keeps ordinary atomic save bound to the same editor for workspace reads and edits', async () => {
  const state = await ordinarySaveFixture()
  try {
    const absolutePath = path.join(state.root, 'notes', 'a.md')
    const original = await targetFor(state.service, absolutePath)
    expect((await readAll(state.service, 'notes/a.md')).content).toBe('# Saved from editor')
    await expect(state.save()).resolves.toMatchObject({ ok: true })
    const successor = await targetFor(state.service, absolutePath)
    expect(successor.fileIdentity).not.toBe(original.fileIdentity)
    state.editor.state.markdown = '# Unsaved after ordinary save'
    state.editor.state.revision += 1
    const diskRead = vi.spyOn(state.documents, 'readForMain')

    const current = await readAll(state.service, 'notes/a.md')
    expect(current.content).toBe('# Unsaved after ordinary save')
    expect(current.version.mtimeMs).toBe(18)
    expect(current.version.fileId).toBe(successor.fileIdentity)
    const manifest = await state.service.planEdit({
      path: 'notes/a.md', content: '# AI editor replacement', expectedVersion: current.version,
    }, 'ordinary-save-editor-edit')
    await state.service.executeAuthorized(manifest, manifest.nonce)

    expect(state.editor.state.markdown).toBe('# AI editor replacement')
    expect(state.editor.state.applyCalls).toBe(1)
    expect(diskRead).not.toHaveBeenCalled()
    expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
    expect(await readFile(absolutePath, 'utf8')).toBe('# Saved from editor')
    expect(state.responseErrors).toEqual([])
  } finally {
    await state.bridge.dispose()
  }
})

it('guards ordinary atomic save before and after replacement against another window disk fallback', async () => {
  const beforeReplace = deferred()
  const allowReplace = deferred()
  const afterReplace = deferred()
  const allowPublish = deferred()
  const state = await ordinarySaveFixture({
    documentIo: {
      ...nodeDocumentIO,
      rename: async (source, destination) => {
        beforeReplace.resolve()
        await allowReplace.promise
        await nodeDocumentIO.rename(source, destination)
        afterReplace.resolve()
        await allowPublish.promise
      },
    },
  })
  const otherWorkspace = new WorkspaceService()
  await otherWorkspace.setRoot(state.root)
  const windowB = new WorkspaceAiFileService({
    windowId: 8, workspace: otherWorkspace, documents: new DocumentService(otherWorkspace),
    editorBoundary: state.editorBoundary, conversions: state.conversions, docx: state.docx,
    commitAdapter: state.commitAdapter, journal: new AiOperationJournal<WorkspaceAiMutationExecution>(),
    operationId: () => 'ordinary-save-cross-window', nonce: () => 'ordinary-save-cross-window-nonce',
  })
  const saving = state.save()
  try {
    for (const boundary of [beforeReplace, afterReplace]) {
      await boundary.promise
      const absolutePath = path.join(state.root, 'notes', 'a.md')
      const metadata = await stat(absolutePath, { bigint: true })
      const bytes = await readFile(absolutePath)
      const diskVersion = {
        fileId: fileId(metadata), revision: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length, mtimeMs: Math.trunc(Number(metadata.mtimeNs / 1_000_000n)),
      }
      await expect(readAll(windowB, 'notes/a.md')).rejects.toMatchObject({ code: 'STALE_TARGET' })
      await expect(windowB.planEdit({
        path: 'notes/a.md', content: '# Must not reach disk', expectedVersion: diskVersion,
      }, 'ordinary-save-cross-window-edit')).rejects.toMatchObject({ code: 'STALE_TARGET' })
      allowReplace.resolve()
    }
  } finally {
    allowReplace.resolve()
    allowPublish.resolve()
    await saving
    await state.bridge.dispose()
  }
  expect(await saving).toMatchObject({ ok: true })
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
  expect(state.editor.state.applyCalls).toBe(0)
})

it.each(['before replacement', 'after replacement', 'after publication'] as const)(
  'restores the verified editor identity when ordinary atomic save fails %s',
  async (failureStage) => {
    const state = await ordinarySaveFixture({
      documentIo: {
        ...nodeDocumentIO,
        rename: async (source, destination) => {
          if (failureStage === 'before replacement') throw new Error('rename failed before replacement')
          await nodeDocumentIO.rename(source, destination)
          if (failureStage === 'after replacement') throw new Error('rename failed after replacement')
        },
      },
      documentOptions: {
        onStage: (event) => {
          if (failureStage === 'after publication' && event.stage === 'save-persisted-bound') {
            throw new Error('verification failed after publication')
          }
        },
      },
    })
    try {
      const absolutePath = path.join(state.root, 'notes', 'a.md')
      const original = await targetFor(state.service, absolutePath)
      await expect(state.save()).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_FAILED' } })
      const actual = await targetFor(state.service, absolutePath)
      if (failureStage === 'before replacement') {
        expect(actual.fileIdentity).toBe(original.fileIdentity)
      } else {
        expect(actual.fileIdentity).not.toBe(original.fileIdentity)
        await expect(state.editorBoundary.lookup(original)).resolves.toEqual({ status: 'closed' })
      }
      await expect(state.editorBoundary.lookup(actual)).resolves.toMatchObject({ status: 'open' })
      state.editor.state.markdown = '# Still owned after save error'
      const current = await readAll(state.service, 'notes/a.md')
      expect(current.content).toBe('# Still owned after save error')
      expect(current.version.fileId).toBe(actual.fileIdentity)
      expect(current.version.mtimeMs).toBe(17)
      const manifest = await state.service.planEdit({
        path: 'notes/a.md', content: '# AI after save error', expectedVersion: current.version,
      }, 'ordinary-save-error-editor-edit')
      await state.service.executeAuthorized(manifest, manifest.nonce)
      expect(state.editor.state.markdown).toBe('# AI after save error')
      expect(state.editor.state.applyCalls).toBe(1)
      expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
      expect(state.responseErrors).toEqual([])
    } finally {
      await state.bridge.dispose()
    }
  },
)

it('rejects construction without an explicit app-global editor boundary', async () => {
  const state = await fixture()
  const options = {
    windowId: 8,
    workspace: state.workspace,
    documents: state.documents,
    conversions: state.conversions,
  } as unknown as WorkspaceAiFileServiceOptions

  expect(() => new WorkspaceAiFileService(options)).toThrow('editor boundary')
})

it('issues a canonical root capability and provider-facing relative read results', async () => {
  const { root, service } = await fixture()

  const capability = await service.getRootCapability()
  const page = await readAll(service, 'notes/a.md')

  expect(capability).toMatchObject({ windowId: 7, rootFinalPath: root })
  expect(capability.workspaceId).not.toContain(root)
  expect(page).toMatchObject({ kind: 'document', path: 'notes/a.md', content: '# A' })
  expect(JSON.stringify(page)).not.toContain(root)
})

it.each(['a.json', 'a.ts', 'a.cjs', 'CMakeLists.txt'])('does not grant AI reads to an explicitly opened code document %s', async name => {
  const { root, service, editorRegistry } = await fixture()
  await writeFile(path.join(root, name), 'code')
  const target = await targetFor(service, path.join(root, name))
  await registerEditor(editorRegistry, target, statefulEditor({ markdown: 'private code' }).port)
  await expect(readAll(service, name)).rejects.toMatchObject({ code: 'AI_UNSUPPORTED_EDIT' })
})

it('keeps new code types outside AI listing, rename and delete capabilities', async () => {
  const { root, service } = await fixture()
  await writeFile(path.join(root, 'code.ts'), 'const a = 1')
  const listed = await service.listEntries({ path: '', cursor: 0, maxEntries: 100, directoryVersion: null })
  expect(listed.entries.map(entry => entry.name)).not.toContain('code.ts')
  const version = { fileId: '1.1', revision: 'a'.repeat(64), size: 1, mtimeMs: 1 }
  await expect(service.planRename({ path: 'code.ts', newPath: 'other.ts', expectedVersion: version }, 'rename-code')).rejects.toMatchObject({ code: 'AI_UNSUPPORTED_EDIT' })
  await expect(service.planDelete({ path: 'code.ts', expectedVersion: version }, 'delete-code')).rejects.toMatchObject({ code: 'AI_UNSUPPORTED_EDIT' })
})

it('reads and paginates one dirty open editor snapshot without touching disk or conversion', async () => {
  const { conversions, documents, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor({ markdown: '# Dirty editor', revision: 17 })
  await registerEditor(editorRegistry, target, editor.port)
  const diskRead = vi.spyOn(documents, 'readForMain')

  const first = await service.readDocument({ path: 'notes/a.md', cursor: 0, maxChars: 7 })
  const second = await service.readDocument({ path: 'notes/a.md', cursor: 7, maxChars: 48_000 })

  expect(first).toMatchObject({
    kind: 'document', content: '# Dirty', nextCursor: 7,
    version: {
      fileId: target.fileIdentity,
      revision: contentHash('# Dirty editor'),
      mtimeMs: 17,
    },
  })
  expect(second.content).toBe(' editor')
  expect(diskRead).not.toHaveBeenCalled()
  expect(conversions.convertResolved).not.toHaveBeenCalled()
})

it('fails closed across windows when another owner has the same dirty physical file open', async () => {
  const state = await fixture()
  const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
  const editor = statefulEditor({ markdown: '# Window A dirty', revision: 31 })
  await registerEditor(state.editorRegistry, target, editor.port)
  const diskRead = vi.spyOn(state.documents, 'readForMain')
  const windowB = new WorkspaceAiFileService({
    windowId: 8,
    workspace: state.workspace,
    documents: state.documents,
    editorBoundary: state.editorBoundary,
    conversions: state.conversions,
    docx: state.docx,
    commitAdapter: state.commitAdapter,
    journal: new AiOperationJournal<WorkspaceAiMutationExecution>(),
    operationId: () => 'cross-window-operation',
    nonce: () => 'cross-window-nonce',
  })

  const opened = await readAll(state.service, 'notes/a.md')
  await expect(readAll(windowB, 'notes/a.md')).rejects.toMatchObject({ code: 'STALE_TARGET' })
  await expect(windowB.planEdit({
    path: 'notes/a.md', content: '# Must not apply', expectedVersion: opened.version,
  }, 'cross-window-edit')).rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(diskRead).not.toHaveBeenCalled()
  expect(editor.state.applyCalls).toBe(0)
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
})

it('derives an open edit expected size from captured UTF-8 bytes', async () => {
  const { editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor({ markdown: '# 脏', revision: 4 })
  const planReplacement = vi.spyOn(editor.port, 'planReplacement')
  await registerEditor(editorRegistry, target, editor.port)
  const opened = await readAll(service, 'notes/a.md')

  expect(opened.version.size).toBe(Buffer.byteLength('# 脏', 'utf8'))
  await expect(service.planEdit({
    path: 'notes/a.md',
    content: '# Replacement',
    expectedVersion: { ...opened.version, size: '# 脏'.length },
  }, 'wrong-editor-size')).rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(planReplacement).not.toHaveBeenCalled()
})

it('routes an open edit through exactly one editor transaction and returns its successor version', async () => {
  const { commitAdapter, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor({ markdown: '# Dirty editor', revision: 21 })
  await registerEditor(editorRegistry, target, editor.port)
  const opened = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md',
    content: '# Editor replacement',
    expectedVersion: opened.version,
  }, 'open-editor-edit')

  const executed = await service.executeAuthorized(manifest, manifest.nonce)

  expect(editor.state.markdown).toBe('# Editor replacement')
  expect(editor.state.applyCalls).toBe(1)
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
  expect(executed.successorVersion).toEqual({
    fileId: target.fileIdentity,
    revision: contentHash('# Editor replacement'),
    size: Buffer.byteLength('# Editor replacement'),
    mtimeMs: 22,
  })
})

it.each(['capture', 'plan'] as const)(
  'aborts a hung open-editor %s during edit planning and releases both authority leases',
  async (phase) => {
    const state = await fixture()
    const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
    const editor = statefulEditor({ markdown: '# Dirty editor', revision: 21 })
    const late = deferred<unknown>()
    const entered = deferred<AbortSignal>()
    let hang = false
    const port: OpenDocumentEditorPort = {
      ...editor.port,
      async captureReadSnapshot(input, requestSignal) {
        if (hang && phase === 'capture') {
          entered.resolve(requestSignal)
          return await late.promise as never
        }
        return await editor.port.captureReadSnapshot(input, requestSignal)
      },
      async planReplacement(input, requestSignal) {
        if (hang && phase === 'plan') {
          entered.resolve(requestSignal)
          return await late.promise as never
        }
        return await editor.port.planReplacement(input, requestSignal)
      },
    }
    const registration = await registerEditor(state.editorRegistry, target, port)
    const opened = await readAll(state.service, 'notes/a.md')
    hang = true
    const controller = new AbortController()
    const planning = state.service.planEdit({
      path: 'notes/a.md', content: '# Never planned', expectedVersion: opened.version,
    }, `abort-open-${phase}`, controller.signal)

    const requestSignal = await entered.promise
    controller.abort()

    await expect(planning).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSignal.aborted).toBe(true)
    expect(await state.editorBoundary.lookup(target)).toMatchObject({ status: 'open' })
    expect(editor.state.applyCalls).toBe(0)
    expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
    if (phase === 'capture') late.reject(new Error('late capture'))
    else {
      late.resolve({
        status: 'planned', registrationToken: registration.registrationToken,
        registrationRevision: registration.registrationRevision,
        bindingToken: registration.bindingToken, bindingRevision: registration.bindingRevision,
        operationId: 'late-orphan', editorRevision: 21, contentHash: contentHash('# Dirty editor'),
      })
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(editor.state.applyCalls).toBe(0)
  },
)

it('fails a duplicate open owner closed without reading disk', async () => {
  const { documents, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  await registerEditor(editorRegistry, target, statefulEditor().port)
  await registerEditor(editorRegistry, target, statefulEditor().port)
  const diskRead = vi.spyOn(documents, 'readForMain')

  await expect(readAll(service, 'notes/a.md')).rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(diskRead).not.toHaveBeenCalled()
})

it.each(['unavailable', 'throw'] as const)(
  'does not fall back to disk when an open editor snapshot is %s',
  async (failure) => {
    const { documents, editorRegistry, root, service } = await fixture()
    const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
    const editor = statefulEditor()
    const port: OpenDocumentEditorPort = {
      ...editor.port,
      async captureReadSnapshot() {
        if (failure === 'throw') throw new Error('simulated broker failure')
        return { status: 'unavailable' }
      },
    }
    await registerEditor(editorRegistry, target, port)
    const diskRead = vi.spyOn(documents, 'readForMain')

    await expect(readAll(service, 'notes/a.md'))
      .rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(diskRead).not.toHaveBeenCalled()
  },
)

it('does not fall back to disk while an open-document binding is transitioning', async () => {
  const { documents, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  await editorRegistry.reserve(target)
  const diskRead = vi.spyOn(documents, 'readForMain')

  await expect(readAll(service, 'notes/a.md'))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(diskRead).not.toHaveBeenCalled()
})

it('fails an open-to-closed ownership change before either editor or native mutation', async () => {
  const { commitAdapter, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor()
  const registration = await registerEditor(editorRegistry, target, editor.port)
  const opened = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Must not apply', expectedVersion: opened.version,
  }, 'open-to-closed')
  await editorRegistry.unregister(registration)

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(editor.state.applyCalls).toBe(0)
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it('fails a closed-to-open ownership change before either native or editor mutation', async () => {
  const { commitAdapter, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const closed = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Must not apply', expectedVersion: closed.version,
  }, 'closed-to-open')
  const editor = statefulEditor({ markdown: closed.content })
  await registerEditor(editorRegistry, target, editor.port)

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(editor.state.applyCalls).toBe(0)
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it('holds the app identity lease through a closed native commit so opening waits', async () => {
  let releaseCommit!: () => void
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve })
  let commitEntered = false
  const state = await fixture({
    async beforeCommit() {
      commitEntered = true
      await commitGate
    },
  })
  const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
  const closed = await readAll(state.service, 'notes/a.md')
  const manifest = await state.service.planEdit({
    path: 'notes/a.md', content: '# Native edit', expectedVersion: closed.version,
  }, 'closed-commit-lease')

  const executing = state.service.executeAuthorized(manifest, manifest.nonce)
  await vi.waitFor(() => expect(commitEntered).toBe(true))
  let opened = false
  const editor = statefulEditor({ markdown: '# Native edit' })
  const binding = registerEditor(state.editorRegistry, target, editor.port)
    .then(() => { opened = true })
  await Promise.resolve()

  expect(opened).toBe(false)
  releaseCommit()
  await executing
  await binding
  expect(opened).toBe(true)
})

it('fails reopen/rebind even when content and editor revision repeat', async () => {
  const { commitAdapter, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const first = statefulEditor({ markdown: '# Same', revision: 5 })
  const firstRegistration = await registerEditor(editorRegistry, target, first.port)
  const opened = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Must not apply', expectedVersion: opened.version,
  }, 'rebind-aba')
  await editorRegistry.unregister(firstRegistration)
  const second = statefulEditor({ markdown: '# Same', revision: 5 })
  await registerEditor(editorRegistry, target, second.port)

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(first.state.applyCalls).toBe(0)
  expect(second.state.applyCalls).toBe(0)
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it('fails editor revision/content ABA at the transaction compare-and-apply boundary', async () => {
  const { commitAdapter, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor({ markdown: '# A', revision: 5 })
  await registerEditor(editorRegistry, target, editor.port)
  const opened = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Must not apply', expectedVersion: opened.version,
  }, 'editor-content-aba')
  editor.state.markdown = '# B'
  editor.state.revision = 6
  editor.state.markdown = '# A'
  editor.state.revision = 7

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(editor.state.markdown).toBe('# A')
  expect(editor.state.applyCalls).toBe(1)
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it('recovers a lost editor transaction ACK by querying once and never replays it', async () => {
  const { commitAdapter, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor({ loseApplyAck: true })
  await registerEditor(editorRegistry, target, editor.port)
  const opened = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Applied once', expectedVersion: opened.version,
  }, 'lost-editor-ack')

  const executed = await service.executeAuthorized(manifest, manifest.nonce)
  const replay = await service.executeAuthorized(manifest, manifest.nonce)
  expect(editor.state.markdown).toBe('# Applied once')
  expect(editor.state.applyCalls).toBe(1)
  expect(editor.state.queryCalls).toBe(1)
  expect(replay).toEqual(executed)
  expect(executed.successorVersion).toMatchObject({
    revision: contentHash('# Applied once'), mtimeMs: 10,
  })
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it.each(['unknown', 'unavailable'] as const)(
  'makes a lost ACK terminal unknown after one %s outcome query',
  async (queryResult) => {
    const { commitAdapter, editorRegistry, root, service } = await fixture()
    const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
    const editor = statefulEditor({ loseApplyAck: true, queryResult })
    await registerEditor(editorRegistry, target, editor.port)
    const opened = await readAll(service, 'notes/a.md')
    const manifest = await service.planEdit({
      path: 'notes/a.md', content: '# Applied once', expectedVersion: opened.version,
    }, `lost-editor-ack-${queryResult}`)

    await expect(service.executeAuthorized(manifest, manifest.nonce))
      .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
    await expect(service.executeAuthorized(manifest, manifest.nonce))
      .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
    expect(editor.state.applyCalls).toBe(1)
    expect(editor.state.queryCalls).toBe(1)
    expect(commitAdapter!.commit).not.toHaveBeenCalled()
  },
)

it.each(['stale', 'not-applied'] as const)(
  'fails a lost ACK as stale after one %s outcome query without replay',
  async (queryResult) => {
    const { commitAdapter, editorRegistry, root, service } = await fixture()
    const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
    const editor = statefulEditor({ loseApplyAck: true, queryResult })
    await registerEditor(editorRegistry, target, editor.port)
    const opened = await readAll(service, 'notes/a.md')
    const manifest = await service.planEdit({
      path: 'notes/a.md', content: '# Applied once', expectedVersion: opened.version,
    }, `lost-editor-ack-${queryResult}`)

    await expect(service.executeAuthorized(manifest, manifest.nonce))
      .rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(editor.state.applyCalls).toBe(1)
    expect(editor.state.queryCalls).toBe(1)
    expect(commitAdapter!.commit).not.toHaveBeenCalled()
  },
)

it('does not accept or migrate a successor for a nonmonotonic editor revision', async () => {
  const { commitAdapter, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor({ nonmonotonicApply: true })
  await registerEditor(editorRegistry, target, editor.port)
  const opened = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Replacement', expectedVersion: opened.version,
  }, 'nonmonotonic-revision')

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(editor.state.applyCalls).toBe(1)
  expect(editor.state.queryCalls).toBe(1)
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it('uses canonical identity rather than provider path casing for an open binding', async () => {
  const { documents, editorRegistry, root, service } = await fixture()
  const target = await targetFor(service, path.join(root, 'notes', 'a.md'))
  const editor = statefulEditor({ markdown: '# Case alias' })
  await registerEditor(editorRegistry, target, editor.port)
  const diskRead = vi.spyOn(documents, 'readForMain')

  const page = await readAll(service, 'notes/A.MD')

  expect(page.content).toBe('# Case alias')
  expect(page.version.fileId).toBe(target.fileIdentity)
  expect(diskRead).not.toHaveBeenCalled()
})

it('binds paginated directory listings to the workspace generation, identity, and revision', async () => {
  const { root, service } = await fixture()
  await writeFile(path.join(root, 'notes', 'b.md'), '# B', 'utf8')
  const first = await service.listEntries({
    path: 'notes',
    cursor: 0,
    maxEntries: 1,
    directoryVersion: null,
  })

  expect(first.entries).toHaveLength(1)
  expect(first.nextCursor).toBe(1)
  expect(JSON.stringify(first)).not.toContain(root)
  await writeFile(path.join(root, 'notes', 'c.md'), '# C', 'utf8')

  await expect(service.listEntries({
    path: 'notes',
    cursor: 1 as AiPositiveCursor,
    maxEntries: 1,
    directoryVersion: first.directoryVersion,
  })).rejects.toMatchObject({ code: 'AI_FILE_CHANGED' })
})

it('rejects a directory listing when activation switches from A to B during enumeration', async () => {
  const { service, workspace } = await fixture()
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-list-b-'))
  roots.push(secondRoot)
  await mkdir(path.join(secondRoot, 'notes'))
  await writeFile(path.join(secondRoot, 'notes', 'from-b.md'), '# B', 'utf8')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered = false
  const listDirectory = workspace.listDirectory.bind(workspace)
  vi.spyOn(workspace, 'listDirectory').mockImplementation(async (...args) => {
    entered = true
    await gate
    return await listDirectory(...args)
  })

  const listing = service.listEntries({ path: 'notes', cursor: 0, maxEntries: 10, directoryVersion: null })
  await vi.waitFor(() => expect(entered).toBe(true))
  await workspace.setRoot(secondRoot)
  release()

  await expect(listing).rejects.toMatchObject({ code: 'AI_WORKSPACE_CHANGED' })
})

it('rejects a directory listing when activation switches A to B to A during enumeration', async () => {
  const { root, service, workspace } = await fixture()
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-list-aba-'))
  roots.push(secondRoot)
  await mkdir(path.join(secondRoot, 'notes'))
  await writeFile(path.join(secondRoot, 'notes', 'from-b.md'), '# B', 'utf8')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered = false
  const listDirectory = workspace.listDirectory.bind(workspace)
  vi.spyOn(workspace, 'listDirectory').mockImplementation(async (...args) => {
    entered = true
    await gate
    return await listDirectory(...args)
  })

  const listing = service.listEntries({ path: 'notes', cursor: 0, maxEntries: 10, directoryVersion: null })
  await vi.waitFor(() => expect(entered).toBe(true))
  await workspace.setRoot(secondRoot)
  await workspace.setRoot(root)
  release()

  await expect(listing).rejects.toMatchObject({ code: 'AI_WORKSPACE_CHANGED' })
})

it.each([
  '../outside.md',
  'notes/../../outside.md',
  '\\\\server\\share\\file.md',
  '\\\\?\\C:\\device.md',
  'C:\\absolute.md',
  'notes/a.md:stream',
  'notes\\a.md',
  'CON.md',
  'notes/NUL.txt',
])('rejects unsafe provider path %s', async (unsafePath) => {
  const { service } = await fixture()

  await expect(service.readDocument({ path: unsafePath, cursor: 0, maxChars: 100 }))
    .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
  await expect(service.planCreate({ path: unsafePath, content: 'x' }, `create:${unsafePath}`))
    .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
})

it('rejects a junction that redirects a provider path out of the workspace', async () => {
  const { root, service } = await fixture()
  const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-outside-'))
  roots.push(outside)
  await writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8')
  await symlink(outside, path.join(root, 'escape'), 'junction')

  await expect(service.readDocument({ path: 'escape/secret.md', cursor: 0, maxChars: 100 }))
    .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
})

it('reads converted documents through the normalized conversion pipeline and keeps them read-only', async () => {
  const { conversions, service } = await fixture()

  const page = await readAll(service, 'source.pdf')

  expect(page).toMatchObject({
    kind: 'document',
    path: 'source.pdf',
    displayName: 'source.pdf',
    sourceFormat: 'pdf',
    content: '# Converted\n\nNormalized PDF text.',
  })
  expect(conversions.convertResolved).toHaveBeenCalledTimes(1)
  await expect(service.planEdit({
    path: 'source.pdf',
    content: 'replacement',
    expectedVersion: page.version,
  }, 'edit-pdf')).rejects.toMatchObject({ code: 'AI_UNSUPPORTED_EDIT' })
})

it('reads DOCX through the provider-safe text-only Pandoc pipeline and keeps it read-only', async () => {
  const { docx, root, service } = await fixture()
  const controller = new AbortController()

  const page = await service.readDocument({ path: 'source.docx', cursor: 0, maxChars: 48_000 }, controller.signal)

  expect(page).toMatchObject({
    kind: 'document',
    path: 'source.docx',
    sourceFormat: 'docx',
    content: [
      '# Imported',
      '',
      'Normalized DOCX text.',
      '',
      'User paths: C:\\Notes\\original.txt and file:///C:/Notes/original.txt',
      '',
      '[image omitted]',
    ].join('\n'),
  })
  expect(JSON.stringify(page)).not.toContain(root)
  expect(docx.import).not.toHaveBeenCalled()
  expect(docx.importText).toHaveBeenCalledTimes(1)
  expect(docx.importText).toHaveBeenCalledWith(expect.any(String), {
    signal: controller.signal,
    timeoutMs: 60_000,
  })
  await expect(service.planEdit({
    path: 'source.docx',
    content: 'replacement',
    expectedVersion: page.version,
  }, 'edit-docx')).rejects.toMatchObject({ code: 'AI_UNSUPPORTED_EDIT' })
})

it.each([
  { format: 'MarkItDown', file: 'source.pdf', mutation: 'rename' as const },
  { format: 'MarkItDown', file: 'source.pdf', mutation: 'delete' as const },
  { format: 'DOCX', file: 'source.docx', mutation: 'rename' as const },
  { format: 'DOCX', file: 'source.docx', mutation: 'delete' as const },
])('aborts $format conversion during $mutation planning without retaining authority or recording a mutation', async ({ file, mutation }) => {
  const state = await fixture()
  const page = await readAll(state.service, file)
  const entered = deferred<AbortSignal>()
  if (file.endsWith('.pdf')) {
    state.conversions.convertResolved.mockImplementation(async (...args: unknown[]) => {
      const requestSignal = args[1] as AbortSignal
      entered.resolve(requestSignal)
      return await new Promise<never>((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true })
      })
    })
  } else {
    state.docx.importText.mockImplementation(async (...args: unknown[]) => {
      const requestSignal = (args[1] as { signal: AbortSignal }).signal
      entered.resolve(requestSignal)
      return await new Promise<never>((_resolve, reject) => {
        requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true })
      })
    })
  }
  const target = await targetFor(state.service, path.join(state.root, file))
  const controller = new AbortController()
  const planning = mutation === 'rename'
    ? state.service.planRename({
      path: file, newPath: `renamed-${file}`, expectedVersion: page.version,
    }, `abort-${file}-${mutation}`, controller.signal)
    : state.service.planDelete({
      path: file, expectedVersion: page.version,
    }, `abort-${file}-${mutation}`, controller.signal)

  const requestSignal = await entered.promise
  controller.abort()

  await expect(planning).rejects.toMatchObject({ name: 'AbortError' })
  expect(requestSignal).toBe(controller.signal)
  const reservation = await state.editorRegistry.reserve(target)
  await state.editorRegistry.cancelReservation(reservation)
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-after-abort-'))
  roots.push(secondRoot)
  expect(await settlesWithin(state.workspace.setRoot(secondRoot))).toBe(true)
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
})

it('rejects editing when the file identity was replaced after planning', async () => {
  const { root, service } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md',
    content: '# Replacement',
    expectedVersion: page.version,
  }, 'edit-replaced-file')
  await rename(path.join(root, 'notes', 'a.md'), path.join(root, 'notes', 'old.md'))
  await writeFile(path.join(root, 'notes', 'a.md'), '# A', 'utf8')

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# A')
})

it('rejects a content version mismatch before planning a mutation', async () => {
  const { root, service } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  await writeFile(path.join(root, 'notes', 'a.md'), '# changed', 'utf8')

  await expect(service.planEdit({
    path: 'notes/a.md',
    content: '# unsafe overwrite',
    expectedVersion: page.version,
  }, 'stale-edit')).rejects.toMatchObject({ code: 'STALE_TARGET' })
})

it('terminalizes an abandoned authorization so it cannot be approved or executed later', async () => {
  const { commitAdapter, service } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md',
    content: '# Denied',
    expectedVersion: page.version,
  }, 'denied-edit')

  service.abandon(manifest, 'authorization-denied')

  expect(() => service.authorize(manifest, manifest.nonce)).toThrow()
  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_OPERATION_INVALID' })
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it('terminalizes an authorized operation that is abandoned before execution starts', async () => {
  const { commitAdapter, service } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md',
    content: '# Canceled',
    expectedVersion: page.version,
  }, 'approved-then-canceled-edit')

  service.authorize(manifest, manifest.nonce)
  service.abandon(manifest, 'authorization-canceled')

  await expect(service.executeAuthorized(manifest))
    .rejects.toMatchObject({ code: 'AI_OPERATION_INVALID' })
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
})

it('executes one authorized edit once and reports the canonical absolute path only in local audit', async () => {
  const { root, service } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md',
    content: '# Edited',
    expectedVersion: page.version,
  }, 'edit-once')

  const first = await service.executeAuthorized(manifest, manifest.nonce)
  const duplicate = await service.executeAuthorized(manifest, manifest.nonce)

  expect(first).toEqual(duplicate)
  expect(first.result).toMatchObject({ kind: 'mutation', state: 'succeeded', paths: ['notes/a.md'] })
  expect(first.localAudit).toEqual({ kind: 'edited', absolutePaths: [path.join(root, 'notes', 'a.md')] })
  expect(first.successorVersion).toMatchObject({ fileId: page.version.fileId })
  expect(first.successorVersion?.revision).not.toBe(page.version.revision)
  expect(JSON.stringify(first.result)).not.toContain(root)
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# Edited')
})

it('creates and renames regular files without overwriting or mutating directories', async () => {
  const { root, service } = await fixture()
  const createManifest = await service.planCreate({ path: 'notes/new.md', content: 'new' }, 'create-new')
  await service.executeAuthorized(createManifest, createManifest.nonce)
  const created = await readAll(service, 'notes/new.md')
  const renameManifest = await service.planRename({
    path: 'notes/new.md',
    newPath: 'notes/renamed.md',
    expectedVersion: created.version,
  }, 'rename-new')

  const renamed = await service.executeAuthorized(renameManifest, renameManifest.nonce)

  expect(renamed.localAudit).toEqual({
    kind: 'renamed',
    absolutePaths: [path.join(root, 'notes', 'new.md'), path.join(root, 'notes', 'renamed.md')],
  })
  expect(await readFile(path.join(root, 'notes', 'renamed.md'), 'utf8')).toBe('new')
  await expect(service.planCreate({ path: 'notes', content: 'not-a-file' }, 'directory-create'))
    .rejects.toMatchObject({ code: 'AI_UNSUPPORTED_EDIT' })
})

it.each([
  ['rename', 'clean', false],
  ['rename', 'dirty', true],
  ['delete', 'clean', false],
  ['delete', 'dirty', true],
] as const)('rejects planning %s while its source is open and %s', async (kind, _state, dirty) => {
  const state = await fixture()
  const sourcePath = path.join(state.root, 'notes', 'a.md')
  const expected = await readAll(state.service, 'notes/a.md')
  const target = await targetFor(state.service, sourcePath)
  await registerEditor(state.editorRegistry, target, statefulEditor({
    markdown: '# A',
    dirty,
  }).port)

  const planning = kind === 'rename'
    ? state.service.planRename({
      path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: expected.version,
    }, `plan-open-${kind}-${String(dirty)}`)
    : state.service.planDelete({
      path: 'notes/a.md', expectedVersion: expected.version,
    }, `plan-open-${kind}-${String(dirty)}`)

  await expect(planning).rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
  await expect(readFile(sourcePath, 'utf8')).resolves.toBe('# A')
})

it('rejects structural planning for ambiguous and duplicate open ownership', async () => {
  const ambiguous = await fixture()
  const ambiguousExpected = await readAll(ambiguous.service, 'notes/a.md')
  const ambiguousTarget = await targetFor(ambiguous.service, path.join(ambiguous.root, 'notes', 'a.md'))
  await registerEditor(ambiguous.editorRegistry, ambiguousTarget, statefulEditor().port)
  const otherWindow = new WorkspaceAiFileService({
    windowId: 8,
    workspace: ambiguous.workspace,
    documents: ambiguous.documents,
    editorBoundary: ambiguous.editorBoundary,
    conversions: ambiguous.conversions,
    docx: ambiguous.docx,
    commitAdapter: ambiguous.commitAdapter,
    journal: new AiOperationJournal<WorkspaceAiMutationExecution>(),
    operationId: () => 'structural-ambiguous-operation',
    nonce: () => 'structural-ambiguous-nonce',
  })

  await expect(otherWindow.planDelete({
    path: 'notes/a.md', expectedVersion: ambiguousExpected.version,
  }, 'ambiguous-delete')).rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(ambiguous.commitAdapter!.commit).not.toHaveBeenCalled()

  const duplicate = await fixture()
  const duplicateExpected = await readAll(duplicate.service, 'notes/a.md')
  const duplicateTarget = await targetFor(duplicate.service, path.join(duplicate.root, 'notes', 'a.md'))
  await registerEditor(duplicate.editorRegistry, duplicateTarget, statefulEditor().port)
  await registerEditor(duplicate.editorRegistry, duplicateTarget, statefulEditor().port)

  await expect(duplicate.service.planRename({
    path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: duplicateExpected.version,
  }, 'duplicate-rename')).rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(duplicate.commitAdapter!.commit).not.toHaveBeenCalled()
})

it.each(['reservation', 'rebind'] as const)(
  'rejects structural planning while the source has an editor %s transition',
  async (transition) => {
    const state = await fixture()
    const expected = await readAll(state.service, 'notes/a.md')
    const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
    if (transition === 'reservation') {
      await state.editorRegistry.reserve(target)
    } else {
      const registration = await registerEditor(state.editorRegistry, target, statefulEditor().port)
      await state.editorRegistry.beginRebind(registration)
    }

    await expect(state.service.planDelete({
      path: 'notes/a.md', expectedVersion: expected.version,
    }, `plan-${transition}-delete`)).rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
  },
)

it.each([
  ['rename', 'ambiguous'],
  ['delete', 'duplicate'],
] as const)('rejects executing a planned %s under %s open ownership', async (kind, ownership) => {
  const state = await fixture()
  const expected = await readAll(state.service, 'notes/a.md')
  const manifest = kind === 'rename'
    ? await state.service.planRename({
      path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: expected.version,
    }, `execute-${ownership}-${kind}`)
    : await state.service.planDelete({
      path: 'notes/a.md', expectedVersion: expected.version,
    }, `execute-${ownership}-${kind}`)
  const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
  if (ownership === 'ambiguous') {
    await registerEditor(state.editorRegistry, { ...target, windowId: 8 }, statefulEditor().port)
  } else {
    await registerEditor(state.editorRegistry, target, statefulEditor().port)
    await registerEditor(state.editorRegistry, target, statefulEditor().port)
  }

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
})

it.each(['rename', 'delete'] as const)(
  'rejects executing a planned %s when its closed source becomes open',
  async (kind) => {
    const state = await fixture()
    const expected = await readAll(state.service, 'notes/a.md')
    const manifest = kind === 'rename'
      ? await state.service.planRename({
        path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: expected.version,
      }, `execute-open-${kind}`)
      : await state.service.planDelete({
        path: 'notes/a.md', expectedVersion: expected.version,
      }, `execute-open-${kind}`)
    const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
    await registerEditor(state.editorRegistry, target, statefulEditor({ markdown: '# A' }).port)

    await expect(state.service.executeAuthorized(manifest, manifest.nonce))
      .rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
    await expect(readFile(path.join(state.root, 'notes', 'a.md'), 'utf8')).resolves.toBe('# A')
  },
)

it.each(['reservation', 'rebind'] as const)(
  'rejects executing a structural plan during an editor %s transition',
  async (transition) => {
    const state = await fixture()
    const expected = await readAll(state.service, 'notes/a.md')
    const manifest = await state.service.planDelete({
      path: 'notes/a.md', expectedVersion: expected.version,
    }, `execute-${transition}-delete`)
    const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
    if (transition === 'reservation') {
      await state.editorRegistry.reserve(target)
    } else {
      const registration = await registerEditor(state.editorRegistry, target, statefulEditor().port)
      await state.editorRegistry.beginRebind(registration)
    }

    await expect(state.service.executeAuthorized(manifest, manifest.nonce))
      .rejects.toMatchObject({ code: 'STALE_TARGET' })
    expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
  },
)

it('rejects an open-close-reopen ownership ABA before structural execution', async () => {
  const state = await fixture()
  const expected = await readAll(state.service, 'notes/a.md')
  const manifest = await state.service.planRename({
    path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: expected.version,
  }, 'structural-open-aba')
  const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
  const first = await registerEditor(state.editorRegistry, target, statefulEditor({ markdown: '# A' }).port)
  await state.editorRegistry.unregister(first)
  await registerEditor(state.editorRegistry, target, statefulEditor({ markdown: '# A' }).port)

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
})

it('rejects a structural plan after atomic-save rebind changes the source file identity', async () => {
  const state = await fixture()
  const sourcePath = path.join(state.root, 'notes', 'a.md')
  const expected = await readAll(state.service, 'notes/a.md')
  const manifest = await state.service.planDelete({
    path: 'notes/a.md', expectedVersion: expected.version,
  }, 'structural-fileid-rebind')
  const originalTarget = await targetFor(state.service, sourcePath)
  const editor = statefulEditor({ markdown: '# A' })
  const registration = await registerEditor(state.editorRegistry, originalTarget, editor.port)
  const rebind = await state.editorRegistry.beginRebind(registration)
  await rename(sourcePath, path.join(state.root, 'notes', 'old.md'))
  await writeFile(sourcePath, '# A', 'utf8')
  const successorTarget = await targetFor(state.service, sourcePath)
  await rebind.commit(successorTarget.fileIdentity, { target: successorTarget, port: editor.port })

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_FILE_CHANGED' })
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
  await expect(readFile(sourcePath, 'utf8')).resolves.toBe('# A')
})

it.each(['rename', 'delete'] as const)(
  'holds the source identity lease through a native %s commit',
  async (kind) => {
    let releaseCommit!: () => void
    const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve })
    const commitEntered = deferred()
    let identityLeaseDepth = 0
    const state = await fixture({
      async beforeCommit(request) {
        if ((kind === 'rename' && request.kind !== 'rename')
          || (kind === 'delete' && request.kind !== 'recycle')) return
        commitEntered.resolve()
        await commitGate
      },
    })
    const expected = await readAll(state.service, 'notes/a.md')
    const manifest = kind === 'rename'
      ? await state.service.planRename({
        path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: expected.version,
      }, `structural-lease-${kind}`)
      : await state.service.planDelete({
        path: 'notes/a.md', expectedVersion: expected.version,
      }, `structural-lease-${kind}`)
    const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
    const withIdentityLease = state.editorBoundary.withIdentityLease.bind(state.editorBoundary)
    vi.spyOn(state.editorBoundary, 'withIdentityLease').mockImplementation(async (leaseTarget, operation) => (
      await withIdentityLease(leaseTarget, async () => {
        identityLeaseDepth += 1
        try {
          return await operation()
        } finally {
          identityLeaseDepth -= 1
        }
      })
    ))

    const execution = state.service.executeAuthorized(manifest, manifest.nonce)
    await commitEntered.promise
    const leaseHeldAtCommit = identityLeaseDepth > 0
    let opened = false
    const opening = registerEditor(state.editorRegistry, target, statefulEditor().port)
      .then(() => { opened = true })

    releaseCommit()
    await execution
    await opening
    expect(leaseHeldAtCommit).toBe(true)
    expect(opened).toBe(true)
  },
)

it.each(['read', 'edit', 'rename', 'delete'] as const)(
  'orders workspace authority before the identity lease for %s without deadlock',
  async (kind) => {
    const state = await fixture()
    const original = await readAll(state.service, 'notes/a.md')
    const activeManifest = await state.service.planEdit({
      path: 'notes/a.md', content: '# Authority holder', expectedVersion: original.version,
    }, `authority-holder-${kind}`)
    const capability = await state.service.getRootCapability()
    const identityRequested = deferred()
    const releaseIdentityRequest = deferred()
    const workspaceRequested = deferred()
    const withIdentityLease = state.editorBoundary.withIdentityLease.bind(state.editorBoundary)
    let identityCalls = 0
    let entryCapabilityMock: ReturnType<typeof vi.spyOn> | undefined
    vi.spyOn(state.editorBoundary, 'withIdentityLease').mockImplementation(async (target, operation) => {
      identityCalls += 1
      if (identityCalls === 1) {
        identityRequested.resolve()
        await releaseIdentityRequest.promise
      } else if (identityCalls === 2) {
        entryCapabilityMock?.mockRestore()
      }
      return await withIdentityLease(target, operation)
    })

    const activeExecution = state.service.executeAuthorized(activeManifest, activeManifest.nonce)
    await identityRequested.promise

    entryCapabilityMock = vi.spyOn(state.service, 'getRootCapability').mockResolvedValue(capability)
    const withMutationLease = state.workspace.withMutationLease.bind(state.workspace)
    vi.spyOn(state.workspace, 'withMutationLease').mockImplementation(async (expected, operation) => {
      workspaceRequested.resolve()
      return await withMutationLease(expected, operation)
    })
    const getValidatedActivationSnapshot = state.workspace.getValidatedActivationSnapshot
      .bind(state.workspace)
    vi.spyOn(state.workspace, 'getValidatedActivationSnapshot').mockImplementation(async () => {
      workspaceRequested.resolve()
      return await getValidatedActivationSnapshot()
    })

    const queuedOperation = kind === 'read'
      ? readAll(state.service, 'notes/a.md')
      : kind === 'edit'
        ? state.service.planEdit({
          path: 'notes/a.md', content: '# Queued edit', expectedVersion: original.version,
        }, 'queued-edit')
        : kind === 'rename'
          ? state.service.planRename({
            path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: original.version,
          }, 'queued-rename')
          : state.service.planDelete({
            path: 'notes/a.md', expectedVersion: original.version,
          }, 'queued-delete')

    await workspaceRequested.promise
    const queuedBeforeIdentity = identityCalls === 1
    releaseIdentityRequest.resolve()
    const completed = await settlesWithin(Promise.allSettled([activeExecution, queuedOperation]))

    expect(queuedBeforeIdentity).toBe(true)
    expect(completed).toBe(true)
  },
)

it('keeps create independent from unrelated open editor ownership', async () => {
  const state = await fixture()
  const target = await targetFor(state.service, path.join(state.root, 'notes', 'a.md'))
  await registerEditor(state.editorRegistry, target, statefulEditor().port)

  const manifest = await state.service.planCreate({ path: 'notes/new.md', content: 'new' }, 'create-with-open')
  await expect(state.service.executeAuthorized(manifest, manifest.nonce)).resolves.toMatchObject({
    result: { kind: 'mutation', state: 'succeeded', paths: ['notes/new.md'] },
  })
  await expect(readFile(path.join(state.root, 'notes', 'new.md'), 'utf8')).resolves.toBe('new')
})

it('deletes only through the injected recycle-bin adapter after identity revalidation', async () => {
  const { commitAdapter, recycled, root, service } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planDelete({ path: 'notes/a.md', expectedVersion: page.version }, 'delete-a')

  const executed = await service.executeAuthorized(manifest, manifest.nonce)

  expect(commitAdapter!.commit).toHaveBeenCalledWith(expect.objectContaining({
    kind: 'recycle',
    source: expect.objectContaining({ absolutePath: path.join(root, 'notes', 'a.md') }),
  }))
  expect(executed.localAudit).toEqual({
    kind: 'recycled',
    absolutePaths: [path.join(root, 'notes', 'a.md')],
  })
  expect((await stat(path.join(recycled, 'a.md'))).isFile()).toBe(true)
  await expect(stat(path.join(root, 'notes', 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('invalidates manifests when the loaded workspace changes', async () => {
  const { commitAdapter, service, workspace } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md',
    content: '# Wrong workspace',
    expectedVersion: page.version,
  }, 'switch-workspace')
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-second-'))
  roots.push(secondRoot)
  await mkdir(path.join(secondRoot, 'notes'))
  await writeFile(path.join(secondRoot, 'notes', 'a.md'), '# Second', 'utf8')
  await workspace.setRoot(secondRoot)

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
  expect(await readFile(path.join(secondRoot, 'notes', 'a.md'), 'utf8')).toBe('# Second')
})

it('invalidates an old manifest after A to B to A reactivation', async () => {
  const { commitAdapter, root, service, workspace } = await fixture()
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md',
    content: '# Stale generation',
    expectedVersion: page.version,
  }, 'aba-switch')
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-aba-'))
  roots.push(secondRoot)
  await workspace.setRoot(secondRoot)
  await workspace.setRoot(root)

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'STALE_TARGET' })
  expect(commitAdapter!.commit).not.toHaveBeenCalled()
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# A')
})

it('does not return a cached capability when activation changes during validation', async () => {
  const { root, service, workspace } = await fixture()
  const seeded = await service.getRootCapability()
  const activation = vi.spyOn(workspace, 'getActivationSnapshot')
    .mockReturnValueOnce({ root, epoch: seeded.rootGeneration })
    .mockReturnValueOnce({ root, epoch: seeded.rootGeneration + 2 })

  await expect(service.getRootCapability())
    .rejects.toMatchObject({ code: 'AI_WORKSPACE_CHANGED' })
  activation.mockRestore()
})

it('rejects an ordinary same-path workspace root replacement without issuing a new capability', async () => {
  const { root, service } = await fixture()
  const original = await service.getRootCapability()
  const movedRoot = `${root}-original`
  roots.push(movedRoot)
  await rename(root, movedRoot)
  await mkdir(root)
  await mkdir(path.join(root, 'notes'))
  await writeFile(path.join(root, 'notes', 'replacement.md'), '# Replacement', 'utf8')

  await expect(service.getRootCapability())
    .rejects.toMatchObject({ code: 'AI_WORKSPACE_CHANGED' })
  await expect(service.readDocument({ path: 'notes/replacement.md', cursor: 0, maxChars: 100 }))
    .rejects.toMatchObject({ code: 'AI_WORKSPACE_CHANGED' })
  expect(original.rootFileId).not.toBe('')
})

it('holds a fixed-root mutation lease across commit while a workspace switch waits', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered = false
  const state = await fixture({
    beforeCommit: async () => {
      entered = true
      await gate
    },
  })
  const page = await readAll(state.service, 'notes/a.md')
  const manifest = await state.service.planEdit({
    path: 'notes/a.md', content: '# Fixed root', expectedVersion: page.version,
  }, 'fixed-root')
  const execution = state.service.executeAuthorized(manifest, manifest.nonce)
  await vi.waitFor(() => expect(entered).toBe(true))
  const secondRoot = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-mid-switch-'))
  roots.push(secondRoot)
  await mkdir(path.join(secondRoot, 'notes'))
  await writeFile(path.join(secondRoot, 'notes', 'a.md'), '# Second', 'utf8')
  let switched = false
  const switching = state.workspace.setRoot(secondRoot).then(() => { switched = true })

  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(switched).toBe(false)
  release()
  await execution
  await switching
  expect(await readFile(path.join(state.root, 'notes', 'a.md'), 'utf8')).toBe('# Fixed root')
  expect(await readFile(path.join(secondRoot, 'notes', 'a.md'), 'utf8')).toBe('# Second')
})

it('does not overwrite a destination created at the native commit boundary', async () => {
  let state!: Awaited<ReturnType<typeof fixture>>
  state = await fixture({
    beforeCommit: async (request) => {
      if (request.kind === 'create') await writeFile(request.destination.absolutePath, 'concurrent', 'utf8')
    },
  })
  const manifest = await state.service.planCreate({ path: 'notes/new.md', content: 'AI' }, 'create-race')

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_FILE_CHANGED' })
  expect(await readFile(path.join(state.root, 'notes', 'new.md'), 'utf8')).toBe('concurrent')
})

it('does not let rename overwrite a destination created at the native commit boundary', async () => {
  let state!: Awaited<ReturnType<typeof fixture>>
  state = await fixture({
    beforeCommit: async (request) => {
      if (request.kind === 'rename') await writeFile(request.destination.absolutePath, 'concurrent', 'utf8')
    },
  })
  const page = await readAll(state.service, 'notes/a.md')
  const manifest = await state.service.planRename({
    path: 'notes/a.md', newPath: 'notes/renamed.md', expectedVersion: page.version,
  }, 'rename-destination-race')

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_FILE_CHANGED' })
  expect(await readFile(path.join(state.root, 'notes', 'renamed.md'), 'utf8')).toBe('concurrent')
  expect(await readFile(path.join(state.root, 'notes', 'a.md'), 'utf8')).toBe('# A')
})

it('does not mutate a source replaced at the native commit boundary', async () => {
  let state!: Awaited<ReturnType<typeof fixture>>
  state = await fixture({
    beforeCommit: async (request) => {
      if (request.kind !== 'edit') return
      await rename(request.source.absolutePath, `${request.source.absolutePath}.old`)
      await writeFile(request.source.absolutePath, 'replacement', 'utf8')
    },
  })
  const page = await readAll(state.service, 'notes/a.md')
  const manifest = await state.service.planEdit({
    path: 'notes/a.md', content: 'AI', expectedVersion: page.version,
  }, 'source-race')

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_FILE_CHANGED' })
  expect(await readFile(path.join(state.root, 'notes', 'a.md'), 'utf8')).toBe('replacement')
})

it('fails closed before the native adapter for a hardlinked workspace document', async () => {
  const state = await fixture()
  const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-hardlink-outside-'))
  roots.push(outside)
  const external = path.join(outside, 'external.md')
  const inside = path.join(state.root, 'notes', 'linked.md')
  await writeFile(external, 'external must remain unchanged')
  try {
    await link(external, inside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') return
    throw error
  }

  await expect(readAll(state.service, 'notes/linked.md'))
    .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
  expect(state.commitAdapter!.commit).not.toHaveBeenCalled()
  await expect(readFile(external, 'utf8')).resolves.toBe('external must remain unchanged')
})

it('does not recycle a replacement installed at the native commit boundary', async () => {
  let state!: Awaited<ReturnType<typeof fixture>>
  state = await fixture({
    beforeCommit: async (request) => {
      if (request.kind !== 'recycle') return
      await rename(request.source.absolutePath, `${request.source.absolutePath}.old`)
      await writeFile(request.source.absolutePath, 'replacement', 'utf8')
    },
  })
  const page = await readAll(state.service, 'notes/a.md')
  const manifest = await state.service.planDelete({
    path: 'notes/a.md', expectedVersion: page.version,
  }, 'recycle-source-race')

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_FILE_CHANGED' })
  expect(await readFile(path.join(state.root, 'notes', 'a.md'), 'utf8')).toBe('replacement')
  await expect(stat(path.join(state.recycled, 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not follow a parent redirected at the native commit boundary', async ({ skip }) => {
  const outside = await mkdtemp(path.join(tmpdir(), 'arkdown-ai-parent-outside-'))
  roots.push(outside)
  let state!: Awaited<ReturnType<typeof fixture>>
  state = await fixture({
    beforeCommit: async (request) => {
      if (request.kind !== 'create') return
      const moved = path.join(state.root, 'moved-notes')
      await rename(path.join(state.root, 'notes'), moved)
      try {
        await symlink(outside, path.join(state.root, 'notes'), process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        skip()
      }
    },
  })
  const manifest = await state.service.planCreate({ path: 'notes/new.md', content: 'AI' }, 'parent-race')

  await expect(state.service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_FILE_CHANGED' })
  await expect(stat(path.join(outside, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('fails closed when the native identity-bound commit adapter is unavailable', async () => {
  const { root, service } = await fixture({ commitAdapter: null })
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# No fallback', expectedVersion: page.version,
  }, 'no-adapter')

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toMatchObject({ code: 'AI_COMMIT_UNAVAILABLE' })
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# A')
})

it('settles a malformed native adapter response unknown and never retries it', async () => {
  const commitAdapter: WindowsWorkspaceCommitAdapter = {
    commit: vi.fn(async () => undefined as never),
  }
  const { journal, root, service } = await fixture({ commitAdapter })
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Must not retry', expectedVersion: page.version,
  }, 'malformed-adapter')

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(journal.get(manifest.operationId)?.state).toBe('unknown')
  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(commitAdapter.commit).toHaveBeenCalledTimes(1)
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# A')
})

it.each([
  ['extra committed key', () => ({ status: 'committed', extra: true })],
  ['inherited status', () => Object.create({ status: 'committed' })],
  ['proxied committed status', () => new Proxy({ status: 'committed' }, {})],
  ['missing status', () => ({})],
  ['invalid rejected reason', () => ({ status: 'rejected', reason: 'other' })],
  ['missing rejected reason', () => ({ status: 'rejected' })],
  ['extra rejected key', () => ({ status: 'rejected', reason: 'source-changed', extra: true })],
  ['empty unknown reason', () => ({ status: 'unknown', reason: '' })],
  ['oversized unknown reason', () => ({ status: 'unknown', reason: 'x'.repeat(513) })],
  ['extra unknown key', () => ({ status: 'unknown', reason: 'uncertain', extra: true })],
] as const)('settles an inexact native adapter outcome unknown: %s', async (_name, value) => {
  const commitAdapter: WindowsWorkspaceCommitAdapter = {
    commit: vi.fn(async () => value() as never),
  }
  const { journal, root, service } = await fixture({ commitAdapter })
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Must not trust outcome', expectedVersion: page.version,
  }, `inexact-adapter-${_name.replaceAll(' ', '-')}`)

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(journal.get(manifest.operationId)?.state).toBe('unknown')
  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(commitAdapter.commit).toHaveBeenCalledTimes(1)
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# A')
})

it.each(['stateful', 'throwing'] as const)(
  'rejects a %s outcome accessor without invoking it',
  async (kind) => {
    let reads = 0
    const outcome = Object.defineProperty({}, 'status', {
      enumerable: true,
      get: () => {
        reads += 1
        if (kind === 'throwing') throw new Error('must not run')
        return reads === 1 ? 'committed' : 'unknown'
      },
    })
    const commitAdapter: WindowsWorkspaceCommitAdapter = {
      commit: vi.fn(async () => outcome as never),
    }
    const { journal, service } = await fixture({ commitAdapter })
    const page = await readAll(service, 'notes/a.md')
    const manifest = await service.planEdit({
      path: 'notes/a.md', content: '# Must not trust accessor', expectedVersion: page.version,
    }, `accessor-adapter-${kind}`)

    await expect(service.executeAuthorized(manifest, manifest.nonce))
      .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
    expect(journal.get(manifest.operationId)?.state).toBe('unknown')
    expect(reads).toBe(0)
  },
)

it('settles a post-commit verification failure unknown and never replays it', async () => {
  const { commitAdapter, journal, root, service } = await fixture({ unknownAfterCommit: true })
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planEdit({
    path: 'notes/a.md', content: '# Maybe committed', expectedVersion: page.version,
  }, 'uncertain-edit')

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(journal.get(manifest.operationId)?.state).toBe('unknown')
  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(commitAdapter!.commit).toHaveBeenCalledTimes(1)
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# Maybe committed')
})

it('settles an uncertain recycle unknown and never moves a replacement on replay', async () => {
  const { commitAdapter, journal, recycled, service } = await fixture({ unknownAfterCommit: true })
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planDelete({ path: 'notes/a.md', expectedVersion: page.version }, 'uncertain-recycle')

  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(journal.get(manifest.operationId)?.state).toBe('unknown')
  await expect(service.executeAuthorized(manifest, manifest.nonce))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(commitAdapter!.commit).toHaveBeenCalledTimes(1)
  expect((await stat(path.join(recycled, 'a.md'))).isFile()).toBe(true)
})

it('serializes structural commits so only one reaches the adapter at a time', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let calls = 0
  const state = await fixture({
    beforeCommit: async (request) => {
      if (request.kind !== 'create') return
      calls += 1
      if (calls === 1) await gate
    },
  })
  const first = await state.service.planCreate({ path: 'notes/one.md', content: 'one' }, 'structural-one')
  const second = await state.service.planCreate({ path: 'notes/two.md', content: 'two' }, 'structural-two')
  const firstExecution = state.service.executeAuthorized(first, first.nonce)
  await vi.waitFor(() => expect(calls).toBe(1))
  const secondExecution = state.service.executeAuthorized(second, second.nonce)

  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(calls).toBe(1)
  release()
  await Promise.all([firstExecution, secondExecution])
  expect(calls).toBe(2)
})

it('filters and rejects repository and application control directories for every AI operation', async () => {
  const { root, service } = await fixture()
  for (const name of ['.git', '.codex', '.arkdown-dev-data', '.arkdown-ai-quarantine', 'node_modules']) {
    await mkdir(path.join(root, name))
    await writeFile(path.join(root, name, 'secret.md'), 'secret', 'utf8')
  }
  await mkdir(path.join(root, 'notes', '.git'))
  await writeFile(path.join(root, 'notes', '.git', 'secret.md'), 'nested secret', 'utf8')

  const listed = await service.listEntries({ path: '', cursor: 0, maxEntries: 100, directoryVersion: null } as never)
  expect(listed.entries.map((entry) => entry.name)).not.toEqual(expect.arrayContaining([
    '.git', '.codex', '.arkdown-dev-data', '.arkdown-ai-quarantine', 'node_modules',
  ]))
  for (const controlPath of [
    '.git/secret.md', '.codex/new.md', '.arkdown-ai-quarantine/recovery.json', 'node_modules/file.md', 'notes\\.git\\secret.md',
  ]) {
    await expect(service.readDocument({ path: controlPath, cursor: 0, maxChars: 100 }))
      .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
    await expect(service.planCreate({ path: controlPath, content: 'x' }, `blocked-${path.basename(controlPath)}`))
      .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
    const expectedVersion = { fileId: '1.1', revision: 'a'.repeat(64), size: 1, mtimeMs: 1 }
    await expect(service.planEdit({ path: controlPath, content: 'x', expectedVersion }, `edit-${path.basename(controlPath)}`))
      .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
    await expect(service.planDelete({ path: controlPath, expectedVersion }, `delete-${path.basename(controlPath)}`))
      .rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
  }
  const page = await readAll(service, 'notes/a.md')
  await expect(service.planRename({
    path: 'notes/a.md', newPath: '.git/a.md', expectedVersion: page.version,
  }, 'rename-control')).rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
  await expect(service.listEntries({
    path: '.git', cursor: 0, maxEntries: 10, directoryVersion: null,
  })).rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
})

it('classifies a control-path create as invalid before extension or idempotency lookup', async () => {
  const { service } = await fixture()
  await service.planCreate({ path: 'notes/safe.md', content: 'safe' }, 'shared-create-key')

  await expect(service.planCreate({
    path: '.arkdown-ai-quarantine/recovery.bin',
    content: 'unsafe',
  }, 'shared-create-key')).rejects.toMatchObject({ code: 'AI_INVALID_PATH' })
})

it('reports the known safe recycle rejection as a typed failure without an audit or retry', async () => {
  const commitAdapter: WindowsWorkspaceCommitAdapter = { commit: vi.fn(async () => ({ status: 'rejected', reason: 'recycle-unavailable' }) as never) }
  const { journal, root, recycled, service } = await fixture({ commitAdapter })
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planDelete({ path: 'notes/a.md', expectedVersion: page.version }, 'safe-recycle-rejection')
  await expect(service.executeAuthorized(manifest, manifest.nonce)).rejects.toMatchObject({ code: 'AI_RECYCLE_UNAVAILABLE' })
  expect(journal.get(manifest.operationId)?.state).toBe('failed')
  await expect(service.executeAuthorized(manifest, manifest.nonce)).rejects.toMatchObject({ code: 'AI_RECYCLE_UNAVAILABLE' })
  expect(commitAdapter.commit).toHaveBeenCalledTimes(1)
  expect(await readFile(path.join(root, 'notes', 'a.md'), 'utf8')).toBe('# A')
  await expect(stat(path.join(recycled, 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it.each(['edit', 'create', 'rename'] as const)('settles a recycle rejection on a %s request unknown', async kind => {
  const commitAdapter: WindowsWorkspaceCommitAdapter = { commit: vi.fn(async () => ({ status: 'rejected', reason: 'recycle-unavailable' }) as never) }
  const { journal, service } = await fixture({ commitAdapter })
  const page = await readAll(service, 'notes/a.md')
  const manifest = kind === 'edit' ? await service.planEdit({ path: 'notes/a.md', content: '# next', expectedVersion: page.version }, 'wrong-recycle-edit')
    : kind === 'rename' ? await service.planRename({ path: 'notes/a.md', newPath: 'notes/b.md', expectedVersion: page.version }, 'wrong-recycle-rename')
      : await service.planCreate({ path: 'notes/new.md', content: '# new' }, 'wrong-recycle-create')
  await expect(service.executeAuthorized(manifest, manifest.nonce)).rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(journal.get(manifest.operationId)?.state).toBe('unknown')
})
it.each([
  [{ status: 'rejected', reason: 'unsupported' }, 'AI_COMMIT_UNAVAILABLE'],
  [{ status: 'unknown', reason: 'recycle-unavailable' }, null],
  [{ status: 'rejected', reason: 'recycle-unavailable', extra: true }, null],
] as const)('does not claim safe recycle failure for %j', async (outcome, code) => {
  const commitAdapter: WindowsWorkspaceCommitAdapter = { commit: vi.fn(async () => outcome as never) }
  const { service } = await fixture({ commitAdapter })
  const page = await readAll(service, 'notes/a.md')
  const manifest = await service.planDelete({ path: 'notes/a.md', expectedVersion: page.version }, 'not-safe-rejection')
  const execution = service.executeAuthorized(manifest, manifest.nonce)
  if (code) await expect(execution).rejects.toMatchObject({ code })
  else await expect(execution).rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
})
