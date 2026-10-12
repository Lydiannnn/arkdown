import { describe, expect, it } from 'vitest'
import type { AiWorkspaceToolName } from '../../src/shared/ai-conversation'
import {
  admitAiToolBatch, beginAiToolRound, claimAiFinalization, createAiToolBudget,
  finishAiToolBudget, type AiToolBudget,
} from '../../src/main/models/ai-tool-budget'

const read = (count: number) => Array.from({ length: count }, () => ({ name: 'read_workspace_document' as const, replay: false }))
const write = (count: number) => Array.from({ length: count }, () => ({ name: 'edit_workspace_document' as const, replay: false }))
const replay = { name: 'edit_workspace_document' as const, replay: true }

describe('one user-request tool budget', () => {
  it.each([8, 9, 64, 65, 191, 192, 255, 256])('admits %i new reads independently of the write budget', count => {
    const result = admitAiToolBatch(createAiToolBudget(), read(count))
    expect(result.admitted).toBe(true)
    expect(result.budget.readUsed).toBe(count)
    expect(result.budget.writeUsed).toBe(0)
    expect(result.budget.phase).toBe('tools')
    expect(result.softNotice).toBe(count >= 192)
  })
  it.each(['reads-first', 'writes-first'] as const)('permits all 256 reads and 16 writes within independent rounds: %s', order => {
    let budget = createAiToolBudget()
    const batches = order === 'reads-first' ? [read(256), write(16)] : [write(16), read(256)]
    for (let index = 0; index < batches.length; index += 1) {
      const round = beginAiToolRound(budget)
      expect(round.started).toBe(true)
      const result = admitAiToolBatch(round.budget, batches[index]!)
      expect(result.admitted).toBe(true)
      budget = result.budget
      expect(budget.phase).toBe(index === 1 ? 'finalizing' : 'tools')
    }
    expect(budget).toMatchObject({ readUsed: 256, writeUsed: 16, toolRounds: 2, stopReason: 'budgets-exhausted' })
  })
  it('rejects the entire mixed batch if even one category would exceed its limit', () => {
    const before = admitAiToolBatch(createAiToolBudget(), [...read(255), ...write(15)]).budget
    const result = admitAiToolBatch(before, [...read(1), ...write(2), replay])
    expect(result.admitted).toBe(false)
    expect(result.budget).toMatchObject({ readUsed: 255, writeUsed: 15, rejectedNewCalls: 3, phase: 'finalizing', stopReason: 'write-budget' })
    expect(result.requested).toEqual({ read: 1, write: 2 })
    expect(before).toMatchObject({ readUsed: 255, writeUsed: 15, rejectedNewCalls: 0, phase: 'tools' })
  })
  it.each([
    [read(257), 'read-budget'], [write(17), 'write-budget'], [[...read(257), ...write(17)], 'combined-budget'],
  ] as const)('does not reserve rejected new operations', (calls, stopReason) => {
    expect(admitAiToolBatch(createAiToolBudget(), calls)).toMatchObject({ admitted: false, budget: { readUsed: 0, writeUsed: 0, stopReason }, softNotice: false })
  })
  it.each(['read', 'write'] as const)('rejects the next %s after its exact limit without charging a cached historical write', category => {
    const batch = category === 'read' ? read : write
    const before = admitAiToolBatch(createAiToolBudget(), batch(category === 'read' ? 256 : 16)).budget
    const next = admitAiToolBatch(before, [...batch(1), replay])
    expect(next.admitted).toBe(false)
    expect(next.budget).toMatchObject({ readUsed: category === 'read' ? 256 : 0,
      writeUsed: category === 'write' ? 16 : 0, rejectedNewCalls: 1,
      stopReason: category === 'read' ? 'read-budget' : 'write-budget' })
  })
  it('emits the soft notice once when crossing 192 and keeps admitted counts independent of outcome', () => {
    const first = admitAiToolBatch(createAiToolBudget(), read(191))
    const second = admitAiToolBatch(first.budget, read(1))
    expect(second.softNotice).toBe(true)
    const third = admitAiToolBatch(second.budget, [...read(1), replay])
    expect(third.softNotice).toBe(false)
    expect(third.budget.readUsed).toBe(193)
    expect(third.budget.writeUsed).toBe(0)
  })
  it('bounds cached-only rounds without executing or charging the historical write again', () => {
    let budget = createAiToolBudget()
    for (let i = 0; i < 80; i += 1) {
      const round = beginAiToolRound(budget)
      expect(round.started).toBe(true)
      budget = admitAiToolBatch(round.budget, [replay]).budget
    }
    expect(budget).toMatchObject({ toolRounds: 80, readUsed: 0, writeUsed: 0, phase: 'finalizing', stopReason: 'tool-rounds' })
    expect(beginAiToolRound(budget)).toEqual({ started: false, budget })
  })
  it('claims at most one finalization attempt and cannot reopen a terminal budget', () => {
    const paused = admitAiToolBatch(createAiToolBudget(), read(257)).budget
    expect(claimAiFinalization(createAiToolBudget()).started).toBe(false)
    const final = claimAiFinalization(paused)
    expect(final.started).toBe(true)
    expect(claimAiFinalization(final.budget).started).toBe(false)
    const done = finishAiToolBudget(final.budget)
    expect(beginAiToolRound(done).started).toBe(false)
    expect(claimAiFinalization(done).started).toBe(false)
    expect(admitAiToolBatch(done, read(1))).toMatchObject({ admitted: false, budget: done })
    expect(createAiToolBudget()).toMatchObject({ readUsed: 0, writeUsed: 0, toolRounds: 0, finalizationAttempted: false })
  })
  it('classifies all supported tools exhaustively, never defaulting an unknown name to a read', () => {
    const reads: AiWorkspaceToolName[] = ['read_current_document', 'list_workspace_entries', 'read_workspace_document']
    const writes: AiWorkspaceToolName[] = ['edit_workspace_document', 'create_workspace_document', 'rename_workspace_document', 'delete_workspace_document']
    const result = admitAiToolBatch(createAiToolBudget(), [...reads, ...writes].map(name => ({ name, replay: false })))
    expect(result.budget).toMatchObject({ readUsed: 3, writeUsed: 4 })
    expect(() => admitAiToolBatch(createAiToolBudget(), [{ name: 'unknown' as AiWorkspaceToolName, replay: false }])).toThrow()
  })
  it('does not mutate retained previous snapshots or caller arrays', () => {
    const before: AiToolBudget = createAiToolBudget()
    const calls = Object.freeze(read(2).map(call => Object.freeze(call)))
    expect(admitAiToolBatch(before, calls).budget.readUsed).toBe(2)
    expect(before.readUsed).toBe(0)
    expect(Object.isFrozen(before)).toBe(true)
  })
})
