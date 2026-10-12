import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import {
  createWorkspaceAiEditorAdapter,
} from '../../src/renderer/editor/workspace-ai-editor-adapter'
import type { AiOpenDocumentRendererPort } from '../../src/shared/contracts'

function sha256(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

function createFixture(initial = '# Before') {
  let markdown = initial
  let dirty = false
  const apply = vi.fn((replacement: string) => {
    markdown = replacement
    dirty = true
  })
  const adapter = createWorkspaceAiEditorAdapter<string>({
    capture: () => ({ markdown, dirty }),
    prepareReplacement: (replacement) => {
      if (replacement === 'invalid') throw new Error('parse failed')
      return replacement
    },
    applyReplacement: (replacement) => apply(replacement),
  })
  const port: AiOpenDocumentRendererPort = adapter.createPort()
  return {
    adapter,
    apply,
    port,
    setMarkdown(next: string) {
      markdown = next
      dirty = true
      adapter.noteEditorEdit()
    },
  }
}

it('captures exact Markdown with its revision, hash, and dirty state through the shared renderer port', async () => {
  const fixture = createFixture('frontmatter\n\ud83e\uddea')

  await expect(fixture.port.captureReadSnapshot({}))
    .resolves.toEqual({
      status: 'captured',
      editorRevision: 0,
      contentHash: sha256('frontmatter\n\ud83e\uddea'),
      markdown: 'frontmatter\n\ud83e\uddea',
      dirty: false,
    })
})

it('plans and applies one replacement exactly once while preserving exact replacement hashing', async () => {
  const fixture = createFixture()
  const expectedContentHash = sha256('# Before')
  const replacementMarkdown = '# After\n\n```ts\nconst n = 1\n```\n'
  const input = {
    operationId: 'operation-1',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown,
  }

  await expect(fixture.port.planReplacement(input)).resolves.toEqual({
    status: 'planned',
    editorRevision: 0,
    contentHash: expectedContentHash,
  })
  const applied = {
    status: 'applied',
    editorRevision: 1,
    contentHash: sha256(replacementMarkdown),
    dirty: true,
  }
  await expect(fixture.port.applyTransaction(input)).resolves.toEqual(applied)
  await expect(fixture.port.applyTransaction(input)).resolves.toEqual(applied)
  expect(fixture.apply).toHaveBeenCalledTimes(1)

  await expect(fixture.port.queryOutcome({
    operationId: 'operation-1',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementContentHash: sha256(replacementMarkdown),
  })).resolves.toEqual(applied)

  await expect(fixture.port.applyTransaction({
    ...input,
    expectedContentHash: sha256('different base'),
  })).resolves.toEqual({ status: 'stale' })
  await expect(fixture.port.queryOutcome({
    operationId: 'operation-1',
    expectedEditorRevision: 0,
    expectedContentHash: sha256('different base'),
    replacementContentHash: sha256(replacementMarkdown),
  })).resolves.toEqual({ status: 'unknown' })
})

it('invalidates a plan after a user edit even when the text returns to the original bytes', async () => {
  const fixture = createFixture()
  const input = {
    operationId: 'operation-aba',
    expectedEditorRevision: 0,
    expectedContentHash: sha256('# Before'),
    replacementMarkdown: '# AI',
  }
  expect((await fixture.port.planReplacement(input)).status).toBe('planned')

  fixture.setMarkdown('# Changed')
  fixture.setMarkdown('# Before')

  await expect(fixture.port.applyTransaction(input)).resolves.toEqual({ status: 'stale' })
  expect(fixture.apply).not.toHaveBeenCalled()
})

it('fails closed on parse errors, malformed requests, and lifecycle disposal', async () => {
  const fixture = createFixture()
  const base = {
    operationId: 'operation-invalid',
    expectedEditorRevision: 0,
    expectedContentHash: sha256('# Before'),
    replacementMarkdown: 'invalid',
  }
  await expect(fixture.port.planReplacement(base))
    .resolves.toEqual({ status: 'unavailable' })

  await expect(fixture.port.planReplacement({ ...base, operationId: 'contains spaces' }))
    .resolves.toEqual({ status: 'unavailable' })

  fixture.adapter.dispose()
  await expect(fixture.port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })
})

it('reports not-applied only for an exact live plan and bounds completed outcomes', async () => {
  const fixture = createFixture('zero')
  const firstInput = {
    operationId: 'operation-0',
    expectedEditorRevision: 0,
    expectedContentHash: sha256('zero'),
    replacementMarkdown: 'one',
  }
  expect((await fixture.port.planReplacement(firstInput)).status).toBe('planned')
  await expect(fixture.port.queryOutcome({
    operationId: 'operation-0',
    expectedEditorRevision: 0,
    expectedContentHash: sha256('zero'),
    replacementContentHash: sha256('one'),
  })).resolves.toEqual({ status: 'not-applied' })

  for (let index = 0; index < 70; index += 1) {
    const capture = await fixture.port.captureReadSnapshot({})
    if (capture.status !== 'captured') throw new Error('capture failed')
    const input = {
      operationId: `operation-${index + 1}`,
      expectedEditorRevision: capture.editorRevision,
      expectedContentHash: capture.contentHash,
      replacementMarkdown: `replacement-${index}`,
    }
    expect((await fixture.port.planReplacement(input)).status).toBe('planned')
    expect((await fixture.port.applyTransaction(input)).status).toBe('applied')
  }

  await expect(fixture.port.queryOutcome({
    operationId: 'operation-1',
    expectedEditorRevision: 0,
    expectedContentHash: sha256('zero'),
    replacementContentHash: sha256('replacement-0'),
  })).resolves.toEqual({ status: 'unknown' })
})

it('bounds prepared replacements before they can retain unbounded editor documents', async () => {
  const fixture = createFixture('same')
  const expectedContentHash = sha256('same')
  for (let index = 0; index < 64; index += 1) {
    const result = await fixture.port.planReplacement({
      operationId: `pending-${index}`,
      expectedEditorRevision: 0,
      expectedContentHash,
      replacementMarkdown: `replacement-${index}`,
    })
    expect(result.status).toBe('planned')
  }

  await expect(fixture.port.planReplacement({
    operationId: 'pending-overflow',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown: 'overflow',
  })).resolves.toEqual({ status: 'unavailable' })
})

it('makes an earlier port stale when the editor is rebound without replaying its journal', async () => {
  const fixture = createFixture('same')
  const nextPort = fixture.adapter.createPort()

  await expect(fixture.port.captureReadSnapshot({}))
    .resolves.toEqual({ status: 'stale' })
  await expect(nextPort.captureReadSnapshot({}))
    .resolves.toEqual(expect.objectContaining({ status: 'captured' }))
})

it('does not return a cached applied outcome after its lifecycle ends during hashing', async () => {
  const fixture = createFixture('before')
  const input = {
    operationId: 'operation-race',
    expectedEditorRevision: 0,
    expectedContentHash: sha256('before'),
    replacementMarkdown: 'after',
  }
  expect((await fixture.port.planReplacement(input)).status).toBe('planned')
  expect((await fixture.port.applyTransaction(input)).status).toBe('applied')

  let resolveDigest!: (value: ArrayBuffer) => void
  const digest = new Promise<ArrayBuffer>((resolve) => { resolveDigest = resolve })
  const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockReturnValue(digest)
  const duplicate = fixture.port.applyTransaction(input)
  fixture.adapter.dispose()
  const expected = Uint8Array.from(Buffer.from(sha256('after'), 'hex'))
  resolveDigest(expected.buffer)

  await expect(duplicate).resolves.toEqual({ status: 'stale' })
  spy.mockRestore()
})

it('releases a planning reservation when hashing fails', async () => {
  const fixture = createFixture('same')
  const expectedContentHash = sha256('same')
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
  const spy = vi.spyOn(globalThis.crypto.subtle, 'digest')
    .mockRejectedValueOnce(new Error('digest failed'))
    .mockImplementation((algorithm, data) => originalDigest(algorithm, data))
  const input = {
    operationId: 'hash-failure',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown: 'replacement',
  }

  await expect(fixture.port.planReplacement(input)).resolves.toEqual({ status: 'unavailable' })
  await expect(fixture.port.planReplacement(input)).resolves.toEqual(expect.objectContaining({
    status: 'planned',
  }))
  spy.mockRestore()
})

it('reserves bounded planning capacity before asynchronous hashing and releases stale slots', async () => {
  const fixture = createFixture('same')
  const expectedContentHash = sha256('same')
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
  let releaseHashes!: () => void
  const gate = new Promise<void>((resolve) => { releaseHashes = resolve })
  const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    await gate
    return await originalDigest(algorithm, data)
  })
  const pending = Array.from({ length: 64 }, (_, index) => fixture.port.planReplacement({
    operationId: `concurrent-${index}`,
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown: `replacement-${index}`,
  }))

  await expect(fixture.port.planReplacement({
    operationId: 'concurrent-0',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown: 'replacement-0',
  })).resolves.toEqual({ status: 'stale' })

  const overflow = fixture.port.planReplacement({
    operationId: 'concurrent-overflow',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown: 'overflow',
  })
  const overflowResult = await Promise.race([
    overflow,
    Promise.resolve({ status: 'still-hashing' as const }),
  ])
  expect(overflowResult).toEqual({ status: 'unavailable' })

  const nextPort = fixture.adapter.createPort()
  releaseHashes()
  const results = await Promise.all(pending)
  expect(results.filter((result) => result.status === 'stale')).toHaveLength(64)
  expect((await nextPort.planReplacement({
    operationId: 'replacement-after-rebind',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown: 'slot was released',
  })).status).toBe('planned')
  spy.mockRestore()
})

it('gives a rebound port independent planning capacity before stale hashes settle', async () => {
  const fixture = createFixture('same')
  const expectedContentHash = sha256('same')
  const originalDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle)
  let releaseOldHashes!: () => void
  let releaseNewHashes!: () => void
  const oldGate = new Promise<void>((resolve) => { releaseOldHashes = resolve })
  const newGate = new Promise<void>((resolve) => { releaseNewHashes = resolve })
  let phase: 'old' | 'new' | 'open' = 'old'
  const spy = vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const scheduledPhase = phase
    if (scheduledPhase === 'old') await oldGate
    if (scheduledPhase === 'new') await newGate
    return await originalDigest(algorithm, data)
  })
  const inputFor = (index: number, prefix: string) => ({
    operationId: `rebound-${index}`,
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementMarkdown: `${prefix}-${index}`,
  })
  const stalePlans = Array.from({ length: 64 }, (_, index) => (
    fixture.port.planReplacement(inputFor(index, 'old'))
  ))

  const reboundPort = fixture.adapter.createPort()
  phase = 'new'
  const reboundPlans = Array.from({ length: 64 }, (_, index) => (
    reboundPort.planReplacement(inputFor(index, 'new'))
  ))
  await expect(reboundPort.planReplacement(inputFor(64, 'overflow')))
    .resolves.toEqual({ status: 'unavailable' })

  phase = 'open'
  releaseOldHashes()
  await expect(Promise.all(stalePlans)).resolves.toEqual(
    Array.from({ length: 64 }, () => ({ status: 'stale' })),
  )
  await expect(reboundPort.planReplacement(inputFor(64, 'still-overflow')))
    .resolves.toEqual({ status: 'unavailable' })

  releaseNewHashes()
  const planned = await Promise.all(reboundPlans)
  expect(planned.filter((result) => result.status === 'planned')).toHaveLength(64)
  await expect(reboundPort.queryOutcome({
    operationId: 'rebound-0',
    expectedEditorRevision: 0,
    expectedContentHash,
    replacementContentHash: sha256('new-0'),
  })).resolves.toEqual({ status: 'not-applied' })
  spy.mockRestore()
})
