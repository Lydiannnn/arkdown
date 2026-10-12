import { expect, it, vi } from 'vitest'
import { RecoveryCoordinator } from '../../src/main/drafts/recovery-coordinator'
import type { DraftSummary } from '../../src/shared/contracts'

const draftId = '123e4567-e89b-42d3-a456-426614174000'
const summary = {
  draftId,
  originalAbsolutePath: 'C:\\notes\\note.md',
  workspaceAbsolutePath: 'C:\\notes',
  originalRevision: 'a'.repeat(64),
  originalMtimeMs: 1,
  encoding: 'utf8' as const,
  newline: 'lf' as const,
  updatedAt: '2026-07-24T00:00:00.000Z',
  ignoredAt: null,
}

function harness(summaries: DraftSummary[] = [summary]) {
  const drafts = {
    listRecoverable: vi.fn(async () => summaries),
    read: vi.fn(async () => ({ manifest: summary, markdown: '# recovered' })),
    markIgnored: vi.fn(async () => undefined),
  }
  const prompt = vi.fn(async () => 'recover' as const)
  const open = vi.fn(async () => undefined)
  return {
    drafts,
    prompt,
    open,
    coordinator: new RecoveryCoordinator({ drafts, prompt, open }),
  }
}

it('starts normally without prompting when no recoverable draft exists', async () => {
  const { coordinator, prompt, open } = harness([])

  await expect(coordinator.promptAndOpen()).resolves.toEqual({
    found: 0,
    recovered: 0,
    ignored: 0,
  })
  expect(prompt).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it('prompts in Chinese-facing orchestration and opens every accepted valid draft', async () => {
  const { coordinator, prompt, open } = harness()

  await expect(coordinator.promptAndOpen()).resolves.toEqual({
    found: 1,
    recovered: 1,
    ignored: 0,
  })
  expect(prompt).toHaveBeenCalledWith([summary])
  expect(open).toHaveBeenCalledWith({
    manifest: summary,
    markdown: '# recovered',
  })
})

it('temporarily ignores drafts without deleting them', async () => {
  const { coordinator, prompt, drafts, open } = harness()
  prompt.mockResolvedValue('ignore' as never)

  await expect(coordinator.promptAndOpen()).resolves.toEqual({
    found: 1,
    recovered: 0,
    ignored: 1,
  })
  expect(drafts.markIgnored).toHaveBeenCalledWith(draftId)
  expect(open).not.toHaveBeenCalled()
  expect(drafts.read).not.toHaveBeenCalled()
})

it('retains recovery eligibility when the prompt surface is unavailable, allowing a later retry', async () => {
  const { coordinator, prompt, drafts, open } = harness()
  prompt.mockRejectedValueOnce(new Error('dialog unavailable'))
  await expect(coordinator.promptAndOpen()).rejects.toThrow('dialog unavailable')
  expect(drafts.markIgnored).not.toHaveBeenCalled()
  expect(drafts.read).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  await expect(coordinator.promptAndOpen()).resolves.toMatchObject({ recovered: 1, ignored: 0 })
})

it('skips a draft that becomes invalid before it can be opened', async () => {
  const { coordinator, drafts, open } = harness()
  drafts.read.mockResolvedValue(null as never)

  await expect(coordinator.promptAndOpen()).resolves.toEqual({
    found: 1,
    recovered: 0,
    ignored: 0,
  })
  expect(open).not.toHaveBeenCalled()
})

it('includes previously ignored drafts only on explicit manual review', async () => {
  const { coordinator, drafts, open } = harness([{ ...summary, ignoredAt: '2026-10-03T00:00:00.000Z' }])
  await expect(coordinator.promptAndOpen(true)).resolves.toMatchObject({ recovered: 1 })
  expect(drafts.listRecoverable).toHaveBeenCalledWith(true)
  expect(open).toHaveBeenCalledOnce()
})

it('does not offer drafts already claimed by a live window', async () => {
  const drafts = { listRecoverable: async () => [summary], read: async () => ({ manifest: summary, markdown: 'active' }),
    markIgnored: async () => undefined, isClaimed: () => true }
  const prompt = vi.fn(async () => 'recover' as const)
  const coordinator = new RecoveryCoordinator({ drafts, prompt, open: async () => { throw new Error('must not duplicate a live owner') } })
  expect(await coordinator.promptAndOpen(true)).toEqual({ found: 0, recovered: 0, ignored: 0 })
  expect(prompt).not.toHaveBeenCalled()
})

it('coalesces concurrent review requests into one recovery decision', async () => {
  const { coordinator, prompt, open } = harness()
  let decide!: (choice: 'recover') => void
  prompt.mockReturnValueOnce(new Promise((resolve) => { decide = resolve }))
  const first = coordinator.promptAndOpen(true)
  const second = coordinator.promptAndOpen(true)
  await Promise.resolve()
  decide('recover')
  expect(await first).toEqual(await second)
  expect(open).toHaveBeenCalledOnce()
})
