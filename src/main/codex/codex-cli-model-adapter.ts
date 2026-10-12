import { createModelReasoningSignal } from '../models/model-reasoning-timer'
import { version } from '../../../package.json'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { discoverCodexCliExecutables } from './codex-cli-executable'
import { isCanonicalAiToolCallId } from '../../shared/ai-conversation'
import { effectiveModelThinking } from '../../shared/model-thinking'
import { ModelProtocolError, modelProtocolError } from '../models/model-errors'
import { providerModelError, semanticModelError } from '../models/model-provider-errors'
import type { ModelChatInput, ModelChatMessage, ModelChatResult } from '../models/model-protocol-client'
import type { ModelProcessDelta } from '../models/model-process-delta'

type Json = Record<string, unknown>
const record = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = () => semanticModelError('incompatible-response', 'protocol-malformed', 'decode', 'codex')
const unavailable = () => semanticModelError('invalid-endpoint', 'cli-unavailable', 'cli', 'codex')
const interrupted = () => semanticModelError('invalid-endpoint', 'stream-interrupted', 'receive', 'codex')
const unknownCli = () => semanticModelError('invalid-endpoint', 'unknown', 'cli', 'codex')
const MAX_STREAM_BYTES = 8 * 1024 * 1024
const MAX_LINE_BYTES = 256 * 1024
const CONNECTION_ERROR_VARIANTS = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']

function codexErrorInfo(error: unknown): unknown {
  return record(error) ? error.codexErrorInfo ?? (record(error.data) ? error.data.codexErrorInfo : undefined) : undefined
}

/** Map versioned Codex error metadata only; never inspect or expose provider prose. */
export function codexModelError(error: unknown): ModelProtocolError {
  const unknown = () => semanticModelError('incompatible-response', 'unknown', 'cli', 'codex')
  if (!record(error)) return unknown()
  const info = codexErrorInfo(error)
  if (info === 'unauthorized') return semanticModelError('authentication-failed', 'cli-authentication', 'cli', 'codex')
  if (info === 'usageLimitExceeded') return semanticModelError('quota-exceeded', 'quota-exceeded', 'provider', 'codex')
  if (info === 'sessionBudgetExceeded') return semanticModelError('quota-exceeded', 'cli-budget-exceeded', 'cli', 'codex')
  if (info === 'serverOverloaded') return semanticModelError('rate-limited', 'service-unavailable', 'provider', 'codex')
  if (error.code === -32001) return semanticModelError('rate-limited', 'rate-limited', 'provider', 'codex')
  if (info === 'internalServerError') return semanticModelError('invalid-endpoint', 'service-unavailable', 'provider', 'codex')
  if (info === 'contextWindowExceeded') return semanticModelError('incompatible-response', 'context-limit', 'provider', 'codex')
  if (info === 'badRequest') return semanticModelError('incompatible-response', 'request-rejected', 'provider', 'codex')
  if (info === 'sandboxError') return semanticModelError('incompatible-response', 'cli-sandbox', 'cli', 'codex')
  if (record(info) && Object.keys(info).length === 1) {
    for (const variant of CONNECTION_ERROR_VARIANTS) {
      if (!Object.hasOwn(info, variant) || !record(info[variant])) continue
      const status = info[variant].httpStatusCode
      if (status == null) return semanticModelError('invalid-endpoint', variant === 'responseStreamDisconnected' ? 'stream-interrupted' : 'network', variant === 'httpConnectionFailed' ? 'connect' : 'receive', 'codex')
      if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
        const mapped = providerModelError(undefined, { source: 'codex', httpStatus: status })
        const legacy = status === 402 ? 'quota-exceeded' : status >= 500 && status !== 504 ? 'invalid-endpoint' : mapped.status
        // 402 alone proves a request rejection, not a specific exhausted balance.
        return modelProtocolError(legacy, undefined, status === 402
          ? { version: 1, reason: 'request-rejected', stage: 'provider', source: 'codex', httpStatus: status } : mapped.detail)
      }
      return unknown()
    }
  }
  return unknown()
}

// These overrides are process-local: never rewrite the user's Codex configuration.
export const CODEX_RESTRICTED_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  'features.shell_tool': false, 'features.unified_exec': false, 'features.apps': false,
  'features.hooks': false, 'features.multi_agent': false, 'features.plugins': false,
  'features.memories': false, 'features.goals': false, 'features.js_repl': false,
  'tools.view_image': false, web_search: 'disabled',
})

export interface CodexModelAdapterOptions {
  resolveExecutable?: () => Promise<string | undefined>
  launch?(cwd: string, signal: AbortSignal): Promise<ChildProcessWithoutNullStreams>
  createWorkspace?(): Promise<string>
  removeWorkspace?(cwd: string): Promise<void>
  terminateTree?(child: ChildProcessWithoutNullStreams): Promise<void>
  timeoutMs?: number
  cleanupTimeoutMs?: number
}

function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(command, args, {
    encoding: 'utf8', maxBuffer: 16 * 1024, timeout: 2_000, windowsHide: true,
  }, (error, stdout) => error ? reject(unknownCli()) : resolve(stdout)))
}

async function launchDefault(cwd: string, signal: AbortSignal, resolveExecutable?: () => Promise<string | undefined>): Promise<ChildProcessWithoutNullStreams> {
  const executable = resolveExecutable ? await resolveExecutable()
    : (await discoverCodexCliExecutables()).find(value => path.extname(value).toLowerCase() === '.exe')
  signal.throwIfAborted()
  const overrides = Object.entries(CODEX_RESTRICTED_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])
  if (executable && path.win32.isAbsolute(executable) && path.win32.extname(executable).toLowerCase() === '.exe') return spawn(executable, [...overrides, 'app-server'], { cwd, windowsHide: true, shell: false, stdio: 'pipe' })
  throw unavailable()
}

async function terminateDefault(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid) return
  if (process.platform === 'win32') { await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F']); return }
  child.kill('SIGKILL')
}

/** Replay only Arkdown messages, never provider encrypted reasoning or a Codex workspace. */
export function codexHistory(messages: readonly ModelChatMessage[]): Json[] {
  const items: Json[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
    } else {
      if (message.content) items.push({ type: 'message', role: message.role,
        content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }] })
      if (message.role === 'assistant') for (const call of message.toolCalls ?? []) {
        items.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsJson })
      }
    }
  }
  return items
}

/** One ephemeral app-server turn per ModelProtocolClient request; Arkdown owns every tool execution. */
export function createCodexCliModelAdapter(options: CodexModelAdapterOptions = {}) {
  return { async streamChat(input: ModelChatInput): Promise<ModelChatResult> {
    input.signal.throwIfAborted()
    const cwd = await (options.createWorkspace ?? (() => mkdtemp(path.join(tmpdir(), 'arkdown-codex-'))))()
    let child: ChildProcessWithoutNullStreams | undefined
    let closed = false
    let resolveClosed!: () => void
    const closePromise = new Promise<void>(resolve => { resolveClosed = resolve })
    let stop: (() => void) | undefined
    try {
      input.signal.throwIfAborted()
      child = await (options.launch ?? ((workspace, signal) => launchDefault(workspace, signal, options.resolveExecutable)))(cwd, input.signal)
      child.once('close', () => { closed = true; resolveClosed() })
      const process = child
      const receiveDelta = (text: string) => {
        try { input.onDelta(text) } catch {
          if (input.signal.aborted) throw input.signal.reason
          throw semanticModelError('invalid-endpoint', 'unknown', 'receive', 'codex')
        }
      }
      let sequence = 0
      let finished = false
      let threadId: string | undefined
      let turnId: string | undefined
      let receivingTurn = false
      let retryConnectionError: ModelProtocolError | undefined
      const terminalError = (error: unknown): ModelProtocolError => {
        const mapped = codexModelError(error)
        // Some CLI versions discard transport metadata after retry exhaustion.
        // Only a terminal `other` may inherit the owned turn's prior classification.
        return mapped.status === 'incompatible-response' && codexErrorInfo(error) === 'other'
          ? retryConnectionError ?? mapped : mapped
      }
      const itemKinds = new Map<string, 'reasoning' | 'commentary' | 'answer'>()
      const unknownMessages = new Map<string, string[]>()
      let unknownMessageBytes = 0
      const processText = new Map<string, { text: string; closed: boolean }>()
      let processConsumer = input.onProcess
      const receiveProcess = (event: ModelProcessDelta) => {
        if (finished) return
        input.signal.throwIfAborted()
        try { processConsumer?.(Object.freeze({ ...event })) } catch { processConsumer = undefined }
        input.signal.throwIfAborted()
      }
      const itemId = (value: unknown): string => {
        if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw invalid()
        return value
      }
      const processPart = (id: string, kind: ModelProcessDelta['kind'], index: unknown, text: unknown, complete: boolean) => {
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || typeof text !== 'string') throw invalid()
        const key = JSON.stringify([id, kind, index])
        const prior = processText.get(key) ?? { text: '', closed: false }
        if (complete ? !text.startsWith(prior.text) || prior.closed && text !== prior.text : prior.closed) throw invalid()
        const delta = complete ? text.slice(prior.text.length) : text
        processText.set(key, { text: complete ? text : prior.text + text, closed: complete })
        if (delta) receiveProcess({ kind, itemId: id, segmentIndex: index, delta, delivery: complete ? 'complete' : 'stream' })
      }
      const messageText = new Map<string, string>()
      const early: Json[] = []
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>()
      let resolveResult!: (value: ModelChatResult) => void
      let rejectResult!: (error: unknown) => void
      const result = new Promise<ModelChatResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
      // Setup may fail before the caller awaits the final turn result.
      void result.catch(() => undefined)
      const emptyResult = (): ModelChatResult => ({ toolCalls: [], reasoningContent: '', providerReplay: null, usage: null })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const fail = (error: unknown) => {
        if (finished) return
        finished = true; clearTimeout(timeout)
        for (const operation of pending.values()) operation.reject(error)
        pending.clear(); rejectResult(error)
      }
      const refresh = () => {
        clearTimeout(timeout)
        timeout = setTimeout(() => fail(semanticModelError('timeout', 'timeout', 'receive', 'codex')), options.timeoutMs ?? input.initialInactivityTimeoutMs ?? 30_000)
      }
      const send = (value: Json) => {
        if (closed || process.stdin.destroyed) throw interrupted()
        const line = JSON.stringify(value) + '\n'
        if (Buffer.byteLength(line) > MAX_STREAM_BYTES) throw invalid()
        process.stdin.write(line, error => { if (error) fail(interrupted()) })
      }
      const request = (method: string, params: Json): Promise<unknown> => {
        if (finished) return Promise.reject(input.signal.aborted ? input.signal.reason : invalid())
        const id = ++sequence
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject })
          try { send({ id, method, params }) } catch (error) { fail(error) }
        })
      }
      const interrupt = () => {
        if (!threadId || !turnId || closed) return
        try { send({ id: ++sequence, method: 'turn/interrupt', params: { threadId, turnId } }) } catch { /* process cleanup follows */ }
      }
      const abort = () => { interrupt(); fail(input.signal.reason ?? new DOMException('Aborted', 'AbortError')) }
      stop = () => { clearTimeout(timeout); input.signal.removeEventListener('abort', abort); interrupt() }
      input.signal.addEventListener('abort', abort, { once: true })
      process.once('error', () => fail(unavailable()))
      process.stdin.on('error', () => fail(interrupted()))
      process.once('close', () => fail(interrupted()))
      process.stdout.once('end', () => { if (!finished) fail(semanticModelError('incompatible-response', 'stream-interrupted', 'receive', 'codex')) })
      let stdoutBytes = 0, stderrBytes = 0, buffer = ''
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const complete = (value: ModelChatResult) => { if (finished) return; finished = true; clearTimeout(timeout); resolveResult(value) }
      const reasoning = createModelReasoningSignal(input.signal, input.onReasoning)
      const priorStop = stop
      stop = () => { reasoning.dispose(); priorStop?.() }
      const classify = (item: Json): string | undefined => {
        if (item.type !== 'agentMessage' && item.type !== 'reasoning') return undefined
        const id = itemId(item.id)
        if (item.type === 'agentMessage' && item.phase != null && item.phase !== 'commentary' && item.phase !== 'final_answer') throw invalid()
        const kind = item.type === 'reasoning' ? 'reasoning' : item.phase === 'commentary' ? 'commentary' : 'answer'
        const prior = itemKinds.get(id)
        if (prior !== undefined && prior !== kind) throw invalid()
        itemKinds.set(id, kind)
        const queued = unknownMessages.get(id)
        if (queued) {
          if (kind === 'reasoning') throw invalid()
          unknownMessages.delete(id)
          for (const text of queued) {
            unknownMessageBytes -= Buffer.byteLength(text)
            if (finished) break
            if (kind === 'commentary') processPart(id, 'commentary', 0, text, false)
            else receiveDelta(text)
          }
        }
        return id
      }
      const finishMessage = (item: Json) => {
        const id = classify(item)
        if (id === undefined || finished) return
        if (item.type === 'reasoning') {
          for (const [field, kind] of [['summary', 'reasoning-summary'], ['content', 'reasoning-text']] as const) {
            const parts = item[field] ?? []
            if (!Array.isArray(parts) || parts.some(text => typeof text !== 'string')) throw invalid()
            for (const key of processText.keys()) {
              const [owner, channel, index] = JSON.parse(key) as [string, string, number]
              if (owner === id && channel === kind && index >= parts.length) throw invalid()
            }
            parts.forEach((text, index) => { if (!finished) processPart(id, kind, index, text, true) })
          }
          return
        }
        if (typeof item.text !== 'string') { fail(invalid()); return }
        if (itemKinds.get(id) === 'commentary') { processPart(id, 'commentary', 0, item.text, true); return }
        const emitted = messageText.get(id) ?? ''
        if (!item.text.startsWith(emitted)) { fail(invalid()); return }
        const remaining = item.text.slice(emitted.length)
        messageText.set(id, item.text)
        if (remaining) receiveDelta(remaining)
      }
      const notification = (message: Json) => {
        const params = message.params
        if (!record(params)) return
        if (params.threadId !== threadId) return
        if (receivingTurn && !turnId) { early.push(message); return }
        if (message.method === 'turn/completed') {
          if (!record(params.turn) || params.turn.id !== turnId) return
          reasoning.update(false)
          if (params.turn.status !== 'completed') { fail(terminalError(params.turn.error)); return }
          if (Array.isArray(params.turn.items)) for (const item of params.turn.items) {
            if (record(item) && !finished) finishMessage(item)
          }
          if (unknownMessages.size) { fail(invalid()); return }
          complete(emptyResult()); return
        }
        if (params.turnId !== turnId || !turnId) return
        if (message.method === 'item/started' && record(params.item)) {
          reasoning.update(params.item.type === 'reasoning')
          classify(params.item)
          refresh()
        } else if (message.method === 'item/completed' && record(params.item)) {
          if (params.item.type === 'reasoning') reasoning.update(false)
          if (params.item.type === 'agentMessage') reasoning.update(false)
          finishMessage(params.item)
          refresh()
        } else if (message.method === 'item/reasoning/textDelta' || message.method === 'item/reasoning/summaryTextDelta') {
          const id = itemId(params.itemId)
          if (itemKinds.has(id) && itemKinds.get(id) !== 'reasoning' || unknownMessages.has(id)) throw invalid()
          itemKinds.set(id, 'reasoning')
          const summary = message.method === 'item/reasoning/summaryTextDelta'
          processPart(id, summary ? 'reasoning-summary' : 'reasoning-text', summary ? params.summaryIndex : params.contentIndex, params.delta, false)
          if (params.delta !== '') reasoning.update(true)
          refresh()
        } else if (message.method === 'item/agentMessage/delta') {
          reasoning.update(false)
          if (typeof params.delta !== 'string') { fail(invalid()); return }
          const id = itemId(params.itemId)
          const kind = itemKinds.get(id)
          if (kind === 'reasoning') throw invalid()
          messageText.set(id, (messageText.get(id) ?? '') + params.delta)
          if (kind === 'commentary') processPart(id, 'commentary', 0, params.delta, false)
          else if (kind === 'answer') { if (params.delta) receiveDelta(params.delta) }
          else if (params.delta) {
            const queued = unknownMessages.get(id) ?? []
            unknownMessageBytes += Buffer.byteLength(params.delta)
            if (unknownMessageBytes > MAX_LINE_BYTES || !unknownMessages.has(id) && unknownMessages.size >= 256) throw invalid()
            queued.push(params.delta)
            unknownMessages.set(id, queued)
          }
          refresh()
        } else if (message.method === 'item/tool/call') {
          reasoning.update(false)
          if (message.id === undefined || !isCanonicalAiToolCallId(params.callId)) { fail(semanticModelError('incompatible-response', 'tool-invalid-identity', 'tool-validation', 'codex')); return }
          if (typeof params.tool !== 'string' || !input.tools?.some(tool => tool.name === params.tool) || params.namespace != null) { fail(semanticModelError('incompatible-response', 'tool-invalid-name', 'tool-validation', 'codex')); return }
          if (!record(params.arguments)) { fail(semanticModelError('incompatible-response', 'tool-invalid-arguments', 'tool-validation', 'codex')); return }
          const argumentsJson = JSON.stringify(params.arguments)
          if (Buffer.byteLength(argumentsJson) > MAX_LINE_BYTES) { fail(semanticModelError('incompatible-response', 'tool-invalid-arguments', 'tool-validation', 'codex')); return }
          // Do not acknowledge or execute the tool here. The service applies its existing read/write policy.
          interrupt()
          complete({ ...emptyResult(), toolCalls: [{ id: params.callId, name: params.tool, argumentsJson }] })
        } else if (message.method === 'error') {
          reasoning.update(false)
          if (params.willRetry === true) {
            const info = codexErrorInfo(params.error)
            const mapped = codexModelError(params.error)
            retryConnectionError = record(info) && Object.keys(info).length === 1
              && CONNECTION_ERROR_VARIANTS.some(variant => record(info[variant]))
              && mapped.status !== 'incompatible-response' ? mapped : undefined
            refresh()
          } else fail(terminalError(params.error))
        }
      }
      process.stdout.on('data', (chunk: Buffer) => {
        if (finished) return
        try {
          stdoutBytes += chunk.length
          if (stdoutBytes > MAX_STREAM_BYTES) throw invalid()
          buffer += decoder.decode(chunk, { stream: true })
          let end: number
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
            if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw invalid()
            if (!line.trim()) continue
            const message: unknown = JSON.parse(line)
            if (!record(message)) throw invalid()
            if (typeof message.id === 'number' && !('method' in message)) {
              const operation = pending.get(message.id)
              if (!operation) continue
              pending.delete(message.id)
              if ('error' in message) { const error = codexModelError(message.error); operation.reject(error); fail(error) }
              else if ('result' in message) { operation.resolve(message.result); refresh() }
              else throw invalid()
            } else if (typeof message.method === 'string') {
              if ('id' in message && message.method !== 'item/tool/call') {
                // Never delegate approvals, login, environment, shell or arbitrary server requests.
                throw invalid()
              }
              notification(message)
            }
            if (finished) break
          }
          if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) throw invalid()
        } catch (error) { fail(error instanceof ModelProtocolError || error instanceof Error && error.name === 'AbortError' ? error : invalid()) }
      })
      process.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_LINE_BYTES) fail(invalid()) })
      refresh()
      if (input.signal.aborted) abort()
      await request('initialize', { clientInfo: { name: 'arkdown', version }, capabilities: { experimentalApi: true } })
      send({ method: 'initialized', params: {} })
      // Configuration can contain credentials. Keep this response inside the adapter,
      // derive server names only, and never echo the response in errors or diagnostics.
      const configuration = await request('config/read', { includeLayers: false, cwd })
      if (!record(configuration) || !record(configuration.config)) throw invalid()
      const servers = configuration.config.mcp_servers
      if (servers != null && !record(servers)) throw invalid()
      const disabledServers = Object.fromEntries(Object.keys(servers ?? {}).map(name => [name, { enabled: false }]))
      const thread = await request('thread/start', {
        ...(input.modelId !== 'codex-default' ? { model: input.modelId } : {}),
        ephemeral: true, cwd, environments: [], runtimeWorkspaceRoots: [], selectedCapabilityRoots: [],
        approvalPolicy: 'never', sandbox: 'read-only', config: { ...CODEX_RESTRICTED_CONFIG, mcp_servers: disabledServers },
        baseInstructions: '你是嵌入 Arkdown 的文档助手。遵循任务，仅使用显式提供的 Arkdown 宿主工具。CLI 沙箱只读，禁止本地原生写入、提权或绕过权限；这不代表宿主文档只读。宿主编辑等工具用于按其权限接口提交请求，需要许可时由 Arkdown 询问并决定是否执行，不要自行授予许可。仅凭成功工具结果声称已修改，失败或未授权时如实说明。',
        developerInstructions: input.messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n'),
        dynamicTools: (input.tools ?? []).map(tool => ({ type: 'function', ...tool })),
      })
      if (!record(thread) || !record(thread.thread) || typeof thread.thread.id !== 'string') throw invalid()
      threadId = thread.thread.id
      await request('thread/inject_items', { threadId, items: codexHistory(input.messages) })
      receivingTurn = true
      // Catalog refreshes can narrow support while a saved preference stays unchanged.
      // Only discovered CLI capability authorizes an override; preserve CLI defaults otherwise.
      const effort = input.reasoningEffort === 'default' || !input.capabilityOverride?.thinking
        ? 'default' : effectiveModelThinking(input, input).reasoningEffort
      const turn = await request('turn/start', { threadId, input: [], environments: [],
        ...(effort !== 'default' ? { effort } : {}) })
      if (!record(turn) || !record(turn.turn) || typeof turn.turn.id !== 'string') throw invalid()
      turnId = turn.turn.id
      for (const message of early) { if (!finished) notification(message) }
      return await result
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (error instanceof ModelProtocolError) throw error
      throw unknownCli()
    } finally {
      stop?.()
      if (child && !closed) {
        child.stdin.end()
        const waitForClose = async () => {
          let timer: ReturnType<typeof setTimeout> | undefined
          try { return await Promise.race([closePromise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), options.cleanupTimeoutMs ?? 1_000) })]) }
          finally { clearTimeout(timer) }
        }
        if (!await waitForClose()) {
          await (options.terminateTree ?? terminateDefault)(child)
          if (!await waitForClose()) throw unknownCli()
        }
      }
      try { await (options.removeWorkspace ?? (directory => rm(directory, { recursive: true, force: true })))(cwd) }
      catch { throw unknownCli() }
    }
  } }
}
