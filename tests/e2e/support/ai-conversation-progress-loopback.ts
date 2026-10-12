import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { AI_WORKSPACE_TOOLS } from '../../../src/main/models/ai-conversation-prompts'
import { parseWorkspaceToolResult } from '../../../src/shared/ai-conversation'
import { markdownContainsText } from './markdown-markers'

export const KEY = 'synthetic-native-progress-key'
export const MODEL = 'gpt-5-native-progress'
export const STREAM = 'SYNTHETIC_STREAM_READ_TWICE'
export const FAILURE = 'SYNTHETIC_QUOTA_AFTER_PARTIAL'
export const UNSAVED = 'NATIVE_CURRENT_UNSAVED_7bd1'
export const RAW_ERROR = 'SYNTHETIC_PRIVATE_PROVIDER_PROSE_DO_NOT_RENDER'
export const EDIT_ONE = 'NATIVE_DOCUMENT_GRANT_EDIT_ONE'
export const EDIT_TWO = 'NATIVE_DOCUMENT_GRANT_EDIT_TWO'
export const PARTIAL = 'RETAIN_THIS_PARTIAL_ANSWER'
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function requireFact(value: unknown, code: string): asserts value { if (!value) throw new Error(code) }

export class ProgressLoopback {
  private server?: Server
  private responses = new Set<ServerResponse>()
  private gates = new Map<string, () => void>()
  private pendingGates = new Set<string>()
  private stopped = false
  private port = 0
  phase = 'idle'
  probeCount = 0
  conversationCount = 0
  confirmedReads = 0
  confirmedWrites = 0
  readonly faults: string[] = []
  readonly toolDiagnostics: Array<Record<string, unknown>> = []
  readonly events: Array<{ phase: string; at: number; requests: number }> = []
  get baseUrl() { return `http://127.0.0.1:${this.port}/v1` }
  private mark(phase: string) { this.phase = phase; if (this.events.length < 80) this.events.push({ phase, at: Date.now(), requests: this.conversationCount }) }
  release(name: string) {
    const resolve = this.gates.get(name)
    if (resolve) { this.gates.delete(name); resolve() }
    else this.pendingGates.add(name)
  }
  private async hold(name: string) {
    if (this.pendingGates.delete(name) || this.stopped) return
    this.mark(name)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.gates.delete(name); reject(new Error('gate-timeout:' + name)) }, 30_000)
      this.gates.set(name, () => { clearTimeout(timer); resolve() })
    })
    if (this.stopped) throw new Error('closed')
  }
  async start() {
    this.server = createServer((request, response) => {
      this.responses.add(response)
      response.on('close', () => this.responses.delete(response))
      void (async () => {
        requireFact(request.method === 'POST' && request.url === '/v1/chat/completions', 'route')
        requireFact(request.headers.authorization === `Bearer ${KEY}`, 'authorization')
        const chunks: Buffer[] = []; let size = 0
        for await (const part of request) {
          const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
          size += chunk.length; requireFact(size <= 512 * 1024, 'request-bound'); chunks.push(chunk)
        }
        const text = Buffer.concat(chunks).toString('utf8')
        requireFact(!text.includes(KEY), 'key-in-body')
        const body: unknown = JSON.parse(text)
        requireFact(record(body) && body.model === MODEL && body.stream === true && Array.isArray(body.messages), 'envelope')
        const messages = body.messages as unknown[]
        requireFact(messages.every(record), 'messages')
        const all = messages as Record<string, unknown>[]
        if (all.length === 1 && all[0]?.role === 'user' && all[0].content === 'Reply with OK only.') {
          requireFact(body.max_tokens === 2 && body.reasoning_effort === 'low', 'probe-low-contract')
          this.probeCount++; this.headers(response); this.delta(response, { content: 'OK' }); this.end(response); return
        }
        requireFact(body.max_tokens === 32768 && body.reasoning_effort === 'high', 'conversation-contract')
        requireFact(Array.isArray(body.tools) && body.tool_choice === 'auto', 'tools-required')
        const expected = AI_WORKSPACE_TOOLS.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
        for (const offered of body.tools) requireFact(expected.some(tool => JSON.stringify(tool) === JSON.stringify(offered)), 'tool-schema')
        requireFact(body.tools.some(tool => record(tool) && record(tool.function) && tool.function.name === 'read_current_document'), 'current-tool-missing')
        let userIndex = -1
        for (let index = 0; index < all.length; index++) if (all[index]?.role === 'user') userIndex = index
        const command = all[userIndex]?.content
        requireFact(typeof command === 'string' && (command.includes(STREAM) || command.includes(FAILURE)), 'command')
        this.conversationCount++; requireFact(this.conversationCount <= 6, 'unexpected-retry-or-request')
        if (command.includes(FAILURE)) {
          requireFact(this.conversationCount === 1, 'automatic-retry')
          this.headers(response)
          this.delta(response, { reasoning_content: 'ERROR_PROCESS_PREFIX\n' })
          await delay(80)
          this.delta(response, { content: PARTIAL })
          await this.hold('release-quota-error')
          response.write(`data: ${JSON.stringify({ error: { type: 'insufficient_quota', code: 'insufficient_quota', message: RAW_ERROR } })}\n\n`)
          response.end(); this.mark('quota-sent'); return
        }
        const tools = all.slice(userIndex + 1).filter(message => message.role === 'tool')
        const calls = all.slice(userIndex + 1).flatMap(message => message.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : [])
        requireFact(calls.length === tools.length && tools.length === this.conversationCount - 1, 'paired-tool-round')
        const expectedNames = ['read_current_document', 'read_workspace_document', 'edit_workspace_document', 'read_workspace_document', 'edit_workspace_document'] as const
        requireFact(tools.length <= expectedNames.length, 'tool-limit')
        for (let index = 0; index < tools.length; index++) {
          const id = `native_tool_${index + 1}`
          const call = calls[index]; const result = tools[index]
          requireFact(record(call) && call.id === id && record(call.function) && call.function.name === expectedNames[index], 'tool-identity')
          requireFact(result?.tool_call_id === id && typeof result.content === 'string', 'result-identity')
          const raw: unknown = JSON.parse(result.content)
          const parsed = parseWorkspaceToolResult(expectedNames[index]!, raw)
          if (this.toolDiagnostics.length < 32) this.toolDiagnostics.push({
            round: this.conversationCount, index, name: expectedNames[index], parsedKind: parsed?.kind ?? null,
            rawKind: record(raw) && ['document', 'mutation', 'denied', 'unavailable', 'not-executed'].includes(String(raw.kind)) ? raw.kind : 'other',
            expectedDisplayName: record(raw) && raw.displayName === 'note.md',
            hasUnsavedMarker: record(raw) && typeof raw.content === 'string' && markdownContainsText(raw.content, UNSAVED),
            dirty: record(raw) && typeof raw.dirty === 'boolean' ? raw.dirty : null,
            contentLength: record(raw) && typeof raw.content === 'string' ? raw.content.length : null,
            totalChars: record(raw) && typeof raw.totalChars === 'number' ? raw.totalChars : null,
            // Product field names only, never untrusted names/paths/body/version/key text.
            shape: record(raw) ? ['kind','displayName','sourceFormat','dirty','cursor','content','nextCursor','hasMore','totalChars','version','path','state','operationId','paths'].filter(key => Object.hasOwn(raw,key)) : [],
          })
          if (index === 2 || index === 4) {
            requireFact(parsed?.kind === 'mutation' && parsed.state === 'succeeded' && parsed.paths.length === 1 && parsed.paths[0] === 'note.md', 'actual-current-write-failed')
          } else {
            requireFact(parsed?.kind === 'document', 'read-result-schema-or-kind')
            requireFact(parsed.displayName === 'note.md', 'read-result-display-name')
            requireFact(markdownContainsText(parsed.content, UNSAVED), 'read-result-unsaved-marker')
            if (index === 0) requireFact('dirty' in parsed && parsed.dirty, 'current-document-not-dirty')
            if (index === 3) requireFact(markdownContainsText(parsed.content, EDIT_ONE), 'fresh-read-after-first-edit')
          }
        }
        this.confirmedReads = Number(tools.length >= 1) + Number(tools.length >= 2) + Number(tools.length >= 4)
        this.confirmedWrites = Number(tools.length >= 3) + Number(tools.length >= 5)
        this.headers(response)
        if (tools.length === 0) {
          await this.lines(response, 'reasoning_content', 'PROVIDER_THINKING', 55)
          await this.hold('reason-more')
          await this.lines(response, 'reasoning_content', 'REASON_TAIL', 25)
          await this.hold('read-one')
          this.call(response, 1, 'read_current_document', { cursor: 0, maxChars: 48000 }); return
        }
        if (tools.length === 1) {
          this.delta(response, { reasoning_content: 'SECOND_ROUND_ACTUAL_REASONING\n' })
          await delay(100)
          this.call(response, 2, 'read_workspace_document', { path: 'note.md', cursor: 0, maxChars: 48000 }); return
        }
        if (tools.length === 3) {
          await this.hold('first-edit-confirmed')
          this.call(response, tools.length + 1, 'read_workspace_document', { path: 'note.md', cursor: 0, maxChars: 48000 }); return
        }
        if (tools.length === 2 || tools.length === 4) {
          const previous = tools[tools.length - 1]!
          const document = parseWorkspaceToolResult('read_workspace_document', JSON.parse(String(previous.content)))
          requireFact(document?.kind === 'document', 'fresh-version-missing')
          this.call(response, tools.length + 1, 'edit_workspace_document', { path: 'note.md',
            content: document.content + '\n' + (tools.length === 2 ? EDIT_ONE : EDIT_TWO) + '\n', expectedVersion: document.version }); return
        }
        await this.lines(response, 'content', 'ANSWER_LINE', 70)
        await this.hold('answer-more')
        await this.lines(response, 'content', 'ANSWER_TAIL', 25)
        await this.hold('finish-answer')
        this.delta(response, { content: '\nSTREAM_COMPLETE' }); this.end(response); this.mark('completed')
      })().catch(error => {
        if (this.stopped) return
        this.faults.push(error instanceof Error ? error.message : 'unknown')
        this.mark('contract-failed')
        if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'synthetic_contract_failed' } }))
      })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve) })
    this.port = (this.server.address() as AddressInfo).port
  }
  private headers(response: ServerResponse) { response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' }); response.flushHeaders() }
  private delta(response: ServerResponse, delta: Record<string, string>) { response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`) }
  private async lines(response: ServerResponse, field: string, prefix: string, count: number) {
    for (let index = 0; index < count; index++) {
      requireFact(!response.destroyed && !this.stopped, 'stream-closed')
      this.delta(response, { [field]: `${prefix}_${index.toString().padStart(3, '0')} synthetic observable content.\n\n` })
      await delay(40)
    }
  }
  private call(response: ServerResponse, index: number, name: string, args: Record<string, unknown>) {
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `native_tool_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
    this.end(response)
  }
  private end(response: ServerResponse) {
    response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
  async close() {
    this.stopped = true
    for (const release of this.gates.values()) release()
    this.gates.clear()
    for (const response of this.responses) response.destroy()
    const server = this.server; this.server = undefined
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  }
}
