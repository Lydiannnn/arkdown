import { afterEach, describe, expect, it } from 'vitest'
import { createModelProtocolClient } from '../../../src/main/models/model-protocol-client'
import type { ModelChatMessage } from '../../../src/main/models/model-protocol-client'
import { translationThinkingPreference } from '../../../src/shared/model-thinking'
import {
  AI_WORKSPACE_TOOLS,
  READ_CURRENT_DOCUMENT_TOOL,
} from '../../../src/main/models/ai-conversation-prompts'
import {
  AI_CONVERSATION_E2E_READ_COMMAND,
  AiConversationLoopbackServer,
} from './ai-conversation-loopback'

const servers: AiConversationLoopbackServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close()))
})

async function post(
  server: AiConversationLoopbackServer,
  payload: unknown,
  apiKey = 'local-e2e-key',
): Promise<Response> {
  return await fetch(server.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
}

function ordinaryEnvelope(messages: readonly unknown[]): Record<string, unknown> {
  return {
    model: 'local-e2e-model',
    messages,
    stream: true,
    max_tokens: 32_768,
    tools: [{
      type: 'function',
      function: {
        name: READ_CURRENT_DOCUMENT_TOOL.name,
        description: READ_CURRENT_DOCUMENT_TOOL.description,
        parameters: READ_CURRENT_DOCUMENT_TOOL.inputSchema,
      },
    }],
    tool_choice: 'auto',
  }
}

function workspaceEnvelope(messages: readonly unknown[]): Record<string, unknown> {
  return {
    model: 'local-e2e-model',
    messages,
    stream: true,
    max_tokens: 32_768,
    tools: AI_WORKSPACE_TOOLS.slice(1).map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    })),
    tool_choice: 'auto',
  }
}

async function createServer(modelId = 'local-e2e-model'): Promise<AiConversationLoopbackServer> {
  const server = new AiConversationLoopbackServer({
    apiKey: 'local-e2e-key',
    documentMarkers: ['UNSAVED-A-9f7d', 'UNSAVED-B-a41c'],
    modelId,
  })
  servers.push(server)
  await server.start()
  return server
}

describe('AI conversation loopback provider', () => {
  it('accepts only the bounded local OpenAI connection probe', async () => {
    const server = await createServer()

    const accepted = await post(server, {
      model: 'local-e2e-model',
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      stream: true,
      max_tokens: 2,
      reasoning_effort: 'low',
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toContain('OK')

    const wrongKey = await post(server, {
      model: 'local-e2e-model',
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      stream: true,
      max_tokens: 2,
      reasoning_effort: 'low',
    }, 'wrong-key')
    expect(wrongKey.status).toBe(401)
    expect(server.probeRequestCount).toBe(1)
    expect(server.requestRecords()).toEqual([expect.objectContaining({
      kind: 'probe',
      method: 'POST',
      pathname: '/v1/chat/completions',
      headers: expect.objectContaining({
        accept: '*/*',
        authorization: 'Bearer [REDACTED]',
        contentType: 'application/json',
      }),
      body: {
        model: 'local-e2e-model',
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        stream: true,
        max_tokens: 2,
        reasoning_effort: 'low',
      },
    })])
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it.each([undefined, 'high'] as const)('rejects a native connection probe with effort %s', async (effort) => {
    const server = await createServer('gpt-5-local-e2e')
    const response = await post(server, {
      model: 'gpt-5-local-e2e',
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      stream: true,
      max_tokens: 2,
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
    })
    expect(response.status).toBe(400)
    await response.text()
    expect(server.probeRequestCount).toBe(0)
    expect(server.requestRecords()).toEqual([])
    expect(() => server.assertHealthy()).toThrow(/probe-envelope/u)
  })

  it('rejects extra envelope fields, wrong tool schemas, and unassociated tool results', async () => {
    const server = await createServer()
    const userMessage = `分析当前文档 ${AI_CONVERSATION_E2E_READ_COMMAND}`
    const extraField = await post(server, {
      ...ordinaryEnvelope([
        { role: 'system', content: 'Use tools when needed.' },
        { role: 'user', content: userMessage },
      ]),
      api_key: 'local-e2e-key',
    })
    expect(extraField.status).toBe(400)
    expect(() => server.assertHealthy()).toThrow('AI conversation loopback rejected: secret-body')

    const wrongSchema = ordinaryEnvelope([
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: userMessage },
    ])
    ;(wrongSchema.tools as Array<Record<string, unknown>>)[0] = {
      type: 'function',
      function: {
        name: 'read_current_document',
        description: 'Wrong contract',
        parameters: { type: 'object', additionalProperties: true },
      },
    }
    expect((await post(server, wrongSchema)).status).toBe(400)
    expect(() => server.assertHealthy()).toThrow('AI conversation loopback rejected: secret-body,tool-contract')

    const unassociated = await post(server, ordinaryEnvelope([
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: userMessage },
      {
        role: 'tool',
        tool_call_id: 'call_without_assistant_declaration',
        content: JSON.stringify({ kind: 'document', content: 'UNSAVED-A-9f7d' }),
      },
    ]))
    expect(unassociated.status).toBe(400)
    expect(() => server.assertHealthy()).toThrow('AI conversation loopback rejected: secret-body,tool-contract,tool-link')
    const malformedReasoning = await post(server, ordinaryEnvelope([
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'assistant', content: 'previous answer', reasoning_content: { invalid: true } },
      { role: 'user', content: userMessage },
    ]))
    expect(malformedReasoning.status).toBe(400)
    expect(() => server.assertHealthy()).toThrow('AI conversation loopback rejected: envelope,secret-body,tool-contract,tool-link')
  })

  it('returns a deterministic tool call and proves the continuation contains unsaved editor text', async () => {
    const server = await createServer()
    const userMessage = `分析当前文档 ${AI_CONVERSATION_E2E_READ_COMMAND}`
    const first = await post(server, ordinaryEnvelope([
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: userMessage },
    ]))
    const firstBody = await first.text()

    expect(first.status).toBe(200)
    expect(firstBody).toContain('read_current_document')
    expect(firstBody).toContain('call_e2e_current_document_1')

    const toolResult = JSON.stringify({
      kind: 'document',
      displayName: 'a.md',
      sourceFormat: 'markdown',
      dirty: true,
      cursor: 0,
      content: '# A\n\nUNSAVED-A-9f7d',
      nextCursor: null,
      hasMore: false,
      totalChars: 21,
      version: { fileId: 'file-a', revision: '1', size: 21, mtimeMs: 1 },
    })
    const second = await post(server, ordinaryEnvelope([
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: userMessage },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_e2e_current_document_1',
          type: 'function',
          function: {
            name: 'read_current_document',
            arguments: '{"cursor":0,"maxChars":48000}',
          },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_e2e_current_document_1',
        content: toolResult,
      },
    ]))
    const secondBody = await second.text()

    expect(second.status).toBe(200)
    expect(secondBody).toContain('LOOPBACK_READ_OK:UNSAVED-A-9f7d')
    expect(secondBody).toContain('23410')
    expect(server.documentReadMarkers()).toEqual(['UNSAVED-A-9f7d'])
    expect(server.conversationRequestCount).toBe(2)
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it('requires a fresh linked workspace read after edit and verifies the new content and version', async () => {
    const server = await createServer()
    const user = '编辑工作区文档 E2E_WORKSPACE_EDIT_ONCE'
    const baseMessages = [
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: user },
    ]
    const first = await post(server, workspaceEnvelope(baseMessages))
    const firstBody = await first.text()
    expect(first.status).toBe(200)
    expect(firstBody).toContain('read_workspace_document')
    expect(firstBody).toContain(String.raw`{\"path\":\"b.md\",\"cursor\":0,\"maxChars\":48000}`)

    const readCall = {
      id: 'call_e2e_read_workspace_document_1',
      type: 'function',
      function: {
        name: 'read_workspace_document',
        arguments: '{"path":"b.md","cursor":0,"maxChars":48000}',
      },
    }
    const version = { fileId: 'file-b', revision: 'revision-b', size: 10, mtimeMs: 1 }
    const readResult = JSON.stringify({
      kind: 'document', path: 'b.md', displayName: 'b.md', sourceFormat: 'markdown',
      cursor: 0, content: '# B\n\nSaved B\n', nextCursor: null, hasMore: false,
      totalChars: 13, version,
    })
    const secondMessages = [
      ...baseMessages,
      { role: 'assistant', content: '', tool_calls: [readCall] },
      { role: 'tool', tool_call_id: readCall.id, content: readResult },
    ]
    const second = await post(server, workspaceEnvelope(secondMessages))
    const secondBody = await second.text()
    expect(second.status).toBe(200)
    expect(secondBody).toContain('edit_workspace_document')
    expect(secondBody).toContain('AI_EDITED_ONCE')
    expect(secondBody).toContain('revision-b')

    const editCall = {
      id: 'call_e2e_edit_workspace_document_2',
      type: 'function',
      function: {
        name: 'edit_workspace_document',
        arguments: JSON.stringify({
          path: 'b.md', content: '# B\n\nAI_EDITED_ONCE\n', expectedVersion: version,
        }),
      },
    }
    const thirdMessages = [
      ...secondMessages,
      { role: 'assistant', content: '', tool_calls: [editCall] },
      {
        role: 'tool', tool_call_id: editCall.id,
        content: JSON.stringify({
          kind: 'mutation', operationId: '11111111-1111-4111-8111-111111111111',
          state: 'succeeded', paths: ['b.md'],
        }),
      },
    ]
    const third = await post(server, workspaceEnvelope(thirdMessages))
    expect(third.status).toBe(200)
    const thirdBody = await third.text()
    expect(thirdBody).toContain('read_workspace_document')
    expect(thirdBody).toContain(String.raw`{\"path\":\"b.md\",\"cursor\":0,\"maxChars\":48000}`)
    expect(thirdBody).not.toContain('LOOPBACK_WORKSPACE_WRITE_OK')
    const content = '# B\n\nAI_EDITED_ONCE\n'
    const fourth = await post(server, workspaceEnvelope([
      ...thirdMessages,
      { role: 'assistant', content: '', tool_calls: [{
        ...readCall, id: 'call_e2e_read_workspace_document_3',
      }] },
      { role: 'tool', tool_call_id: 'call_e2e_read_workspace_document_3', content: JSON.stringify({
        kind: 'document', path: 'b.md', displayName: 'b.md', sourceFormat: 'markdown',
        cursor: 0, content, nextCursor: null, hasMore: false, totalChars: content.length,
        version: { ...version, revision: 'revision-b-after-edit', size: content.length },
      }) },
    ]))
    expect(fourth.status).toBe(200)
    expect(await fourth.text()).toContain('LOOPBACK_WORKSPACE_WRITE_OK:AI_EDITED_ONCE')
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it.each(['unavailable', 'stale-content', 'stale-version', 'wrong-path', 'nonzero-cursor'] as const)(
    'rejects a successful mutation whose fresh readback is %s', async (failure) => {
      const server = await createServer()
      const before = '# B\n\nSaved B\n'
      const after = '# B\n\nAI_EDITED_ONCE\n'
      const version = { fileId: 'file-b', revision: 'revision-before', size: before.length, mtimeMs: 1 }
      const page = {
        kind: 'document', path: 'b.md', displayName: 'b.md', sourceFormat: 'markdown',
        cursor: 0, content: after, nextCursor: null, hasMore: false, totalChars: after.length,
        version: { ...version, revision: 'revision-after', size: after.length },
      }
      const result = failure === 'unavailable' ? { kind: 'unavailable' }
        : failure === 'stale-content' ? { ...page, content: before, totalChars: before.length }
          : failure === 'stale-version' ? { ...page, version }
            : failure === 'wrong-path' ? { ...page, path: 'other.md' }
              : { ...page, cursor: 1 }
      const linked = (id: string, name: string, args: unknown, value: unknown) => [
        { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
        { role: 'tool', tool_call_id: id, content: JSON.stringify(value) },
      ]
      const response = await post(server, workspaceEnvelope([
        { role: 'user', content: '编辑工作区文档 E2E_WORKSPACE_EDIT_ONCE' },
        ...linked('read-before', 'read_workspace_document', { path: 'b.md', cursor: 0, maxChars: 48000 },
          { ...page, content: before, totalChars: before.length, version }),
        ...linked('edit', 'edit_workspace_document', { path: 'b.md', content: after, expectedVersion: version },
          { kind: 'mutation', operationId: '11111111-1111-4111-8111-111111111111', state: 'succeeded', paths: ['b.md'] }),
        ...linked('read-after', 'read_workspace_document', { path: 'b.md', cursor: 0, maxChars: 48000 }, result),
      ]))
      expect(response.status).toBe(400)
      await response.text()
      expect(() => server.assertHealthy()).toThrow(/workspace-readback-result/u)
    },
  )

  it('speaks the production OpenAI protocol client contract before packaged E2E consumes it', async () => {
    const server = await createServer('gpt-5-local-e2e')
    const client = createModelProtocolClient()
    const signal = new AbortController().signal
    const provider = {
      provider: 'other' as const,
      protocol: 'openai' as const,
      baseUrl: server.baseUrl,
      modelId: 'gpt-5-local-e2e',
      apiKey: 'local-e2e-key',
      thinkingMode: 'enabled' as const, reasoningEffort: 'high' as const,
      capabilityOverride: {
        contextWindowTokens: 128_000,
        maxInputTokens: 95_000,
        maxOutputTokens: 32_768,
      },
      signal,
    }
    // The actual connection service selects the cheap probe preference separately
    // from the user's conversation preference; the protocol client preserves it.
    await expect(client.testConnection({ ...provider, ...translationThinkingPreference(provider) })).resolves.toBeUndefined()
    expect(server.requestRecords().filter(({ kind }) => kind === 'probe')).toEqual([
      expect.objectContaining({ body: {
        model: provider.modelId,
        messages: [{ role: 'user', content: 'Reply with OK only.' }],
        stream: true,
        max_tokens: 2,
        reasoning_effort: 'low',
      } }),
    ])

    const user = `分析当前文档 ${AI_CONVERSATION_E2E_READ_COMMAND}`
    const tools = [READ_CURRENT_DOCUMENT_TOOL]
    const first = await client.streamChat({
      ...provider,
      messages: [
        { role: 'system', content: 'Use tools when needed.' },
        { role: 'user', content: user },
      ],
      tools,
      requestedOutputTokens: 32_768,
      onDelta: () => undefined,
    })
    expect(first.toolCalls).toEqual([{
      id: 'call_e2e_current_document_1',
      name: 'read_current_document',
      argumentsJson: '{"cursor":0,"maxChars":48000}',
    }])

    const deltas: string[] = []
    const toolResult = JSON.stringify({
      kind: 'document', dirty: true, cursor: 0, content: 'UNSAVED-B-a41c',
    })
    const second = await client.streamChat({
      ...provider,
      messages: [
        { role: 'system', content: 'Use tools when needed.' },
        { role: 'user', content: user },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        {
          role: 'tool',
          toolCallId: first.toolCalls[0]!.id,
          name: first.toolCalls[0]!.name,
          content: toolResult,
        },
      ],
      tools,
      requestedOutputTokens: 32_768,
      onDelta: (delta) => deltas.push(delta),
    })
    expect(deltas.join('')).toBe('LOOPBACK_READ_OK:UNSAVED-B-a41c')
    expect(second.usage).toMatchObject({ totalTokens: 23_410, estimated: false })
    expect(server.documentReadMarkers()).toEqual(['UNSAVED-B-a41c'])
    const conversations = server.requestRecords().filter(({ kind }) => kind === 'conversation')
    expect(conversations).toHaveLength(2)
    expect(conversations[0]).toMatchObject({
      headers: {
        accept: 'text/event-stream, application/json',
        authorization: 'Bearer [REDACTED]',
        contentType: 'application/json',
      },
      body: {
        max_tokens: 32_768,
        reasoning_effort: 'high',
        tool_choice: 'auto',
      },
    })
    expect(conversations[1]).toMatchObject({
      body: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            tool_calls: [{
              id: 'call_e2e_current_document_1',
              type: 'function',
              function: {
                name: 'read_current_document',
                arguments: '{"cursor":0,"maxChars":48000}',
              },
            }],
          }),
          expect.objectContaining({
            role: 'tool',
            tool_call_id: 'call_e2e_current_document_1',
          }),
        ]),
      },
    })
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it('accepts actual client replay from a natural reply through a document tool response', async () => {
    const server = await createServer('gpt-5-arkdown-ai-e2e')
    const requestBodies: unknown[] = []
    const client = createModelProtocolClient(async (input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)))
      return fetch(input, init)
    })
    const provider = {
      provider: 'other' as const, protocol: 'openai' as const,
      baseUrl: server.baseUrl, modelId: 'gpt-5-arkdown-ai-e2e', apiKey: 'local-e2e-key',
      thinkingMode: 'enabled' as const, reasoningEffort: 'high' as const,
      capabilityOverride: { contextWindowTokens: 128_000, maxInputTokens: 95_000, maxOutputTokens: 32_768 },
      requestedOutputTokens: 32_768, signal: new AbortController().signal,
    }
    const messages: ModelChatMessage[] = [
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: '普通对话 E2E_SESSION_MARKER_WORKSPACE_A' },
    ]
    try {
      let naturalText = ''
      const natural = await client.streamChat({
        ...provider, messages, onDelta: (delta) => { naturalText += delta },
      })
      expect(natural.usage?.inputTokens).toBe(120)
      messages.push({ role: 'assistant', content: naturalText, reasoningContent: natural.reasoningContent })
      messages.push({ role: 'user', content: `分析当前文档 ${AI_CONVERSATION_E2E_READ_COMMAND}` })
      const called = await client.streamChat({
        ...provider, messages, tools: [READ_CURRENT_DOCUMENT_TOOL], onDelta: () => undefined,
      })
      expect(called.toolCalls).toEqual([{
        id: 'call_e2e_current_document_1', name: 'read_current_document',
        argumentsJson: '{"cursor":0,"maxChars":48000}',
      }])
      expect(called.usage?.inputTokens).toBe(40)
      messages.push({
        role: 'assistant', content: '', reasoningContent: called.reasoningContent,
        toolCalls: called.toolCalls,
      })
      messages.push({
        role: 'tool', toolCallId: called.toolCalls[0]!.id, name: 'read_current_document',
        content: JSON.stringify({ kind: 'document', dirty: true, cursor: 0, content: 'UNSAVED-B-a41c' }),
      })
      let readText = ''
      await client.streamChat({
        ...provider, messages, tools: [READ_CURRENT_DOCUMENT_TOOL],
        onDelta: (delta) => { readText += delta },
      })
      expect(readText).toBe('LOOPBACK_READ_OK:UNSAVED-B-a41c')
      expect(server.documentReadMarkers()).toEqual(['UNSAVED-B-a41c'])
      expect(() => server.assertHealthy()).not.toThrow()
    } catch (error) {
      let fixtureFailure = ''
      try { server.assertHealthy() } catch (failure) { fixtureFailure = String(failure) }
      // Bodies are generated synthetic fixture data. Never retain request headers or the key.
      expect(JSON.stringify(requestBodies)).not.toContain('local-e2e-key')
      throw new Error(JSON.stringify({ error: String(error), fixtureFailure, requestBodies }))
    }
  })

  it('returns the complete workspace session marker including internal underscores', async () => {
    const server = await createServer()
    const response = await post(server, {
      model: 'local-e2e-model',
      messages: [
        { role: 'system', content: 'Use tools when needed.' },
        { role: 'user', content: '普通对话 E2E_SESSION_MARKER_WORKSPACE_A' },
      ],
      stream: true,
      max_tokens: 32_768,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('LOOPBACK_CHAT_OK:E2E_SESSION_MARKER_WORKSPACE_A')
    expect(() => server.assertHealthy()).not.toThrow()
  })

  it('keeps request records credential-free and rejects malformed or unexpected input', async () => {
    const server = await createServer()
    const response = await post(server, {
      model: 'local-e2e-model',
      messages: [
        { role: 'system', content: 'Use tools when needed.' },
        { role: 'user', content: '普通对话 E2E_SESSION_MARKER' },
      ],
      stream: true,
      max_tokens: 32_768,
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('LOOPBACK_CHAT_OK:E2E_SESSION_MARKER')

    const malformed = await post(server, ordinaryEnvelope([
      { role: 'system', content: 'Use tools when needed.' },
      { role: 'user', content: { secret: 'not text' } },
    ]))
    expect(malformed.status).toBe(400)

    const serializedRecords = JSON.stringify(server.requestRecords())
    expect(serializedRecords).not.toContain('local-e2e-key')
    expect(serializedRecords).not.toMatch(/api[_-]?key/iu)
    expect(serializedRecords).toContain('Bearer [REDACTED]')
    expect(serializedRecords).toContain('E2E_SESSION_MARKER')
    expect(() => server.assertHealthy()).toThrow(/envelope|messages/u)
  })
})
