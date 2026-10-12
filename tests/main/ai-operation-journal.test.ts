import { expect, it, vi } from 'vitest'
import type { AiOperationManifest } from '../../src/shared/ai-conversation'
import {
  AiOperationJournal,
  AiOperationOutcomeUnknownError,
} from '../../src/main/workspace/ai-operation-journal'

function manifest(overrides: Partial<AiOperationManifest> = {}): AiOperationManifest {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    idempotencyKey: 'request-1:tool-1',
    nonce: 'nonce-1',
    workspaceGeneration: 'workspace-generation-1',
    toolName: 'edit_workspace_document',
    relativePaths: ['notes/a.md'],
    expectedVersions: [{ fileId: '7:11', revision: 'a'.repeat(64), size: 3, mtimeMs: 1 }],
    ...overrides,
  }
}

it('permits only the declared operation lifecycle and keeps terminal states terminal', async () => {
  const journal = new AiOperationJournal<string>()
  const planned = journal.plan(manifest())

  expect(planned.state).toBe('planned')
  expect(journal.transition(planned.manifest.operationId, 'awaitingApproval').state).toBe('awaitingApproval')
  expect(journal.authorize(planned.manifest.operationId, 'nonce-1').state).toBe('authorized')
  await expect(journal.execute(planned.manifest.operationId, async () => 'saved'))
    .resolves.toMatchObject({ state: 'succeeded', result: 'saved' })
  expect(() => journal.transition(planned.manifest.operationId, 'failed')).toThrow('Invalid AI operation transition')
})

it('consumes authorization nonces exactly once across the journal', () => {
  const journal = new AiOperationJournal()
  const first = journal.plan(manifest())
  journal.transition(first.manifest.operationId, 'awaitingApproval')
  journal.authorize(first.manifest.operationId, 'nonce-1')

  const second = journal.plan(manifest({
    operationId: '22222222-2222-4222-8222-222222222222',
    idempotencyKey: 'request-2:tool-2',
  }))
  journal.transition(second.manifest.operationId, 'awaitingApproval')

  expect(() => journal.authorize(second.manifest.operationId, 'nonce-1'))
    .toThrow('Authorization nonce has already been consumed')
  expect(() => journal.authorize(first.manifest.operationId, 'nonce-1'))
    .toThrow('Authorization nonce has already been consumed')
})

it('returns the existing terminal entry for a reused idempotency key without executing twice', async () => {
  const journal = new AiOperationJournal<number>()
  const first = journal.plan(manifest())
  journal.transition(first.manifest.operationId, 'awaitingApproval')
  journal.authorize(first.manifest.operationId, 'nonce-1')
  const mutation = vi.fn(async () => 1)
  await journal.execute(first.manifest.operationId, mutation)

  const duplicate = journal.plan(manifest({
    operationId: '22222222-2222-4222-8222-222222222222',
    nonce: 'nonce-2',
  }))
  const replay = await journal.execute(duplicate.manifest.operationId, mutation)

  expect(duplicate.manifest.operationId).toBe(first.manifest.operationId)
  expect(replay).toMatchObject({ state: 'succeeded', result: 1 })
  expect(mutation).toHaveBeenCalledTimes(1)
})

it('marks an ambiguous execution unknown and never replays it', async () => {
  const journal = new AiOperationJournal<number>()
  const planned = journal.plan(manifest())
  journal.transition(planned.manifest.operationId, 'awaitingApproval')
  journal.authorize(planned.manifest.operationId, 'nonce-1')
  const mutation = vi.fn(async () => {
    throw new AiOperationOutcomeUnknownError()
  })

  await expect(journal.execute(planned.manifest.operationId, mutation))
    .rejects.toBeInstanceOf(AiOperationOutcomeUnknownError)
  expect(journal.get(planned.manifest.operationId)?.state).toBe('unknown')
  await expect(journal.execute(planned.manifest.operationId, mutation))
    .resolves.toMatchObject({ state: 'unknown' })
  expect(mutation).toHaveBeenCalledTimes(1)
})

it('allows an approval denial but no other shortcut from awaiting approval', () => {
  const journal = new AiOperationJournal()
  const planned = journal.plan(manifest())
  journal.transition(planned.manifest.operationId, 'awaitingApproval')

  expect(() => journal.transition(planned.manifest.operationId, 'executing'))
    .toThrow('Invalid AI operation transition')
  expect(journal.transition(planned.manifest.operationId, 'failed').state).toBe('failed')
})

it('preserves an externally settled unknown state when execution reports uncertainty', async () => {
  const journal = new AiOperationJournal<number>()
  const planned = journal.plan(manifest())
  journal.transition(planned.manifest.operationId, 'awaitingApproval')
  journal.authorize(planned.manifest.operationId, 'nonce-1')
  const uncertain = new AiOperationOutcomeUnknownError()

  await expect(journal.execute(planned.manifest.operationId, async () => {
    journal.transition(planned.manifest.operationId, 'unknown')
    throw uncertain
  })).rejects.toBe(uncertain)
  expect(journal.get(planned.manifest.operationId)?.state).toBe('unknown')
})

it('returns an externally terminalized entry when the execution callback resolves', async () => {
  const journal = new AiOperationJournal<number>()
  const planned = journal.plan(manifest())
  journal.transition(planned.manifest.operationId, 'awaitingApproval')
  journal.authorize(planned.manifest.operationId, 'nonce-1')

  await expect(journal.execute(planned.manifest.operationId, async () => {
    journal.transition(planned.manifest.operationId, 'succeeded', { result: 7 })
    return 99
  })).resolves.toMatchObject({ state: 'succeeded', result: 7 })
  expect(journal.get(planned.manifest.operationId)).toMatchObject({ state: 'succeeded', result: 7 })
})

it('recursively freezes terminal results so replay cannot be mutated by a caller', async () => {
  type Result = { result: { paths: string[] }; localAudit: { absolutePaths: string[] } }
  const journal = new AiOperationJournal<Result>()
  const planned = journal.plan(manifest())
  journal.transition(planned.manifest.operationId, 'awaitingApproval')
  journal.authorize(planned.manifest.operationId, 'nonce-1')
  const mutable: Result = {
    result: { paths: ['notes/a.md'] },
    localAudit: { absolutePaths: ['C:\\workspace\\notes\\a.md'] },
  }
  const completed = await journal.execute(planned.manifest.operationId, async () => mutable)

  mutable.result.paths[0] = 'tampered.md'
  expect(() => completed.result!.localAudit.absolutePaths.push('C:\\outside.md')).toThrow()
  await expect(journal.execute(planned.manifest.operationId, async () => mutable))
    .resolves.toMatchObject({
      result: {
        result: { paths: ['notes/a.md'] },
        localAudit: { absolutePaths: ['C:\\workspace\\notes\\a.md'] },
      },
    })
})
