import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  forwardRef,
  useImperativeHandle,
  useState,
} from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wireDesktopLifecycle } from '../../src/main/desktop-lifecycle'
import { createModelProtocolClient } from '../../src/main/models/model-protocol-client'
import { OpenDocumentRegistry } from '../../src/main/documents/open-document-registry'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import {
  AI_CONVERSATION_EVENT_CHANNEL,
  IPC_CHANNELS,
  TRANSLATION_EVENT_CHANNEL,
  type AiCurrentDocumentRendererPort,
  type ArkdownApi,
} from '../../src/shared/contracts'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import type { LargeModelSettings } from '../../src/shared/large-model-settings'
import type { CodeExplanationRequestDetail } from '../../src/renderer/editor/mermaid/adaptive-code-block-view'
import { useAiConversation } from '../../src/renderer/editor/use-ai-conversation'
import { modelObservation } from '../helpers/model-observation'

const CONNECTION_ID = '550e8400-e29b-41d4-a716-446655440000'
const IDS = [
  '550e8400-e29b-41d4-a716-446655440001',
  '550e8400-e29b-41d4-a716-446655440002',
  '550e8400-e29b-41d4-a716-446655440003',
  '550e8400-e29b-41d4-a716-446655440004',
  '550e8400-e29b-41d4-a716-446655440005',
  '550e8400-e29b-41d4-a716-446655440006',
] as const

const visualEditorBridge = vi.hoisted(() => ({
  requestCodeExplanation: null as null | ((detail: CodeExplanationRequestDetail) => void),
}))

vi.mock('../../src/renderer/editor/VisualEditor', () => ({
  VisualEditor: forwardRef<
    { flush(): string | null },
    {
      markdown: string
      onCodeExplanationRequest?(detail: CodeExplanationRequestDetail): void
    }
  >(function CrossLayerVisualEditor({ markdown, onCodeExplanationRequest }, ref) {
    visualEditorBridge.requestCodeExplanation = onCodeExplanationRequest ?? null
    useImperativeHandle(ref, () => ({ flush: () => markdown }), [markdown])
    return (
      <button
        onClick={() => onCodeExplanationRequest?.({
          language: 'ts',
          code: 'const unsavedValue = 42',
        })}
        type="button"
      >
        跨层解读代码
      </button>
    )
  }),
}))

vi.mock('../../src/renderer/editor/SourceEditor', () => ({
  SourceEditor: forwardRef(function CrossLayerSourceEditor(_, ref) {
    useImperativeHandle(ref, () => ({ flush: () => null }), [])
    return <div data-testid="cross-layer-source-editor" />
  }),
}))

import { EditorPane } from '../../src/renderer/editor/EditorPane'

class EventBus {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()

  emit(channel: string, payload: unknown): void {
    for (const listener of this.listeners.get(channel) ?? []) listener(payload)
  }

  transport(channel: string): { subscribe(listener: (payload: unknown) => void): () => void } {
    return {
      subscribe: (listener) => {
        const listeners = this.listeners.get(channel) ?? new Set()
        listeners.add(listener)
        this.listeners.set(channel, listeners)
        return () => listeners.delete(listener)
      },
    }
  }
}

class TestWindow {
  private readonly closedListeners = new Set<() => void>()
  private readonly closeListeners = new Set<(event: { preventDefault(): void }) => void>()
  readonly webContents: {
    id: number
    mainFrame: object
    send: ReturnType<typeof vi.fn>
    isDestroyed: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
    removeListener: ReturnType<typeof vi.fn>
  }
  readonly isDestroyed = vi.fn(() => false)

  constructor(bus: EventBus) {
    this.webContents = {
      id: 1,
      mainFrame: {},
      send: vi.fn((channel: string, payload: unknown) => bus.emit(channel, payload)),
      isDestroyed: vi.fn(() => false),
      on: vi.fn(),
      removeListener: vi.fn(),
    }
  }

  once(event: 'closed', listener: () => void): void {
    if (event === 'closed') this.closedListeners.add(listener)
  }

  on(event: 'close', listener: (event: { preventDefault(): void }) => void): void {
    if (event === 'close') this.closeListeners.add(listener)
  }

  getSize(): [number, number] { return [1200, 800] }
  getPosition(): [number, number] { return [0, 0] }
  close(): void { this.triggerClosed() }

  triggerClosed(): void {
    for (const listener of this.closedListeners) listener()
    this.closedListeners.clear()
    this.closeListeners.clear()
  }
}

function registrar() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
  return {
    handlers,
    handle: vi.fn((
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => Promise<unknown>,
    ) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    on: vi.fn(),
    removeListener: vi.fn(),
  }
}

function modelSettings(): LargeModelSettings {
  return {
    version: 6, codexCli: null,
    connections: [{
      id: CONNECTION_ID,
      name: 'Cross-layer model',
      provider: 'deepseek',
      accessType: 'standard-api',
      protocol: 'openai',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'cross-layer-model',
      apiKeyHint: '••••test',
      status: 'connected',
      lastTestedAt: null,
      capabilityOverride: null,
    }],
    selectionTranslation: {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'en',
      privacyNoticeAccepted: true,
    },
    screenshotTranslation: {
      connectionId: null,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      targetLanguage: 'auto',
    },
    aiConversation: {
      connectionId: CONNECTION_ID,
      thinkingMode: 'default' as const, reasoningEffort: 'default',
      writePolicy: 'ask-every-time',
    },
  }
}

function sseResponse(payloads: readonly unknown[]): Response {
  const body = [
    ...payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function toolCallResponse(
  id: string,
  cursor: number,
  maxChars: number,
): Response {
  return sseResponse([{
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id,
          function: {
            name: 'read_current_document',
            arguments: JSON.stringify({ cursor, maxChars }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }])
}

function textResponse(...deltas: string[]): Response {
  return sseResponse(deltas.map((delta, index) => ({
    choices: [{
      delta: { content: delta },
      finish_reason: index === deltas.length - 1 ? 'stop' : null,
    }],
  })))
}

interface CrossLayerHarness {
  api: ArkdownApi
  settings: LargeModelSettings
  reactivateWorkspace(): Promise<void>
  close(): void
}

const openHarnesses = new Set<CrossLayerHarness>()

async function createCrossLayerHarness(fetchImpl: typeof fetch): Promise<CrossLayerHarness> {
  const settings = modelSettings()
  const bus = new EventBus()
  const ipcMain = registrar()
  const appWindow = new TestWindow(bus)
  const settingsValue = { lastWorkspace: null, models: settings }
  const settingsCoordinator = {
    get: () => settingsValue,
    update: vi.fn(async () => undefined),
    getEditorAppearanceSnapshot: () => ({
      appearance: DEFAULT_EDITOR_APPEARANCE,
      revision: 0,
    }),
    setEditorAppearance: vi.fn(async (appearance) => ({ appearance, revision: 1 })),
    compareAndSetEditorAppearance: vi.fn(async () => ({
      applied: false,
      snapshot: { appearance: DEFAULT_EDITOR_APPEARANCE, revision: 0 },
    })),
    getAiConversationWritePolicySnapshot: () => ({
      policy: settings.aiConversation.writePolicy,
      revision: 0,
    }),
    subscribeAiConversationWritePolicy: vi.fn(() => () => undefined),
    getAiConversationModelSelectionSnapshot: () => ({
      connectionId: settings.aiConversation.connectionId,
      thinkingMode: settings.aiConversation.thinkingMode, reasoningEffort: settings.aiConversation.reasoningEffort,
      revision: 0,
    }),
    subscribeAiConversationModelSelection: vi.fn(() => () => undefined),
  }
  const modelConnections = {
    getSettings: () => settings,
    getCredentialSnapshot: async () => ({
      connection: settings.connections[0]!,
      apiKey: 'cross-layer-api-key',
    }),
    setAiConversation: vi.fn(async () => settings),
  }

  const wired = wireDesktopLifecycle({
    ipcMain: ipcMain as never,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    window: appWindow as never,
    runtimeDependencies: {
      workspaceCommitAdapter: undefined,
      openDocumentRegistry: new OpenDocumentRegistry(),
      workspaceAiEditorBoundary: {
        withIdentityLease: async (_target: unknown, operation: () => unknown) => await operation(),
        lookup: vi.fn(async () => ({ status: 'closed' as const })),
        captureReadSnapshot: vi.fn(),
        planReplacement: vi.fn(),
        applyTransaction: vi.fn(),
        queryOutcome: vi.fn(),
      },
      registerWindowCleanup: vi.fn((cleanup: () => void | Promise<void>) => ({
        disposeWindow: async () => { await cleanup() },
        unregister: vi.fn(),
      })),
    } as never,
    documentConversions: { convertResolved: vi.fn() } as never,
    settingsCoordinator: settingsCoordinator as never,
    saveWindowBounds: vi.fn(async () => undefined),
    confirmStopAi: vi.fn(async () => true),
    onCloseStateChanged: vi.fn(),
    normalizeBounds: (bounds) => bounds,
    reportOperationError: vi.fn(),
    reportCloseError: vi.fn(),
    modelConnections: modelConnections as never,
    observedModelConnections: { getSettings: async () => modelObservation(settings) } as never,
    modelSecretVault: { get: vi.fn(async () => 'cross-layer-api-key') } as never,
    modelProtocolClient: createModelProtocolClient(fetchImpl, 1_000),
    controlWindow: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 0 })),
    getWindowState: vi.fn(() => ({ maximized: false, fullscreen: false, revision: 0 })),
  })
  await wired.workspace.setRoot(process.cwd())
  await wired.ai.synchronizeWorkspaceAfterDirectRootSet()

  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = ipcMain.handlers.get(channel)
    if (!handler) throw new Error(`Missing IPC handler for ${channel}`)
    return handler({
      sender: appWindow.webContents,
      senderFrame: appWindow.webContents.mainFrame,
    }, ...args)
  }
  let currentDocumentPort: AiCurrentDocumentRendererPort | undefined
  bus.transport(IPC_CHANNELS.aiRendererPortRequest).subscribe((raw) => {
    if (!raw || typeof raw !== 'object') return
    const request = raw as {
      transportRequestId?: string
      method?: 'openSnapshot' | 'readPage' | 'release'
      payload?: Record<string, unknown>
    }
    if (!request.transportRequestId || !request.method || !request.payload) return
    const port = currentDocumentPort
    const unavailable = request.method === 'release'
      ? { status: 'released' as const }
      : { status: 'unavailable' as const }
    void (async () => {
      let result: unknown = unavailable
      if (port) {
        if (request.method === 'openSnapshot') {
          result = await port.openSnapshot({
            cursor: 0,
            maxChars: Number(request.payload!.maxChars),
          })
        } else if (request.method === 'readPage') {
          result = await port.readPage({
            snapshotId: String(request.payload!.snapshotId),
            cursor: Number(request.payload!.cursor),
            maxChars: Number(request.payload!.maxChars),
          })
        } else {
          await port.release({ snapshotId: String(request.payload!.snapshotId) })
        }
      }
      await invoke(IPC_CHANNELS.submitAiCurrentDocumentPortResponse, {
        transportRequestId: request.transportRequestId,
        method: request.method,
        result,
      })
    })()
  })
  const apiArguments: Parameters<typeof createArkdownApi> = [invoke]
  apiArguments[7] = bus.transport(TRANSLATION_EVENT_CHANNEL)
  apiArguments[23] = bus.transport(AI_CONVERSATION_EVENT_CHANNEL)
  apiArguments[24] = {
    attachCurrentDocumentPort(port) {
      let active = false
      return {
        commit() { currentDocumentPort = port; active = true },
        rollback() { if (active && currentDocumentPort === port) currentDocumentPort = undefined },
        detach() { if (currentDocumentPort === port) currentDocumentPort = undefined },
      }
    },
    attachOpenDocumentPort() {
      return { bind() {}, detach() {} }
    },
  }
  const api = createArkdownApi(...apiArguments) as ArkdownApi
  const harness: CrossLayerHarness = {
    api,
    settings,
    async reactivateWorkspace() {
      await wired.workspace.setRoot(process.cwd())
      await wired.ai.synchronizeWorkspaceAfterDirectRootSet()
    },
    close() {
      appWindow.triggerClosed()
      openHarnesses.delete(harness)
    },
  }
  openHarnesses.add(harness)
  return harness
}

afterEach(() => {
  for (const harness of [...openHarnesses]) harness.close()
  visualEditorBridge.requestCodeExplanation = null
})

describe('AI conversation cross-layer harness', () => {
  it.each([IDS[0], null])('completes an actual renderer send with document identity %s through preload, IPC and protocol', async (expectedDocumentId) => {
    const bodies: Array<Record<string, unknown>> = []
    const harness = await createCrossLayerHarness(vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (expectedDocumentId === null && bodies.length === 1) return toolCallResponse('call_null_document', 0, 20)
      return textResponse('Identity-safe ', 'answer.')
    }) as typeof fetch)
    const openSnapshot = vi.fn(async () => ({ status: 'captured' as const, snapshotId: 'unrelated-snapshot',
      displayName: 'unrelated.md', sourceFormat: 'markdown', dirty: true, content: 'unrelated private document',
      nextCursor: null, hasMore: false, totalChars: 26 }))
    expect((await harness.api.registerAiCurrentDocumentPort({ openSnapshot,
      readPage: async () => ({ status: 'unavailable' as const }), release() {} })).ok).toBe(true)
    const workspace = await harness.api.getAiWorkspaceState()
    if (!workspace.ok) throw new Error(workspace.error.message)
    const { result } = renderHook(() => useAiConversation({ api: harness.api, workspace: workspace.value }))
    await act(async () => {
      expect(await result.current.sendMessage('Answer with this document identity', expectedDocumentId)).toBe(true)
    })
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Identity-safe answer.'))
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
    expect(bodies[0]).toMatchObject({ model: 'cross-layer-model', messages: expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'Answer with this document identity' }),
    ]) })
    expect(openSnapshot).not.toHaveBeenCalled()
    expect(JSON.stringify(bodies)).not.toContain('unrelated private document')
    if (expectedDocumentId === null) {
      expect(bodies).toHaveLength(2)
      const messages = bodies[1]!.messages as Array<Record<string, unknown>>
      const tool = messages.find(({ role }) => role === 'tool')
      expect(tool).toMatchObject({ tool_call_id: 'call_null_document' })
      expect(JSON.parse(String(tool?.content))).toMatchObject({ kind: 'unavailable' })
    }
  })

  it.each(['model', 'effort', 'workspace'] as const)('retains default document intent through a %s transition and honors explicit off at the actual tool boundary', async (change) => {
    const bodies: Array<Record<string, unknown>> = []
    let askForRead = true
    const harness = await createCrossLayerHarness(vi.fn(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (askForRead) { askForRead = false; return toolCallResponse(`call_${bodies.length}`, 0, 20) }
      return textResponse('Finished')
    }) as typeof fetch)
    const openSnapshot = vi.fn(async () => ({ status: 'captured' as const, snapshotId: 'snapshot-fresh', displayName: 'note.md',
      sourceFormat: 'markdown', dirty: true, content: 'private unsaved text', nextCursor: null, hasMore: false, totalChars: 20 }))
    const port: AiCurrentDocumentRendererPort = { openSnapshot, readPage: async () => ({ status: 'unavailable' }), release() {} }
    const binding = await harness.api.getAiWorkspaceState()
    if (!binding.ok) throw new Error(binding.error.message)
    expect((await harness.api.registerAiCurrentDocumentPort({ ...port })).ok).toBe(true)
    const view = renderHook(({ workspace, profileFingerprint }) => useAiConversation({ api: harness.api, workspace, profileFingerprint }),
      { initialProps: { workspace: binding.value, profileFingerprint: 'first' } })
    expect(view.result.current.capabilities.currentDocument).toBe(true)
    await act(async () => { expect(await view.result.current.sendMessage('Read the current document')).toBe(true) })
    await waitFor(() => expect(view.result.current.status).toBe('idle'))
    expect(openSnapshot).toHaveBeenCalledOnce()
    expect(JSON.stringify(bodies[0])).not.toContain('private unsaved text')
    let workspace = binding.value
    if (change === 'model') harness.settings.connections[0]!.modelId = 'second-model'
    if (change === 'effort') harness.settings.aiConversation.reasoningEffort = 'high'
    if (change === 'workspace') {
      await harness.reactivateWorkspace()
      const next = await harness.api.getAiWorkspaceState()
      if (!next.ok) throw new Error(next.error.message)
      workspace = next.value
      expect((await harness.api.registerAiCurrentDocumentPort({ ...port })).ok).toBe(true)
    }
    view.rerender({ workspace, profileFingerprint: 'second' })
    expect(view.result.current.capabilities.currentDocument).toBe(true)
    askForRead = true
    await act(async () => { expect(await view.result.current.sendMessage('Read it again')).toBe(true) })
    await waitFor(() => expect(view.result.current.status).toBe('idle'))
    expect(openSnapshot).toHaveBeenCalledTimes(2)
    await act(async () => { expect(await view.result.current.setCurrentDocumentAccess(false)).toBe(true) })
    view.rerender({ workspace, profileFingerprint: 'third' })
    askForRead = true
    await act(async () => { expect(await view.result.current.sendMessage('No document read')).toBe(true) })
    await waitFor(() => expect(view.result.current.status).toBe('idle'))
    expect(openSnapshot).toHaveBeenCalledTimes(2)
    expect(view.result.current.capabilities.currentDocument).toBe(false)
    expect(JSON.stringify(bodies.at(-1))).toContain('denied')
  })
  it('keeps document text out of the first protocol payload, then pages one current unsaved snapshot', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (requestBodies.length === 1) return toolCallResponse('call_page_1', 0, 5)
      if (requestBodies.length === 2) return toolCallResponse('call_page_2', 5, 5)
      return textResponse('Paged ', 'answer.')
    }) as unknown as typeof fetch
    const harness = await createCrossLayerHarness(fetchImpl)
    window.arkdown = harness.api
    const createIds = [...IDS]
    const workspaceState = await harness.api.getAiWorkspaceState()
    if (!workspaceState.ok) throw new Error(workspaceState.error.message)
    const activeWorkspace = workspaceState.value
    const readSnapshot = vi.fn(() => 'draft-body')
    const snapshots = new Map<string, string>()
    const registration = await harness.api.registerAiCurrentDocumentPort({
      async openSnapshot({ maxChars }) {
        const content = readSnapshot()
        snapshots.set('snapshot-1', content)
        const page = content.slice(0, maxChars)
        return {
          status: 'captured',
          snapshotId: 'snapshot-1',
          displayName: 'unsaved.md',
          sourceFormat: 'markdown',
          dirty: true,
          content: page,
          nextCursor: page.length < content.length ? page.length : null,
          hasMore: page.length < content.length,
          totalChars: content.length,
        }
      },
      async readPage({ snapshotId, cursor, maxChars }) {
        const content = snapshots.get(snapshotId)
        if (!content) return { status: 'unavailable' }
        const page = content.slice(cursor, cursor + maxChars)
        const nextCursor = cursor + page.length < content.length ? cursor + page.length : null
        return {
          status: 'captured',
          displayName: 'unsaved.md',
          sourceFormat: 'markdown',
          dirty: true,
          content: page,
          nextCursor,
          hasMore: nextCursor !== null,
          totalChars: content.length,
        }
      },
      release({ snapshotId }) { snapshots.delete(snapshotId) },
    })
    expect(registration.ok).toBe(true)
    const { result } = renderHook(() => useAiConversation({
      api: harness.api,
      workspace: workspaceState.value,
      createId: () => createIds.shift() ?? IDS.at(-1)!,
    }))

    await act(async () => {
      await result.current.setCurrentDocumentAccess(true)
      await result.current.sendMessage('Summarize only after permission')
    })
    await waitFor(() => expect(result.current.messages.at(-1)?.content).toBe('Paged answer.'))

    expect(JSON.stringify(requestBodies[0])).not.toContain('draft-body')
    expect(requestBodies[0]).toHaveProperty('tools')
    expect(readSnapshot).toHaveBeenCalledOnce()
    expect(requestBodies).toHaveLength(3)
    const continuationMessages = requestBodies[2]!.messages as Array<Record<string, unknown>>
    const toolMessages = continuationMessages.filter(({ role }) => role === 'tool')
    expect(toolMessages).toHaveLength(2)
    expect(toolMessages.map(({ content }) => JSON.parse(String(content)))).toMatchObject([
      {
        dirty: true,
        cursor: 0,
        content: 'draft',
        nextCursor: 5,
        hasMore: true,
        totalChars: 10,
      },
      {
        dirty: true,
        cursor: 5,
        content: '-body',
        nextCursor: null,
        hasMore: false,
        totalChars: 10,
      },
    ])
    expect(toolMessages).toEqual([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_page_1' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_page_2' }),
    ])
    expect(toolMessages.every((message) => !Object.hasOwn(message, 'name'))).toBe(true)
  })

  it('opens the AI tab for code explanation and renders a real streamed protocol response', async () => {
    let resolveResponse!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve })
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return response
    }) as unknown as typeof fetch
    const harness = await createCrossLayerHarness(fetchImpl)
    window.arkdown = harness.api
    const workspaceState = await harness.api.getAiWorkspaceState()
    if (!workspaceState.ok) throw new Error(workspaceState.error.message)
    const activeWorkspace = workspaceState.value

    function CodeExplanationPane() {
      const [rightSidebarState, setRightSidebarState] = useState<{
        open: boolean
        activeTab: 'translation' | 'ai-chat' | 'document-view'
      }>({ open: false, activeTab: 'translation' })
      return <>
        <output data-testid="cross-layer-sidebar-state">
          {rightSidebarState.open ? 'open' : 'closed'}:{rightSidebarState.activeTab}
        </output>
        <EditorPane
          aiWorkspace={activeWorkspace}
          documentDirty
          documentDisplayName="unsaved-code.md"
          documentKey="__untitled__:code-cross-layer"
          markdown="```ts\nconst unsavedValue = 42\n```"
          onChange={() => undefined}
          onCloseRightSidebar={() => setRightSidebarState((current) => ({
            ...current,
            open: false,
          }))}
          onOpenLargeModelSettings={() => undefined}
          onOpenRightSidebar={(activeTab) => setRightSidebarState({ open: true, activeTab })}
          rightSidebarState={rightSidebarState}
        />
      </>
    }

    render(<CodeExplanationPane />)
    fireEvent.click(screen.getByRole('button', { name: '跨层解读代码' }))

    await waitFor(() => expect(screen.getByTestId('cross-layer-sidebar-state'))
      .toHaveTextContent('open:ai-chat'))
    await waitFor(() => expect(requestBodies).toHaveLength(1))
    expect(JSON.stringify(requestBodies[0])).toContain('const unsavedValue = 42')
    expect(await screen.findByRole('button', { name: '停止生成' })).toBeInTheDocument()

    resolveResponse(textResponse('Code explanation ', 'streamed.'))

    expect(await screen.findByText('Code explanation streamed.')).toBeInTheDocument()
  })

  it('keeps selection translation on the same preload/IPC/protocol path without tools', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return textResponse('Translated')
    }) as unknown as typeof fetch
    const harness = await createCrossLayerHarness(fetchImpl)
    const terminal = new Promise<void>((resolve) => {
      const unsubscribe = harness.api.onTranslationEvent((event) => {
        if (event.type !== 'completed') return
        unsubscribe()
        resolve()
      })
    })

    const started = await harness.api.startTranslation({
      documentKey: 'notes/current.md',
      content: { markdown: '**hello**', plainText: 'hello' },
      mode: 'visual',
    })
    expect(started.ok).toBe(true)
    await terminal

    expect(requestBodies).toHaveLength(1)
    expect(requestBodies[0]).not.toHaveProperty('tools')
    expect(requestBodies[0]).not.toHaveProperty('tool_choice')
    expect(JSON.stringify(requestBodies[0])).toContain('**hello**')
  })
})
