import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  AI_DOCUMENT_PAGE_MAX_CHARS,
  AI_DOCUMENT_TOOL_CALL_LIMIT,
  AI_WORKSPACE_TOOL_NAMES,
  parseAiConversationEvent,
  parseAiFileVersion,
  parseAiOperationManifest,
  parseCancelAiConversationInput,
  parseCurrentDocumentToolResult,
  parseListWorkspaceEntriesArguments,
  parseReadWorkspaceDocumentArguments,
  parseStartAiConversationInput,
  parseSubmitAiWorkspaceToolResultInput,
  parseWorkspaceToolResult,
  isCanonicalWorkspaceRelativePath,
  type AiWorkspaceToolContractMap,
  type AiFileVersion,
  type AiCurrentDocumentToolResult,
} from '../../src/shared/ai-conversation'
import type { AiBudgetNotExecuted } from '../../src/shared/ai-budget-result'

const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000'
const CONVERSATION_ID = '550e8400-e29b-41d4-a716-446655440001'
const MESSAGE_ID = '550e8400-e29b-41d4-a716-446655440002'

const VERSION: AiFileVersion = {
  fileId: 'volume-1.file-2',
  revision: 'sha256.abc',
  size: 12,
  mtimeMs: 1_700_000_000_000,
}

describe('AI workspace shared contract', () => {
  it('registers the exact readable process codec in the outer conversation event boundary', () => {
    const event = { requestId: REQUEST_ID, messageId: MESSAGE_ID, type: 'process-text', round: 1, sequence: 1,
      kind: 'reasoning-summary', itemId: CONVERSATION_ID, segmentIndex: 0, delta: 'readable', delivery: 'stream' }
    expect(parseAiConversationEvent(event)).toEqual(event)
    expect(parseAiConversationEvent({ ...event, encrypted: 'must not cross' })).toBeUndefined()
    const getter = { ...event }
    Object.defineProperty(getter, 'type', { enumerable: true, get() { throw new Error('must not invoke') } })
    expect(() => parseAiConversationEvent(getter)).not.toThrow()
    expect(parseAiConversationEvent(getter)).toBeUndefined()
  })
  it('accepts only opaque source identities and a null ambiguous-source boundary', () => {
    const base = { requestId: REQUEST_ID, conversationId: CONVERSATION_ID, workspaceKey: 'workspace-a',
      acknowledgedTranscriptRevision: 0, messages: [{ id: MESSAGE_ID, role: 'user', content: 'quoted material' }],
      capabilities: { currentDocument: false, workspace: false }, writePolicy: 'ask-every-time' }
    expect(parseStartAiConversationInput({ ...base, expectedDocumentId: MESSAGE_ID })?.expectedDocumentId).toBe(MESSAGE_ID)
    expect(parseStartAiConversationInput({ ...base, expectedDocumentId: null })?.expectedDocumentId).toBeNull()
    for (const expectedDocumentId of ['C:/private/A.md', '', {}, undefined]) {
      expect(parseStartAiConversationInput({ ...base, expectedDocumentId })).toBeUndefined()
    }
  })
  it('exact-parses only bounded local compaction records with an acknowledged revision', () => {
    const compacted = {
      requestId: REQUEST_ID, type: 'context-compaction', transcriptRevision: 3,
      status: 'compacted', beforeTokens: 78_000, afterTokens: 46_000, contextWindowTokens: 100_000,
    }
    expect(parseAiConversationEvent(compacted)).toEqual(compacted)
    expect(parseAiConversationEvent(compacted)).not.toBe(compacted)
    const failed = { requestId: REQUEST_ID, type: 'context-compaction', transcriptRevision: 2, status: 'failed' }
    expect(parseAiConversationEvent(failed)).toEqual(failed)
    for (const malformed of [
      { ...compacted, contextWindowTokens: 0 },
      { ...compacted, contextWindowTokens: null },
      { ...compacted, beforeTokens: -1 },
      { ...compacted, afterTokens: 1.5 },
      { ...compacted, afterTokens: 78_001 },
      { ...compacted, transcriptRevision: -1 },
      { ...compacted, message: 'forged system message' },
      { ...failed, beforeTokens: 100 },
      { ...failed, status: 'disabled' },
    ]) expect(parseAiConversationEvent(malformed)).toBeUndefined()
  })

  it('parses a workspace-scoped start without a document identity', () => {
    expect(parseStartAiConversationInput({
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 0,
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'Summarize this workspace.' }],
      capabilities: { currentDocument: true, workspace: false },
      writePolicy: 'ask-every-time',
    })).toEqual({
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 0,
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'Summarize this workspace.' }],
      capabilities: { currentDocument: true, workspace: false },
      writePolicy: 'ask-every-time',
    })
  })

  it('rejects extra keys, document identity, and non-canonical workspace starts', () => {
    const start = {
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 0,
      messages: [],
      capabilities: { currentDocument: false, workspace: false },
      writePolicy: 'ask-every-time',
    }

    expect(parseStartAiConversationInput({ ...start, documentKey: 'notes/private.md' })).toBeUndefined()
    expect(parseStartAiConversationInput({ ...start, requestId: 'not-a-request-id' })).toBeUndefined()
    expect(parseStartAiConversationInput({ ...start, workspaceKey: ' C:\\secret ' })).toBeUndefined()
    expect(parseStartAiConversationInput({ ...start, capabilities: { currentDocument: false } })).toBeUndefined()
  })

  it('accepts only a bounded user delta after an authoritative transcript revision', () => {
    const base = {
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 7,
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'Next question.' }],
      capabilities: { currentDocument: false, workspace: false },
      writePolicy: 'ask-every-time',
    }
    expect(parseStartAiConversationInput(base)).toEqual(base)
    expect(parseStartAiConversationInput({
      ...base,
      messages: [...base.messages, {
        id: '650e8400-e29b-41d4-a716-446655440003', role: 'user', content: 'Full history replay.',
      }],
    })).toBeUndefined()
    expect(parseStartAiConversationInput({
      ...base, messages: [{ ...base.messages[0], role: 'assistant' }],
    })).toBeUndefined()
    const { acknowledgedTranscriptRevision: _omitted, ...withoutRevision } = base
    expect(parseStartAiConversationInput(withoutRevision)).toBeUndefined()
  })

  it('rejects accessor, symbol, non-enumerable, and non-ordinary start records without reading getters', () => {
    const base = {
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 7,
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'Next question.' }],
      capabilities: { currentDocument: false, workspace: false },
      writePolicy: 'ask-every-time' as const,
    }
    let getterReads = 0
    const accessorMessage = Object.defineProperty({
      id: MESSAGE_ID, role: 'user',
    }, 'content', {
      enumerable: true,
      get() { getterReads += 1; return 'do not read' },
    })
    expect(parseStartAiConversationInput({ ...base, messages: [accessorMessage] })).toBeUndefined()
    expect(getterReads).toBe(0)

    const accessorTop = { ...base }
    Object.defineProperty(accessorTop, 'requestId', {
      enumerable: true,
      get() { getterReads += 1; return REQUEST_ID },
    })
    expect(parseStartAiConversationInput(accessorTop)).toBeUndefined()
    const accessorMessages: unknown[] = []
    Object.defineProperty(accessorMessages, '0', {
      enumerable: true,
      get() { getterReads += 1; return base.messages[0] },
    })
    expect(parseStartAiConversationInput({ ...base, messages: accessorMessages })).toBeUndefined()
    const accessorCapabilities = { ...base.capabilities }
    Object.defineProperty(accessorCapabilities, 'currentDocument', {
      enumerable: true,
      get() { getterReads += 1; return false },
    })
    expect(parseStartAiConversationInput({ ...base, capabilities: accessorCapabilities })).toBeUndefined()
    expect(getterReads).toBe(0)

    const hiddenMessage = { ...base.messages[0] }
    Object.defineProperty(hiddenMessage, 'content', { value: 'hidden', enumerable: false })
    expect(parseStartAiConversationInput({ ...base, messages: [hiddenMessage] })).toBeUndefined()
    expect(parseStartAiConversationInput({
      ...base,
      capabilities: Object.assign({ ...base.capabilities }, { [Symbol('extra')]: true }),
    })).toBeUndefined()
    expect(parseStartAiConversationInput(Object.assign(Object.create(null), base))).toBeUndefined()
  })

  it('returns an ordinary deeply frozen start data record', () => {
    const parsed = parseStartAiConversationInput({
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 7,
      messages: [{ id: MESSAGE_ID, role: 'user', content: 'Next question.' }],
      capabilities: { currentDocument: false, workspace: false },
      writePolicy: 'ask-every-time',
    })
    expect(parsed).toBeDefined()
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed!.messages)).toBe(true)
    expect(Object.isFrozen(parsed!.messages[0])).toBe(true)
    expect(Object.isFrozen(parsed!.capabilities)).toBe(true)
  })

  it('rejects an empty start because capability toggles use their dedicated command', () => {
    expect(parseStartAiConversationInput({
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 0,
      messages: [],
      capabilities: { currentDocument: true, workspace: true },
      writePolicy: 'workspace-grant',
    })).toBeUndefined()
  })

  it('publishes exactly the supported workspace tools', () => {
    expect(AI_WORKSPACE_TOOL_NAMES).toEqual([
      'read_current_document',
      'list_workspace_entries',
      'read_workspace_document',
      'edit_workspace_document',
      'create_workspace_document',
      'rename_workspace_document',
      'delete_workspace_document',
    ])
  })

  it('accepts only canonical workspace-relative tool paths', () => {
    expect(parseReadWorkspaceDocumentArguments({ path: 'notes/todo.md', cursor: 0, maxChars: 100 })).toEqual({
      path: 'notes/todo.md', cursor: 0, maxChars: 100,
    })
    expect(parseListWorkspaceEntriesArguments({ path: 'notes', cursor: 0, maxEntries: 100, directoryVersion: null })).toEqual({
      path: 'notes', cursor: 0, maxEntries: 100, directoryVersion: null,
    })
    expect(parseListWorkspaceEntriesArguments({ path: '', cursor: 0, maxEntries: 100, directoryVersion: null })).toEqual({
      path: '', cursor: 0, maxEntries: 100, directoryVersion: null,
    })
    expect(parseListWorkspaceEntriesArguments({
      path: '', cursor: 1, maxEntries: 100,
      directoryVersion: { workspaceGeneration: 'generation-1', directoryId: 'directory.1', revision: 'list.1' },
    })).toEqual({
      path: '', cursor: 1, maxEntries: 100,
      directoryVersion: { workspaceGeneration: 'generation-1', directoryId: 'directory.1', revision: 'list.1' },
    })
    for (const path of [
      'C:\\secret.txt', '\\\\server\\share\\secret.txt', '/etc/passwd', '../secret.txt',
      'notes/../secret.txt', 'notes\\secret.txt', 'notes/a.txt:stream', 'notes/\0secret.txt',
      'NUL.txt', 'CON', 'notes/PRN.md', 'notes/file. ', 'notes/file.', 'notes//todo.md',
      'notes/', '', 'notes/<bad>.md', 'nul.txt', 'CoN.md',
    ]) {
      expect(parseReadWorkspaceDocumentArguments({ path, cursor: 0, maxChars: 100 })).toBeUndefined()
    }
  })

  it('keeps runtime relative-path whitespace and segment-length boundaries exact', () => {
    expect(isCanonicalWorkspaceRelativePath('a'.repeat(255))).toBe(true)
    expect(isCanonicalWorkspaceRelativePath('a'.repeat(256))).toBe(false)
    expect(isCanonicalWorkspaceRelativePath(`notes/${'a'.repeat(255)}`)).toBe(true)
    expect(isCanonicalWorkspaceRelativePath(`notes/${'a'.repeat(256)}`)).toBe(false)
    expect(isCanonicalWorkspaceRelativePath(' notes/todo.md')).toBe(false)
    expect(isCanonicalWorkspaceRelativePath('notes/todo.md ')).toBe(false)
  })

  it('keeps wire names to one safe segment and requires a version on list continuation', () => {
    expect(parseCurrentDocumentToolResult({
      kind: 'document', displayName: '/etc/passwd', sourceFormat: 'markdown', dirty: false,
      cursor: 0, content: 'x', nextCursor: null, hasMore: false, totalChars: 1, version: VERSION,
    })).toBeUndefined()
    expect(parseSubmitAiWorkspaceToolResultInput({
      requestId: REQUEST_ID, toolCallId: 'call_1', toolName: 'list_workspace_entries',
      result: {
        kind: 'entries', directoryPath: 'notes',
        directoryVersion: { workspaceGeneration: 'generation-1', directoryId: 'directory.1', revision: 'list.1' },
        cursor: 0, entries: [{ path: 'notes/todo.md', name: '//server/share', kind: 'document' }], nextCursor: null,
      },
    })).toBeUndefined()
    expect(parseListWorkspaceEntriesArguments({ path: 'notes', cursor: 1, maxEntries: 100, directoryVersion: null })).toBeUndefined()
    expect(parseWorkspaceToolResult('list_workspace_entries', {
      kind: 'entries', directoryPath: '',
      directoryVersion: { workspaceGeneration: 'generation-1', directoryId: 'directory.1', revision: 'list.1' },
      cursor: 1, entries: [{ path: 'notes/todo.md', name: 'todo.md', kind: 'document' }], nextCursor: null,
    })).toMatchObject({ kind: 'entries', directoryPath: '', cursor: 1 })
  })

  it('rejects sparse and extended arrays at every contract boundary', () => {
    const sparse = new Array(1)
    expect(parseStartAiConversationInput({
      requestId: REQUEST_ID,
      conversationId: CONVERSATION_ID,
      workspaceKey: 'workspace-generation-1',
      acknowledgedTranscriptRevision: 0,
      messages: sparse,
      capabilities: { currentDocument: false, workspace: false },
      writePolicy: 'ask-every-time',
    })).toBeUndefined()

    const paths = ['notes/todo.md'] as string[] & { extra?: string }
    paths.extra = 'not-an-index'
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID,
      type: 'authorization-requested',
      toolCallId: 'call_1',
      toolName: 'edit_workspace_document',
      operationId: '550e8400-e29b-41d4-a716-446655440003',
      scope: 'document',
      paths,
    })).toBeUndefined()
  })

  it('parses bounded current-document snapshots and versioned workspace results', () => {
    expect(parseCurrentDocumentToolResult({
      kind: 'document',
      displayName: 'draft.md',
      sourceFormat: 'markdown',
      dirty: true,
      cursor: 0,
      content: 'draft',
      nextCursor: null,
      hasMore: false,
      totalChars: 5,
      version: VERSION,
    })).toMatchObject({ kind: 'document', version: VERSION })

    expect(parseCurrentDocumentToolResult({
      kind: 'document',
      displayName: 'C:\\private\\draft.md',
      sourceFormat: 'markdown',
      dirty: true,
      cursor: 0,
      content: 'draft',
      nextCursor: null,
      hasMore: false,
      totalChars: 5,
      version: VERSION,
    })).toBeUndefined()

    expect(parseSubmitAiWorkspaceToolResultInput({
      requestId: REQUEST_ID,
      toolCallId: 'call_1',
      toolName: 'read_workspace_document',
      result: {
        kind: 'document', path: 'notes/todo.md', displayName: 'todo.md', sourceFormat: 'markdown',
        cursor: 0, content: 'todo', nextCursor: null, hasMore: false, totalChars: 4, version: VERSION,
      },
    })).toMatchObject({ toolName: 'read_workspace_document' })
  })

  it('rejects malformed versions and results whose discriminant does not match the tool', () => {
    expect(parseAiFileVersion({ ...VERSION, extra: true })).toBeUndefined()
    expect(parseAiFileVersion({ ...VERSION, size: -1 })).toBeUndefined()
    expect(parseAiFileVersion({ ...VERSION, revision: 'C:\\private\\revision' })).toBeUndefined()
    expect(parseSubmitAiWorkspaceToolResultInput({
      requestId: REQUEST_ID,
      toolCallId: 'call_1',
      toolName: 'read_workspace_document',
      result: { kind: 'entries', entries: [], nextCursor: null },
    })).toBeUndefined()
  })

  it('binds directory continuations to a versioned directory identity', () => {
    expect(parseSubmitAiWorkspaceToolResultInput({
      requestId: REQUEST_ID,
      toolCallId: 'call_1',
      toolName: 'list_workspace_entries',
      result: {
        kind: 'entries',
        directoryPath: 'notes',
        directoryVersion: { workspaceGeneration: 'generation-1', directoryId: 'directory.1', revision: 'list.1' },
        cursor: 0,
        entries: [{ path: 'notes/todo.md', name: 'todo.md', kind: 'document' }],
        nextCursor: 1,
      },
    })).toMatchObject({ toolName: 'list_workspace_entries' })
    expect(parseSubmitAiWorkspaceToolResultInput({
      requestId: REQUEST_ID,
      toolCallId: 'call_1',
      toolName: 'list_workspace_entries',
      result: {
        kind: 'entries', directoryPath: 'notes',
        directoryVersion: { workspaceGeneration: 'generation-1', directoryId: 'directory.1', revision: 'list.1' },
        cursor: 1, entries: [], nextCursor: 1,
      },
    })).toBeUndefined()
  })

  it('parses only canonical cancel, authorization, audit, and usage events', () => {
    expect(parseCancelAiConversationInput({ requestId: REQUEST_ID })).toEqual({ requestId: REQUEST_ID })
    expect(parseCancelAiConversationInput({ requestId: REQUEST_ID, extra: true })).toBeUndefined()
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID,
      type: 'authorization-requested',
      toolCallId: 'call_1',
      toolName: 'edit_workspace_document',
      operationId: '550e8400-e29b-41d4-a716-446655440003',
      scope: 'document',
      paths: ['notes/todo.md'],
    })).toMatchObject({ type: 'authorization-requested', scope: 'document' })
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID,
      type: 'authorization-requested',
      toolCallId: 'call_1',
      toolName: 'rename_workspace_document',
      operationId: '550e8400-e29b-41d4-a716-446655440003',
      scope: 'document',
      paths: ['notes/a.md', 'notes/b.md'],
    })).toBeUndefined()
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID,
      type: 'usage',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, cachedInputTokens: null, estimated: false },
    })).toMatchObject({ type: 'usage' })
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID,
      type: 'audit',
      action: 'edited',
      absolutePaths: ['C:\\private\\todo.md'],
    })).toMatchObject({ type: 'audit' })
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID,
      type: 'audit',
      action: 'edited',
      absolutePaths: ['notes/todo.md'],
    })).toBeUndefined()
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID,
      type: 'audit',
      action: 'renamed',
      absolutePaths: ['C:\\private\\before.md'],
    })).toBeUndefined()
  })

  it('binds streamed assistant deltas to explicit authoritative message revisions', () => {
    const assistantId = '650e8400-e29b-41d4-a716-446655440004'
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID, type: 'started', transcriptRevision: 1,
    })).toEqual({ requestId: REQUEST_ID, type: 'started', transcriptRevision: 1 })
    expect(parseAiConversationEvent({ requestId: REQUEST_ID, type: 'started' })).toBeUndefined()
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID, type: 'user-message-accepted', messageId: MESSAGE_ID,
      transcriptRevision: 1,
    })).toEqual({
      requestId: REQUEST_ID, type: 'user-message-accepted', messageId: MESSAGE_ID,
      transcriptRevision: 1,
    })
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID, type: 'message-start', messageId: assistantId,
      previousTranscriptRevision: 1,
    })).toEqual({
      requestId: REQUEST_ID, type: 'message-start', messageId: assistantId,
      previousTranscriptRevision: 1,
    })
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID, type: 'delta', messageId: assistantId, delta: '\n answer \n',
    })).toEqual({
      requestId: REQUEST_ID, type: 'delta', messageId: assistantId, delta: '\n answer \n',
    })
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID, type: 'message-completed', messageId: assistantId,
      transcriptRevision: 2,
    })).toEqual({
      requestId: REQUEST_ID, type: 'message-completed', messageId: assistantId,
      transcriptRevision: 2,
    })
    expect(parseAiConversationEvent({
      requestId: REQUEST_ID, type: 'delta', delta: 'ambiguous',
    })).toBeUndefined()
  })

  it('parses an exact local unknown-operation status without accepting control data', () => {
    const event = {
      requestId: REQUEST_ID,
      type: 'operation-status',
      toolName: 'edit_workspace_document',
      operationId: '650e8400-e29b-41d4-a716-446655440000',
      status: 'unknown',
      paths: ['notes/a.md'],
    }
    expect(parseAiConversationEvent(event)).toEqual(event)
    expect(parseAiConversationEvent({ ...event, nonce: 'hidden' })).toBeUndefined()
    expect(parseAiConversationEvent({ ...event, paths: ['C:\\secret\\a.md'] })).toBeUndefined()
  })

  it('allows only controlled stale guidance on unavailable or failed mutation results', () => {
    const recovery = { reason: 'target-changed',
      guidance: 'The target changed. Read the affected document again from cursor 0 and use the newly returned version before requesting a new write.' }
    const failed = { kind: 'mutation', operationId: '650e8400-e29b-41d4-a716-446655440000',
      state: 'failed', paths: ['notes/a.md'], ...recovery }
    const unavailable = { kind: 'unavailable', ...recovery }
    expect(parseWorkspaceToolResult('edit_workspace_document', failed)).toEqual(failed)
    expect(parseWorkspaceToolResult('edit_workspace_document', unavailable)).toEqual(unavailable)
    expect(parseWorkspaceToolResult('edit_workspace_document', { ...failed, state: 'unknown' })).toBeUndefined()
    expect(parseWorkspaceToolResult('edit_workspace_document', { ...failed, state: 'succeeded' })).toBeUndefined()
    expect(parseWorkspaceToolResult('read_workspace_document', unavailable)).toBeUndefined()
    expect(parseWorkspaceToolResult('edit_workspace_document', { ...unavailable, reason: 'other' })).toBeUndefined()
    expect(parseWorkspaceToolResult('edit_workspace_document', { ...failed, guidance: 'C:\\private\\secret.md' })).toBeUndefined()
    expect(parseWorkspaceToolResult('edit_workspace_document', { kind: 'unavailable', reason: 'target-changed' })).toBeUndefined()
  })

  it('deep-copies and freezes mutation results and path-bearing events at the shared boundary', () => {
    const mutationPaths = ['notes/a.md']
    const mutation = parseWorkspaceToolResult('edit_workspace_document', {
      kind: 'mutation', operationId: '650e8400-e29b-41d4-a716-446655440000',
      state: 'succeeded', paths: mutationPaths,
    })!
    if (mutation.kind !== 'mutation') throw new Error('expected mutation')
    mutationPaths[0] = 'notes/changed.md'
    expect(mutation.paths).toEqual(['notes/a.md'])
    expect(Object.isFrozen(mutation)).toBe(true)
    expect(Object.isFrozen(mutation.paths)).toBe(true)

    const cases = [
      {
        raw: {
          requestId: REQUEST_ID, type: 'authorization-requested' as const, toolCallId: 'call_1',
          toolName: 'edit_workspace_document' as const,
          operationId: '650e8400-e29b-41d4-a716-446655440001', scope: 'action' as const,
          paths: ['notes/a.md'],
        },
        key: 'paths' as const,
      },
      {
        raw: {
          requestId: REQUEST_ID, type: 'operation-status' as const,
          toolName: 'edit_workspace_document' as const,
          operationId: '650e8400-e29b-41d4-a716-446655440002', status: 'unknown' as const,
          paths: ['notes/a.md'],
        },
        key: 'paths' as const,
      },
      {
        raw: {
          requestId: REQUEST_ID, type: 'audit' as const, action: 'edited' as const,
          absolutePaths: ['C:\\workspace\\notes\\a.md'],
        },
        key: 'absolutePaths' as const,
      },
    ]
    for (const item of cases) {
      const parsed = parseAiConversationEvent(item.raw)!
      const source = (item.raw as unknown as Record<string, string[]>)[item.key]!
      source[0] = 'mutated'
      const parsedPaths = (parsed as unknown as Record<string, string[]>)[item.key]!
      expect(parsedPaths[0]).not.toBe('mutated')
      expect(Object.isFrozen(parsed)).toBe(true)
      expect(Object.isFrozen(parsedPaths)).toBe(true)
    }
  })

  it('bounds manifests and binds structural actions to their exact paths and versions', () => {
    expect(parseAiOperationManifest({
      operationId: '550e8400-e29b-41d4-a716-446655440003',
      idempotencyKey: 'operation.1',
      nonce: 'nonce.1',
      workspaceGeneration: 'generation.1',
      toolName: 'rename_workspace_document',
      relativePaths: ['notes/a.md', 'notes/b.md'],
      expectedVersions: [VERSION],
    })).toMatchObject({ toolName: 'rename_workspace_document' })
    expect(parseAiOperationManifest({
      operationId: '550e8400-e29b-41d4-a716-446655440003',
      idempotencyKey: 'operation.1',
      nonce: 'nonce.1',
      workspaceGeneration: 'generation.1',
      toolName: 'create_workspace_document',
      relativePaths: ['notes/a.md', 'notes/b.md'],
      expectedVersions: [VERSION],
    })).toBeUndefined()
  })

  it('keeps page and tool call limits bounded', () => {
    expect(AI_DOCUMENT_PAGE_MAX_CHARS).toBe(48_000)
    expect(AI_DOCUMENT_TOOL_CALL_LIMIT).toBe(8)
  })
})

const currentDocumentResult: AiWorkspaceToolContractMap['read_current_document']['result'] = {
  kind: 'unavailable',
}
void currentDocumentResult

const renameMutationResult: AiWorkspaceToolContractMap['rename_workspace_document']['result'] = {
  kind: 'mutation',
  operationId: '550e8400-e29b-41d4-a716-446655440003',
  state: 'planned',
  paths: ['notes/a.md', 'notes/b.md'],
}
void renameMutationResult

const invalidEditMutationResult: AiWorkspaceToolContractMap['edit_workspace_document']['result'] = {
  kind: 'mutation', operationId: '550e8400-e29b-41d4-a716-446655440003', state: 'planned',
  // @ts-expect-error edit results have exactly one path at the type boundary
  paths: ['notes/a.md', 'notes/b.md'],
}
void invalidEditMutationResult

expectTypeOf<Exclude<AiWorkspaceToolContractMap['read_workspace_document']['result'], AiBudgetNotExecuted>>().toEqualTypeOf<
  { kind: 'document'; path: string; displayName: string; sourceFormat: string; cursor: number; content: string; nextCursor: number | null; hasMore: boolean; totalChars: number; version: AiFileVersion }
  | { kind: 'denied'; guidance?: '请开启“AI 可查看文档”。' | '请开启“AI 可查看工作区”。' | '创建、重命名或删除文档需要选择“每次询问”或“按工作区许可”。' }
  | { kind: 'unavailable' }
>()
expectTypeOf<Extract<AiWorkspaceToolContractMap['read_workspace_document']['result'], AiBudgetNotExecuted>>().toEqualTypeOf<AiBudgetNotExecuted>()
expectTypeOf<Extract<AiCurrentDocumentToolResult, AiBudgetNotExecuted>>().toEqualTypeOf<never>()


describe('thinking event wire boundary', () => {
  const event = { requestId: '550e8400-e29b-41d4-a716-446655440001', type: 'thinking', messageId: '550e8400-e29b-41d4-a716-446655440002', active: true, elapsedMs: 1234 }
  it('accepts time metadata only', () => {
    expect(parseAiConversationEvent(event)).toEqual(event)
    expect(parseAiConversationEvent({ ...event, text: 'PRIVATE_THINKING' })).toBeUndefined()
    expect(parseAiConversationEvent({ ...event, active: 'true' })).toBeUndefined()
  })
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid elapsed milliseconds %s', elapsedMs => {
    expect(parseAiConversationEvent({ ...event, elapsedMs })).toBeUndefined()
  })
})

it('accepts fixed safe recycle guidance only on an exact failed delete result', () => {
  const failed = { kind: 'mutation', operationId: '650e8400-e29b-41d4-a716-446655440001', state: 'failed', paths: ['notes/a.md'], reason: 'recycle-unavailable', guidance: '当前版本的 AI 暂不支持安全移入回收站，本次删除未执行，文件保留在原位置。请在资源管理器中手动移入回收站。' }
  expect(parseWorkspaceToolResult('delete_workspace_document', failed)).toEqual(failed)
  for (const toolName of ['edit_workspace_document', 'create_workspace_document', 'rename_workspace_document', 'read_workspace_document'] as const) {
    expect(parseWorkspaceToolResult(toolName, failed)).toBeUndefined()
  }
  for (const state of ['succeeded', 'unknown', 'executing']) expect(parseWorkspaceToolResult('delete_workspace_document', { ...failed, state })).toBeUndefined()
  expect(parseWorkspaceToolResult('delete_workspace_document', { ...failed, guidance: 'raw private error' })).toBeUndefined()
  expect(parseWorkspaceToolResult('delete_workspace_document', { ...failed, reason: 'unsupported' })).toBeUndefined()
  expect(parseWorkspaceToolResult('delete_workspace_document', { ...failed, extra: true })).toBeUndefined()
  const { guidance, ...missingGuidance } = failed
  expect(parseWorkspaceToolResult('delete_workspace_document', missingGuidance)).toBeUndefined()
  expect(parseWorkspaceToolResult('delete_workspace_document', { kind: 'unavailable', reason: failed.reason, guidance })).toBeUndefined()
})
