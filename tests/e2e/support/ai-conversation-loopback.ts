import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { AI_WORKSPACE_TOOLS } from '../../../src/main/models/ai-conversation-prompts'
import {
  parseWorkspaceToolArguments,
  parseWorkspaceToolResult,
} from '../../../src/shared/ai-conversation'

const MAX_REQUEST_BODY_BYTES = 512 * 1024
const CONNECTION_PROBE = 'Reply with OK only.'
const SESSION_MARKER_PATTERN = /E2E_SESSION_MARKER(?:_[0-9A-Za-z_-]+)?/u

export const AI_CONVERSATION_E2E_READ_COMMAND = 'E2E_READ_CURRENT_DOCUMENT'
export const AI_CONVERSATION_E2E_WORKSPACE_ONCE_COMMAND = 'E2E_WORKSPACE_EDIT_ONCE'
export const AI_CONVERSATION_E2E_WORKSPACE_SESSION_COMMAND = 'E2E_WORKSPACE_EDIT_SESSION'
export const AI_CONVERSATION_E2E_WORKSPACE_SESSION_SECOND_COMMAND = 'E2E_WORKSPACE_EDIT_SESSION_SECOND'
export const AI_CONVERSATION_E2E_WORKSPACE_DENY_COMMAND = 'E2E_WORKSPACE_EDIT_DENY'

export interface AiConversationLoopbackOptions {
  apiKey: string
  documentMarkers: readonly string[]
  modelId: string
}

export interface AiConversationLoopbackRequestRecord {
  kind: 'conversation' | 'probe'
  method: 'POST'
  pathname: '/v1/chat/completions'
  headers: {
    accept: string | null
    authorization: 'Bearer [REDACTED]'
    contentType: string | null
    host: string | null
    userAgent: string | null
  }
  bodyByteLength: number
  body: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value)
  return ownKeys.length === keys.length
    && ownKeys.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

const EXPECTED_WIRE_TOOLS = AI_WORKSPACE_TOOLS.map((tool) => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  },
}))

function validTools(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const names = value.map((tool) => (
    isRecord(tool) && isRecord(tool.function) ? tool.function.name : undefined
  ))
  const expected = names.length === 1 && names[0] === 'read_current_document'
    ? EXPECTED_WIRE_TOOLS.slice(0, 1)
    : names.length === 6 && names[0] === 'list_workspace_entries'
      ? EXPECTED_WIRE_TOOLS.slice(1)
      : names.length === 7 ? EXPECTED_WIRE_TOOLS : null
  return expected !== null && exactJson(value, expected)
}

function validToolLinks(messages: readonly Record<string, unknown>[], offeredTools: unknown): boolean {
  const offeredNames = new Set<string>()
  if (Array.isArray(offeredTools)) {
    for (const tool of offeredTools) {
      if (isRecord(tool) && isRecord(tool.function) && typeof tool.function.name === 'string') {
        offeredNames.add(tool.function.name)
      }
    }
  }
  const declared = new Map<string, string>()
  const consumed = new Set<string>()
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const value of message.tool_calls) {
        if (!isRecord(value) || !hasExactKeys(value, ['id', 'type', 'function'])
          || typeof value.id !== 'string' || value.id.length === 0 || declared.has(value.id)
          || value.type !== 'function' || !isRecord(value.function)
          || !hasExactKeys(value.function, ['name', 'arguments'])
          || typeof value.function.name !== 'string'
          || typeof value.function.arguments !== 'string'
          || !offeredNames.has(value.function.name)) return false
        let parsedArguments: unknown
        try { parsedArguments = JSON.parse(value.function.arguments) } catch { return false }
        if (!parseWorkspaceToolArguments(value.function.name as never, parsedArguments)) return false
        declared.set(value.id, value.function.name)
      }
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string'
        || !declared.has(message.tool_call_id)
        || consumed.has(message.tool_call_id)) return false
      consumed.add(message.tool_call_id)
    }
  }
  return true
}

function validMessages(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) return false
  return value.every((message) => {
    if (!isRecord(message) || typeof message.role !== 'string') return false
    if (message.role === 'system' || message.role === 'user') {
      return hasExactKeys(message, ['role', 'content']) && typeof message.content === 'string'
    }
    if (message.role === 'assistant') {
      return typeof message.content === 'string'
        && (message.reasoning_content === undefined || typeof message.reasoning_content === 'string')
        && (message.tool_calls === undefined || Array.isArray(message.tool_calls))
        && hasExactKeys(message, [
          'role', 'content',
          ...(message.reasoning_content === undefined ? [] : ['reasoning_content']),
          ...(message.tool_calls === undefined ? [] : ['tool_calls']),
        ])
    }
    if (message.role === 'tool') {
      return hasExactKeys(message, ['role', 'tool_call_id', 'content'])
        && typeof message.content === 'string'
        && typeof message.tool_call_id === 'string'
    }
    return false
  })
}

function latestUserMessage(messages: readonly Record<string, unknown>[]): {
  content: string
  index: number
} | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user' && typeof message.content === 'string') {
      return { content: message.content, index }
    }
  }
  return null
}

function workspaceEditMarker(content: string): string | null {
  if (content.includes(AI_CONVERSATION_E2E_WORKSPACE_SESSION_SECOND_COMMAND)) {
    return 'AI_EDITED_SESSION_SECOND'
  }
  if (content.includes(AI_CONVERSATION_E2E_WORKSPACE_SESSION_COMMAND)) {
    return 'AI_EDITED_SESSION'
  }
  if (content.includes(AI_CONVERSATION_E2E_WORKSPACE_DENY_COMMAND)) {
    return 'AI_EDITED_DENIED_SHOULD_NOT_PERSIST'
  }
  return content.includes(AI_CONVERSATION_E2E_WORKSPACE_ONCE_COMMAND)
    ? 'AI_EDITED_ONCE'
    : null
}

function linkedToolResultsAfter(
  messages: readonly Record<string, unknown>[],
  index: number,
): Array<{ name: string; content: string }> | null {
  const calls = new Map<string, string>()
  const results: Array<{ name: string; content: string }> = []
  for (const message of messages.slice(index + 1)) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (isRecord(call) && typeof call.id === 'string' && isRecord(call.function)
          && typeof call.function.name === 'string') calls.set(call.id, call.function.name)
      }
    } else if (message.role === 'tool' && typeof message.tool_call_id === 'string'
      && typeof message.content === 'string') {
      const name = calls.get(message.tool_call_id)
      if (!name) return null
      results.push({ name, content: message.content })
    }
  }
  return results
}

export class AiConversationLoopbackServer {
  private server: Server | undefined
  private closing = false
  private readonly failures = new Set<string>()
  private readonly records: AiConversationLoopbackRequestRecord[] = []
  private readonly observedDocumentMarkers: string[] = []
  private toolCallSequence = 0
  conversationRequestCount = 0
  probeRequestCount = 0
  port = 0

  constructor(private readonly options: AiConversationLoopbackOptions) {}

  get baseUrl(): string {
    if (!this.port) throw new Error('AI conversation loopback is not running')
    return `http://127.0.0.1:${this.port}/v1`
  }

  requestRecords(): readonly AiConversationLoopbackRequestRecord[] {
    return structuredClone(this.records)
  }

  documentReadMarkers(): readonly string[] {
    return [...this.observedDocumentMarkers]
  }

  assertHealthy(): void {
    if (this.failures.size > 0) {
      throw new Error(`AI conversation loopback rejected: ${[...this.failures].sort().join(',')}`)
    }
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('AI conversation loopback is already running')
    this.closing = false
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!this.closing) this.failures.add('handler')
        if (!response.destroyed) {
          if (!response.headersSent) response.writeHead(500)
          response.end()
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      const server = this.server!
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '127.0.0.1')
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    this.closing = true
    const server = this.server
    this.server = undefined
    this.port = 0
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2_000)
      timeout.unref?.()
      server.close(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }

  private reject(response: ServerResponse, failure: string, status = 400): void {
    this.failures.add(failure)
    response.writeHead(status).end()
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      this.reject(response, 'route', 404)
      return
    }
    if (request.headers.authorization !== `Bearer ${this.options.apiKey}`) {
      response.writeHead(401).end()
      return
    }

    const chunks: Buffer[] = []
    let byteLength = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += bytes.byteLength
      if (byteLength > MAX_REQUEST_BODY_BYTES) {
        this.reject(response, 'request-size', 413)
        return
      }
      chunks.push(bytes)
    }
    let payload: unknown
    let bodyText = ''
    try {
      bodyText = Buffer.concat(chunks, byteLength).toString('utf8')
      payload = JSON.parse(bodyText) as unknown
    } catch {
      this.reject(response, 'json')
      return
    } finally {
      chunks.length = 0
    }
    if (bodyText.includes(this.options.apiKey)) {
      this.reject(response, 'secret-body')
      return
    }
    if (!isRecord(payload)
      || payload.model !== this.options.modelId
      || payload.stream !== true
      || !validMessages(payload.messages)) {
      this.reject(response, 'envelope')
      return
    }

    const messages = payload.messages
    const isProbe = messages.length === 1
      && messages[0]?.role === 'user'
      && messages[0].content === CONNECTION_PROBE
    if (isProbe) {
      const probeKeys = payload.reasoning_effort === undefined
        ? ['model', 'messages', 'stream', 'max_tokens']
        : ['model', 'messages', 'stream', 'max_tokens', 'reasoning_effort']
      if (!hasExactKeys(payload, probeKeys)
        || payload.max_tokens !== 2
        || payload.reasoning_effort !== 'low') {
        this.reject(response, 'probe-envelope')
        return
      }
      this.probeRequestCount += 1
      this.records.push(this.record('probe', request, byteLength, payload))
      this.writeTextResponse(response, 'OK', { prompt_tokens: 8, completion_tokens: 1 })
      return
    }

    const latestUser = latestUserMessage(messages)
    if (!latestUser) {
      this.reject(response, 'messages')
      return
    }

    const hasTools = payload.tools !== undefined
    const conversationKeys = [
      'model', 'messages', 'stream', 'max_tokens',
      ...(payload.reasoning_effort === undefined ? [] : ['reasoning_effort']),
      ...(hasTools ? ['tools', 'tool_choice'] : []),
    ]
    if (!hasExactKeys(payload, conversationKeys)
      || payload.max_tokens !== 32_768
      || (payload.reasoning_effort !== undefined && payload.reasoning_effort !== 'high')) {
      this.reject(response, 'envelope-fields')
      return
    }
    if (hasTools && (payload.tool_choice !== 'auto' || !validTools(payload.tools))) {
      this.reject(response, 'tool-contract')
      return
    }
    if (!validToolLinks(messages, payload.tools)) {
      this.reject(response, 'tool-link')
      return
    }

    const offersCurrentDocumentTool = Array.isArray(payload.tools)
      && payload.tools.some((tool) => (
        isRecord(tool)
        && tool.type === 'function'
        && isRecord(tool.function)
        && tool.function.name === 'read_current_document'
      ))
    const workspaceMarker = workspaceEditMarker(latestUser.content)
    const offersWorkspaceTools = Array.isArray(payload.tools)
      && payload.tools.some((tool) => (
        isRecord(tool) && isRecord(tool.function)
        && tool.function.name === 'read_workspace_document'
      ))
      && payload.tools.some((tool) => (
        isRecord(tool) && isRecord(tool.function)
        && tool.function.name === 'edit_workspace_document'
      ))
    if (latestUser.content.includes(AI_CONVERSATION_E2E_READ_COMMAND)
      ? !offersCurrentDocumentTool
      : workspaceMarker !== null && !offersWorkspaceTools) {
      this.reject(response, 'tools')
      return
    }

    this.conversationRequestCount += 1
    this.records.push(this.record('conversation', request, byteLength, payload))
    const toolsAfterUser = messages.slice(latestUser.index + 1).filter(({ role }) => role === 'tool')
    if (latestUser.content.includes(AI_CONVERSATION_E2E_READ_COMMAND)) {
      if (toolsAfterUser.length === 0) {
        this.writeToolCallResponse(response)
        return
      }
      const toolText = toolsAfterUser.map(({ content }) => String(content)).join('\n')
      const marker = this.options.documentMarkers.find((candidate) => toolText.includes(candidate))
      if (!marker) {
        this.reject(response, 'document-marker')
        return
      }
      this.observedDocumentMarkers.push(marker)
      this.writeTextResponse(response, `LOOPBACK_READ_OK:${marker}`, {
        prompt_tokens: 23_400,
        completion_tokens: 10,
      })
      return
    }

    if (workspaceMarker !== null) {
      const linked = linkedToolResultsAfter(messages, latestUser.index)
      if (linked === null || linked.length > 3) {
        this.reject(response, 'workspace-tool-link')
        return
      }
      if (linked.length === 0) {
        this.writeToolCallResponse(response, 'read_workspace_document', {
          path: 'b.md', cursor: 0, maxChars: 48_000,
        })
        return
      }
      if (linked[0]!.name !== 'read_workspace_document') {
        this.reject(response, 'workspace-read-link')
        return
      }
      let readResult: unknown
      try { readResult = JSON.parse(linked[0]!.content) } catch {
        this.reject(response, 'workspace-read-json')
        return
      }
      const document = parseWorkspaceToolResult('read_workspace_document', readResult)
      if (linked.length === 1) {
        if (document?.kind !== 'document' || document.path !== 'b.md') {
          this.reject(response, 'workspace-read-result')
          return
        }
        this.writeToolCallResponse(response, 'edit_workspace_document', {
          path: 'b.md',
          content: `# B\n\n${workspaceMarker}\n`,
          expectedVersion: document.version,
        })
        return
      }
      if (linked[1]!.name !== 'edit_workspace_document') {
        this.reject(response, 'workspace-edit-link')
        return
      }
      let editResult: unknown
      try { editResult = JSON.parse(linked[1]!.content) } catch {
        this.reject(response, 'workspace-edit-json')
        return
      }
      const mutation = parseWorkspaceToolResult('edit_workspace_document', editResult)
      if (mutation?.kind === 'denied') {
        this.writeTextResponse(response, `LOOPBACK_WORKSPACE_WRITE_DENIED:${workspaceMarker}`, {
          prompt_tokens: 180, completion_tokens: 8,
        })
        return
      }
      if (mutation?.kind !== 'mutation' || mutation.state !== 'succeeded'
        || mutation.paths.length !== 1 || mutation.paths[0] !== 'b.md') {
        this.reject(response, 'workspace-edit-result')
        return
      }
      if (linked.length === 2) {
        // Completing an edit does not prove the tool can reread its new state.
        this.writeToolCallResponse(response, 'read_workspace_document', {
          path: 'b.md', cursor: 0, maxChars: 48_000,
        })
        return
      }
      if (linked[2]!.name !== 'read_workspace_document') {
        this.reject(response, 'workspace-readback-link')
        return
      }
      let readbackResult: unknown
      try { readbackResult = JSON.parse(linked[2]!.content) } catch {
        this.reject(response, 'workspace-readback-json')
        return
      }
      const readback = parseWorkspaceToolResult('read_workspace_document', readbackResult)
      const expectedContent = `# B\n\n${workspaceMarker}\n`
      // Editor snapshots serialize Markdown escapes; compare the complete parsed document.
      const markdownTree = (source: string) => JSON.stringify(fromMarkdown(source),
        (key, value: unknown) => key === 'position' ? undefined : value)
      if (document?.kind !== 'document' || readback?.kind !== 'document'
        || readback.path !== 'b.md' || readback.cursor !== 0
        || markdownTree(readback.content) !== markdownTree(expectedContent) || readback.hasMore || readback.nextCursor !== null
        || readback.totalChars !== readback.content.length
        || readback.version.fileId !== document.version.fileId
        || readback.version.revision === document.version.revision) {
        this.reject(response, 'workspace-readback-result')
        return
      }
      this.writeTextResponse(response, `LOOPBACK_WORKSPACE_WRITE_OK:${workspaceMarker}`, {
        prompt_tokens: 220, completion_tokens: 8,
      })
      return
    }

    const marker = latestUser.content.match(SESSION_MARKER_PATTERN)?.[0] ?? 'NATURAL_CHAT'
    this.writeTextResponse(response, `LOOPBACK_CHAT_OK:${marker}`, {
      prompt_tokens: 120,
      completion_tokens: 8,
    })
  }

  private record(
    kind: AiConversationLoopbackRequestRecord['kind'],
    request: IncomingMessage,
    bodyByteLength: number,
    body: Record<string, unknown>,
  ): AiConversationLoopbackRequestRecord {
    return {
      kind,
      method: 'POST',
      pathname: '/v1/chat/completions',
      headers: {
        accept: request.headers.accept ?? null,
        authorization: 'Bearer [REDACTED]',
        contentType: request.headers['content-type'] ?? null,
        host: request.headers.host ?? null,
        userAgent: request.headers['user-agent'] ?? null,
      },
      bodyByteLength,
      body: structuredClone(body),
    }
  }

  private writeHeaders(response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'close',
    })
  }

  private writeToolCallResponse(
    response: ServerResponse,
    name = 'read_current_document',
    argumentsValue: Record<string, unknown> = { cursor: 0, maxChars: 48_000 },
  ): void {
    this.toolCallSequence += 1
    const id = name === 'read_current_document'
      ? `call_e2e_current_document_${this.toolCallSequence}`
      : `call_e2e_${name}_${this.toolCallSequence}`
    this.writeHeaders(response)
    response.write(`data: ${JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id,
            function: {
              name,
              arguments: JSON.stringify(argumentsValue),
            },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  }

  private writeTextResponse(
    response: ServerResponse,
    content: string,
    usage: { prompt_tokens: number; completion_tokens: number },
  ): void {
    this.writeHeaders(response)
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`)
    response.write(`data: ${JSON.stringify({
      choices: [],
      usage: {
        ...usage,
        total_tokens: usage.prompt_tokens + usage.completion_tokens,
      },
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
}
