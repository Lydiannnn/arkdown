import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { CanonicalFileIdentity } from '../../src/main/documents/document-identity'
import {
  OpenDocumentRegistry,
  type OpenDocumentEditorPort,
  type OpenDocumentRegistration,
} from '../../src/main/documents/open-document-registry'
import {
  RegistryWorkspaceAiEditorBoundary,
  type WorkspaceAiEditorBindingRef,
  type WorkspaceAiEditorTarget,
} from '../../src/main/documents/workspace-ai-editor-boundary'

const TARGET: WorkspaceAiEditorTarget = Object.freeze({
  windowId: 7,
  workspaceId: 'workspace-1',
  generation: 'generation-1',
  fileIdentity: '1.2' as CanonicalFileIdentity,
})
const OTHER_OWNER: WorkspaceAiEditorTarget = Object.freeze({
  ...TARGET,
  windowId: 8,
  workspaceId: 'workspace-2',
  generation: 'generation-2',
})

function hash(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex')
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function editorPort(markdown = '# Dirty', revision = 9): OpenDocumentEditorPort {
  const contentHash = hash(markdown)
  return {
    async captureReadSnapshot(input) {
      return { status: 'captured', ...input, editorRevision: revision, contentHash, markdown, dirty: true }
    },
    async planReplacement(input) {
      return {
        status: 'planned', registrationToken: input.registrationToken,
        registrationRevision: input.registrationRevision, bindingToken: input.bindingToken,
        bindingRevision: input.bindingRevision, operationId: input.operationId,
        editorRevision: input.expectedEditorRevision, contentHash: input.expectedContentHash,
      }
    },
    async applyTransaction(input) {
      return {
        status: 'applied', registrationToken: input.registrationToken,
        registrationRevision: input.registrationRevision, bindingToken: input.bindingToken,
        bindingRevision: input.bindingRevision, operationId: input.operationId,
        editorRevision: revision + 1, contentHash: hash(input.replacementMarkdown), dirty: true,
      }
    },
    async queryOutcome(input) {
      return {
        status: 'applied', registrationToken: input.registrationToken,
        registrationRevision: input.registrationRevision, bindingToken: input.bindingToken,
        bindingRevision: input.bindingRevision, operationId: input.operationId,
        editorRevision: revision + 1, contentHash: input.replacementContentHash, dirty: true,
      }
    },
  }
}

async function register(
  registry: OpenDocumentRegistry,
  target = TARGET,
  port = editorPort(),
): Promise<OpenDocumentRegistration> {
  return await registry.register(await registry.reserve(target), port)
}

function bindingRef(registration: OpenDocumentRegistration): WorkspaceAiEditorBindingRef {
  return {
    registrationToken: registration.registrationToken,
    registrationRevision: registration.registrationRevision,
    bindingToken: registration.bindingToken,
    bindingRevision: registration.bindingRevision,
  }
}

it('keys ownership process-wide by physical identity and never exposes another window as closed', async () => {
  const registry = new OpenDocumentRegistry()
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const first = await register(registry)

  expect(await boundary.lookup(TARGET)).toEqual({ status: 'open', ...bindingRef(first) })
  expect(await boundary.lookup(OTHER_OWNER)).toEqual({ status: 'ambiguous' })
  await register(registry, OTHER_OWNER)
  expect(await boundary.lookup(TARGET)).toEqual({ status: 'duplicate' })
  expect(await boundary.lookup(OTHER_OWNER)).toEqual({ status: 'duplicate' })
})

it('reserves then registers atomically with registry-issued monotonic non-reusable tokens', async () => {
  const registry = new OpenDocumentRegistry()
  const reservation = await registry.reserve(TARGET)
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'transition' })
  await expect(registry.register({ ...reservation }, editorPort())).rejects.toThrow()
  const first = await registry.register(reservation, editorPort())
  await expect(registry.register(reservation, editorPort())).rejects.toThrow()
  await registry.unregister(first)

  const second = await register(registry)
  expect(second.registrationToken).not.toBe(first.registrationToken)
  expect(second.bindingToken).not.toBe(first.bindingToken)
  expect(second.registrationRevision).toBeGreaterThan(first.registrationRevision)
  expect(second.bindingRevision).toBeGreaterThan(first.bindingRevision)
  await expect(registry.unregister(first)).rejects.toThrow()
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'open', ...bindingRef(second) })
})

it('can cancel a failed registration reservation without exposing a reusable token', async () => {
  const registry = new OpenDocumentRegistry()
  const reservation = await registry.reserve(TARGET)

  await registry.cancelReservation(reservation)
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'closed' })
  await expect(registry.cancelReservation(reservation)).rejects.toThrow()
  await expect(registry.register(reservation, editorPort())).rejects.toThrow()
  const later = await registry.reserve(TARGET)
  expect(later.registrationRevision).toBeGreaterThan(reservation.registrationRevision)
  expect(later.registrationToken).not.toBe(reservation.registrationToken)
})

it('fails closed before registry token and revision space can overflow', async () => {
  const registry = new OpenDocumentRegistry(Number.MAX_SAFE_INTEGER - 1)
  const last = await registry.reserve(TARGET)

  expect(last.registrationRevision).toBe(Number.MAX_SAFE_INTEGER)
  await expect(registry.register(last, editorPort())).rejects.toThrow('exhausted')
  await expect(registry.reserve(TARGET)).rejects.toThrow('exhausted')
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'transition' })
})

it('preflights all rebind revisions before changing either physical identity', async () => {
  const registry = new OpenDocumentRegistry(Number.MAX_SAFE_INTEGER - 5)
  const registration = await register(registry)
  const rebind = await registry.beginRebind(registration)
  const successorTarget = Object.freeze({ ...TARGET, fileIdentity: '1.3' as CanonicalFileIdentity })

  await expect(rebind.commit(successorTarget.fileIdentity, {
    target: successorTarget,
    port: editorPort(),
  })).rejects.toThrow('exhausted')
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'transition' })
  expect(registry.lookupLeased(successorTarget)).toEqual({ status: 'closed' })

  const restored = await rebind.rollback()
  expect(restored.bindingRevision).toBe(Number.MAX_SAFE_INTEGER)
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'open', ...bindingRef(restored) })
})

it('serializes all owners of one physical identity on the same lease', async () => {
  const registry = new OpenDocumentRegistry()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let reserveFinished = false
  const leased = registry.withIdentityLease(TARGET, async () => {
    expect(registry.lookupLeased(TARGET)).toEqual({ status: 'closed' })
    await gate
  })
  const reserving = registry.reserve(OTHER_OWNER).then(() => { reserveFinished = true })
  await Promise.resolve()
  expect(reserveFinished).toBe(false)
  release()
  await leased
  await reserving
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'transition' })
})

it('rebinds old to successor atomically and advances registry identity', async () => {
  const registry = new OpenDocumentRegistry()
  const first = await register(registry)
  const successorTarget = Object.freeze({ ...TARGET, fileIdentity: '1.3' as CanonicalFileIdentity })

  const rebind = await registry.beginRebind(first)
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'transition' })
  await expect(registry.unregister(first)).rejects.toThrow()
  await expect(registry.beginRebind(first)).rejects.toThrow()
  const successor = await rebind.commit(successorTarget.fileIdentity, {
    target: successorTarget,
    port: editorPort('# Successor', 10),
  })

  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(successorTarget)).toEqual({ status: 'open', ...bindingRef(successor) })
  expect(successor.registrationRevision).toBeGreaterThan(first.registrationRevision)
  expect(successor.bindingRevision).toBeGreaterThan(first.bindingRevision)
  await expect(rebind.rollback()).rejects.toThrow()
})

it('rollback restores the old owner with a new revision and makes pre-rebind handles stale', async () => {
  const registry = new OpenDocumentRegistry()
  const first = await register(registry)
  const rebind = await registry.beginRebind(first)
  const restored = await rebind.rollback()

  expect(restored.bindingToken).not.toBe(first.bindingToken)
  expect(restored.bindingRevision).toBeGreaterThan(first.bindingRevision)
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'open', ...bindingRef(restored) })
  await expect(registry.beginRebind(first)).rejects.toThrow()
  await expect(registry.unregister(first)).rejects.toThrow()
})

it('rejects a rebind that changes owner or workspace lifetime authority', async () => {
  const registry = new OpenDocumentRegistry()
  const first = await register(registry)
  const rebind = await registry.beginRebind(first)
  const wrongOwner = Object.freeze({
    ...OTHER_OWNER,
    fileIdentity: '1.3' as CanonicalFileIdentity,
  })

  await expect(rebind.commit(wrongOwner.fileIdentity, {
    target: wrongOwner,
    port: editorPort(),
  })).rejects.toThrow()
  const restored = await rebind.rollback()
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'open', ...bindingRef(restored) })
})

it('atomically transfers one live binding to an explicitly authorized workspace lifetime', async () => {
  const registry = new OpenDocumentRegistry()
  const port = editorPort('# Same renderer port')
  const first = await register(registry, TARGET, port)
  const successorTarget = Object.freeze({
    ...TARGET,
    workspaceId: 'workspace-2',
    generation: 'generation-2',
    fileIdentity: '1.3' as CanonicalFileIdentity,
  })

  const transfer = await registry.beginAuthorityTransfer(first, {
    windowId: successorTarget.windowId,
    workspaceId: successorTarget.workspaceId,
    generation: successorTarget.generation,
  })
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'transition' })
  expect(registry.lookupLeased(successorTarget)).toEqual({ status: 'closed' })

  const successor = await transfer.commit(successorTarget.fileIdentity, {
    target: successorTarget,
    port,
  })
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(successorTarget)).toEqual({ status: 'open', ...bindingRef(successor) })
})

it('refuses an authority transfer into an identity already owned by another editor', async () => {
  const registry = new OpenDocumentRegistry()
  const sourcePort = editorPort()
  const source = await register(registry, TARGET, sourcePort)
  const successorTarget = Object.freeze({
    ...TARGET,
    workspaceId: 'workspace-2',
    generation: 'generation-2',
    fileIdentity: '1.3' as CanonicalFileIdentity,
  })
  const existing = await register(registry, successorTarget)
  const transfer = await registry.beginAuthorityTransfer(source, successorTarget)

  await expect(transfer.commit(successorTarget.fileIdentity, {
    target: successorTarget,
    port: sourcePort,
  })).rejects.toThrow()
  const restored = await transfer.rollback()
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'open', ...bindingRef(restored) })
  expect(registry.lookupLeased(successorTarget)).toEqual({ status: 'open', ...bindingRef(existing) })
})

it('guards an existing Save As destination identity before the filesystem replacement starts', async () => {
  const registry = new OpenDocumentRegistry()
  const source = await register(registry)
  const destination = Object.freeze({
    ...TARGET,
    workspaceId: 'workspace-2',
    generation: 'generation-2',
    fileIdentity: '1.3' as CanonicalFileIdentity,
  })
  const transfer = await registry.beginAuthorityTransfer(source, destination)
  await transfer.guardDestination(destination)
  expect(registry.lookupLeased(destination)).toEqual({ status: 'transition' })
  await transfer.rollback()
  expect(registry.lookupLeased(destination)).toEqual({ status: 'closed' })

  const occupiedSource = await register(registry, TARGET, editorPort('# Occupied source'))
  const occupied = await register(registry, destination)
  const occupiedTransfer = await registry.beginAuthorityTransfer(occupiedSource, destination)
  await expect(occupiedTransfer.guardDestination(destination)).rejects.toThrow('owned')
  await occupiedTransfer.rollback()
  await registry.unregister(occupied)
})

it('hands a guarded replacement destination from its old identity to the atomic successor', async () => {
  const registry = new OpenDocumentRegistry()
  const port = editorPort()
  const source = await register(registry, TARGET, port)
  const oldDestination = Object.freeze({
    ...TARGET,
    workspaceId: 'workspace-2',
    generation: 'generation-2',
    fileIdentity: '2.b' as CanonicalFileIdentity,
  })
  const successor = Object.freeze({ ...oldDestination, fileIdentity: '3.c' as CanonicalFileIdentity })
  const transfer = await registry.beginAuthorityTransfer(source, oldDestination)

  await transfer.guardDestination(oldDestination)
  await transfer.handoffDestination(successor)

  expect(registry.lookupLeased(oldDestination)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(successor)).toEqual({ status: 'transition' })
  await expect(registry.reserve(successor)).rejects.toThrow('guarded')
  await transfer.commit(successor.fileIdentity, { target: successor, port })
  expect(registry.lookupLeased(successor)).toMatchObject({ status: 'open' })
})

it('keeps a rebind destination guard live when handoff receives the same identity', async () => {
  const registry = new OpenDocumentRegistry()
  const port = editorPort()
  const source = await register(registry, TARGET, port)
  const destination = Object.freeze({
    ...TARGET,
    workspaceId: 'workspace-2',
    generation: 'generation-2',
    fileIdentity: '2.b' as CanonicalFileIdentity,
  })
  const transfer = await registry.beginAuthorityTransfer(source, destination)

  await transfer.guardDestination(destination)
  const equivalentDestination = Object.freeze({ ...destination })
  await transfer.handoffDestination(equivalentDestination)
  await transfer.commit(equivalentDestination.fileIdentity, {
    target: equivalentDestination,
    port,
  })

  expect(registry.lookupLeased(equivalentDestination)).toMatchObject({ status: 'open' })
})

it('exclusively guards an unbound Save As destination until it is released', async () => {
  const registry = new OpenDocumentRegistry()
  const guard = await registry.guardDestination(TARGET)

  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'transition' })
  await expect(registry.reserve(TARGET)).rejects.toThrow('guarded')
  await guard.release()
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'closed' })
  const later = await registry.guardDestination(TARGET)
  await later.release()

  const occupiedRegistry = new OpenDocumentRegistry()
  const registered = await register(occupiedRegistry)
  await expect(occupiedRegistry.guardDestination(TARGET)).rejects.toThrow('owned')
  await occupiedRegistry.unregister(registered)
})

it('hands an unbound destination guard to the atomic successor identity', async () => {
  const registry = new OpenDocumentRegistry()
  const guard = await registry.guardDestination(TARGET)
  const successor = Object.freeze({ ...TARGET, fileIdentity: '3.c' as CanonicalFileIdentity })

  await guard.handoff(successor)

  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'closed' })
  expect(registry.lookupLeased(successor)).toEqual({ status: 'transition' })
  await expect(registry.reserve(successor)).rejects.toThrow('guarded')
  await guard.release()
  expect(registry.lookupLeased(successor)).toEqual({ status: 'closed' })
})

it('keeps an unbound destination guard releasable after same-identity handoff', async () => {
  const registry = new OpenDocumentRegistry()
  const guard = await registry.guardDestination(TARGET)
  const equivalentTarget = Object.freeze({ ...TARGET })

  await guard.handoff(equivalentTarget)
  await expect(registry.reserve(equivalentTarget)).rejects.toThrow('guarded')
  await guard.release()

  expect(registry.lookupLeased(equivalentTarget)).toEqual({ status: 'closed' })
})

it('rejects authority transfer to another window and restores source authority on rollback', async () => {
  const registry = new OpenDocumentRegistry()
  const first = await register(registry)

  await expect(registry.beginAuthorityTransfer(first, {
    windowId: TARGET.windowId + 1,
    workspaceId: 'workspace-2',
    generation: 'generation-2',
  })).rejects.toThrow()

  const transfer = await registry.beginAuthorityTransfer(first, {
    windowId: TARGET.windowId,
    workspaceId: 'workspace-2',
    generation: 'generation-2',
  })
  const restored = await transfer.rollback()
  expect(registry.lookupLeased(TARGET)).toEqual({ status: 'open', ...bindingRef(restored) })
})

it('strictly clones and freezes editor snapshots returned by the exact live registration', async () => {
  const registry = new OpenDocumentRegistry()
  let mutable: Record<string, unknown>
  const port: OpenDocumentEditorPort = {
    ...editorPort(),
    async captureReadSnapshot(input) {
      mutable = {
        status: 'captured', ...input, editorRevision: 9,
        contentHash: hash('# Dirty'), markdown: '# Dirty', dirty: true,
      }
      return mutable as never
    },
  }
  const registration = await register(registry, TARGET, port)
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const captured = await boundary.captureReadSnapshot({ target: TARGET, ...bindingRef(registration) }, signal())
  mutable!.markdown = '# Mutated later'

  expect(captured).toMatchObject({ status: 'captured', markdown: '# Dirty', dirty: true })
  expect(Object.isFrozen(captured)).toBe(true)
})

it('rejects malformed snapshots and stale registration relationships without invoking getters', async () => {
  const registry = new OpenDocumentRegistry()
  let getterCalls = 0
  let captureCalls = 0
  const port: OpenDocumentEditorPort = {
    ...editorPort(),
    async captureReadSnapshot(input) {
      captureCalls += 1
      return {
        status: 'captured', ...input, editorRevision: 9, contentHash: hash('# Dirty'),
        get markdown() { getterCalls += 1; return '# Dirty' }, dirty: true,
      }
    },
  }
  const registration = await register(registry, TARGET, port)
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const stale = { ...bindingRef(registration), bindingRevision: registration.bindingRevision + 1 }

  expect(await boundary.captureReadSnapshot({ target: TARGET, ...stale }, signal())).toEqual({ status: 'stale' })
  expect(captureCalls).toBe(0)
  expect(await boundary.captureReadSnapshot({ target: TARGET, ...bindingRef(registration) }, signal()))
    .toEqual({ status: 'unavailable' })
  expect(getterCalls).toBe(0)
})

it('uses a main-issued operation id and validates exact plan/apply/query relationships', async () => {
  const registry = new OpenDocumentRegistry()
  const port = editorPort()
  const apply = vi.spyOn(port, 'applyTransaction')
  const query = vi.spyOn(port, 'queryOutcome')
  const registration = await register(registry, TARGET, port)
  const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
  const captured = await boundary.captureReadSnapshot({ target: TARGET, ...bindingRef(registration) }, signal())
  if (captured.status !== 'captured') throw new Error('expected capture')
  const planned = await boundary.planReplacement({
    target: TARGET, ...bindingRef(registration), operationId: 'operation-1',
    expectedEditorRevision: captured.editorRevision, expectedContentHash: captured.contentHash,
    replacementMarkdown: '# Replaced',
  }, signal())
  if (planned.status !== 'planned') throw new Error('expected plan')

  const applied = await boundary.applyTransaction({ target: TARGET, plan: planned, replacementMarkdown: '# Replaced' })
  const queried = await boundary.queryOutcome({ target: TARGET, plan: planned, replacementMarkdown: '# Replaced' })

  expect(planned).toMatchObject({ status: 'planned', operationId: 'operation-1', ...bindingRef(registration) })
  expect(applied).toMatchObject({ status: 'applied', operationId: 'operation-1', editorRevision: 10 })
  expect(queried).toMatchObject({ status: 'applied', operationId: 'operation-1', editorRevision: 10 })
  expect(apply).toHaveBeenCalledTimes(1)
  expect(query).toHaveBeenCalledTimes(1)
  expect(Object.isFrozen(planned)).toBe(true)
  expect(Object.isFrozen(applied)).toBe(true)
  expect(Object.isFrozen(queried)).toBe(true)
})

it.each(['apply', 'query'] as const)(
  'rejects nonmonotonic or wrong-hash %s acknowledgements as unknown',
  async (kind) => {
    const registry = new OpenDocumentRegistry()
    const port: OpenDocumentEditorPort = {
      ...editorPort(),
      async applyTransaction(input) {
        return {
          status: 'applied', registrationToken: input.registrationToken,
          registrationRevision: input.registrationRevision, bindingToken: input.bindingToken,
          bindingRevision: input.bindingRevision, operationId: input.operationId,
          editorRevision: input.expectedEditorRevision, contentHash: hash('# Wrong'), dirty: true,
        }
      },
      async queryOutcome(input) {
        return {
          status: 'applied', registrationToken: input.registrationToken,
          registrationRevision: input.registrationRevision, bindingToken: input.bindingToken,
          bindingRevision: input.bindingRevision, operationId: input.operationId,
          editorRevision: input.expectedEditorRevision, contentHash: hash('# Wrong'), dirty: true,
        }
      },
    }
    const registration = await register(registry, TARGET, port)
    const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
    const planned = await boundary.planReplacement({
      target: TARGET, ...bindingRef(registration), operationId: 'operation-1',
      expectedEditorRevision: 9, expectedContentHash: hash('# Dirty'), replacementMarkdown: '# Replaced',
    }, signal())
    if (planned.status !== 'planned') throw new Error('expected plan')

    const result = kind === 'apply'
      ? await boundary.applyTransaction({ target: TARGET, plan: planned, replacementMarkdown: '# Replaced' })
      : await boundary.queryOutcome({ target: TARGET, plan: planned, replacementMarkdown: '# Replaced' })
    expect(result).toEqual({ status: 'unknown' })
  },
)

it.each(['capture', 'plan'] as const)(
  'aborts a hung editor %s request, releases the identity lease, and isolates a late response',
  async (kind) => {
    const registry = new OpenDocumentRegistry()
    const response = deferred<unknown>()
    const entered = deferred<AbortSignal>()
    const apply = vi.fn()
    const port: OpenDocumentEditorPort = {
      ...editorPort(),
      async captureReadSnapshot(_input, requestSignal) {
        entered.resolve(requestSignal)
        return await response.promise as never
      },
      async planReplacement(_input, requestSignal) {
        entered.resolve(requestSignal)
        return await response.promise as never
      },
      applyTransaction: apply,
    }
    const registration = await register(registry, TARGET, port)
    const boundary = new RegistryWorkspaceAiEditorBoundary(registry)
    const controller = new AbortController()
    const pending = kind === 'capture'
      ? boundary.captureReadSnapshot({ target: TARGET, ...bindingRef(registration) }, controller.signal)
      : boundary.planReplacement({
        target: TARGET, ...bindingRef(registration), operationId: 'operation-late',
        expectedEditorRevision: 9, expectedContentHash: hash('# Dirty'), replacementMarkdown: '# Replaced',
      }, controller.signal)

    const requestSignal = await entered.promise
    controller.abort('cancelled')

    await expect(pending).resolves.toEqual({ status: 'stale' })
    expect(requestSignal.aborted).toBe(true)
    expect(await boundary.lookup(TARGET)).toMatchObject({ status: 'open' })
    if (kind === 'capture') {
      response.reject(new Error('late capture failure'))
    } else {
      response.resolve({
        status: 'planned', ...bindingRef(registration), operationId: 'operation-late',
        editorRevision: 9, contentHash: hash('# Dirty'),
      })
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(apply).not.toHaveBeenCalled()
  },
)

it.each(['capture', 'plan'] as const)(
  'bounds a hung editor %s request with the main-owned planning deadline',
  async (kind) => {
    const registry = new OpenDocumentRegistry()
    const response = deferred<unknown>()
    const entered = deferred<AbortSignal>()
    let deadline!: () => void
    let cancelled = false
    const boundary = new RegistryWorkspaceAiEditorBoundary(registry, {
      planningTimeoutMs: 25,
      scheduleTimeout(callback, delayMs) {
        expect(delayMs).toBe(25)
        deadline = callback
        return () => { cancelled = true }
      },
    })
    const port: OpenDocumentEditorPort = {
      ...editorPort(),
      async captureReadSnapshot(_input, requestSignal) {
        entered.resolve(requestSignal)
        return await response.promise as never
      },
      async planReplacement(_input, requestSignal) {
        entered.resolve(requestSignal)
        return await response.promise as never
      },
    }
    const registration = await register(registry, TARGET, port)
    const pending = kind === 'capture'
      ? boundary.captureReadSnapshot({ target: TARGET, ...bindingRef(registration) }, signal())
      : boundary.planReplacement({
        target: TARGET, ...bindingRef(registration), operationId: 'operation-timeout',
        expectedEditorRevision: 9, expectedContentHash: hash('# Dirty'), replacementMarkdown: '# Replaced',
      }, signal())

    const requestSignal = await entered.promise
    deadline()

    await expect(pending).resolves.toEqual({ status: 'stale' })
    expect(requestSignal.aborted).toBe(true)
    expect(cancelled).toBe(true)
    expect(await boundary.lookup(TARGET)).toMatchObject({ status: 'open' })
    response.reject(new Error('late deadline failure'))
    await Promise.resolve()
    await Promise.resolve()
  },
)
