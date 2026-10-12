import { expect, it, vi } from 'vitest'
import {
  AiConversationRequestRegistry,
  AiConversationSessionService,
} from '../../src/main/models/ai-conversation-session-service'
import {
  WindowAiCurrentDocumentBroker,
  type RendererCurrentDocumentCaptureRequest,
  type RendererCurrentDocumentOpenRequest,
  type RendererCurrentDocumentPort,
} from '../../src/main/documents/window-ai-current-document-broker'

const AUTHORITY_A = Object.freeze({ workspaceId: 'workspace-a', workspaceGeneration: 'generation-a' })
const AUTHORITY_B = Object.freeze({ workspaceId: 'workspace-b', workspaceGeneration: 'generation-b' })
const OPEN_INPUT = Object.freeze({
  requestId: '10000000-0000-4000-8000-000000000001',
  conversationId: '20000000-0000-4000-8000-000000000001',
  workspaceId: AUTHORITY_A.workspaceId,
  workspaceGeneration: AUTHORITY_A.workspaceGeneration,
  toolCallId: 'call_1',
  signal: new AbortController().signal,
})

interface Deferred<T = void> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason?: unknown): void
}

class ManualDrainTimer {
  private nextId = 0
  readonly tasks = new Map<number, () => void>()
  readonly delays: number[] = []
  readonly cancelled: number[] = []

  readonly schedule = (callback: () => void, delayMs: number): number => {
    this.nextId += 1
    this.tasks.set(this.nextId, callback)
    this.delays.push(delayMs)
    return this.nextId
  }

  readonly cancel = (handle: unknown): void => {
    const id = handle as number
    this.tasks.delete(id)
    this.cancelled.push(id)
  }

  fireAll(): void {
    const callbacks = [...this.tasks.values()]
    this.tasks.clear()
    for (const callback of callbacks) callback()
  }
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function flushMicrotasks(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

function frozen<T extends object>(value: T): Readonly<T> { return Object.freeze(value) }

function captured(
  request: RendererCurrentDocumentCaptureRequest,
  snapshotId: string,
  text = 'abcdef',
  overrides: Record<string, unknown> = {},
) {
  const content = text.slice(request.cursor, request.cursor + request.maxChars)
  const consumed = request.cursor + content.length
  const hasMore = consumed < text.length
  return frozen({
    status: 'captured' as const,
    ...request,
    snapshotId,
    displayName: 'note.md',
    sourceFormat: 'markdown',
    dirty: true,
    content,
    nextCursor: hasMore ? consumed : null,
    hasMore,
    totalChars: text.length,
    ...overrides,
  })
}

function unavailable(request: RendererCurrentDocumentOpenRequest) {
  return frozen({ status: 'unavailable' as const, ...request })
}

it('preserves the expected source identity through delayed broker authority resolution', async () => {
  const expectedDocumentId = 'd30496c8-1725-4eab-ab59-b3152de3e938'
  const gate = deferred<typeof AUTHORITY_A>()
  let delayAuthority = false
  let activeDocumentId = expectedDocumentId
  const read = vi.fn(async (request: RendererCurrentDocumentOpenRequest) => (
    request.expectedDocumentId === activeDocumentId
      ? captured(request, 'captured-A', 'A content') : unavailable(request)
  ))
  const { broker } = await setup({ rendererPort: port({ openSnapshot: read }),
    getWorkspaceAuthority: () => delayAuthority ? gate.promise : AUTHORITY_A })
  const first = await broker.openSnapshot({ ...OPEN_INPUT, expectedDocumentId })
  expect(first).not.toBeNull()
  await first!.release()
  delayAuthority = true
  const second = broker.openSnapshot({ ...OPEN_INPUT, expectedDocumentId })
  await flushMicrotasks()
  activeDocumentId = 'bcdef123-1725-4eab-ab59-b3152de3e938'
  gate.resolve(AUTHORITY_A)
  expect(await second).toBeNull()
  expect(read).toHaveBeenLastCalledWith(expect.objectContaining({ expectedDocumentId }), expect.any(AbortSignal))
  await broker.dispose()
})

function port(options: {
  active?: () => { snapshotId: string; text: string; displayName?: string }
  openSnapshot?: RendererCurrentDocumentPort['openSnapshot']
  readPage?: RendererCurrentDocumentPort['readPage']
  release?: RendererCurrentDocumentPort['release']
} = {}): RendererCurrentDocumentPort {
  const captures = new Map<string, { text: string; displayName?: string }>()
  return {
    openSnapshot: options.openSnapshot ?? (async (request) => {
      const active = options.active?.() ?? { snapshotId: 'snapshot-1', text: 'abcdef' }
      captures.set(active.snapshotId, { text: active.text, displayName: active.displayName })
      return captured(request, active.snapshotId, active.text, active.displayName
        ? { displayName: active.displayName } : {})
    }),
    readPage: options.readPage ?? (async (request) => {
      const capture = captures.get(request.snapshotId)
      return capture === undefined
        ? frozen({ status: 'unavailable' as const, ...request })
        : captured(request, request.snapshotId, capture.text, capture.displayName
          ? { displayName: capture.displayName } : {})
    }),
    release: options.release ?? (async () => undefined),
  }
}

async function setup(options: {
  authority?: { current: typeof AUTHORITY_A | typeof AUTHORITY_B | null }
  getWorkspaceAuthority?: () => typeof AUTHORITY_A | typeof AUTHORITY_B | null
    | Promise<typeof AUTHORITY_A | typeof AUTHORITY_B | null>
  rendererPort?: RendererCurrentDocumentPort | null
  ids?: string[]
  limits?: {
    maxSnapshots?: number
    maxPendingCalls?: number
    maxOpenCalls?: number
    maxReadCallsPerSnapshot?: number
    maxCaptureCalls?: number
    maxCaptureChars?: number
    maxCaptureBytes?: number
    drainTimeoutMs?: number
  }
  capturePrimitives?: {
    utf8ByteLength(value: string): number
    createSha256(): { update(value: string): void; digestHex(): string }
  }
  drainTimer?: { schedule(callback: () => void, delayMs: number): unknown; cancel(handle: unknown): void }
} = {}) {
  const authority = options.authority ?? { current: AUTHORITY_A as typeof AUTHORITY_A | typeof AUTHORITY_B | null }
  const ids = options.ids ?? ['broker-request-1', 'broker-request-2', 'broker-request-3']
  const broker = new WindowAiCurrentDocumentBroker({
    ownerId: 7,
    getWorkspaceAuthority: options.getWorkspaceAuthority ?? (() => authority.current),
    createBrokerRequestId: () => ids.shift() ?? 'broker-request-exhausted',
    limits: options.limits,
    capturePrimitives: options.capturePrimitives,
    drainTimer: options.drainTimer,
  })
  const rendererPort = options.rendererPort === undefined ? port() : options.rendererPort
  const registration = rendererPort === null ? null : await broker.registerPort(rendererPort)
  return { authority, broker, registration, rendererPort }
}

function sessionForBroker(
  broker: WindowAiCurrentDocumentBroker,
  streamChat: ReturnType<typeof vi.fn>,
): AiConversationSessionService {
  const connectionId = '550e8400-e29b-41d4-a716-446655440000'
  const connection = {
    id: connectionId, name: 'Model', provider: 'deepseek', accessType: 'standard-api',
    protocol: 'openai', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-model',
    apiKeyHint: 'test', status: 'connected', lastTestedAt: null, capabilityOverride: null,
  }
  const models = {
    version: 5, codexCli: null,
    connections: [connection],
    selectionTranslation: {
      connectionId: null, reasoningEffort: 'off', targetLanguage: 'auto', privacyNoticeAccepted: false,
    },
    screenshotTranslation: { connectionId: null, reasoningEffort: 'off', targetLanguage: 'auto' },
    aiConversation: { connectionId, reasoningEffort: 'off', writePolicy: 'ask-every-time' },
  }
  return new AiConversationSessionService({
    ownerId: 7,
    requestRegistry: new AiConversationRequestRegistry(),
    settings: {
      get: () => ({ lastWorkspace: null, models }),
      getAiConversationWritePolicySnapshot: () => ({ policy: 'ask-every-time', revision: 0 }),
      subscribeAiConversationWritePolicy: () => () => undefined,
      getAiConversationModelSelectionSnapshot: () => ({
        connectionId, reasoningEffort: 'off', revision: 0,
      }),
      subscribeAiConversationModelSelection: () => () => undefined,
    },
    connections: { getCredentialSnapshot: async () => ({ connection, apiKey: 'api-key' }) },
    client: { streamChat, testConnection: async () => undefined },
    events: { emit: () => undefined },
    files: {
      getRootCapability: async () => ({
        windowId: 7, workspaceId: AUTHORITY_A.workspaceId, rootGeneration: 1,
        workspaceGeneration: AUTHORITY_A.workspaceGeneration,
        rootFinalPath: 'C:\\workspace-a', rootVolumeSerial: 'volume', rootFileId: 'root-workspace-a',
      }),
    },
    currentDocument: broker,
  } as unknown as ConstructorParameters<typeof AiConversationSessionService>[0])
}

it('captures the invocation-time document and constructs the public version entirely in main', async () => {
  let active = { snapshotId: 'snapshot-before', text: 'before' }
  const openRequests: RendererCurrentDocumentOpenRequest[] = []
  const rendererPort = port({
    async openSnapshot(request) {
      openRequests.push(request)
      return captured(request, active.snapshotId, active.text)
    },
  })
  active = { snapshotId: 'renderer-secret', text: '\uD83D\uDE00x' }
  const { broker } = await setup({ rendererPort })

  const snapshot = await broker.openSnapshot(OPEN_INPUT)
  expect(snapshot).not.toBeNull()
  expect(openRequests).toEqual([{
    ownerId: 7,
    requestId: OPEN_INPUT.requestId,
    conversationId: OPEN_INPUT.conversationId,
    workspaceId: AUTHORITY_A.workspaceId,
    workspaceGeneration: AUTHORITY_A.workspaceGeneration,
    toolCallId: OPEN_INPUT.toolCallId,
    brokerRequestId: 'broker-request-1',
    cursor: 0,
    maxChars: 48_000,
  }])
  const result = await snapshot!.readPage({ cursor: 0, maxChars: 3 }, OPEN_INPUT.signal)
  expect(result).toEqual({
    kind: 'document', displayName: 'note.md', sourceFormat: 'markdown', dirty: true,
    cursor: 0, content: '\uD83D\uDE00x', nextCursor: null, hasMore: false, totalChars: 3,
    version: {
      fileId: 'current-document.1',
      revision: '10f5e9cdd01d869815a52f43599f9c372ffa4b41cda11b5180da85dc0928333c',
      size: 5,
      mtimeMs: 1,
    },
  })
  expect(Reflect.ownKeys(snapshot!)).toEqual(['readPage', 'release'])
  expect(JSON.stringify(result)).not.toContain('renderer-secret')
  expect(JSON.stringify(result)).not.toContain(OPEN_INPUT.requestId)
  expect(JSON.stringify(result)).not.toContain('broker-request')
})

it.each(['fileId', 'revision', 'size', 'mtimeMs', 'version'])(
  'rejects a renderer attempt to provide public version field %s', async (field) => {
    const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
    const rendererPort = port({
      async openSnapshot(request) {
        return frozen({ ...captured(request, 'forged-version', 'abc'), [field]: 'renderer-value' })
      },
      release,
    })
    const { broker } = await setup({ rendererPort })
    expect(await broker.openSnapshot(OPEN_INPUT)).toBeNull()
    expect(release).toHaveBeenCalledOnce()
  },
)

it('captures all renderer pages before accepting and serves later pages only from the frozen main buffer', async () => {
  const rendererRead = vi.fn<RendererCurrentDocumentPort['readPage']>(async (request) => (
    request.cursor === 3 ? captured(request, 'multi-page', 'abcdef')
      : frozen({ status: 'unavailable' as const, ...request })
  ))
  const rendererPort = port({
    async openSnapshot(request) {
      return captured(request, 'multi-page', 'abcdef', { content: 'abc', nextCursor: 3, hasMore: true })
    },
    readPage: rendererRead,
  })
  const { broker } = await setup({ rendererPort })
  const snapshot = await broker.openSnapshot(OPEN_INPUT)

  expect(rendererRead).toHaveBeenCalledOnce()
  expect(await snapshot!.readPage({ cursor: 0, maxChars: 3 }, OPEN_INPUT.signal))
    .toMatchObject({ kind: 'document', content: 'abc', nextCursor: 3 })
  expect(await snapshot!.readPage({ cursor: 3, maxChars: 3 }, OPEN_INPUT.signal))
    .toMatchObject({ kind: 'document', content: 'def', nextCursor: null })
  expect(rendererRead).toHaveBeenCalledOnce()
})

it('captures hundreds of near-limit chunks with one incremental byte and hash update per chunk', async () => {
  const totalChars = 400
  const text = 'x'.repeat(totalChars)
  const byteInputs: string[] = []
  const hashInputs: string[] = []
  let digests = 0
  const capturePrimitives = {
    utf8ByteLength(value: string) {
      byteInputs.push(value)
      return Buffer.byteLength(value, 'utf8')
    },
    createSha256() {
      return {
        update(value: string) { hashInputs.push(value) },
        digestHex() { digests += 1; return 'a'.repeat(64) },
      }
    },
  }
  const capturePage = (request: RendererCurrentDocumentCaptureRequest) => {
    const next = request.cursor + 1
    return captured(request, 'many-chunks', text, {
      content: 'x', nextCursor: next < totalChars ? next : null,
      hasMore: next < totalChars,
    })
  }
  const rendererPort = port({
    async openSnapshot(request) { return capturePage(request) },
    async readPage(request) { return capturePage(request) },
  })
  const { broker } = await setup({
    rendererPort,
    capturePrimitives,
    limits: {
      maxCaptureCalls: totalChars,
      maxCaptureChars: totalChars,
      maxCaptureBytes: totalChars,
    },
  })

  const snapshot = await broker.openSnapshot(OPEN_INPUT)
  expect(snapshot).not.toBeNull()
  expect(byteInputs).toHaveLength(totalChars)
  expect(byteInputs.every((value) => value === 'x')).toBe(true)
  expect(hashInputs).toHaveLength(totalChars)
  expect(hashInputs.every((value) => value === 'x')).toBe(true)
  expect(digests).toBe(1)
  expect(await snapshot!.readPage({ cursor: 0, maxChars: 48_000 }, OPEN_INPUT.signal))
    .toMatchObject({ kind: 'document', content: text, version: { revision: 'a'.repeat(64), size: totalChars } })
})

it.each([
  ['metadata drift', { displayName: 'changed.md' }],
  ['dirty drift', { dirty: false }],
  ['total drift', { totalChars: 7 }],
  ['repeated cursor', { cursor: 0 }],
  ['non-progressing page', { content: '', nextCursor: 3 }],
  ['extra key', { extra: true }],
] as const)('releases a partial capture on %s', async (_name, fault) => {
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const rendererPort = port({
    async openSnapshot(request) {
      return captured(request, 'drifting', 'abcdef', { content: 'abc', nextCursor: 3, hasMore: true })
    },
    async readPage(request) { return frozen({ ...captured(request, 'drifting', 'abcdef'), ...fault }) },
    release,
  })
  const { broker } = await setup({ rendererPort })
  expect(await broker.openSnapshot(OPEN_INPUT)).toBeNull()
  expect(release).toHaveBeenCalledOnce()
})

it('keeps an accepted main-buffered snapshot stable across a same-workspace renderer document switch', async () => {
  let active = { snapshotId: 'snapshot-old', text: 'abcdef', displayName: 'old.md' }
  const rendererPort = port({ active: () => active })
  const { broker } = await setup({ rendererPort })
  const snapshot = await broker.openSnapshot(OPEN_INPUT)
  active = { snapshotId: 'snapshot-new', text: 'uvwxyz', displayName: 'new.md' }

  expect(await snapshot!.readPage({ cursor: 0, maxChars: 3 }, OPEN_INPUT.signal))
    .toMatchObject({ kind: 'document', displayName: 'old.md', content: 'abc' })
  expect(await snapshot!.readPage({ cursor: 3, maxChars: 3 }, OPEN_INPUT.signal))
    .toMatchObject({ kind: 'document', displayName: 'old.md', content: 'def' })
})

it('checks async trusted authority before and after every cached page', async () => {
  let current: typeof AUTHORITY_A | typeof AUTHORITY_B = AUTHORITY_A
  let calls = 0
  const postRead = deferred()
  const postReadEntered = deferred()
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const { broker } = await setup({
    rendererPort: port({ release }),
    getWorkspaceAuthority: async () => {
      calls += 1
      if (calls === 4) {
        postReadEntered.resolve()
        await postRead.promise
      }
      return current
    },
  })
  const snapshot = await broker.openSnapshot(OPEN_INPUT)
  const pending = snapshot!.readPage({ cursor: 0, maxChars: 3 }, OPEN_INPUT.signal)
  await postReadEntered.promise
  current = AUTHORITY_B
  postRead.resolve()

  expect(await pending).toEqual({ kind: 'unavailable' })
  expect(release).toHaveBeenCalledOnce()
})

it('rejects authority or port replacement during a partial capture and releases exactly once', async () => {
  const readEntered = deferred()
  const finishRead = deferred()
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const oldPort = port({
    async openSnapshot(request) {
      return captured(request, 'late-partial', 'abcdef', { content: 'abc', nextCursor: 3, hasMore: true })
    },
    async readPage(request) {
      readEntered.resolve()
      await finishRead.promise
      return captured(request, 'late-partial', 'abcdef')
    },
    release,
  })
  const state = await setup({ rendererPort: oldPort })
  const pending = state.broker.openSnapshot(OPEN_INPUT)
  await readEntered.promise
  state.authority.current = AUTHORITY_B
  const replacing = state.broker.registerPort(port())
  finishRead.resolve()

  expect(await pending).toBeNull()
  await replacing
  expect(release).toHaveBeenCalledOnce()
})

it.each([
  ['ownerId', { ownerId: 8 }],
  ['workspaceId', { workspaceId: 'workspace-b' }],
  ['workspaceGeneration', { workspaceGeneration: 'generation-b' }],
  ['toolCallId', { toolCallId: 'call_other' }],
  ['brokerRequestId', { brokerRequestId: 'renderer-chosen' }],
] as const)('rejects and releases a capture with forged %s', async (_name, forged) => {
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const rendererPort = port({
    async openSnapshot(request) { return frozen({ ...captured(request, 'forged-binding'), ...forged }) },
    release,
  })
  const { broker } = await setup({ rendererPort })
  expect(await broker.openSnapshot(OPEN_INPUT)).toBeNull()
  expect(release).toHaveBeenCalledOnce()
  expect(release.mock.calls[0]?.[0]).toMatchObject({
    ownerId: 7, workspaceId: AUTHORITY_A.workspaceId,
    workspaceGeneration: AUTHORITY_A.workspaceGeneration, snapshotId: 'forged-binding',
  })
})

it('rejects mutable, proxy, accessor, and null-prototype renderer data without invoking accessors', async () => {
  const getter = vi.fn(() => 'accessor-id')
  const request = frozen({
    ownerId: 7, requestId: OPEN_INPUT.requestId, conversationId: OPEN_INPUT.conversationId,
    workspaceId: AUTHORITY_A.workspaceId, workspaceGeneration: AUTHORITY_A.workspaceGeneration,
    toolCallId: OPEN_INPUT.toolCallId, brokerRequestId: 'broker-request-1', cursor: 0 as const, maxChars: 48_000,
  })
  const values: unknown[] = [
    { ...captured(request, 'mutable') },
    new Proxy(frozen({ status: 'captured' }), {}),
    Object.freeze(Object.defineProperty({ status: 'captured' }, 'snapshotId', { enumerable: true, get: getter })),
    Object.freeze(Object.assign(Object.create(null), { status: 'captured', snapshotId: 'null-record' })),
  ]
  let index = 0
  const rendererPort = port({ async openSnapshot() { return values[index++] } })
  const { broker } = await setup({ rendererPort, ids: [
    'broker-request-1', 'broker-request-2', 'broker-request-3', 'broker-request-4',
  ] })
  for (let call = 0; call < values.length; call += 1) {
    expect(await broker.openSnapshot({ ...OPEN_INPUT, toolCallId: `call_${call + 1}` })).toBeNull()
  }
  expect(getter).not.toHaveBeenCalled()
})

it('rejects a direct thenable port boundary without invoking renderer-controlled then', async () => {
  const then = vi.fn((_resolve: (value: unknown) => void) => undefined)
  const rendererPort = {
    openSnapshot: () => ({ then }),
    readPage: async (request: RendererCurrentDocumentCaptureRequest) => frozen({ status: 'unavailable' as const, ...request }),
    release: async () => undefined,
  } as unknown as RendererCurrentDocumentPort
  const { broker } = await setup({ rendererPort })
  expect(await broker.openSnapshot(OPEN_INPUT)).toBeNull()
  expect(then).not.toHaveBeenCalled()
})

it('rejects a duplicate or previously released snapshot ID and releases it exactly once', async () => {
  let calls = 0
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const { broker } = await setup({ rendererPort: port({
    async openSnapshot(request) {
      calls += 1
      return calls === 1 ? frozen({ ...captured(request, 'duplicate'), extra: true })
        : captured(request, 'duplicate')
    },
    release,
  }) })
  expect(await broker.openSnapshot(OPEN_INPUT)).toBeNull()
  expect(await broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_2' })).toBeNull()
  expect(release).toHaveBeenCalledOnce()
})

it('uses UTF-16-safe boundaries when paging the main buffer', async () => {
  const { broker } = await setup({ rendererPort: port({ active: () => ({
    snapshotId: 'emoji', text: 'a\uD83D\uDE00b', displayName: 'emoji.md',
  }) }) })
  const snapshot = await broker.openSnapshot(OPEN_INPUT)

  expect(await snapshot!.readPage({ cursor: 0, maxChars: 2 }, OPEN_INPUT.signal))
    .toMatchObject({ kind: 'document', content: 'a', nextCursor: 1 })
  expect(await snapshot!.readPage({ cursor: 1, maxChars: 2 }, OPEN_INPUT.signal))
    .toMatchObject({ kind: 'document', content: '\uD83D\uDE00', nextCursor: 3 })
  expect(await snapshot!.readPage({ cursor: 2, maxChars: 1 }, OPEN_INPUT.signal))
    .toEqual({ kind: 'unavailable' })
})

it('terminalizes an accepted buffered read on caller abort while authority never settles', async () => {
  const lateAuthority = deferred<typeof AUTHORITY_A>()
  let authorityCalls = 0
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const state = await setup({
    getWorkspaceAuthority: () => {
      authorityCalls += 1
      return authorityCalls <= 3 ? AUTHORITY_A : lateAuthority.promise
    },
    rendererPort: port({ release }),
  })
  const snapshot = await state.broker.openSnapshot(OPEN_INPUT)
  const caller = new AbortController()
  let terminal: unknown
  const reading = snapshot!.readPage({ cursor: 0, maxChars: 3 }, caller.signal)
    .then((value) => { terminal = value })

  expect(authorityCalls).toBe(4)
  caller.abort()
  await Promise.resolve()
  await Promise.resolve()
  expect(terminal).toEqual({ kind: 'unavailable' })

  lateAuthority.reject(new Error('late authority failure'))
  await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
  await reading
  expect(await snapshot!.readPage({ cursor: 0, maxChars: 3 }, OPEN_INPUT.signal))
    .toEqual({ kind: 'unavailable' })
  expect(release).toHaveBeenCalledOnce()
})

it('detaches an accepted buffered read at the broker deadline when authority never settles', async () => {
  const timer = new ManualDrainTimer()
  const lateAuthority = deferred<typeof AUTHORITY_A>()
  let authorityCalls = 0
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const state = await setup({
    getWorkspaceAuthority: () => {
      authorityCalls += 1
      return authorityCalls <= 4 ? AUTHORITY_A : lateAuthority.promise
    },
    rendererPort: port({ release }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
  })
  const snapshot = await state.broker.openSnapshot(OPEN_INPUT)
  let terminal: unknown
  const reading = snapshot!.readPage({ cursor: 0, maxChars: 3 }, OPEN_INPUT.signal)
    .then((value) => { terminal = value })
  await vi.waitFor(() => expect(authorityCalls).toBe(5))
  const disposing = state.broker.dispose()

  await Promise.resolve()
  timer.fireAll()
  await disposing
  await Promise.resolve()
  await Promise.resolve()
  expect(terminal).toEqual({ kind: 'unavailable' })
  expect(release).toHaveBeenCalledOnce()

  lateAuthority.resolve(AUTHORITY_A)
  await reading
  expect(terminal).toEqual({ kind: 'unavailable' })
  expect(release).toHaveBeenCalledOnce()
  expect(timer.tasks.size).toBe(0)
})

it('terminalizes an initial authority wait on caller abort without invoking the renderer', async () => {
  const authorityEntered = deferred()
  const lateAuthority = deferred<typeof AUTHORITY_A>()
  const openSnapshot = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => (
    captured(request, 'must-not-open')
  ))
  const caller = new AbortController()
  const state = await setup({
    getWorkspaceAuthority: () => {
      authorityEntered.resolve()
      return lateAuthority.promise
    },
    rendererPort: port({ openSnapshot }),
  })
  const portState = (state.broker as unknown as {
    currentPort: { operations: Set<unknown> }
  }).currentPort
  let terminal: unknown
  const pending = state.broker.openSnapshot({ ...OPEN_INPUT, signal: caller.signal })
    .then((value) => { terminal = value; return value })
  await authorityEntered.promise

  caller.abort()
  await flushMicrotasks()
  const terminalAtAbort = terminal
  lateAuthority.reject(new Error('late initial authority failure'))
  await expect(pending).resolves.toBeNull()

  expect(terminalAtAbort).toBeNull()
  expect(openSnapshot).not.toHaveBeenCalled()
  expect(portState.operations.size).toBe(0)
  expect((state.broker as unknown as { pendingCalls: number }).pendingCalls).toBe(0)
})

it('detaches an initial authority wait at the dispose deadline and ignores a late resolution', async () => {
  const timer = new ManualDrainTimer()
  const authorityEntered = deferred()
  const lateAuthority = deferred<typeof AUTHORITY_A>()
  const openSnapshot = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => (
    captured(request, 'must-not-open')
  ))
  const state = await setup({
    getWorkspaceAuthority: () => {
      authorityEntered.resolve()
      return lateAuthority.promise
    },
    rendererPort: port({ openSnapshot }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
  })
  const portState = (state.broker as unknown as {
    currentPort: { operations: Set<unknown> }
  }).currentPort
  let terminal: unknown
  const pending = state.broker.openSnapshot(OPEN_INPUT)
    .then((value) => { terminal = value; return value })
  await authorityEntered.promise

  const disposing = state.broker.dispose()
  await flushMicrotasks()
  const scheduledDeadlines = timer.tasks.size
  timer.fireAll()
  await disposing
  await flushMicrotasks()
  const terminalAtDeadline = terminal
  lateAuthority.resolve(AUTHORITY_A)
  await expect(pending).resolves.toBeNull()

  expect(scheduledDeadlines).toBe(1)
  expect(terminalAtDeadline).toBeNull()
  expect(openSnapshot).not.toHaveBeenCalled()
  expect(portState.operations.size).toBe(0)
  expect((state.broker as unknown as { pendingCalls: number }).pendingCalls).toBe(0)
  expect(timer.tasks.size).toBe(0)
})

it('releases a provisional snapshot when caller aborts a stalled first post-open authority check', async () => {
  const timer = new ManualDrainTimer()
  const postOpenAuthorityEntered = deferred()
  const lateAuthority = deferred<typeof AUTHORITY_A>()
  const lateReleaseAck = deferred()
  let authorityCalls = 0
  const release = vi.fn<RendererCurrentDocumentPort['release']>(() => lateReleaseAck.promise)
  const caller = new AbortController()
  const state = await setup({
    getWorkspaceAuthority: () => {
      authorityCalls += 1
      if (authorityCalls === 2) {
        postOpenAuthorityEntered.resolve()
        return lateAuthority.promise
      }
      return AUTHORITY_A
    },
    rendererPort: port({ release }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
  })
  let terminal: unknown
  const pending = state.broker.openSnapshot({ ...OPEN_INPUT, signal: caller.signal })
    .then((value) => { terminal = value; return value })
  await postOpenAuthorityEntered.promise

  caller.abort()
  await flushMicrotasks()
  const terminalAtAbort = terminal
  const releaseDeadlines = timer.tasks.size
  timer.fireAll()
  lateAuthority.reject(new Error('late post-open authority failure'))
  lateReleaseAck.reject(new Error('late provisional release failure'))
  await expect(pending).resolves.toBeNull()

  expect(terminalAtAbort).toBeNull()
  expect(releaseDeadlines).toBe(1)
  expect(release).toHaveBeenCalledOnce()
  expect(release.mock.calls[0]?.[0]).toMatchObject({
    snapshotId: 'snapshot-1', brokerRequestId: 'broker-request-1',
  })
  expect((state.broker as unknown as { pendingCalls: number }).pendingCalls).toBe(0)
  expect(timer.tasks.size).toBe(0)
})

it('detaches a stalled post-page authority check on replacement without mutating the new port', async () => {
  const timer = new ManualDrainTimer()
  const postPageAuthorityEntered = deferred()
  const lateAuthority = deferred<typeof AUTHORITY_A>()
  let authorityCalls = 0
  const oldRelease = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const oldPort = port({
    async openSnapshot(request) {
      return captured(request, 'post-page-replace', 'abcdef', {
        content: 'abc', nextCursor: 3, hasMore: true,
      })
    },
    async readPage(request) { return captured(request, 'post-page-replace', 'abcdef') },
    release: oldRelease,
  })
  const state = await setup({
    getWorkspaceAuthority: () => {
      authorityCalls += 1
      if (authorityCalls === 4) {
        postPageAuthorityEntered.resolve()
        return lateAuthority.promise
      }
      return AUTHORITY_A
    },
    rendererPort: oldPort,
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
    ids: ['broker-request-1', 'broker-request-2'],
  })
  const oldState = (state.broker as unknown as {
    currentPort: {
      operations: Set<unknown>
      snapshots: Map<string, unknown>
      releaseBySnapshotId: Map<string, unknown>
      releasePromises: Set<unknown>
    }
  }).currentPort
  let terminal: unknown
  const pending = state.broker.openSnapshot(OPEN_INPUT)
    .then((value) => { terminal = value; return value })
  await postPageAuthorityEntered.promise

  const newOpen = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => (
    captured(request, 'new-port')
  ))
  const replacing = state.broker.registerPort(port({ openSnapshot: newOpen }))
  await flushMicrotasks()
  expect(timer.tasks.size).toBe(1)
  timer.fireAll()
  await replacing
  await flushMicrotasks()
  const terminalAtDeadline = terminal
  lateAuthority.resolve(AUTHORITY_A)
  await expect(pending).resolves.toBeNull()

  expect(terminalAtDeadline).toBeNull()
  expect(oldRelease).toHaveBeenCalledOnce()
  expect(oldState.operations.size).toBe(0)
  expect(oldState.snapshots.size).toBe(0)
  expect(oldState.releaseBySnapshotId.size).toBe(0)
  expect(oldState.releasePromises.size).toBe(0)
  expect(newOpen).not.toHaveBeenCalled()
  expect(await state.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_2' })).not.toBeNull()
  expect(newOpen).toHaveBeenCalledOnce()
})

it('detaches a stalled post-page authority check on dispose and ignores a late rejection', async () => {
  const timer = new ManualDrainTimer()
  const postPageAuthorityEntered = deferred()
  const lateAuthority = deferred<typeof AUTHORITY_A>()
  let authorityCalls = 0
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const state = await setup({
    getWorkspaceAuthority: () => {
      authorityCalls += 1
      if (authorityCalls === 4) {
        postPageAuthorityEntered.resolve()
        return lateAuthority.promise
      }
      return AUTHORITY_A
    },
    rendererPort: port({
      async openSnapshot(request) {
        return captured(request, 'post-page-dispose', 'abcdef', {
          content: 'abc', nextCursor: 3, hasMore: true,
        })
      },
      async readPage(request) { return captured(request, 'post-page-dispose', 'abcdef') },
      release,
    }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
  })
  const portState = (state.broker as unknown as {
    currentPort: {
      operations: Set<unknown>
      snapshots: Map<string, unknown>
      releaseBySnapshotId: Map<string, unknown>
      releasePromises: Set<unknown>
    }
  }).currentPort
  let terminal: unknown
  const pending = state.broker.openSnapshot(OPEN_INPUT)
    .then((value) => { terminal = value; return value })
  await postPageAuthorityEntered.promise

  const disposing = state.broker.dispose()
  await flushMicrotasks()
  expect(timer.tasks.size).toBe(1)
  timer.fireAll()
  await disposing
  await flushMicrotasks()
  const terminalAtDeadline = terminal
  lateAuthority.reject(new Error('late post-page authority failure'))
  await expect(pending).resolves.toBeNull()

  expect(terminalAtDeadline).toBeNull()
  expect(release).toHaveBeenCalledOnce()
  expect(portState.operations.size).toBe(0)
  expect(portState.snapshots.size).toBe(0)
  expect(portState.releaseBySnapshotId.size).toBe(0)
  expect(portState.releasePromises.size).toBe(0)
  expect((state.broker as unknown as { pendingCalls: number }).pendingCalls).toBe(0)
})

it.each(['cancel', 'dispose'] as const)(
  'lets AI session %s drain while the broker initial authority never settles',
  async (action) => {
    const authorityEntered = deferred()
    const lateAuthority = deferred<typeof AUTHORITY_A>()
    const openSnapshot = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => (
      captured(request, 'must-not-open')
    ))
    const { broker } = await setup({
      getWorkspaceAuthority: () => {
        authorityEntered.resolve()
        return lateAuthority.promise
      },
      rendererPort: port({ openSnapshot }),
    })
    const session = sessionForBroker(broker, vi.fn(async () => ({
      toolCalls: [{ id: 'call_1', name: 'read_current_document', argumentsJson: '{"cursor":0,"maxChars":4}' }],
      reasoningContent: '', providerReplay: null, usage: null,
    })))
    await session.start({
      requestId: OPEN_INPUT.requestId,
      conversationId: OPEN_INPUT.conversationId,
      workspaceKey: AUTHORITY_A.workspaceId,
      acknowledgedTranscriptRevision: 0,
      messages: [{ id: '30000000-0000-4000-8000-000000000001', role: 'user', content: 'read it' }],
      capabilities: { currentDocument: true, workspace: false },
      writePolicy: 'ask-every-time',
    })
    await authorityEntered.promise

    let drained = false
    const draining = (action === 'cancel'
      ? session.cancel(OPEN_INPUT.requestId)
      : session.dispose()).then(() => { drained = true })
    await flushMicrotasks(40)
    const drainedBeforeLateAuthority = drained
    const activeCompletionsBeforeLateAuthority = (session as unknown as {
      activeCompletions: Set<unknown>
    }).activeCompletions.size
    lateAuthority.reject(new Error(`late authority after session ${action}`))
    await draining

    expect(drainedBeforeLateAuthority).toBe(true)
    expect(activeCompletionsBeforeLateAuthority).toBe(0)
    expect(openSnapshot).not.toHaveBeenCalled()
    expect((broker as unknown as { pendingCalls: number }).pendingCalls).toBe(0)
    await session.dispose()
    await broker.dispose()
  },
)

it('awaits an already in-flight release before making a replacement port available', async () => {
  const releaseAck = deferred()
  const releaseEntered = deferred()
  const oldRelease = vi.fn<RendererCurrentDocumentPort['release']>(async () => {
    releaseEntered.resolve()
    await releaseAck.promise
  })
  const old = await setup({ rendererPort: port({ release: oldRelease }), ids: [
    'broker-request-1', 'broker-request-2', 'broker-request-3',
  ] })
  const snapshot = await old.broker.openSnapshot(OPEN_INPUT)
  const releasing = snapshot!.release()
  await releaseEntered.promise
  const newOpen = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => captured(request, 'new'))
  let replacementReady = false
  const replacing = old.broker.registerPort(port({ openSnapshot: newOpen })).then((registration) => {
    replacementReady = true
    return registration
  })

  await Promise.resolve()
  expect(replacementReady).toBe(false)
  expect(await old.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_2' })).toBeNull()
  expect(newOpen).not.toHaveBeenCalled()
  releaseAck.resolve()
  await releasing
  const registration = await replacing
  expect(registration.portGeneration).toBeGreaterThan(0)
  expect(await old.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_3' })).not.toBeNull()
  expect(oldRelease).toHaveBeenCalledOnce()
})

it('clears a scheduled drain deadline when a normal release ACK arrives', async () => {
  const timer = new ManualDrainTimer()
  const releaseAck = deferred()
  const releaseEntered = deferred()
  const state = await setup({
    rendererPort: port({ release: async () => { releaseEntered.resolve(); await releaseAck.promise } }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 25 },
  })
  await state.broker.openSnapshot(OPEN_INPUT)
  const replacement = state.broker.registerPort(port())
  await releaseEntered.promise
  expect(timer.tasks.size).toBe(1)
  expect(timer.delays).toEqual([25])
  releaseAck.resolve()
  await replacement

  expect(timer.tasks.size).toBe(0)
  expect(timer.cancelled).toHaveLength(1)
})

it('uses a five-second default drain deadline and rejects values above the hard cap', async () => {
  const timer = new ManualDrainTimer()
  const releaseAck = deferred()
  const releaseEntered = deferred()
  const state = await setup({
    rendererPort: port({ release: async () => { releaseEntered.resolve(); await releaseAck.promise } }),
    drainTimer: timer,
  })
  await state.broker.openSnapshot(OPEN_INPUT)
  const replacement = state.broker.registerPort(port())
  await releaseEntered.promise
  expect(timer.delays).toEqual([5_000])
  releaseAck.resolve()
  await replacement

  expect(() => new WindowAiCurrentDocumentBroker({
    ownerId: 7,
    getWorkspaceAuthority: () => AUTHORITY_A,
    limits: { drainTimeoutMs: 30_001 },
  })).toThrow('Invalid current-document broker limit: drainTimeoutMs')
})

it('gives every accepted snapshot release its own strict bounded ACK lifecycle', async () => {
  const normalTimer = new ManualDrainTimer()
  const normalAck = deferred()
  const normalRelease = vi.fn<RendererCurrentDocumentPort['release']>(async () => { await normalAck.promise })
  const normal = await setup({
    rendererPort: port({ release: normalRelease }),
    drainTimer: normalTimer,
    limits: { drainTimeoutMs: 10 },
  })
  const normalSnapshot = await normal.broker.openSnapshot(OPEN_INPUT)
  let normallySettled = false
  const normalCompletion = Promise.resolve(normalSnapshot!.release()).then(() => { normallySettled = true })

  await Promise.resolve()
  expect(normallySettled).toBe(false)
  expect(normalTimer.tasks.size).toBe(1)
  normalAck.resolve()
  await normalCompletion
  expect(normalTimer.tasks.size).toBe(0)
  expect(normalTimer.cancelled).toHaveLength(1)
  expect(normalRelease).toHaveBeenCalledOnce()

  const timeoutTimer = new ManualDrainTimer()
  const lateAck = deferred()
  const timeoutRelease = vi.fn<RendererCurrentDocumentPort['release']>(() => lateAck.promise)
  const timed = await setup({
    rendererPort: port({ release: timeoutRelease }),
    drainTimer: timeoutTimer,
    limits: { drainTimeoutMs: 10 },
  })
  const timedSnapshot = await timed.broker.openSnapshot(OPEN_INPUT)
  const firstRelease = timedSnapshot!.release()
  expect(timedSnapshot!.release()).toBe(firstRelease)
  await Promise.resolve()
  expect(timeoutTimer.tasks.size).toBe(1)
  timeoutTimer.fireAll()
  await firstRelease

  const portState = (timed.broker as unknown as {
    currentPort: {
      snapshots: Map<string, unknown>
      releaseBySnapshotId: Map<string, unknown>
      releasePromises: Set<unknown>
      releasedSnapshotIds: Set<string>
    }
  }).currentPort
  expect(portState.snapshots.size).toBe(0)
  expect(portState.releaseBySnapshotId.size).toBe(0)
  expect(portState.releasePromises.size).toBe(0)
  expect(portState.releasedSnapshotIds.size).toBe(1)
  expect(timeoutRelease).toHaveBeenCalledOnce()

  lateAck.reject(new Error('late release failure'))
  await Promise.resolve()
  await timedSnapshot!.release()
  expect(timeoutRelease).toHaveBeenCalledOnce()
  expect(timeoutTimer.tasks.size).toBe(0)
})

it('bounds replacement when an old native open never settles and keeps the new port authoritative', async () => {
  const timer = new ManualDrainTimer()
  const openEntered = deferred()
  const never = new Promise<unknown>(() => undefined)
  const oldOpen = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(() => {
    openEntered.resolve()
    return never
  })
  const state = await setup({
    rendererPort: port({ openSnapshot: oldOpen }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
    ids: ['broker-request-1', 'broker-request-2'],
  })
  const pendingOpen = state.broker.openSnapshot(OPEN_INPUT)
  await openEntered.promise
  const newOpen = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => captured(request, 'new'))
  let ready = false
  const replacement = state.broker.registerPort(port({ openSnapshot: newOpen })).then((value) => {
    ready = true
    return value
  })
  await Promise.resolve()
  expect(ready).toBe(false)
  timer.fireAll()
  await replacement

  expect(ready).toBe(true)
  expect(await pendingOpen).toBeNull()
  expect(await state.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_2' })).not.toBeNull()
  expect(newOpen).toHaveBeenCalledOnce()
}, 500)

it('bounds dispose when an internal capture read never settles and releases the provisional snapshot once', async () => {
  const timer = new ManualDrainTimer()
  const readEntered = deferred()
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const lateRead = deferred<unknown>()
  let readRequest: RendererCurrentDocumentCaptureRequest | undefined
  const state = await setup({
    rendererPort: port({
      async openSnapshot(request) {
        return captured(request, 'hung-read', 'ab', { content: 'a', nextCursor: 1, hasMore: true })
      },
      readPage: (request) => { readRequest = request; readEntered.resolve(); return lateRead.promise },
      release,
    }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
  })
  const pendingRead = state.broker.openSnapshot(OPEN_INPUT)
  await readEntered.promise
  let disposed = false
  const disposing = state.broker.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  timer.fireAll()
  await disposing

  expect(disposed).toBe(true)
  expect(await pendingRead).toBeNull()
  expect(release).toHaveBeenCalledOnce()
  lateRead.resolve(captured(readRequest!, 'hung-read', 'ab'))
  await Promise.resolve()
  expect(release).toHaveBeenCalledOnce()
  await state.broker.dispose()
}, 500)

it('bounds never-settling release ACKs for replacement and dispose without duplicate release', async () => {
  const timer = new ManualDrainTimer()
  const oldRelease = vi.fn<RendererCurrentDocumentPort['release']>(() => new Promise<void>(() => undefined))
  const state = await setup({
    rendererPort: port({ release: oldRelease }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
    ids: ['broker-request-1', 'broker-request-2'],
  })
  const oldSnapshot = await state.broker.openSnapshot(OPEN_INPUT)
  const pendingRelease = oldSnapshot!.release()
  const newRelease = vi.fn<RendererCurrentDocumentPort['release']>(() => new Promise<void>(() => undefined))
  const replacing = state.broker.registerPort(port({ release: newRelease }))
  await Promise.resolve()
  timer.fireAll()
  await Promise.all([pendingRelease, replacing])
  expect(oldRelease).toHaveBeenCalledOnce()

  const newSnapshot = await state.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_2' })
  const pendingNewRelease = newSnapshot!.release()
  const disposing = state.broker.dispose()
  await Promise.resolve()
  timer.fireAll()
  await Promise.all([pendingNewRelease, disposing])
  expect(newRelease).toHaveBeenCalledOnce()
}, 500)

it('ignores a detached old response that settles after the drain deadline', async () => {
  const timer = new ManualDrainTimer()
  const late = deferred<unknown>()
  const openEntered = deferred()
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const oldPort = port({ openSnapshot: () => { openEntered.resolve(); return late.promise }, release })
  const state = await setup({
    rendererPort: oldPort,
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
    ids: ['broker-request-1', 'broker-request-2'],
  })
  const pending = state.broker.openSnapshot(OPEN_INPUT)
  await openEntered.promise
  const newOpen = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => captured(request, 'current'))
  const replacing = state.broker.registerPort(port({ openSnapshot: newOpen }))
  await Promise.resolve()
  timer.fireAll()
  await replacing
  late.resolve(captured(frozen({
    ownerId: 7, requestId: OPEN_INPUT.requestId, conversationId: OPEN_INPUT.conversationId,
    workspaceId: AUTHORITY_A.workspaceId, workspaceGeneration: AUTHORITY_A.workspaceGeneration,
    toolCallId: OPEN_INPUT.toolCallId, brokerRequestId: 'broker-request-1', cursor: 0 as const, maxChars: 48_000,
  }), 'late-old'))

  expect(await pending).toBeNull()
  expect(release).toHaveBeenCalledOnce()
  expect(await state.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_2' })).not.toBeNull()
  expect(newOpen).toHaveBeenCalledOnce()
})

it('handles a detached old rejection after returning the pending open as unavailable', async () => {
  const timer = new ManualDrainTimer()
  const late = deferred<unknown>()
  const openEntered = deferred()
  const state = await setup({
    rendererPort: port({ openSnapshot: () => { openEntered.resolve(); return late.promise } }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
  })
  const pendingOpen = state.broker.openSnapshot(OPEN_INPUT)
  await openEntered.promise
  const disposing = state.broker.dispose()
  await Promise.resolve()
  timer.fireAll()

  await disposing
  expect(await pendingOpen).toBeNull()
  late.reject(new Error('late renderer failure'))
  await Promise.resolve()
}, 500)

it('lets an AI session dispose drain a turn whose renderer open never settles', async () => {
  const late = deferred<unknown>()
  const openEntered = deferred()
  let openRequest: RendererCurrentDocumentOpenRequest | undefined
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const { broker } = await setup({
    rendererPort: port({
      openSnapshot(request) { openRequest = request; openEntered.resolve(); return late.promise },
      release,
    }),
  })
  const session = sessionForBroker(broker, vi.fn(async () => ({
    toolCalls: [{ id: 'call_1', name: 'read_current_document', argumentsJson: '{"cursor":0,"maxChars":4}' }],
    reasoningContent: '', providerReplay: null, usage: null,
  })))
  await session.start({
    requestId: OPEN_INPUT.requestId,
    conversationId: OPEN_INPUT.conversationId,
    workspaceKey: AUTHORITY_A.workspaceId,
    acknowledgedTranscriptRevision: 0,
    messages: [{ id: '30000000-0000-4000-8000-000000000001', role: 'user', content: 'read it' }],
    capabilities: { currentDocument: true, workspace: false },
    writePolicy: 'ask-every-time',
  })
  await openEntered.promise

  await session.dispose()
  await broker.dispose()
  late.resolve(captured(openRequest!, 'late-session'))
  await Promise.resolve()
  expect(release).toHaveBeenCalledOnce()
}, 500)

it('lets an accepted EOF snapshot release unblock session dispose at its own ACK deadline', async () => {
  const timer = new ManualDrainTimer()
  const releaseEntered = deferred()
  const releaseAck = deferred()
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => {
    releaseEntered.resolve()
    await releaseAck.promise
  })
  const { broker } = await setup({
    rendererPort: port({
      active: () => ({ snapshotId: 'session-eof', text: 'abc' }),
      release,
    }),
    drainTimer: timer,
    limits: { drainTimeoutMs: 10 },
  })
  const streamChat = vi.fn()
    .mockResolvedValueOnce({
      toolCalls: [{ id: 'call_1', name: 'read_current_document', argumentsJson: '{"cursor":0,"maxChars":4}' }],
      reasoningContent: '', providerReplay: null, usage: null,
    })
    .mockResolvedValueOnce({ toolCalls: [], reasoningContent: '', providerReplay: null, usage: null })
  const session = sessionForBroker(broker, streamChat)
  await session.start({
    requestId: OPEN_INPUT.requestId,
    conversationId: OPEN_INPUT.conversationId,
    workspaceKey: AUTHORITY_A.workspaceId,
    acknowledgedTranscriptRevision: 0,
    messages: [{ id: '30000000-0000-4000-8000-000000000001', role: 'user', content: 'read it' }],
    capabilities: { currentDocument: true, workspace: false },
    writePolicy: 'ask-every-time',
  })
  await releaseEntered.promise

  let disposed = false
  const disposing = session.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  expect(streamChat).toHaveBeenCalledOnce()
  expect(timer.tasks.size).toBe(1)
  timer.fireAll()
  await disposing

  expect(disposed).toBe(true)
  expect(release).toHaveBeenCalledOnce()
  expect(timer.tasks.size).toBe(0)
  expect(timer.cancelled).toHaveLength(1)
  await broker.dispose()
}, 500)

it('register replacement, unregister, and dispose await their own release ACK exactly once', async () => {
  const firstAck = deferred()
  const firstRelease = vi.fn<RendererCurrentDocumentPort['release']>(async () => { await firstAck.promise })
  const state = await setup({ rendererPort: port({ release: firstRelease }), ids: [
    'broker-request-1', 'broker-request-2', 'broker-request-3',
  ] })
  await state.broker.openSnapshot(OPEN_INPUT)
  let replacementReady = false
  const replacement = state.broker.registerPort(port()).then((value) => { replacementReady = true; return value })
  await Promise.resolve()
  expect(replacementReady).toBe(false)
  firstAck.resolve()
  await replacement
  expect(firstRelease).toHaveBeenCalledOnce()

  const secondAck = deferred()
  const secondRelease = vi.fn<RendererCurrentDocumentPort['release']>(async () => { await secondAck.promise })
  const secondRegistration = await state.broker.registerPort(port({ release: secondRelease }))
  await state.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_2' })
  let unregistered = false
  const unregistering = secondRegistration.unregister().then(() => { unregistered = true })
  await Promise.resolve()
  expect(unregistered).toBe(false)
  secondAck.resolve()
  await unregistering
  expect(secondRelease).toHaveBeenCalledOnce()

  const thirdAck = deferred()
  const thirdRelease = vi.fn<RendererCurrentDocumentPort['release']>(async () => { await thirdAck.promise })
  await state.broker.registerPort(port({ release: thirdRelease }))
  await state.broker.openSnapshot({ ...OPEN_INPUT, toolCallId: 'call_3' })
  let disposed = false
  const disposing = state.broker.dispose().then(() => { disposed = true })
  await Promise.resolve()
  expect(disposed).toBe(false)
  thirdAck.resolve()
  await disposing
  await state.broker.dispose()
  expect(thirdRelease).toHaveBeenCalledOnce()
})

it('dispose releases resources even when port generation is exhausted', async () => {
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const { broker } = await setup({ rendererPort: port({ release }) })
  await broker.openSnapshot(OPEN_INPUT)
  ;(broker as unknown as { portGeneration: number }).portGeneration = Number.MAX_SAFE_INTEGER

  await expect(broker.dispose()).resolves.toBeUndefined()
  expect(release).toHaveBeenCalledOnce()
})

it('fails closed at complete-capture and public-call limits', async () => {
  const release = vi.fn<RendererCurrentDocumentPort['release']>(async () => undefined)
  const tooManyPages = await setup({
    rendererPort: port({
      async openSnapshot(request) {
        return captured(request, 'too-many', 'abcd', { content: 'a', nextCursor: 1, hasMore: true })
      },
      async readPage(request) {
        return captured(request, 'too-many', 'abcd', {
          content: 'b', cursor: request.cursor, nextCursor: request.cursor + 1, hasMore: true,
        })
      },
      release,
    }),
    limits: { maxCaptureCalls: 2 },
  })
  expect(await tooManyPages.broker.openSnapshot(OPEN_INPUT)).toBeNull()
  expect(release).toHaveBeenCalledOnce()

  const bytes = await setup({
    rendererPort: port({ active: () => ({ snapshotId: 'bytes', text: '\uD83D\uDE00', displayName: 'emoji.md' }) }),
    limits: { maxCaptureBytes: 3 },
  })
  expect(await bytes.broker.openSnapshot(OPEN_INPUT)).toBeNull()

  const reads = await setup({ limits: { maxReadCallsPerSnapshot: 1 } })
  const snapshot = await reads.broker.openSnapshot(OPEN_INPUT)
  expect(await snapshot!.readPage({ cursor: 0, maxChars: 3 }, OPEN_INPUT.signal)).toMatchObject({ kind: 'document' })
  expect(await snapshot!.readPage({ cursor: 3, maxChars: 3 }, OPEN_INPUT.signal)).toEqual({ kind: 'unavailable' })
})

it('returns null for an absent or exact unavailable port result', async () => {
  const absent = (await setup({ rendererPort: null })).broker
  expect(await absent.openSnapshot(OPEN_INPUT)).toBeNull()
  const openSnapshot = vi.fn<RendererCurrentDocumentPort['openSnapshot']>(async (request) => unavailable(request))
  const unavailableBroker = (await setup({ rendererPort: port({ openSnapshot }) })).broker
  expect(await unavailableBroker.openSnapshot(OPEN_INPUT)).toBeNull()
  expect(openSnapshot).toHaveBeenCalledOnce()
})
