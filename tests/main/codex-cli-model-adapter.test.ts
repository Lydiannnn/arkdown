import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createCodexCliModelAdapter, codexHistory, codexModelError, CODEX_RESTRICTED_CONFIG } from '../../src/main/codex/codex-cli-model-adapter'
import { createModelProtocolClient, type ModelChatInput } from '../../src/main/models/model-protocol-client'
import { CODEX_CLI_BASE_URL, DEFAULT_LARGE_MODEL_SETTINGS, featureModelConnections, parseLargeModelSettings } from '../../src/shared/large-model-settings'

it.each([
  ['unauthorized', 'cli-authentication'], ['contextWindowExceeded', 'context-limit'],
  ['badRequest', 'request-rejected'], ['sandboxError', 'cli-sandbox'],
  ['serverOverloaded', 'service-unavailable'], ['other', 'unknown'],
] as const)('retains semantic Codex %s metadata without changing legacy status projection', (codexErrorInfo, reason) => {
  const error = codexModelError({ codexErrorInfo, message: 'PRIVATE_MODEL_PROSE' })
  expect(error.detail).toMatchObject({ reason, source: 'codex' })
  expect(JSON.stringify(error)).not.toContain('PRIVATE_MODEL_PROSE')
})

it.each([[403, 'access-denied'], [404, 'not-found'], [402, 'request-rejected'], [503, 'service-unavailable'], [null, 'stream-interrupted']] as const)(
  'does not infer an unsupported root cause from CLI transport HTTP %s', (httpStatusCode, reason) => {
    expect(codexModelError({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode } }, message: 'TLS expired quota wrong key' }).detail)
      .toMatchObject({ reason, source: 'codex' })
  },
)

it('identifies a missing CLI executable without launching a process or diagnosing login', async () => {
  const removeWorkspace = vi.fn(async () => undefined)
  const adapter = createCodexCliModelAdapter({ createWorkspace: async () => 'C:/synthetic-unused', removeWorkspace, resolveExecutable: async () => undefined })
  await expect(adapter.streamChat(input())).rejects.toMatchObject({ detail: { reason: 'cli-unavailable', stage: 'cli', source: 'codex' } })
  expect(removeWorkspace).toHaveBeenCalledOnce()
})

type Packet = { id?: number; method?: string; params: Record<string, any> }
function harness(options: { onTurn?(send: (packet: unknown) => void): void; noClose?: boolean; setupError?: boolean; rpcError?: unknown } = {}) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  const sent: Packet[] = []
  Object.assign(child, { pid: 12, stdout: new PassThrough(), stderr: new PassThrough() })
  const send = (packet: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(packet)+'\n'))
  Object.assign(child, { stdin: new Writable({ write(chunk, _encoding, callback) {
    const request = JSON.parse(chunk.toString()) as Packet; sent.push(request)
    queueMicrotask(() => {
      if (!request.id) return
      if (request.method === 'initialize' && (options.setupError || options.rpcError !== undefined)) {
        send({ id: request.id, error: options.rpcError ?? { message: 'FAKE_SECRET_MUST_NOT_ESCAPE' } }); return
      }
      const result = request.method === 'config/read' ? { config: { mcp_servers: { 'with.dot': { env: { TOKEN:'FAKE_SECRET_MUST_NOT_ESCAPE' } } } } }
        : request.method === 'thread/start' ? { thread: { id: 'thread-1' } }
        : request.method === 'turn/start' ? { turn: { id: 'turn-1' } } : {}
      // Exercise notifications arriving before the turn/start response.
      if (request.method === 'turn/start') {
        // Legacy answer fixtures use a known ordinary message; unclassified-message
        // regressions below deliberately use other IDs until metadata arrives.
        send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'message-1', phase: null, text: '' } } })
        options.onTurn?.(send)
      }
      send({ id: request.id, result })
    })
    callback()
  } }) })
  child.stdin.on('finish', () => { if (!options.noClose) child.emit('close', 0, null) })
  const removeWorkspace = vi.fn(async () => {})
  const terminateTree = vi.fn(async () => { child.emit('close', 0, null) })
  const launch = vi.fn(async () => child)
  const adapter = createCodexCliModelAdapter({ launch, createWorkspace: async () => 'C:/isolated-test', removeWorkspace, terminateTree, timeoutMs: 30, cleanupTimeoutMs: 5 })
  return { child, sent, launch, adapter, removeWorkspace, terminateTree, send }
}
function input(overrides: Partial<ModelChatInput> = {}): ModelChatInput {
  return { provider:'other', protocol:'openai', baseUrl:CODEX_CLI_BASE_URL, modelId:'codex-default', apiKey:'',
    messages:[{role:'system',content:'Translate only'},{role:'user',content:'hello'}], reasoningEffort:'default', thinkingMode:'default',
    signal:new AbortController().signal, onDelta:vi.fn(), ...overrides }
}
const delta = (text: string, threadId = 'thread-1') => ({ method:'item/agentMessage/delta',params:{threadId,turnId:'turn-1',itemId:'message-1',delta:text} })
const completed = { method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}} }

describe('Codex CLI model transport', () => {
  it('omits display callbacks from Codex connection probes', async () => {
    const onProcess = vi.fn()
    const h = harness({ onTurn(send) {
      send({ ...completed, params: { ...completed.params, turn: { ...completed.params.turn, items: [
        { type: 'reasoning', id: 'r1', summary: ['probe only'], content: [] }, { type: 'agentMessage', id: 'm1', text: 'OK', phase: null },
      ] } } })
    } })
    await createModelProtocolClient(vi.fn() as unknown as typeof fetch, 1000, h.adapter).testConnection(input({ onProcess }))
    expect(onProcess).not.toHaveBeenCalled()
  })
  it.each([
    { itemId: undefined, summaryIndex: 0 }, { itemId: '', summaryIndex: 0 }, { itemId: 'r1', summaryIndex: -1 },
    { itemId: 'r1', summaryIndex: 0.5 }, { itemId: 'r1', contentIndex: 0 }, { itemId: 'r1', summaryIndex: Number.MAX_SAFE_INTEGER + 1 },
  ])('validates owned reasoning item IDs and event-specific safe indexes: %j', async fields => {
    const h = harness({ onTurn(send) {
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', delta: 'text', ...fields } })
      send(completed)
    } })
    await expect(h.adapter.streamChat(input({ onProcess: vi.fn() }))).rejects.toMatchObject({ detail: { reason: 'protocol-malformed', source: 'codex' } })
  })
  it.each(['unclassified', 'missing-id', 'type-change', 'phase-change', 'divergent', 'oversize-pending'] as const)('rejects unsafe message routing: %s', async fault => {
    const onDelta = vi.fn(), onProcess = vi.fn()
    const h = harness({ onTurn(send) {
      const event = (method: string, extra: Record<string, unknown>) => send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...extra } })
      event('item/agentMessage/delta', { itemId: fault === 'missing-id' ? undefined : 'unknown', delta: fault === 'oversize-pending' ? 'x'.repeat(100_000) : 'prefix' })
      if (fault === 'oversize-pending') for (let i = 0; i < 2; i++) event('item/agentMessage/delta', { itemId: 'unknown', delta: 'x'.repeat(100_000) })
      if (fault === 'type-change') event('item/started', { item: { id: 'unknown', type: 'reasoning' } })
      if (fault === 'phase-change' || fault === 'divergent') {
        event('item/started', { item: { id: 'unknown', type: 'agentMessage', phase: 'commentary' } })
        event('item/completed', { item: { id: 'unknown', type: 'agentMessage', phase: fault === 'phase-change' ? 'final_answer' : 'commentary', text: 'changed' } })
      }
      send(completed)
    } })
    await expect(h.adapter.streamChat(input({ onDelta, onProcess }))).rejects.toMatchObject({ detail: { reason: 'protocol-malformed' } })
    expect(onDelta).not.toHaveBeenCalled()
  })
  it('classifies buffered ordinary text from final metadata and keeps process opt-in out of the request', async () => {
    const onDelta = vi.fn(), onProcess = vi.fn()
    const h = harness({ onTurn(send) {
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'late-classified', delta: 'Hello' } })
      expect(onDelta).not.toHaveBeenCalled()
      send({ ...completed, params: { ...completed.params, turn: { ...completed.params.turn, items: [{ type: 'agentMessage', id: 'late-classified', phase: null, text: 'Hello world' }] } } })
    } })
    await h.adapter.streamChat(input({ onDelta, onProcess }))
    expect(onDelta.mock.calls).toEqual([['Hello'], [' world']]); expect(onProcess).not.toHaveBeenCalled()
    expect(h.sent.find(packet => packet.method === 'turn/start')?.params).not.toHaveProperty('summary')
  })
  it('suppresses process text after a tool interruption and honors process callback cancellation', async () => {
    const onProcess = vi.fn()
    const h = harness({ onTurn(send) {
      send({ id: 99, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call_1', tool: 'read_document', arguments: {} } })
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r1', summaryIndex: 0, delta: 'late' } })
    } })
    await h.adapter.streamChat(input({ onProcess, tools: [{ name: 'read_document', description: 'read', inputSchema: { type: 'object' } }] }))
    expect(onProcess).not.toHaveBeenCalled()
    const controller = new AbortController(), onDelta = vi.fn()
    const second = harness({ onTurn(send) {
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r1', summaryIndex: 0, delta: 'Summary' } })
      send(delta('late answer')); send(completed)
    } })
    await expect(second.adapter.streamChat(input({ signal: controller.signal, onProcess: () => controller.abort(), onDelta })))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(onDelta).not.toHaveBeenCalled()
  })
  it('routes late-classified commentary and reasoning suffixes without contaminating answers', async () => {
    const onProcess = vi.fn(), onDelta = vi.fn()
    const reason = { type: 'reasoning', id: 'r1', summary: ['Summary done'], content: ['Readable'] }
    const comment = { type: 'agentMessage', id: 'c1', phase: 'commentary', text: 'Working done' }
    const h = harness({ onTurn(send) {
      const event = (method: string, extra: Record<string, unknown>) => send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...extra } })
      event('item/agentMessage/delta', { itemId: 'c1', delta: 'Working' })
      event('item/started', { item: { ...comment, text: '' } })
      event('item/reasoning/summaryTextDelta', { itemId: 'r1', summaryIndex: 0, delta: 'Summary' })
      event('item/reasoning/textDelta', { itemId: 'r1', contentIndex: 0, delta: 'Readable' })
      event('item/completed', { item: reason }); event('item/completed', { item: comment })
      send({ ...completed, params: { ...completed.params, turn: { ...completed.params.turn, items: [reason, comment, { type: 'agentMessage', id: 'final', text: 'Answer', phase: 'final_answer' }] } } })
    } })
    await h.adapter.streamChat(input({ onProcess, onDelta }))
    expect(onDelta.mock.calls).toEqual([['Answer']])
    expect(onProcess.mock.calls.map(([event]) => [event.kind, event.itemId, event.segmentIndex, event.delta, event.delivery])).toEqual([
      ['commentary', 'c1', 0, 'Working', 'stream'], ['reasoning-summary', 'r1', 0, 'Summary', 'stream'],
      ['reasoning-text', 'r1', 0, 'Readable', 'stream'], ['reasoning-summary', 'r1', 0, ' done', 'complete'],
      ['commentary', 'c1', 0, ' done', 'complete'],
    ])
  })
  it('contains optional process consumer exceptions and suppresses post-terminal queued notifications', async () => {
    const onProcess = vi.fn(() => { throw new Error('display unavailable') })
    const h = harness({ onTurn(send) {
      send({ ...completed, params: { ...completed.params, turn: { ...completed.params.turn, items: [
        { type: 'reasoning', id: 'r1', summary: ['Summary'], content: [] }, { type: 'agentMessage', id: 'm1', text: 'Answer', phase: null },
      ] } } })
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'r1', summaryIndex: 0, delta: 'late' } })
    } })
    const request = input({ onProcess })
    await h.adapter.streamChat(request)
    expect(onProcess).toHaveBeenCalledOnce()
    expect(request.onDelta).toHaveBeenCalledExactlyOnceWith('Answer')
  })
  it('separates a local text consumer failure from CLI output parsing', async () => {
    const h = harness({ onTurn(send) { send(delta('partial')); send(completed) } })
    await expect(h.adapter.streamChat(input({ onDelta() { throw new Error('PRIVATE_CALLBACK') } })))
      .rejects.toMatchObject({ detail: { reason: 'unknown', stage: 'receive', source: 'codex' } })
    expect(h.removeWorkspace).toHaveBeenCalledOnce()
  })
  it('distinguishes host edit authorization from the read-only native CLI sandbox', async () => {
    const h = harness({ onTurn(send) {
      send({ id: 99, method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call_edit', namespace: null, tool: 'edit_workspace_document', arguments: { path: 'synthetic.md' } } })
    } })
    const tool = { name: 'edit_workspace_document', description: 'Request an authorized host edit.', inputSchema: { type: 'object' } }
    const result = await h.adapter.streamChat(input({ tools: [tool] }))
    const start = h.sent.find(packet => packet.method === 'thread/start')!.params
    expect(start).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', config: CODEX_RESTRICTED_CONFIG, dynamicTools: [{ type: 'function', ...tool }] })
    expect(start.baseInstructions).toContain('CLI 沙箱只读')
    expect(start.baseInstructions).toContain('这不代表宿主文档只读')
    expect(start.baseInstructions).toContain('需要许可时由 Arkdown 询问')
    expect(start.baseInstructions).toContain('仅凭成功工具结果声称已修改')
    expect(result.toolCalls).toEqual([{ id: 'call_edit', name: 'edit_workspace_document', argumentsJson: '{"path":"synthetic.md"}' }])
    expect(h.sent.some(packet => packet.id === 99)).toBe(false)
  })
  it('uses the completed agentMessage text when the server did not emit deltas', async () => {
    const h = harness({ onTurn(send) {
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'message-1', text: '你好', phase: 'final_answer', memoryCitation: null } } })
      send(completed)
    } })
    const request = input()
    await h.adapter.streamChat(request)
    expect(request.onDelta).toHaveBeenCalledExactlyOnceWith('你好')
  })
  it('adds only missing final text and does not duplicate item and turn completion payloads', async () => {
    const finalItem = { type: 'agentMessage', id: 'message-1', text: '你好世界', phase: 'final_answer', memoryCitation: null }
    const h = harness({ onTurn(send) {
      send(delta('你好'))
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: finalItem } })
      send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { ...finalItem, id: 'commentary', phase: 'commentary', text: 'Working' } } })
      send({ ...completed, params: { ...completed.params, turn: { ...completed.params.turn, items: [finalItem] } } })
    } })
    const onDelta = vi.fn()
    await h.adapter.streamChat(input({ onDelta }))
    expect(onDelta.mock.calls).toEqual([['你好'], ['世界']])
  })
  it('sends the selected concrete CLI model and supported effort to the app server', async () => {
    const h = harness({ onTurn(send) { send(delta('OK')); send(completed) } })
    await h.adapter.streamChat(input({ modelId: 'account-model', reasoningEffort: 'ultra', capabilityOverride: { thinking: { thinking: 'fixed', encoding: 'openai-effort', efforts: ['low', 'ultra'], defaultThinking: 'enabled', defaultEffort: 'low', disabledEfforts: [] } } }))
    expect(h.sent.find(packet => packet.method === 'thread/start')?.params.model).toBe('account-model')
    expect(h.sent.find(packet => packet.method === 'turn/start')?.params.effort).toBe('ultra')
  })
  it.each(['codex-cli', 'codex-cli:refreshed-model'])('normalizes a stale persisted effort for %s against refreshed capability before dispatch', async connectionId => {
    const h = harness({ onTurn(send) { send(delta('OK')); send(completed) } })
    const settings = parseLargeModelSettings(JSON.parse(JSON.stringify({
      ...DEFAULT_LARGE_MODEL_SETTINGS,
      codexCli: { status: 'connected', cliVersion: 'test', lastTestedAt: '2026-09-13T00:00:00.000Z', models: [{ modelId: 'refreshed-model', displayName: 'Refreshed model', supportedReasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low', isDefault: true }] },
      aiConversation: { ...DEFAULT_LARGE_MODEL_SETTINGS.aiConversation, connectionId, reasoningEffort: 'ultra' },
    })))!
    expect(settings.aiConversation.reasoningEffort).toBe('ultra')
    const connection = featureModelConnections(settings).find(model => model.id === connectionId)!
    const request = input({ ...connection, ...settings.aiConversation })
    await h.adapter.streamChat(request)
    expect(h.sent.find(packet => packet.method === 'turn/start')?.params.effort).toBe('low')
    expect(request.reasoningEffort).toBe('ultra')
  })
  it.each(['default', 'unknown'] as const)('omits an effort override for the %s CLI preference or capability', async kind => {
    const h = harness({ onTurn(send) { send(delta('OK')); send(completed) } })
    await h.adapter.streamChat(input({ modelId: 'gpt-5.5', reasoningEffort: kind === 'unknown' ? 'ultra' : 'default', thinkingMode: 'enabled', capabilityOverride: kind === 'unknown' ? null : { thinking: { thinking: 'fixed', encoding: 'openai-effort', efforts: ['low', 'high'], defaultThinking: 'enabled', defaultEffort: 'low', disabledEfforts: [] } } }))
    expect(h.sent.find(packet => packet.method === 'turn/start')?.params).not.toHaveProperty('effort')
  })
  it('streams only the owned turn and disables all discovered MCP servers without forwarding secrets', async () => {
    const h=harness({onTurn(send){send(delta('ignored','foreign'));send(delta('你好'));send(completed)}})
    const request=input()
    expect(await h.adapter.streamChat(request)).toMatchObject({toolCalls:[],providerReplay:null})
    expect(request.onDelta).toHaveBeenCalledExactlyOnceWith('你好')
    const start=h.sent.find(packet=>packet.method==='thread/start')!.params
    expect(start).toMatchObject({ephemeral:true,cwd:'C:/isolated-test',environments:[],runtimeWorkspaceRoots:[],approvalPolicy:'never',sandbox:'read-only',config:{...CODEX_RESTRICTED_CONFIG,mcp_servers:{'with.dot':{enabled:false}}}})
    expect(JSON.stringify(h.sent)).not.toContain('FAKE_SECRET_MUST_NOT_ESCAPE')
    expect(h.removeWorkspace).toHaveBeenCalledExactlyOnceWith('C:/isolated-test')
  })
  it('hands a dynamic call to Arkdown without reporting a fake tool result or running it',async()=>{
    const h=harness({onTurn(send){send({id:99,method:'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:'call_1',tool:'read_document',arguments:{path:'a.md'}}})}})
    const result=await h.adapter.streamChat(input({tools:[{name:'read_document',description:'Read',inputSchema:{type:'object'}}]}))
    expect(result.toolCalls).toEqual([{id:'call_1',name:'read_document',argumentsJson:'{"path":"a.md"}'}])
    expect(h.sent.some(packet=>packet.method==='turn/interrupt')).toBe(true)
    expect(h.sent.some(packet=>packet.id===99)).toBe(false)
    expect(h.sent.find(packet=>packet.method==='thread/start')!.params.dynamicTools[0]).toMatchObject({type:'function',name:'read_document'})
  })
  it('replays assistant tool calls and real tool outputs without encrypted provider history',()=>{
    const history=codexHistory([{role:'assistant',content:'',providerReplay:{protocol:'openai-chat',encryptedContent:'SECRET_REPLAY'},toolCalls:[{id:'call_1',name:'read_document',argumentsJson:'{}'}]},{role:'tool',toolCallId:'call_1',name:'read_document',content:'Authorized document'}])
    expect(history).toEqual([{type:'function_call',call_id:'call_1',name:'read_document',arguments:'{}'},{type:'function_call_output',call_id:'call_1',output:'Authorized document'}])
  })
  it.each(['shell','unknown','bad-id'])('rejects unauthorized tool/approval request %s',async(kind)=>{
    const h=harness({onTurn(send){send({id:99,method:kind==='shell'?'item/commandExecution/requestApproval':'item/tool/call',params:{threadId:'thread-1',turnId:'turn-1',callId:kind==='bad-id'?'bad\n':'call_1',tool:kind==='unknown'?'unknown':'read_document',arguments:{}}})}})
    await expect(h.adapter.streamChat(input({tools:[{name:'read_document',description:'Read',inputSchema:{}}]}))).rejects.toMatchObject({status:'incompatible-response'})
    expect(h.removeWorkspace).toHaveBeenCalledTimes(1)
  })
  it('aborts an active turn, suppresses late output, and closes its child',async()=>{
    const controller=new AbortController(),h=harness()
    const request=input({signal:controller.signal}), promise=h.adapter.streamChat(request)
    const rejection=expect(promise).rejects.toMatchObject({name:'AbortError'})
    await vi.waitFor(()=>expect(h.sent.some(packet=>packet.method==='turn/start')).toBe(true),{interval:1})
    controller.abort()
    h.send(delta('late')); await rejection
    expect(request.onDelta).not.toHaveBeenCalled()
    expect(h.removeWorkspace).toHaveBeenCalledTimes(1)
  })
  it('times out an idle server and escalates shutdown only after stdin EOF is ignored',async()=>{
    const h=harness({noClose:true})
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({status:'timeout'})
    expect(h.child.stdin.writableEnded).toBe(true)
    expect(h.terminateTree).toHaveBeenCalledTimes(1)
    expect(h.removeWorkspace).toHaveBeenCalledTimes(1)
  })
  it('rejects process exit, malformed output and credential-bearing RPC errors with fixed errors',async()=>{
    const setup=harness({setupError:true})
    await expect(setup.adapter.streamChat(input())).rejects.toThrow('The model provider returned an incompatible response')
    const h=harness({onTurn(){h.child.emit('close',1,null)}})
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({status:'invalid-endpoint'})
    const malformed=harness({onTurn(){malformed.child.stdout.emit('data',Buffer.from('{oops\n'))}})
    await expect(malformed.adapter.streamChat(input())).rejects.toMatchObject({status:'incompatible-response'})
  })
  it('never invokes HTTP for the Codex endpoint',async()=>{
    const fetch=vi.fn(),streamChat=vi.fn(async()=>({toolCalls:[],reasoningContent:'',providerReplay:null,usage:null}))
    const client=createModelProtocolClient(fetch,15_000,{streamChat})
    await client.streamChat(input()); await client.testConnection(input())
    expect(streamChat).toHaveBeenCalledTimes(2); expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps Codex commentary out of structured translation output',async()=>{
    const h=harness({onTurn(send){send({method:'item/started',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',id:'commentary',phase:'commentary'}}});send({...delta('Working...'),params:{...delta('').params,itemId:'commentary',delta:'Working...'}});send(delta('{"translations":[]}'));send(completed)}})
    const request=input();await h.adapter.streamChat(request)
    expect(request.onDelta).toHaveBeenCalledExactlyOnceWith('{"translations":[]}')
  })
  it('cleans the temporary workspace after launch failure without exposing the launch error',async()=>{
    const removeWorkspace=vi.fn(async()=>{})
    const adapter=createCodexCliModelAdapter({createWorkspace:async()=> 'C:/isolated-test',launch:async()=>{throw new Error('launch rejected')},removeWorkspace})
    await expect(adapter.streamChat(input())).rejects.toMatchObject({status:'invalid-endpoint'})
    expect(removeWorkspace).toHaveBeenCalledTimes(1)
  })
})

describe('Codex structured errors', () => {
  const retryConnectionFailure = (threadId = 'thread-1', turnId = 'turn-1') => ({
    method: 'error', params: { threadId, turnId, willRetry: true,
      error: { codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        message: 'PRIVATE_PROVIDER_MESSAGE', additionalDetails: 'PRIVATE_PROVIDER_DETAILS' } },
  })
  it.each(['notification', 'completed'])('preserves the owned retry connection classification when the final %s degrades to other', async channel => {
    const h = harness({ onTurn(send) {
      send(retryConnectionFailure())
      const error = { codexErrorInfo: 'other', message: 'PRIVATE_FINAL_MESSAGE' }
      send(channel === 'notification'
        ? { method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error } }
        : { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error } } })
    } })
    const error = await h.adapter.streamChat(input()).catch(error => error)
    expect(error).toMatchObject({ status: 'invalid-endpoint' })
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain('PRIVATE_')
    expect(h.removeWorkspace).toHaveBeenCalledOnce()
  })
  it.each([
    [{ codexErrorInfo: 'unauthorized' }, 'authentication-failed'],
    [{ codexErrorInfo: 'other', code: -32001 }, 'rate-limited'],
    [{ codexErrorInfo: 'badRequest' }, 'incompatible-response'],
    [{ codexErrorInfo: 'sandboxError' }, 'incompatible-response'],
    [{ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 400 } } }, 'incompatible-response'],
    [{ message: 'connection failed' }, 'incompatible-response'],
  ])('preserves a new explicit or unrecognized final error %# after a connection retry', async (error, status) => {
    const h = harness({ onTurn(send) {
      send(retryConnectionFailure())
      send({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error } })
    } })
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({ status })
  })
  it('does not reclassify a malformed agent message after a connection retry', async () => {
    const h = harness({ onTurn(send) {
      send(retryConnectionFailure())
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: 42 } })
    } })
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('discards an older connection classification when a later retry reports a different error', async () => {
    const h = harness({ onTurn(send) {
      send(retryConnectionFailure())
      send({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { codexErrorInfo: 'badRequest' } } })
      send({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { codexErrorInfo: 'other' } } })
    } })
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it.each(['foreign-thread', 'foreign-turn'])('does not reuse connection retry metadata from %s', async source => {
    const h = harness({ onTurn(send) {
      send(retryConnectionFailure(
        source === 'foreign-thread' ? 'foreign' : 'thread-1', source === 'foreign-turn' ? 'foreign' : 'turn-1'))
      send({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { codexErrorInfo: 'other' } } })
    } })
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it('does not retain a prior request connection failure on the same adapter', async () => {
    const first = harness({ onTurn(send) { send(retryConnectionFailure()); send(delta('Recovered')); send(completed) } })
    const second = harness({ onTurn(send) {
      send({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-1', willRetry: false, error: { codexErrorInfo: 'other' } } })
    } })
    const adapter = createCodexCliModelAdapter({
      launch: vi.fn().mockResolvedValueOnce(first.child).mockResolvedValueOnce(second.child),
      createWorkspace: async () => 'C:/isolated-test', removeWorkspace: async () => {},
    })
    await adapter.streamChat(input())
    await expect(adapter.streamChat(input())).rejects.toMatchObject({ status: 'incompatible-response' })
  })
  it.each([
    ['unauthorized', 'authentication-failed'],
    ['usageLimitExceeded', 'quota-exceeded'],
    ['sessionBudgetExceeded', 'quota-exceeded'],
    ['serverOverloaded', 'rate-limited'],
    ['internalServerError', 'invalid-endpoint'],
    ['contextWindowExceeded', 'incompatible-response'],
    ['badRequest', 'incompatible-response'],
    ['sandboxError', 'incompatible-response'],
    ['other', 'incompatible-response'],
  ])('maps %s without retaining provider message or details', (info, status) => {
    const error=codexModelError({codexErrorInfo:info,message:'FAKE_SECRET_MUST_NOT_ESCAPE',additionalDetails:'PRIVATE_PATH'})
    expect(error.status).toBe(status)
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toMatch(/FAKE_SECRET|PRIVATE_PATH/)
  })
  for (const variant of ['httpConnectionFailed','responseStreamConnectionFailed','responseStreamDisconnected','responseTooManyFailedAttempts']) {
    it.each([
      [401,'authentication-failed'],[403,'authentication-failed'],[402,'quota-exceeded'],[404,'model-not-found'],
      [408,'timeout'],[504,'timeout'],[429,'rate-limited'],[503,'invalid-endpoint'],[null,'invalid-endpoint'],[400,'incompatible-response'],
    ])(`maps ${variant} HTTP %s`, (httpStatusCode,status) => {
      expect(codexModelError({codexErrorInfo:{[variant]:{httpStatusCode}},message:'private'}).status).toBe(status)
    })
  }
  it('rejects unknown shapes and never infers authentication or quota from a raw message',()=>{
    for(const error of ['401 quota reached',null,{message:'401 quota reached'},{codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:'401'}}},{codexErrorInfo:{unexpected:{httpStatusCode:401}}}]) {
      expect(codexModelError(error).status).toBe('incompatible-response')
    }
    expect(codexModelError({code:-32001,message:'private'}).status).toBe('rate-limited')
  })
  it.each(['notification','completed','rpc'])('maps the %s error entry point and closes the process',async channel=>{
    const error={message:'FAKE_SECRET_MUST_NOT_ESCAPE',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:401}}}
    const h=harness(channel==='rpc' ? {rpcError:{code:-32603,message:'private',data:error}} : {onTurn(send){
      send(channel==='notification' ? {method:'error',params:{threadId:'thread-1',turnId:'turn-1',willRetry:false,error}}
        : {method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'failed',error}}})
    }})
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({status:'authentication-failed',message:'Model authentication failed'})
    expect(h.removeWorkspace).toHaveBeenCalledTimes(1)
  })
  it('maps an UnknownIssuer transport failure to a network status without parsing its private details',async()=>{
    const h=harness({onTurn(send){send({method:'error',params:{threadId:'thread-1',turnId:'turn-1',willRetry:false,
      error:{codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}},message:'UnknownIssuer at PRIVATE_URL with PRIVATE_TOKEN'}}})}})
    await expect(h.adapter.streamChat(input())).rejects.toMatchObject({status:'invalid-endpoint',message:'The model endpoint is invalid or unavailable'})
  })
  it('lets the CLI recover from willRetry notifications and ignores foreign errors',async()=>{
    const h=harness({onTurn(send){
      send({method:'error',params:{threadId:'foreign',turnId:'turn-1',willRetry:false,error:{codexErrorInfo:'unauthorized'}}})
      send({method:'error',params:{threadId:'thread-1',turnId:'turn-1',willRetry:true,error:{codexErrorInfo:'serverOverloaded'}}})
      send(delta('Recovered'));send(completed)
    }})
    const request=input();await expect(h.adapter.streamChat(request)).resolves.toMatchObject({toolCalls:[]})
    expect(request.onDelta).toHaveBeenCalledExactlyOnceWith('Recovered')
  })
})


it('reports only owned Codex reasoning phases and closes before message/tool/cleanup', async () => {
  const onReasoning = vi.fn()
  const h = harness({ onTurn(send) {
    send({ method: 'item/reasoning/textDelta', params: { threadId: 'foreign', turnId: 'turn-1', delta: 'PRIVATE_THINKING' } })
    send({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'rs_1', type: 'reasoning' } } })
    send({ method: 'item/reasoning/textDelta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'rs_1', contentIndex: 0, delta: 'PRIVATE_THINKING' } })
    send({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'rs_1', type: 'reasoning', content: ['PRIVATE_THINKING'] } } })
    send(delta('Answer'))
    send(completed)
  } })
  await h.adapter.streamChat(input({ onReasoning }))
  expect(onReasoning.mock.calls).toEqual([[true], [false]])
})
