import { describe, expect, it, vi } from 'vitest'
import type { ModelUsage } from '../../src/shared/ai-conversation'
import type { ModelCapabilityProfile } from '../../src/shared/model-capability-profiles'
import type { ModelChatMessage } from '../../src/main/models/model-protocol-client'
import { budgetCounts, budgetLocalClosure, budgetOutcomes } from '../../src/main/models/ai-conversation-segment'
import { admitAiToolBatch, beginAiToolRound, createAiToolBudget } from '../../src/main/models/ai-tool-budget'
import {
  createAiWireLineage,
  type AiContextUsageBaseline,
  type AiWireLineage,
} from '../../src/main/models/ai-context-budget'
import {
  compactWireContext,
  parseAiCompactionCheckpoint,
  segmentCompleteTransactions,
  wireContextMessages,
  type AiCompactionCheckpointV1,
  type AiCompactionSummaryRequest,
  type AiWireContext,
  type AiWireTransaction,
} from '../../src/main/models/ai-context-compactor'

const OPERATION_ID = '550e8400-e29b-41d4-a716-446655440001'
const LINEAGE = createAiWireLineage()

function profile(): ModelCapabilityProfile {
  return {
    contextWindowTokens: 1_500,
    maxInputTokens: 1_000,
    maxOutputTokens: 500,
    supportedReasoningEfforts: ['default', 'low'],
    defaultReasoningEffort: 'default',
    reasoningEncoding: 'none',
  }
}

function checkpoint(overrides: Partial<AiCompactionCheckpointV1> = {}): AiCompactionCheckpointV1 {
  return {
    version: 1,
    userGoals: ['Keep the workspace organized.'],
    decisions: [],
    workspaceFacts: [],
    unresolvedQuestions: [],
    nextSteps: [],
    retainedToolFacts: [],
    completedOperationIds: [],
    ...overrides,
  }
}

function messageCost(messages: readonly ModelChatMessage[]): number {
  return messages.reduce((total, message) => {
    const cost = /^cost:([0-9]+)/.exec(message.content)
    if (cost !== null) return total + Number(cost[1])
    if (message.content.startsWith('ARKDOWN_CONTEXT_CHECKPOINT_V1\n')) {
      return total + 70
    }
    return total
  }, 0)
}

function transaction(cost: number): AiWireTransaction {
  return {
    messages: [
      { role: 'user', content: `cost:${cost}` },
      { role: 'assistant', content: 'cost:0' },
    ],
    completedOperationIds: [],
  }
}

function context(costs: readonly number[]): AiWireContext {
  return {
    lineage: LINEAGE,
    checkpoint: null,
    transactions: costs.map(transaction),
    openTransaction: [],
  }
}

function options(
  wireContext: AiWireContext,
  summarize: (request: AiCompactionSummaryRequest) => Promise<string> = vi.fn(
    async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()),
  ),
  usageBaseline: AiContextUsageBaseline | null = null,
) {
  return {
    context: wireContext,
    profile: profile(),
    capabilities: { currentDocument: false, workspace: false },
    usageBaseline,
    fixedInputTokens: 0,
    requestedOutputTokens: 100,
    normalToolReserveTokens: 0,
    summaryRequestedOutputTokens: 500,
    summaryToolReserveTokens: 0,
    estimateMessageTokens: messageCost,
    summarize,
  }
}

const SECOND_OPERATION_ID = '550e8400-e29b-41d4-a716-446655440002'

function mutationTransaction(
  completedOperationIds: readonly string[],
): AiWireTransaction {
  return {
    messages: [
      { role: 'user', content: 'cost:500' },
      {
        role: 'assistant',
        content: 'cost:0',
        toolCalls: [
          { id: 'call_1', name: 'edit_workspace_document', argumentsJson: '{"path":"notes/a.md","content":"a","expectedVersion":{"fileId":"file-1","revision":"rev-1","size":1,"mtimeMs":1}}' },
          { id: 'call_2', name: 'create_workspace_document', argumentsJson: '{"path":"notes/b.md","content":"b"}' },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'edit_workspace_document',
        content: JSON.stringify({
          kind: 'mutation', operationId: OPERATION_ID,
          state: 'succeeded', paths: ['notes/a.md'],
        }),
      },
      {
        role: 'tool',
        toolCallId: 'call_2',
        name: 'create_workspace_document',
        content: JSON.stringify({
          kind: 'mutation', operationId: SECOND_OPERATION_ID,
          state: 'unknown', paths: ['notes/b.md'],
        }),
      },
      { role: 'assistant', content: 'cost:0' },
    ],
    completedOperationIds,
  }
}

function singleMutationResultTransaction(
  result: Record<string, unknown>,
): AiWireTransaction {
  return {
    messages: [
      { role: 'user', content: 'cost:500' },
      {
        role: 'assistant',
        content: 'cost:0',
        toolCalls: [{
          id: 'call_mutation',
          name: 'edit_workspace_document',
          argumentsJson: '{"path":"notes/a.md","content":"a","expectedVersion":{"fileId":"file-1","revision":"rev-1","size":1,"mtimeMs":1}}',
        }],
      },
      {
        role: 'tool',
        toolCallId: 'call_mutation',
        name: 'edit_workspace_document',
        content: JSON.stringify(result),
      },
      { role: 'assistant', content: 'cost:0' },
    ],
    completedOperationIds: [],
  }
}

describe('AI context transaction segmentation', () => {
  it('keeps paired budget rejection and genuine replay in one locally closed transaction without inventing a signature', () => {
    const budget = admitAiToolBatch(beginAiToolRound(createAiToolBudget()).budget,
      Array.from({ length: 65 }, () => ({ name: 'read_workspace_document' as const, replay: false }))).budget
    const closure = budgetLocalClosure('read-budget', budgetCounts(budget), budgetOutcomes(budget, new Set(), []))
    const replay = { protocol: 'anthropic' as const, blocks: [{ type: 'thinking' as const, thinking: 'provider-private', signature: 'genuine-signature' }] }
    const messages: ModelChatMessage[] = [
      { role: 'user', content: 'Read the source' },
      { role: 'assistant', content: '', providerReplay: replay,
        toolCalls: [{ id: 'call_1', name: 'read_workspace_document', argumentsJson: '{}' }] },
      { role: 'tool', name: 'read_workspace_document', toolCallId: 'call_1', content: JSON.stringify({ kind: 'not-executed', reason: 'read-budget' }) },
    ]
    expect(segmentCompleteTransactions(messages).openTransaction).toEqual(messages)
    const closed = segmentCompleteTransactions([...messages, closure])
    expect(closed.openTransaction).toEqual([])
    expect(closed.transactions).toHaveLength(1)
    expect(closed.transactions[0]!.messages[1]).toMatchObject({ providerReplay: replay })
    expect(closed.transactions[0]!.completedOperationIds).toEqual([])
    expect(closure).not.toHaveProperty('providerReplay')
    expect(closure).not.toHaveProperty('reasoningContent')
    expect(closure.content).toContain('"source":"arkdown-local"')
  })
  it('keeps a complete tool-call/result/final exchange indivisible and leaves a pending call open', () => {
    const messages: ModelChatMessage[] = [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'private reasoning',
        toolCalls: [{
          id: 'call_1',
          name: 'edit_workspace_document',
          argumentsJson: '{"path":"notes/a.md"}',
        }],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'edit_workspace_document',
        content: JSON.stringify({
          kind: 'mutation',
          operationId: OPERATION_ID,
          state: 'succeeded',
          paths: ['notes/a.md'],
        }),
      },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_2', name: 'read_current_document', argumentsJson: '{}' }],
      },
    ]

    const segmented = segmentCompleteTransactions(messages)

    expect(segmented.transactions).toHaveLength(1)
    expect(segmented.transactions[0]).toEqual({
      messages: messages.slice(0, 4),
      completedOperationIds: [OPERATION_ID],
    })
    expect(segmented.openTransaction).toEqual(messages.slice(4))
  })

  it('does not close a tool batch unless every result matches one declared call', () => {
    const messages: ModelChatMessage[] = [
      { role: 'user', content: 'read both' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', name: 'read_current_document', argumentsJson: '{}' },
          { id: 'call_2', name: 'read_workspace_document', argumentsJson: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'read_current_document', content: '{}' },
      { role: 'assistant', content: 'partial result' },
    ]

    expect(segmentCompleteTransactions(messages)).toEqual({
      transactions: [],
      openTransaction: messages,
    })
  })
})

describe('AI context checkpoint compaction', () => {
  it.each(['planned', 'awaitingApproval', 'authorized', 'executing'] as const)(
    'defers a %s mutation result without summarizing or replacing context',
    async (state) => {
      const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
      const pending = singleMutationResultTransaction({
        kind: 'mutation', operationId: OPERATION_ID, state, paths: ['notes/a.md'],
      })
      const segmented = segmentCompleteTransactions(pending.messages)
      const original: AiWireContext = {
        lineage: LINEAGE,
        checkpoint: null,
        transactions: [pending, transaction(300), transaction(100)],
        openTransaction: [],
      }

      expect(segmented.transactions).toEqual([])
      expect(segmented.openTransaction).toEqual(pending.messages)

      const result = await compactWireContext(options(original, summarize))

      expect(result).toMatchObject({ status: 'deferred', context: original })
      expect(result.context).toBe(original)
      expect(summarize).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['failed mutation', {
      kind: 'mutation', operationId: OPERATION_ID, state: 'failed', paths: ['notes/a.md'],
    }],
    ['denied result', { kind: 'denied' }],
    ['unavailable result', { kind: 'unavailable' }],
  ])('compacts a terminal %s without retaining a replay-blocking operation ID', async (_name, terminalResult) => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const terminal = singleMutationResultTransaction(terminalResult as Record<string, unknown>)
    const segmented = segmentCompleteTransactions(terminal.messages)
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [terminal, transaction(300), transaction(100)],
      openTransaction: [],
    }

    expect(segmented.transactions).toHaveLength(1)
    expect(segmented.transactions[0]?.completedOperationIds).toEqual([])

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('compacted')
    expect(result.context.checkpoint?.completedOperationIds).toEqual([])
    expect(summarize).toHaveBeenCalled()
  })

  it('compacts at 85 percent and lands within the 45 to 50 percent target', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))

    const result = await compactWireContext(options(
      context([150, 150, 150, 150, 150, 100]),
      summarize,
    ))

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') throw new Error('expected compaction')
    expect(result.before).toBe(850)
    expect(result.after).toBe(470)
    expect(result.context.transactions).toHaveLength(3)
    expect(result.context.transactions.map((item) => messageCost(item.messages))).toEqual([150, 150, 100])
    expect(result.target).toEqual({
      minimumTokens: 450,
      maximumTokens: 500,
      withinRange: true,
    })
    expect(summarize).toHaveBeenCalled()
    expect(summarize.mock.calls[0]![0]).toMatchObject({
      tools: [],
      requestedOutputTokens: 500,
      thinkingMode: 'disabled' as const, reasoningEffort: 'low',
    })
  })

  it('keeps a 128K workspace turn below the same model-bounded input threshold without summarizing', async () => {
    const original = context([120, 23_400])
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const result = await compactWireContext({
      context: original,
      profile: { ...profile(), contextWindowTokens: 128_000, maxInputTokens: 95_000, maxOutputTokens: 32_768 },
      capabilities: { currentDocument: true, workspace: true },
      usageBaseline: null,
      fixedInputTokens: 0,
      estimateMessageTokens: messageCost,
      summarize,
    })
    expect(result).toMatchObject({ status: 'not-needed', context: original, before: 23_520, after: 23_520 })
    expect(summarize).not.toHaveBeenCalled()
  })

  it('bounds summary headroom and requested output by the same model limits', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const result = await compactWireContext({
      ...options(context([150, 150, 150, 150, 150, 100]), summarize),
      summaryRequestedOutputTokens: 16_384,
      summaryToolReserveTokens: undefined,
    })
    expect(result.status).toBe('compacted')
    expect(summarize).toHaveBeenCalled()
    for (const [request] of summarize.mock.calls) {
      expect(request.requestedOutputTokens).toBe(500)
      expect(messageCost(request.messages)).toBeLessThanOrEqual(300)
    }
  })

  it('uses actual input usage to trigger when the local estimate is below the threshold', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const usage: ModelUsage = {
      inputTokens: 900,
      outputTokens: 10,
      totalTokens: 910,
      cachedInputTokens: 500,
      estimated: false,
    }

    const usageBaseline: AiContextUsageBaseline = {
      usage,
      wireLineage: LINEAGE,
      estimatedNextRequestTokensAtRequest: 700,
    }
    const result = await compactWireContext(options(
      context([200, 200, 200, 100]),
      summarize,
      usageBaseline,
    ))

    expect(result.status).toBe('compacted')
    expect(result.before).toBe(900)
    expect(summarize).toHaveBeenCalled()
  })

  it('accounts for fixed next-request input before and after compaction and renews lineage', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const original = context([150, 150, 150, 150, 150])

    const result = await compactWireContext({
      ...options(original, summarize),
      fixedInputTokens: 100,
    })

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') throw new Error('expected compaction')
    expect(result.before).toBe(850)
    expect(result.after).toBe(470)
    expect(result.context.lineage).not.toBe(original.lineage)
  })

  it('includes fixed input overhead when stale usage falls back to estimation', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const original = context([200, 200, 200])
    const staleLineage = createAiWireLineage()

    const result = await compactWireContext({
      ...options(original, summarize, {
        usage: {
          inputTokens: 999,
          outputTokens: 1,
          totalTokens: 1_000,
          cachedInputTokens: null,
          estimated: false,
        },
        wireLineage: staleLineage,
        estimatedNextRequestTokensAtRequest: 500,
      }),
      fixedInputTokens: 75,
    })

    expect(result).toMatchObject({ status: 'not-needed', before: 675 })
  })

  it('ignores stale usage and includes assistant/tool growth after a matching usage baseline', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const usage: ModelUsage = {
      inputTokens: 800,
      outputTokens: 10,
      totalTokens: 810,
      cachedInputTokens: null,
      estimated: false,
    }
    const wireContext = context([200, 200, 200, 100])
    const matching = await compactWireContext({
      ...options(wireContext, summarize, {
        usage,
        wireLineage: LINEAGE,
        estimatedNextRequestTokensAtRequest: 600,
      }),
    })
    const stale = await compactWireContext({
      ...options(wireContext, summarize, {
        usage: { ...usage, inputTokens: 990, totalTokens: 1_000 },
        wireLineage: createAiWireLineage(),
        estimatedNextRequestTokensAtRequest: 600,
      }),
    })

    expect(matching).toMatchObject({ status: 'compacted', before: 900 })
    expect(stale).toMatchObject({ status: 'not-needed', before: 700 })
  })

  it.each([
    ['missing', []],
    ['forged', ['550e8400-e29b-41d4-a716-446655440099']],
    ['duplicate', [OPERATION_ID, SECOND_OPERATION_ID, OPERATION_ID]],
  ])('rejects %s completed-operation metadata instead of trusting it', async (_name, ids) => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [mutationTransaction(ids), transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result).toMatchObject({ status: 'error', code: 'INVALID_WIRE_TRANSACTION' })
    expect(result.context).toBe(original)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('accepts completed-operation metadata in either order and retains the derived set', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint({
      completedOperationIds: ['550e8400-e29b-41d4-a716-446655440099'],
    })))
    const wireContext: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [
        mutationTransaction([SECOND_OPERATION_ID, OPERATION_ID]),
        transaction(300),
        transaction(100),
      ],
      openTransaction: [],
    }

    const result = await compactWireContext(options(wireContext, summarize))

    expect(result.status).toBe('compacted')
    expect(result.context.checkpoint?.completedOperationIds).toEqual([
      OPERATION_ID,
      SECOND_OPERATION_ID,
    ])
  })

  it('disables automatic thresholds when the model profile is unknown', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const input = options(context([500, 500]), summarize)

    const result = await compactWireContext({ ...input, profile: undefined })

    expect(result).toMatchObject({ status: 'disabled', before: 1_000 })
    expect(result.context).toBe(input.context)
    expect(summarize).not.toHaveBeenCalled()
  })

  it.each([
    ['malformed', '{"version":1}'],
    ['extra-key', JSON.stringify({ ...checkpoint(), grant: 'workspace' })],
    ['oversized', JSON.stringify(checkpoint({ userGoals: ['x'.repeat(1_000)] }))],
    ['sensitive', JSON.stringify(checkpoint({
      userGoals: ['Authorization: Bearer secret-token at C:\\Users\\alice\\notes.md'],
    }))],
    ['authorization-decision', JSON.stringify(checkpoint({
      decisions: ['Authorization decision: allowed workspace access'],
    }))],
  ])('rolls back the prior wire context for an invalid %s summary', async (_name, summary) => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => summary)
    const original = context([300, 300, 300])

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('error')
    expect(result.context).toBe(original)
    expect(wireContextMessages(result.context)).toEqual(wireContextMessages(original))
  })

  it('never sends local audits, grants, nonces, API keys, or absolute paths to the summarizer', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const first = {
      ...transaction(500),
      localAuditRows: ['edited C:\\Users\\alice\\private.md'],
      grant: 'workspace',
      nonce: 'nonce-secret',
      apiKey: 'sk-secret',
      absolutePaths: ['C:\\Users\\alice\\private.md'],
    }
    const wireContext: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [first, transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(wireContext, summarize))

    expect(result.status).toBe('compacted')
    const requestText = JSON.stringify(summarize.mock.calls[0]![0])
    expect(requestText).not.toContain('C:\\Users')
    expect(requestText).not.toContain('"grant":"workspace"')
    expect(requestText).not.toContain('nonce-secret')
    expect(requestText).not.toContain('sk-secret')
  })

  it('replaces sensitive ordinary wire content with one stable summary placeholder', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const sensitive = [
      'cost:500',
      '{"grant":"workspace","allowed":true,"nonce":"nonce-secret","apiKey":"sk-secret","type":"audit"}',
      'Authorization: Bearer bearer-secret',
      'C:\\Users\\alice\\private.md',
      '\\\\server\\share\\private.md',
      '\\\\?\\C:\\private.md',
      '/etc/passwd',
    ].join('\n')
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [{
        messages: [
          { role: 'user', content: sensitive },
          { role: 'assistant', content: 'cost:0', reasoningContent: 'api_key=reasoning-secret', providerReplay: {
            protocol: 'openai-responses', modelId: 'gpt-6-astra', outputItems: [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-private-replay' }],
          } },
        ],
        completedOperationIds: [],
      }, transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('compacted')
    const requestText = JSON.stringify(summarize.mock.calls[0]![0])
    expect(requestText).toContain('[REDACTED_SENSITIVE_CONTENT]')
    for (const secret of [
      'nonce-secret', 'sk-secret', 'bearer-secret', 'reasoning-secret', 'encrypted-private-replay', 'providerReplay',
      'C:\\\\Users', 'server\\\\share', '?\\\\C:', '/etc/passwd',
    ]) expect(requestText).not.toContain(secret)
  })

  it('whitelists exact workspace tool results and redacts sensitive document content', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const sensitiveContent = 'Authorization: Bearer tool-secret at C:\\private.md'
    const toolTransaction: AiWireTransaction = {
      messages: [
        { role: 'user', content: 'cost:500' },
        {
          role: 'assistant',
          content: 'cost:0',
          toolCalls: [{
            id: 'call_read',
            name: 'read_workspace_document',
            argumentsJson: '{"path":"notes/a.md","cursor":0,"maxChars":48000}',
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call_read',
          name: 'read_workspace_document',
          content: JSON.stringify({
            kind: 'document', path: 'notes/a.md', displayName: 'a.md', sourceFormat: 'markdown',
            cursor: 0, content: sensitiveContent,
            nextCursor: null, hasMore: false, totalChars: sensitiveContent.length,
            version: { fileId: 'file-1', revision: 'rev-1', size: sensitiveContent.length, mtimeMs: 1 },
          }),
        },
        { role: 'assistant', content: 'cost:0' },
      ],
      completedOperationIds: [],
    }
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [toolTransaction, transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('compacted')
    const requestText = JSON.stringify(summarize.mock.calls[0]![0])
    expect(requestText).toContain('notes/a.md')
    expect(requestText).toContain('[REDACTED_SENSITIVE_CONTENT]')
    expect(requestText).not.toContain('tool-secret')
    expect(requestText).not.toContain('C:\\\\private.md')
  })

  it('preserves canonical path fields even when their segments resemble authorization metadata', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const toolTransaction: AiWireTransaction = {
      messages: [
        { role: 'user', content: 'cost:500' },
        {
          role: 'assistant',
          content: 'cost:0',
          toolCalls: [{
            id: 'call_read',
            name: 'read_workspace_document',
            argumentsJson: JSON.stringify({
              path: 'authorization/allowed.md', cursor: 0, maxChars: 48_000,
            }),
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call_read',
          name: 'read_workspace_document',
          content: JSON.stringify({
            kind: 'document', path: 'notes/grant=approved.md', displayName: 'approved.md',
            sourceFormat: 'markdown', cursor: 0, content: 'safe content', nextCursor: null,
            hasMore: false, totalChars: 12,
            version: { fileId: 'file-1', revision: 'rev-1', size: 12, mtimeMs: 1 },
          }),
        },
        { role: 'assistant', content: 'cost:0' },
      ],
      completedOperationIds: [],
    }
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [toolTransaction, transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('compacted')
    const requestText = JSON.stringify(summarize.mock.calls[0]![0])
    expect(requestText).toContain('authorization/allowed.md')
    expect(requestText).toContain('notes/grant=approved.md')
  })

  it('removes structured authorization outcomes while keeping tool results contract-valid', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const deniedTransaction: AiWireTransaction = {
      messages: [
        { role: 'user', content: 'cost:500' },
        {
          role: 'assistant', content: 'cost:0',
          toolCalls: [{
            id: 'call_denied', name: 'read_workspace_document',
            argumentsJson: '{"path":"notes/a.md","cursor":0,"maxChars":48000}',
          }],
        },
        {
          role: 'tool', toolCallId: 'call_denied', name: 'read_workspace_document',
          content: '{"kind":"denied"}',
        },
        { role: 'assistant', content: 'cost:0' },
      ],
      completedOperationIds: [],
    }
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [deniedTransaction, transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('compacted')
    const toolMessage = summarize.mock.calls[0]![0].messages.find(
      (message) => message.role === 'tool',
    )
    expect(toolMessage?.content).not.toContain('denied')
    expect(toolMessage?.content).toContain('unavailable')
  })

  it.each([
    ['Windows assignment', 'source=C:\\private.md'],
    ['POSIX assignment', 'path=/etc/passwd'],
    ['quoted Windows', 'source="C:\\private.md"'],
    ['bracketed POSIX', 'path=(/etc/passwd)'],
  ])('redacts absolute paths at %s boundaries in ordinary text', async (_name, sensitive) => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [{
        messages: [
          { role: 'user', content: `cost:500 ${sensitive}` },
          { role: 'assistant', content: 'cost:0' },
        ],
        completedOperationIds: [],
      }, transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('compacted')
    const requestText = JSON.stringify(summarize.mock.calls[0]![0])
    expect(requestText).toContain('[REDACTED_SENSITIVE_CONTENT]')
    expect(requestText).not.toContain(sensitive.replaceAll('\\', '\\\\'))
  })

  it('fails closed before summarization for a tool result outside the exact contract', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const invalid: AiWireTransaction = {
      messages: [
        { role: 'user', content: 'cost:500' },
        {
          role: 'assistant', content: 'cost:0',
          toolCalls: [{ id: 'call_read', name: 'read_current_document', argumentsJson: '{"cursor":0,"maxChars":48000}' }],
        },
        {
          role: 'tool', toolCallId: 'call_read', name: 'read_current_document',
          content: '{"kind":"unavailable","absolutePath":"C:\\\\private.md"}',
        },
        { role: 'assistant', content: 'cost:0' },
      ],
      completedOperationIds: [],
    }
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [invalid, transaction(300), transaction(100)],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result).toMatchObject({ status: 'error', code: 'INVALID_WIRE_TRANSACTION' })
    expect(result.context).toBe(original)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('rolls back instead of dropping completed operation IDs beyond the checkpoint bound', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const operationIds = Array.from({ length: 65 }, (_, index) => (
      `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`
    ))
    const original: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [
        { ...transaction(500), completedOperationIds: operationIds },
        transaction(300),
        transaction(100),
      ],
      openTransaction: [],
    }

    const result = await compactWireContext(options(original, summarize))

    expect(result.status).toBe('error')
    expect(result.context).toBe(original)
  })

  it('hierarchically summarizes closed prefixes without sending an over-limit raw batch', async () => {
    const requests: Array<{ messages: readonly ModelChatMessage[] }> = []
    const summarize = vi.fn(async (request: AiCompactionSummaryRequest) => {
      requests.push(request)
      return JSON.stringify(checkpoint())
    })

    const result = await compactWireContext(options(
      context([400, 400, 400, 400]),
      summarize,
    ))

    expect(result.status).toBe('compacted')
    expect(summarize.mock.calls.length).toBeGreaterThan(1)
    expect(requests.every((request) => messageCost(request.messages) <= 600)).toBe(true)
    expect(result.after).toBe(470)
  })

  it('subtracts the fixed summary instructions from every hierarchical batch limit', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const estimateWithEnvelope = (messages: readonly ModelChatMessage[]) => (
      messageCost(messages)
      + messages.filter((message) => (
        message.content.startsWith('将对话整理为上下文摘要')
        || message.content.startsWith('仅返回 JSON，字段为')
      )).length * 10
    )
    const input = options(context([300, 300, 300, 300]), summarize)

    const result = await compactWireContext({
      ...input,
      estimateMessageTokens: estimateWithEnvelope,
    })

    expect(result.status).toBe('compacted')
    expect(summarize.mock.calls.every(([request]) => (
      estimateWithEnvelope(request.messages) <= 600
    ))).toBe(true)
  })

  it('searches a less aggressive closed-prefix cut before accepting a below-target result', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const cheapCheckpoint = (messages: readonly ModelChatMessage[]) => messages.reduce(
      (total, message) => total + (
        message.content.startsWith('ARKDOWN_CONTEXT_CHECKPOINT_V1\n')
          ? 20
          : (/^cost:([0-9]+)/.exec(message.content)?.[1]
              ? Number(/^cost:([0-9]+)/.exec(message.content)![1])
              : 0)
      ),
      0,
    )
    const input = options(context([390, 40, 300, 120]), summarize)

    const result = await compactWireContext({ ...input, estimateMessageTokens: cheapCheckpoint })

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') throw new Error('expected compaction')
    expect(result.after).toBe(480)
    expect(result.context.transactions.map((item) => cheapCheckpoint(item.messages)))
      .toEqual([40, 300, 120])
    expect(result.target).toEqual({
      minimumTokens: 450,
      maximumTokens: 500,
      withinRange: true,
    })
  })

  it('checks every atomic cut before choosing a target candidate with non-monotonic summaries', async () => {
    const summarizedRawCosts: number[] = []
    const summarize = vi.fn(async (request: AiCompactionSummaryRequest) => {
      const rawCost = messageCost(request.messages)
      summarizedRawCosts.push(rawCost)
      return JSON.stringify(checkpoint({ userGoals: [`cut-${rawCost}`] }))
    })
    const nonMonotonicEstimate = (messages: readonly ModelChatMessage[]) => messages.reduce(
      (total, message) => {
        const cost = /^cost:([0-9]+)/.exec(message.content)
        if (cost !== null) return total + Number(cost[1])
        if (!message.content.startsWith('ARKDOWN_CONTEXT_CHECKPOINT_V1\n')) return total
        const parsed = JSON.parse(message.content.slice('ARKDOWN_CONTEXT_CHECKPOINT_V1\n'.length)) as AiCompactionCheckpointV1
        if (parsed.userGoals[0] === 'cut-300') return total + 20
        if (parsed.userGoals[0] === 'cut-400') return total + 30
        if (parsed.userGoals[0] === 'cut-500') return total + 50
        return total + 70
      },
      0,
    )

    const result = await compactWireContext({
      ...options(context([300, 100, 100, 150, 200]), summarize),
      estimateMessageTokens: nonMonotonicEstimate,
    })

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') throw new Error('expected compaction')
    expect(summarizedRawCosts).toEqual(expect.arrayContaining([300, 400, 500]))
    expect(result.after).toBe(480)
    expect(result.context.transactions.map((item) => messageCost(item.messages)))
      .toEqual([100, 150, 200])
    expect(result.target.withinRange).toBe(true)
  })

  it('marks a below-floor result when indivisible transactions make the target band impossible', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))

    const result = await compactWireContext(options(context([600, 100, 200]), summarize))

    expect(result.status).toBe('compacted')
    if (result.status !== 'compacted') throw new Error('expected compaction')
    expect(result.after).toBe(370)
    expect(result.target).toEqual({
      minimumTokens: 450,
      maximumTokens: 500,
      withinRange: false,
    })
  })

  it('defers a pending authorization transaction and errors if that open transaction alone is oversized', async () => {
    const summarize = vi.fn(async (_request: AiCompactionSummaryRequest) => JSON.stringify(checkpoint()))
    const pending: ModelChatMessage[] = [
      { role: 'user', content: 'cost:900' },
      {
        role: 'assistant',
        content: 'cost:0',
        toolCalls: [{ id: 'call_1', name: 'edit_workspace_document', argumentsJson: '{}' }],
      },
    ]
    const deferredContext: AiWireContext = {
      lineage: LINEAGE,
      checkpoint: null,
      transactions: [],
      openTransaction: pending,
    }
    const oversizedContext: AiWireContext = {
      ...deferredContext,
      openTransaction: [{ role: 'user', content: 'cost:1001' }],
    }

    const deferred = await compactWireContext(options(deferredContext, summarize))
    const oversized = await compactWireContext(options(oversizedContext, summarize))

    expect(deferred.status).toBe('deferred')
    expect(deferred.context).toBe(deferredContext)
    expect(oversized).toMatchObject({ status: 'error', code: 'TOOL_RESULT_TOO_LARGE' })
    expect(oversized.context).toBe(oversizedContext)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('strictly parses bounded version-one checkpoints with relative workspace facts', () => {
    expect(parseAiCompactionCheckpoint(checkpoint({
      workspaceFacts: [{ path: 'notes/a.md', version: 'rev-2', fact: 'The title is A.' }],
      completedOperationIds: [OPERATION_ID],
    }))).toEqual(checkpoint({
      workspaceFacts: [{ path: 'notes/a.md', version: 'rev-2', fact: 'The title is A.' }],
      completedOperationIds: [OPERATION_ID],
    }))
    expect(parseAiCompactionCheckpoint(checkpoint({
      workspaceFacts: [{ path: 'C:\\private.md', version: 'rev-2', fact: 'secret' }],
    }))).toBeUndefined()

    const sparseGoals = new Array<string>(2)
    sparseGoals[1] = 'present'
    Object.defineProperty(sparseGoals, 'maskedHole', { value: 'extra', enumerable: true })
    expect(parseAiCompactionCheckpoint({
      ...checkpoint(),
      userGoals: sparseGoals,
    })).toBeUndefined()
  })

  it('short-circuits oversized arrays and contains Proxy/getter failures in the exported parser', () => {
    const oversizedGoals = new Proxy(new Array<string>(65).fill('goal'), {
      ownKeys: () => { throw new Error('ownKeys must not run') },
    })
    expect(parseAiCompactionCheckpoint({
      ...checkpoint(),
      userGoals: oversizedGoals,
    })).toBeUndefined()

    const proxy = new Proxy(checkpoint(), {
      ownKeys: () => { throw new Error('hostile proxy') },
    })
    const getter = { ...checkpoint() }
    Object.defineProperty(getter, 'version', {
      enumerable: true,
      get: () => { throw new Error('hostile getter') },
    })
    expect(() => parseAiCompactionCheckpoint(proxy)).not.toThrow()
    expect(parseAiCompactionCheckpoint(proxy)).toBeUndefined()
    expect(() => parseAiCompactionCheckpoint(getter)).not.toThrow()
    expect(parseAiCompactionCheckpoint(getter)).toBeUndefined()
  })
})
