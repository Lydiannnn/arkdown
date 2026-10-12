// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { wireDesktopLifecycle } from '../../src/main/desktop-lifecycle'
import { DraftService } from '../../src/main/drafts/draft-service'
import { AssetService } from '../../src/main/assets/asset-service'
import { AssetAccessRegistry } from '../../src/main/assets/asset-path'
import { OpenDocumentRegistry } from '../../src/main/documents/open-document-registry'
import { RegistryWorkspaceAiEditorBoundary } from '../../src/main/documents/workspace-ai-editor-boundary'
import { AiConversationSessionService } from '../../src/main/models/ai-conversation-session-service'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { DEFAULT_LARGE_MODEL_SETTINGS, type ModelConnectionSummary } from '../../src/shared/large-model-settings'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-unnamed-save-'))
  cleanups.push(async () => {
    const relative = path.relative(path.resolve(tmpdir()), root)
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(root).startsWith('arkdown-unnamed-save-')) throw new Error('Unsafe cleanup')
    await rm(root, { recursive: true, force: true })
  })
  const destination = path.join(root, 'documents')
  await mkdir(destination)
  const draftId = '650e8400-e29b-41d4-a716-446655440001'
  const markdown = '# Recovered unnamed draft\n\nKEEP-CONTENT\n'
  const drafts = new DraftService({ root: path.join(root, 'drafts'), appVersion: '1.0.4' })
  await drafts.write({ draftId, markdown, originalAbsolutePath: null, workspaceAbsolutePath: null,
    originalRevision: null, originalMtimeMs: null, encoding: 'utf8', newline: 'lf' })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  const ipcMain = { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel), on: vi.fn(), removeListener: vi.fn() }
  const webContents = { id: 771, mainFrame: {}, send: vi.fn(), isDestroyed: () => false, on: vi.fn(), removeListener: vi.fn() }
  const window = { webContents, isDestroyed: () => false, on: vi.fn(), once: vi.fn(), close: vi.fn(),
    getSize: () => [1200, 800], getPosition: () => [0, 0] }
  const registry = new OpenDocumentRegistry()
  const connection: ModelConnectionSummary = { id: randomUUID(), name: 'Synthetic', provider: 'deepseek', accessType: 'standard-api',
    protocol: 'openai', baseUrl: 'https://example.invalid/v1', modelId: 'deepseek-v4-flash', apiKeyHint: 'test',
    status: 'connected', lastTestedAt: null, capabilityOverride: null }
  const models = structuredClone(DEFAULT_LARGE_MODEL_SETTINGS)
  models.connections = [connection]
  models.aiConversation.connectionId = connection.id
  const settings = new SettingsCoordinator({ save: async () => undefined }, { lastWorkspace: null, models })
  const chooseSavePath = vi.fn(async (): Promise<string | null> => path.join(destination, 'saved.md'))
  const prepare = vi.spyOn(AiConversationSessionService.prototype, 'prepareWorkspaceSwitch')
  const wired = wireDesktopLifecycle({ ipcMain: ipcMain as never, window: window as never,
    showOpenDialog: async () => ({ canceled: false, filePaths: [destination] }),
    runtimeDependencies: { workspaceCommitAdapter: undefined, openDocumentRegistry: registry,
      workspaceAiEditorBoundary: new RegistryWorkspaceAiEditorBoundary(registry),
      registerWindowCleanup: cleanup => {
        cleanups.push(async () => { await cleanup() })
        return { disposeWindow: async () => { await cleanup() }, unregister() {} }
      } },
    documentConversions: { convertResolved: vi.fn() }, settingsCoordinator: settings,
    drafts, chooseSavePath, createAssetService: workspace => new AssetService({ workspace,
      tempRoot: path.join(root, 'assets'), sessionId: 'test', access: new AssetAccessRegistry(),
      readClipboardImage: () => { throw new Error('Clipboard not used') } }),
    modelConnections: { getCredentialSnapshot: async () => ({ connection, apiKey: 'synthetic-local-only' }) } as never,
    modelSecretVault: { get: async () => null } as never,
    modelProtocolClient: { streamChat: async input => {
      input.onDelta('Synthetic reply, no network.')
      return { toolCalls: [], reasoningContent: '', providerReplay: null, usage: null }
    }, testConnection: async () => undefined },
    saveWindowBounds: async () => undefined, normalizeBounds: bounds => bounds, confirmStopAi: async () => true,
    onCloseStateChanged() {}, reportOperationError() {}, reportCloseError() {},
    controlWindow: () => ({ maximized: false, fullscreen: false, revision: 0 }),
    getWindowState: () => ({ maximized: false, fullscreen: false, revision: 0 }),
  })
  const api = createArkdownApi(async (channel, ...args) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler ${channel}`)
    return await handler({ sender: webContents, senderFrame: webContents.mainFrame }, ...args)
  })
  await wired.authorizeDraftRecovery(draftId)
  expect(await api.claimRecoveredDraft!(draftId)).toMatchObject({ ok: true, value: { markdown } })
  const begin = () => api.beginSaveDocumentAs!({ draftId, markdown, encoding: 'utf8', newline: 'lf', suggestedFileName: 'saved.md' })
  return { root, destination, draftId, markdown, drafts, wired, api, chooseSavePath, prepare, begin, settings, webContents }
}

it('saves a recovered unnamed draft from an empty window through the real AI lifecycle and file transaction', async () => {
  const f = await fixture()
  expect(await f.wired.ai.getWorkspaceAuthority()).toBeNull()
  const begun = await f.begin()
  if (!begun.ok || !begun.value) throw new Error('Missing intent')
  const result = await f.api.commitSaveDocumentAs!(begun.value.intentId)
  // Keep the actual preparation failure visible; no fake AI ticket can hide it.
  await expect(f.prepare.mock.results.at(-1)?.value).resolves.toMatchObject({ generation: 1 })
  expect(result).toMatchObject({ ok: true, value: { document: { markdown: f.markdown } } })
  expect(await readFile(path.join(f.destination, 'saved.md'), 'utf8')).toBe(f.markdown)
  expect(f.wired.getCurrentDocumentAbsolutePath()).toBe(path.join(f.destination, 'saved.md'))
  expect(await f.wired.ai.getWorkspaceAuthority()).not.toBeNull()
  expect(await f.drafts.listRecoverable()).toEqual([])
})

it('can cancel the chooser and a prepared save intent, then retry from the same empty window', async () => {
  const f = await fixture()
  f.chooseSavePath.mockResolvedValueOnce(null)
  expect(await f.begin()).toEqual({ ok: true, value: null })
  const aborted = await f.begin()
  if (!aborted.ok || !aborted.value) throw new Error('Missing intent')
  expect(await f.api.abortSaveDocumentAs!(aborted.value.intentId)).toMatchObject({ ok: true })
  expect(f.prepare).not.toHaveBeenCalled()
  expect(await f.drafts.read(f.draftId)).toMatchObject({ markdown: f.markdown })
  const retried = await f.begin()
  if (!retried.ok || !retried.value) throw new Error('Missing intent')
  expect(await f.api.commitSaveDocumentAs!(retried.value.intentId)).toMatchObject({ ok: true })
  expect(await readFile(path.join(f.destination, 'saved.md'), 'utf8')).toBe(f.markdown)
})

it('restores the empty source after a failed write and permits a later save without losing the draft', async () => {
  const f = await fixture()
  vi.spyOn(f.wired.documents, 'createForMain').mockRejectedValueOnce(new Error('Injected destination write failure'))
  const first = await f.begin()
  if (!first.ok || !first.value) throw new Error('Missing intent')
  expect(await f.api.commitSaveDocumentAs!(first.value.intentId)).toMatchObject({ ok: false })
  expect(await f.wired.workspace.getSaveAsActivationSnapshot()).toMatchObject({ root: null })
  expect(await f.wired.ai.getWorkspaceAuthority()).toBeNull()
  expect(await f.drafts.read(f.draftId)).toMatchObject({ markdown: f.markdown })
  await expect(readFile(path.join(f.destination, 'saved.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  const retry = await f.begin()
  if (!retry.ok || !retry.value) throw new Error('Missing intent')
  expect(await f.api.commitSaveDocumentAs!(retry.value.intentId)).toMatchObject({ ok: true })
  expect(await readFile(path.join(f.destination, 'saved.md'), 'utf8')).toBe(f.markdown)
})

it('continues to validate an active source and refuses Save As if that source was removed', async () => {
  const f = await fixture()
  const source = path.join(f.root, 'previous-workspace')
  await mkdir(source)
  await f.wired.workspace.setRoot(source)
  await f.wired.ai.synchronizeWorkspaceAfterDirectRootSet()
  await rmdir(source)
  expect(await f.begin()).toMatchObject({ ok: false })
  expect(await f.drafts.read(f.draftId)).toMatchObject({ markdown: f.markdown })
  await expect(readFile(path.join(f.destination, 'saved.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['restore', 'choose'] as const)('keeps AI usable after the ordinary %s workspace entrypoint', async mode => {
  const f = await fixture()
  if (mode === 'restore') await f.settings.update(current => ({ ...current, lastWorkspace: f.destination }))
  const opened = await (mode === 'restore' ? f.api.restoreWorkspace() : f.api.chooseWorkspace())
  expect(opened).toMatchObject({ ok: true, value: { absolutePath: f.destination } })
  const authority = await f.wired.ai.getWorkspaceAuthority()
  if (!authority) throw new Error('Missing workspace authority')
  expect(await f.api.startAiConversation!({ requestId: randomUUID(), conversationId: randomUUID(), workspaceKey: authority.workspaceId,
    acknowledgedTranscriptRevision: 0, messages: [{ id: randomUUID(), role: 'user', content: 'Reply using the local synthetic client.' }],
    capabilities: { currentDocument: false, workspace: false }, writePolicy: 'ask-every-time' })).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(f.webContents.send.mock.calls.some(([, event]) => event?.type === 'completed')).toBe(true))
})
