import type {
  AiOpenDocumentApplyResult,
  AiOpenDocumentRendererPort,
} from '../../shared/contracts'

const SHA256 = /^[0-9a-f]{64}$/u
const OPAQUE_OPERATION_ID = /^[0-9A-Za-z][0-9A-Za-z._:-]{0,511}$/u
const MAX_OUTCOMES = 64

export type WorkspaceAiEditorPort = AiOpenDocumentRendererPort

export interface WorkspaceAiEditorEngine<Prepared> {
  capture(): Readonly<{ markdown: string; dirty: boolean }>
  prepareReplacement(replacementMarkdown: string): Prepared
  applyReplacement(prepared: Prepared, replacementMarkdown: string): void
}

interface PlannedReplacement<Prepared> {
  readonly operationId: string
  readonly editorRevision: number
  readonly contentHash: string
  readonly replacementMarkdown: string
  readonly replacementContentHash: string
  readonly prepared: Prepared
}

type AppliedOutcome = Extract<AiOpenDocumentApplyResult, { status: 'applied' }>

interface CompletedReplacement {
  readonly operationId: string
  readonly expectedEditorRevision: number
  readonly expectedContentHash: string
  readonly replacementContentHash: string
  readonly outcome: AppliedOutcome
}

function frozenStatus<Status extends string>(status: Status): Readonly<{ status: Status }> {
  return Object.freeze({ status })
}

function validRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

async function sha256(markdown: string): Promise<string> {
  const bytes = new TextEncoder().encode(markdown)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export interface WorkspaceAiEditorAdapter {
  createPort(): WorkspaceAiEditorPort
  noteEditorEdit(): void
  dispose(): void
}

export function createWorkspaceAiEditorAdapter<Prepared>(
  engine: WorkspaceAiEditorEngine<Prepared>,
): WorkspaceAiEditorAdapter {
  let active = true
  let applying = false
  let editorRevision = 0
  let lifecycleEpoch = 0
  const plans = new Map<string, PlannedReplacement<Prepared>>()
  const outcomes = new Map<string, CompletedReplacement>()

  const invalidatePlans = () => { plans.clear() }
  const live = (epoch: number) => active && lifecycleEpoch === epoch
  const advanceRevision = () => {
    if (editorRevision === Number.MAX_SAFE_INTEGER) {
      active = false
      lifecycleEpoch += 1
      invalidatePlans()
      return
    }
    editorRevision += 1
    invalidatePlans()
  }
  const rememberOutcome = (completed: CompletedReplacement) => {
    outcomes.delete(completed.operationId)
    outcomes.set(completed.operationId, completed)
    while (outcomes.size > MAX_OUTCOMES) {
      const oldest = outcomes.keys().next().value as string | undefined
      if (oldest === undefined) break
      outcomes.delete(oldest)
    }
  }

  return {
    createPort() {
      if (!active) throw new Error('Workspace AI editor adapter is disposed')
      lifecycleEpoch += 1
      invalidatePlans()
      outcomes.clear()
      const epoch = lifecycleEpoch
      const preparingTokens = new Set<symbol>()
      const preparingOperationIds = new Set<string>()
      const accepts = () => live(epoch)
      const port: WorkspaceAiEditorPort = {
        async captureReadSnapshot() {
          if (!accepts()) return frozenStatus('stale')
          const revision = editorRevision
          let snapshot: Readonly<{ markdown: string; dirty: boolean }>
          try {
            snapshot = engine.capture()
          } catch {
            return frozenStatus('unavailable')
          }
          if (typeof snapshot.markdown !== 'string' || typeof snapshot.dirty !== 'boolean') {
            return frozenStatus('unavailable')
          }
          let contentHash: string
          try {
            contentHash = await sha256(snapshot.markdown)
          } catch {
            return frozenStatus('unavailable')
          }
          if (!accepts() || editorRevision !== revision) return frozenStatus('stale')
          return Object.freeze({
            status: 'captured' as const,
            editorRevision: revision,
            contentHash,
            markdown: snapshot.markdown,
            dirty: snapshot.dirty,
          })
        },
        async planReplacement(input) {
          if (!accepts()) return frozenStatus('stale')
          if (!validRevision(input.expectedEditorRevision) || !SHA256.test(input.expectedContentHash)
            || !OPAQUE_OPERATION_ID.test(input.operationId)
            || typeof input.replacementMarkdown !== 'string') return frozenStatus('unavailable')
          const completed = outcomes.get(input.operationId)
          if (completed) return frozenStatus('stale')
          const prior = plans.get(input.operationId)
          if (prior) {
            return prior.editorRevision === input.expectedEditorRevision
              && prior.contentHash === input.expectedContentHash
              && prior.replacementMarkdown === input.replacementMarkdown
              ? Object.freeze({
                status: 'planned' as const,
                editorRevision: prior.editorRevision,
                contentHash: prior.contentHash,
              })
              : frozenStatus('stale')
          }
          if (preparingOperationIds.has(input.operationId)) return frozenStatus('stale')
          if (plans.size + preparingTokens.size >= MAX_OUTCOMES) return frozenStatus('unavailable')
          const reservation = Symbol(input.operationId)
          preparingTokens.add(reservation)
          preparingOperationIds.add(input.operationId)
          try {
            const revision = editorRevision
            let snapshot: Readonly<{ markdown: string; dirty: boolean }>
            try {
              snapshot = engine.capture()
            } catch {
              return frozenStatus('unavailable')
            }
            let contentHash: string
            let replacementContentHash: string
            try {
              [contentHash, replacementContentHash] = await Promise.all([
                sha256(snapshot.markdown),
                sha256(input.replacementMarkdown),
              ])
            } catch {
              return frozenStatus('unavailable')
            }
            if (!accepts() || editorRevision !== revision) return frozenStatus('stale')
            if (revision !== input.expectedEditorRevision || contentHash !== input.expectedContentHash) {
              return frozenStatus('stale')
            }
            let prepared: Prepared
            try {
              prepared = engine.prepareReplacement(input.replacementMarkdown)
            } catch {
              return frozenStatus('unavailable')
            }
            if (!accepts() || editorRevision !== revision) return frozenStatus('stale')
            const plan: PlannedReplacement<Prepared> = Object.freeze({
              operationId: input.operationId,
              editorRevision: revision,
              contentHash,
              replacementMarkdown: input.replacementMarkdown,
              replacementContentHash,
              prepared,
            })
            plans.set(input.operationId, plan)
            return Object.freeze({
              status: 'planned' as const,
              editorRevision: plan.editorRevision,
              contentHash: plan.contentHash,
            })
          } finally {
            preparingTokens.delete(reservation)
            preparingOperationIds.delete(input.operationId)
          }
        },
        async applyTransaction(input) {
          if (!accepts()) return frozenStatus('stale')
          const completed = outcomes.get(input.operationId)
          if (completed) {
            let replacementContentHash: string
            try {
              replacementContentHash = await sha256(input.replacementMarkdown)
            } catch {
              return frozenStatus('unknown')
            }
            if (!accepts()) return frozenStatus('stale')
            return completed.expectedEditorRevision === input.expectedEditorRevision
              && completed.expectedContentHash === input.expectedContentHash
              && completed.replacementContentHash === replacementContentHash
              ? completed.outcome
              : frozenStatus('stale')
          }
          const plan = plans.get(input.operationId)
          if (!plan || plan.editorRevision !== input.expectedEditorRevision
            || plan.contentHash !== input.expectedContentHash
            || plan.replacementMarkdown !== input.replacementMarkdown) return frozenStatus('stale')
          const revision = editorRevision
          let snapshot: Readonly<{ markdown: string; dirty: boolean }>
          try {
            snapshot = engine.capture()
          } catch {
            plans.delete(input.operationId)
            return frozenStatus('unknown')
          }
          let currentHash: string
          try {
            currentHash = await sha256(snapshot.markdown)
          } catch {
            plans.delete(input.operationId)
            return frozenStatus('unknown')
          }
          if (!accepts() || editorRevision !== revision
            || revision !== plan.editorRevision || currentHash !== plan.contentHash) {
            plans.delete(input.operationId)
            return frozenStatus('stale')
          }
          if (editorRevision === Number.MAX_SAFE_INTEGER) {
            plans.delete(input.operationId)
            return frozenStatus('stale')
          }
          applying = true
          try {
            engine.applyReplacement(plan.prepared, plan.replacementMarkdown)
          } catch {
            plans.delete(input.operationId)
            return frozenStatus('unknown')
          } finally {
            applying = false
          }
          if (!accepts()) return frozenStatus('unknown')
          editorRevision = revision + 1
          invalidatePlans()
          const outcome = Object.freeze({
            status: 'applied' as const,
            editorRevision,
            contentHash: plan.replacementContentHash,
            dirty: true,
          })
          rememberOutcome(Object.freeze({
            operationId: plan.operationId,
            expectedEditorRevision: plan.editorRevision,
            expectedContentHash: plan.contentHash,
            replacementContentHash: plan.replacementContentHash,
            outcome,
          }))
          return outcome
        },
        async queryOutcome(input) {
          if (!accepts()) return frozenStatus('stale')
          const completed = outcomes.get(input.operationId)
          if (completed) {
            return completed.expectedEditorRevision === input.expectedEditorRevision
              && completed.expectedContentHash === input.expectedContentHash
              && completed.replacementContentHash === input.replacementContentHash
              ? completed.outcome
              : frozenStatus('unknown')
          }
          const plan = plans.get(input.operationId)
          if (!plan) return frozenStatus('unknown')
          return plan.editorRevision === input.expectedEditorRevision
            && plan.contentHash === input.expectedContentHash
            && plan.replacementContentHash === input.replacementContentHash
            ? frozenStatus('not-applied')
            : frozenStatus('unknown')
        },
      }
      return Object.freeze(port)
    },
    noteEditorEdit() {
      if (!active || applying) return
      advanceRevision()
    },
    dispose() {
      if (!active) return
      active = false
      lifecycleEpoch += 1
      invalidatePlans()
      outcomes.clear()
    },
  }
}
