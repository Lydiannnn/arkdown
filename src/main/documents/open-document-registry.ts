import { AsyncLocalStorage } from 'node:async_hooks'
import type { CanonicalFileIdentity } from './document-identity'
import type {
  WorkspaceAiEditorApplyInput,
  WorkspaceAiEditorApplyResult,
  WorkspaceAiEditorBindingRef,
  WorkspaceAiEditorCapturePortInput,
  WorkspaceAiEditorCaptureResult,
  WorkspaceAiEditorPlanPortInput,
  WorkspaceAiEditorPlanResult,
  WorkspaceAiEditorQueryInput,
  WorkspaceAiEditorQueryResult,
  WorkspaceAiEditorTarget,
} from './workspace-ai-editor-boundary'

const FILE_IDENTITY = /^[0-9a-f]+\.[0-9a-f]+$/u

export interface OpenDocumentEditorPort {
  captureReadSnapshot(
    input: Readonly<WorkspaceAiEditorCapturePortInput>,
    signal: AbortSignal,
  ): Promise<WorkspaceAiEditorCaptureResult>
  planReplacement(
    input: Readonly<WorkspaceAiEditorPlanPortInput>,
    signal: AbortSignal,
  ): Promise<WorkspaceAiEditorPlanResult>
  applyTransaction(input: Readonly<WorkspaceAiEditorApplyInput>): Promise<WorkspaceAiEditorApplyResult>
  queryOutcome(input: Readonly<WorkspaceAiEditorQueryInput>): Promise<WorkspaceAiEditorQueryResult>
}

export interface OpenDocumentReservation {
  readonly target: WorkspaceAiEditorTarget
  readonly registrationToken: string
  readonly registrationRevision: number
}

export interface OpenDocumentRegistration extends WorkspaceAiEditorBindingRef {
  readonly target: WorkspaceAiEditorTarget
}

export interface OpenDocumentRebindBinding {
  readonly target: WorkspaceAiEditorTarget
  readonly port: OpenDocumentEditorPort
}

export interface OpenDocumentAuthority {
  readonly windowId: number
  readonly workspaceId: string
  readonly generation: string
}

export interface OpenDocumentRebind {
  guardDestination(target: WorkspaceAiEditorTarget): Promise<void>
  handoffDestination(target: WorkspaceAiEditorTarget): Promise<void>
  commit(
    successorIdentity: CanonicalFileIdentity,
    binding: OpenDocumentRebindBinding,
  ): Promise<OpenDocumentRegistration>
  rollback(): Promise<OpenDocumentRegistration>
}

export interface OpenDocumentDestinationGuard {
  handoff(target: WorkspaceAiEditorTarget): Promise<void>
  release(): Promise<void>
}

export type OpenDocumentLookup =
  | Readonly<{ status: 'closed' }>
  | Readonly<{ status: 'open' } & WorkspaceAiEditorBindingRef>
  | Readonly<{ status: 'ambiguous' | 'duplicate' | 'transition' }>

interface LiveBinding {
  readonly registration: OpenDocumentRegistration
  readonly port: OpenDocumentEditorPort
}

interface IdentityState {
  epoch: number
  readonly reservations: Map<string, OpenDocumentReservation>
  readonly bindings: Map<string, LiveBinding>
  readonly rebinds: Map<string, string>
  readonly destinationGuards: Map<string, WorkspaceAiEditorTarget>
}

function validateTarget(target: WorkspaceAiEditorTarget): CanonicalFileIdentity {
  if (!Number.isSafeInteger(target.windowId) || target.windowId <= 0
    || typeof target.workspaceId !== 'string' || target.workspaceId.length === 0 || target.workspaceId.length > 512
    || typeof target.generation !== 'string' || target.generation.length === 0 || target.generation.length > 512
    || typeof target.fileIdentity !== 'string' || !FILE_IDENTITY.test(target.fileIdentity)) {
    throw new Error('Invalid open-document target')
  }
  return target.fileIdentity
}

function sameTarget(left: WorkspaceAiEditorTarget, right: WorkspaceAiEditorTarget): boolean {
  return left.windowId === right.windowId
    && left.workspaceId === right.workspaceId
    && left.generation === right.generation
    && left.fileIdentity === right.fileIdentity
}

function sameAuthority(left: OpenDocumentAuthority, right: OpenDocumentAuthority): boolean {
  return left.windowId === right.windowId
    && left.workspaceId === right.workspaceId
    && left.generation === right.generation
}

function frozenAuthority(authority: OpenDocumentAuthority): OpenDocumentAuthority {
  if (!Number.isSafeInteger(authority.windowId) || authority.windowId <= 0
    || typeof authority.workspaceId !== 'string' || authority.workspaceId.length === 0
    || authority.workspaceId.length > 512 || typeof authority.generation !== 'string'
    || authority.generation.length === 0 || authority.generation.length > 512) {
    throw new Error('Invalid open-document authority')
  }
  return Object.freeze({
    windowId: authority.windowId,
    workspaceId: authority.workspaceId,
    generation: authority.generation,
  })
}

function frozenTarget(target: WorkspaceAiEditorTarget): WorkspaceAiEditorTarget {
  validateTarget(target)
  return Object.freeze({
    windowId: target.windowId,
    workspaceId: target.workspaceId,
    generation: target.generation,
    fileIdentity: target.fileIdentity,
  })
}

/**
 * Process-wide main-only registry keyed solely by canonical physical file identity.
 * Authority (window/workspace/generation) is data on a binding and never part of the
 * mutual-exclusion key. Callers must reserve before publishing a renderer binding,
 * and use beginRebind around atomic-save identity replacement.
 *
 * Task 9/10 integration obligations: reserve before asking a renderer to open and
 * cancel the reservation on failure; retain only registry-returned registrations;
 * beginRebind before an atomic save can replace identity, then commit the verified
 * successor identity or rollback. Renderer data must never manufacture registry
 * tokens/revisions, and callers must not split an atomic save into unregister/register.
 */
export class OpenDocumentRegistry {
  private readonly states = new Map<CanonicalFileIdentity, IdentityState>()
  private readonly tails = new Map<CanonicalFileIdentity, Promise<void>>()
  private readonly heldKeys = new AsyncLocalStorage<ReadonlySet<CanonicalFileIdentity>>()
  private nextValue: number

  /** The seed exists so exhaustion behavior can be tested without trillions of operations. */
  constructor(initialRevision = 0) {
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw new Error('Invalid open-document registry revision seed')
    }
    this.nextValue = initialRevision
  }

  async withIdentityLease<T>(
    target: WorkspaceAiEditorTarget,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    return await this.withIdentityLeases([validateTarget(target)], operation)
  }

  async reserve(target: WorkspaceAiEditorTarget): Promise<OpenDocumentReservation> {
    const reservedTarget = frozenTarget(target)
    const identity = reservedTarget.fileIdentity
    return await this.withIdentityLeases([identity], () => {
      const state = this.state(identity)
      if (state.destinationGuards.size > 0) {
        throw new Error('Open-document identity is guarded for replacement')
      }
      const [revision] = this.allocateRevisions(1)
      state.epoch = revision
      const reservation = Object.freeze({
        target: reservedTarget,
        registrationToken: `registration-${revision}`,
        registrationRevision: revision,
      })
      state.reservations.set(reservation.registrationToken, reservation)
      return reservation
    })
  }

  async register(
    reservation: OpenDocumentReservation,
    port: OpenDocumentEditorPort,
  ): Promise<OpenDocumentRegistration> {
    const identity = validateTarget(reservation.target)
    return await this.withIdentityLeases([identity], () => {
      const state = this.state(identity)
      const liveReservation = state.reservations.get(reservation.registrationToken)
      if (liveReservation !== reservation) {
        throw new Error('Open-document reservation is stale')
      }
      const [bindingRevision] = this.allocateRevisions(1)
      state.reservations.delete(reservation.registrationToken)
      state.epoch = bindingRevision
      const registration = Object.freeze({
        target: liveReservation.target,
        registrationToken: liveReservation.registrationToken,
        registrationRevision: liveReservation.registrationRevision,
        bindingToken: `binding-${bindingRevision}`,
        bindingRevision,
      })
      state.bindings.set(registration.bindingToken, { registration, port })
      return registration
    })
  }

  async cancelReservation(reservation: OpenDocumentReservation): Promise<void> {
    const identity = validateTarget(reservation.target)
    await this.withIdentityLeases([identity], () => {
      const state = this.state(identity)
      const live = state.reservations.get(reservation.registrationToken)
      if (live !== reservation) {
        throw new Error('Open-document reservation is stale')
      }
      const [revision] = this.allocateRevisions(1)
      state.reservations.delete(reservation.registrationToken)
      state.epoch = revision
    })
  }

  async unregister(registration: OpenDocumentRegistration): Promise<void> {
    const identity = validateTarget(registration.target)
    await this.withIdentityLeases([identity], () => {
      const state = this.state(identity)
      const live = state.bindings.get(registration.bindingToken)
      if (!live || live.registration !== registration) {
        throw new Error('Open-document registration is stale')
      }
      if ([...state.rebinds.values()].includes(registration.bindingToken)) {
        throw new Error('Open-document registration is being rebound')
      }
      const [revision] = this.allocateRevisions(1)
      state.bindings.delete(registration.bindingToken)
      state.epoch = revision
    })
  }

  async beginRebind(registration: OpenDocumentRegistration): Promise<OpenDocumentRebind> {
    return await this.beginAuthorizedRebind(registration, registration.target, false)
  }

  async beginRebindGuardingDestination(
    registration: OpenDocumentRegistration,
    destination: WorkspaceAiEditorTarget,
  ): Promise<OpenDocumentRebind> {
    return await this.beginAuthorizedRebind(
      registration,
      registration.target,
      false,
      destination,
    )
  }

  async beginAuthorityTransfer(
    registration: OpenDocumentRegistration,
    successorAuthority: OpenDocumentAuthority,
  ): Promise<OpenDocumentRebind> {
    const authority = frozenAuthority(successorAuthority)
    if (authority.windowId !== registration.target.windowId) {
      throw new Error('Open-document authority transfer changed owner')
    }
    return await this.beginAuthorizedRebind(registration, authority, true)
  }

  async beginAuthorityTransferGuardingDestination(
    registration: OpenDocumentRegistration,
    successorAuthority: OpenDocumentAuthority,
    destination: WorkspaceAiEditorTarget,
  ): Promise<OpenDocumentRebind> {
    const authority = frozenAuthority(successorAuthority)
    if (authority.windowId !== registration.target.windowId) {
      throw new Error('Open-document authority transfer changed owner')
    }
    return await this.beginAuthorizedRebind(
      registration,
      authority,
      true,
      destination,
    )
  }

  async guardDestination(target: WorkspaceAiEditorTarget): Promise<OpenDocumentDestinationGuard> {
    const guardedTarget = frozenTarget(target)
    const identity = guardedTarget.fileIdentity
    let currentTarget = guardedTarget
    let currentIdentity = identity
    let guardToken = await this.withIdentityLeases([identity], () => {
      const state = this.state(identity)
      if (state.reservations.size > 0 || state.bindings.size > 0 || state.rebinds.size > 0
        || state.destinationGuards.size > 0) {
        throw new Error('Open-document successor identity is already owned')
      }
      const [revision] = this.allocateRevisions(1)
      const token = `destination-guard-${revision}`
      state.epoch = revision
      state.destinationGuards.set(token, guardedTarget)
      return token
    })
    let released = false
    return Object.freeze({
      handoff: async (target: WorkspaceAiEditorTarget): Promise<void> => {
        if (released) throw new Error('Open-document destination guard is already released')
        const successor = frozenTarget(target)
        if (!sameAuthority(successor, currentTarget)) {
          throw new Error('Open-document destination guard authority changed')
        }
        const successorIdentity = successor.fileIdentity
        if (successorIdentity === currentIdentity) {
          await this.withIdentityLeases([currentIdentity], () => {
            const state = this.state(currentIdentity)
            if (state.destinationGuards.get(guardToken) !== currentTarget) {
              throw new Error('Open-document destination guard is stale')
            }
            const [revision] = this.allocateRevisions(1)
            state.destinationGuards.set(guardToken, successor)
            state.epoch = revision
            currentTarget = successor
          })
          return
        }
        await this.withIdentityLeases([currentIdentity, successorIdentity], () => {
          const oldState = this.state(currentIdentity)
          if (oldState.destinationGuards.get(guardToken) !== currentTarget) {
            throw new Error('Open-document destination guard is stale')
          }
          const successorState = this.state(successorIdentity)
          if (successorState.reservations.size > 0 || successorState.bindings.size > 0
            || successorState.rebinds.size > 0 || successorState.destinationGuards.size > 0) {
            throw new Error('Open-document successor identity is already owned')
          }
          const [oldRevision, successorRevision] = this.allocateRevisions(2)
          oldState.destinationGuards.delete(guardToken)
          oldState.epoch = oldRevision
          guardToken = `destination-guard-${successorRevision}`
          successorState.destinationGuards.set(guardToken, successor)
          successorState.epoch = successorRevision
          currentTarget = successor
          currentIdentity = successorIdentity
        })
      },
      release: async (): Promise<void> => {
        if (released) throw new Error('Open-document destination guard is already released')
        await this.withIdentityLeases([currentIdentity], () => {
          const state = this.state(currentIdentity)
          if (state.destinationGuards.get(guardToken) !== currentTarget) {
            throw new Error('Open-document destination guard is stale')
          }
          const [revision] = this.allocateRevisions(1)
          state.destinationGuards.delete(guardToken)
          state.epoch = revision
          released = true
        })
      },
    })
  }

  private async beginAuthorizedRebind(
    registration: OpenDocumentRegistration,
    successorAuthority: OpenDocumentAuthority,
    requireSamePort: boolean,
    initialDestination?: WorkspaceAiEditorTarget,
  ): Promise<OpenDocumentRebind> {
    const oldIdentity = validateTarget(registration.target)
    const initialGuard = initialDestination ? frozenTarget(initialDestination) : null
    if (initialGuard && !sameAuthority(initialGuard, successorAuthority)) {
      throw new Error('Open-document destination authority changed')
    }
    let sourcePort!: OpenDocumentEditorPort
    let guardedDestination: Readonly<{
      target: WorkspaceAiEditorTarget
      guardToken: string | null
    }> | null = null
    const initialIdentity = initialGuard?.fileIdentity
    const rebindToken = await this.withIdentityLeases(
      initialIdentity ? [oldIdentity, initialIdentity] : [oldIdentity],
      () => {
      const state = this.state(oldIdentity)
      const live = state.bindings.get(registration.bindingToken)
      if (!live || live.registration !== registration) {
        throw new Error('Open-document registration is stale')
      }
      if ([...state.rebinds.values()].includes(registration.bindingToken)) {
        throw new Error('Open-document registration is already being rebound')
      }
      const destinationState = initialGuard && initialIdentity !== oldIdentity
        ? this.state(initialIdentity!)
        : null
      if (destinationState && (destinationState.reservations.size > 0
        || destinationState.bindings.size > 0 || destinationState.rebinds.size > 0
        || destinationState.destinationGuards.size > 0)) {
        throw new Error('Open-document successor identity is already owned')
      }
      const revisions = this.allocateRevisions(destinationState ? 2 : 1)
      const rebindRevision = revisions[0]!
      state.epoch = rebindRevision
      const token = `rebind-${rebindRevision}`
      state.rebinds.set(token, registration.bindingToken)
      sourcePort = live.port
      if (initialGuard) {
        if (destinationState) {
          const guardRevision = revisions[1]!
          const guardToken = `rebind-destination-${guardRevision}`
          destinationState.epoch = guardRevision
          destinationState.destinationGuards.set(guardToken, initialGuard)
          guardedDestination = Object.freeze({ target: initialGuard, guardToken })
        } else {
          guardedDestination = Object.freeze({ target: initialGuard, guardToken: null })
        }
      }
      return token
      },
    )
    let completed = false
    const finish = (): void => {
      if (completed) throw new Error('Open-document rebind is already complete')
      completed = true
    }
    return Object.freeze({
      guardDestination: async (target: WorkspaceAiEditorTarget): Promise<void> => {
        if (completed) throw new Error('Open-document rebind is already complete')
        const destination = frozenTarget(target)
        if (!sameAuthority(destination, successorAuthority)) {
          throw new Error('Open-document destination authority changed')
        }
        if (guardedDestination) {
          throw new Error('Open-document rebind destination is already guarded')
        }
        const destinationIdentity = destination.fileIdentity
        await this.withIdentityLeases([oldIdentity, destinationIdentity], () => {
          const oldState = this.state(oldIdentity)
          const live = oldState.bindings.get(registration.bindingToken)
          if (oldState.rebinds.get(rebindToken) !== registration.bindingToken
            || !live || live.registration !== registration) {
            throw new Error('Open-document rebind is stale')
          }
          if (destinationIdentity === oldIdentity) {
            guardedDestination = Object.freeze({ target: destination, guardToken: null })
            return
          }
          const destinationState = this.state(destinationIdentity)
          if (destinationState.reservations.size > 0 || destinationState.bindings.size > 0
            || destinationState.rebinds.size > 0 || destinationState.destinationGuards.size > 0) {
            throw new Error('Open-document successor identity is already owned')
          }
          const [revision] = this.allocateRevisions(1)
          const guardToken = `rebind-destination-${revision}`
          destinationState.epoch = revision
          destinationState.destinationGuards.set(guardToken, destination)
          guardedDestination = Object.freeze({ target: destination, guardToken })
        })
      },
      handoffDestination: async (target: WorkspaceAiEditorTarget): Promise<void> => {
        if (completed) throw new Error('Open-document rebind is already complete')
        const successor = frozenTarget(target)
        if (!sameAuthority(successor, successorAuthority)) {
          throw new Error('Open-document destination authority changed')
        }
        if (!guardedDestination) {
          throw new Error('Open-document rebind destination is not guarded')
        }
        const previous = guardedDestination
        const previousIdentity = previous.target.fileIdentity
        const successorIdentity = successor.fileIdentity
        if (previousIdentity === successorIdentity) {
          await this.withIdentityLeases([oldIdentity, previousIdentity], () => {
            const oldState = this.state(oldIdentity)
            const live = oldState.bindings.get(registration.bindingToken)
            if (oldState.rebinds.get(rebindToken) !== registration.bindingToken
              || !live || live.registration !== registration) {
              throw new Error('Open-document rebind is stale')
            }
            if (previous.guardToken) {
              const destinationState = this.state(previousIdentity)
              if (destinationState.destinationGuards.get(previous.guardToken) !== previous.target) {
                throw new Error('Open-document rebind destination guard is stale')
              }
              const [revision] = this.allocateRevisions(1)
              destinationState.destinationGuards.set(previous.guardToken, successor)
              destinationState.epoch = revision
            }
            guardedDestination = Object.freeze({ ...previous, target: successor })
          })
          return
        }
        await this.withIdentityLeases([oldIdentity, previousIdentity, successorIdentity], () => {
          const oldState = this.state(oldIdentity)
          const live = oldState.bindings.get(registration.bindingToken)
          if (oldState.rebinds.get(rebindToken) !== registration.bindingToken
            || !live || live.registration !== registration) {
            throw new Error('Open-document rebind is stale')
          }
          const previousState = this.state(previousIdentity)
          if (previous.guardToken
            && previousState.destinationGuards.get(previous.guardToken) !== previous.target) {
            throw new Error('Open-document rebind destination guard is stale')
          }
          const successorState = this.state(successorIdentity)
          if (successorState.reservations.size > 0 || successorState.bindings.size > 0
            || successorState.rebinds.size > 0 || successorState.destinationGuards.size > 0) {
            throw new Error('Open-document successor identity is already owned')
          }
          const revisions = this.allocateRevisions(previous.guardToken ? 2 : 1)
          if (previous.guardToken) {
            previousState.destinationGuards.delete(previous.guardToken)
            previousState.epoch = revisions[0]!
          }
          const successorRevision = revisions.at(-1)!
          const guardToken = `rebind-destination-${successorRevision}`
          successorState.destinationGuards.set(guardToken, successor)
          successorState.epoch = successorRevision
          guardedDestination = Object.freeze({ target: successor, guardToken })
        })
      },
      commit: async (
        successorIdentity: CanonicalFileIdentity,
        binding: OpenDocumentRebindBinding,
      ): Promise<OpenDocumentRegistration> => {
        if (completed) throw new Error('Open-document rebind is already complete')
        const successorTarget = frozenTarget(binding.target)
        const successorPort = binding.port
        if (successorTarget.fileIdentity !== successorIdentity) {
          throw new Error('Open-document successor identity does not match its binding')
        }
        if (!sameAuthority(successorTarget, successorAuthority)) {
          throw new Error('Open-document successor authority changed')
        }
        if (requireSamePort && successorPort !== sourcePort) {
          throw new Error('Open-document authority transfer changed editor port')
        }
        if (guardedDestination
          && guardedDestination.target.fileIdentity !== successorIdentity) {
          throw new Error('Open-document successor identity was not guarded')
        }
        const guardedIdentity = guardedDestination?.target.fileIdentity
        return await this.withIdentityLeases(
          guardedIdentity
            ? [oldIdentity, guardedIdentity, successorIdentity]
            : [oldIdentity, successorIdentity],
          () => {
          const oldState = this.state(oldIdentity)
          const live = oldState.bindings.get(registration.bindingToken)
          if (oldState.rebinds.get(rebindToken) !== registration.bindingToken
            || !live || live.registration !== registration) {
            throw new Error('Open-document rebind is stale')
          }
          const guardState = guardedDestination
            ? this.state(guardedDestination.target.fileIdentity)
            : null
          if (guardedDestination?.guardToken
            && guardState!.destinationGuards.get(guardedDestination.guardToken)
              !== guardedDestination.target) {
            throw new Error('Open-document rebind destination guard is stale')
          }
          const newState = this.state(successorIdentity)
          const allowedSourceState = successorIdentity === oldIdentity
          const allowedGuardToken = guardedDestination?.target.fileIdentity === successorIdentity
            ? guardedDestination.guardToken
            : null
          const foreignGuardCount = newState.destinationGuards.size - (
            allowedGuardToken && newState.destinationGuards.has(allowedGuardToken) ? 1 : 0
          )
          if (successorIdentity !== oldIdentity
            && (newState.reservations.size > 0 || newState.bindings.size > 0
              || newState.rebinds.size > 0 || foreignGuardCount > 0)) {
            throw new Error('Open-document successor identity is already owned')
          }
          if (allowedSourceState && foreignGuardCount > 0) {
            throw new Error('Open-document successor identity is already owned')
          }
          const revisions = this.allocateRevisions(
            guardedDestination?.guardToken && guardedIdentity !== oldIdentity ? 4 : 3,
          )
          const [oldRevision, registrationRevision, bindingRevision] = revisions.slice(-3)
          finish()
          oldState.bindings.delete(registration.bindingToken)
          oldState.rebinds.delete(rebindToken)
          oldState.epoch = oldRevision
          if (guardedDestination?.guardToken) {
            guardState!.destinationGuards.delete(guardedDestination.guardToken)
            guardState!.epoch = revisions[0]!
          }
          newState.epoch = bindingRevision
          const successor = Object.freeze({
            target: successorTarget,
            registrationToken: `registration-${registrationRevision}`,
            registrationRevision,
            bindingToken: `binding-${bindingRevision}`,
            bindingRevision,
          })
          newState.bindings.set(successor.bindingToken, { registration: successor, port: successorPort })
          return successor
          },
        )
      },
      rollback: async (): Promise<OpenDocumentRegistration> => {
        if (completed) throw new Error('Open-document rebind is already complete')
        const guardedIdentity = guardedDestination?.target.fileIdentity
        return await this.withIdentityLeases(
          guardedIdentity ? [oldIdentity, guardedIdentity] : [oldIdentity],
          () => {
          const state = this.state(oldIdentity)
          const live = state.bindings.get(registration.bindingToken)
          if (state.rebinds.get(rebindToken) !== registration.bindingToken
            || !live || live.registration !== registration) {
            throw new Error('Open-document rebind is stale')
          }
          const destinationState = guardedDestination?.guardToken
            ? this.state(guardedDestination.target.fileIdentity)
            : null
          if (guardedDestination?.guardToken
            && destinationState!.destinationGuards.get(guardedDestination.guardToken)
              !== guardedDestination.target) {
            throw new Error('Open-document rebind destination guard is stale')
          }
          const revisions = this.allocateRevisions(destinationState ? 3 : 2)
          const [registrationRevision, bindingRevision] = revisions.slice(-2)
          finish()
          if (guardedDestination?.guardToken) {
            destinationState!.destinationGuards.delete(guardedDestination.guardToken)
            destinationState!.epoch = revisions[0]!
          }
          state.bindings.delete(registration.bindingToken)
          state.rebinds.delete(rebindToken)
          state.epoch = bindingRevision
          const restored = Object.freeze({
            target: registration.target,
            registrationToken: `registration-${registrationRevision}`,
            registrationRevision,
            bindingToken: `binding-${bindingRevision}`,
            bindingRevision,
          })
          state.bindings.set(restored.bindingToken, { registration: restored, port: live.port })
          return restored
          },
        )
      },
    })
  }

  lookupLeased(target: WorkspaceAiEditorTarget): OpenDocumentLookup {
    const state = this.states.get(validateTarget(target))
    if (!state) return Object.freeze({ status: 'closed' })
    if (state.reservations.size > 0 || state.rebinds.size > 0
      || state.destinationGuards.size > 0) {
      return Object.freeze({ status: 'transition' })
    }
    if (state.bindings.size === 0) return Object.freeze({ status: 'closed' })
    if (state.bindings.size !== 1) return Object.freeze({ status: 'duplicate' })
    const live = state.bindings.values().next().value as LiveBinding
    if (!sameTarget(live.registration.target, target)) return Object.freeze({ status: 'ambiguous' })
    return Object.freeze({
      status: 'open',
      registrationToken: live.registration.registrationToken,
      registrationRevision: live.registration.registrationRevision,
      bindingToken: live.registration.bindingToken,
      bindingRevision: live.registration.bindingRevision,
    })
  }

  portLeased(
    target: WorkspaceAiEditorTarget,
    binding: WorkspaceAiEditorBindingRef,
  ): OpenDocumentEditorPort | undefined {
    const lookup = this.lookupLeased(target)
    if (lookup.status !== 'open'
      || lookup.registrationToken !== binding.registrationToken
      || lookup.registrationRevision !== binding.registrationRevision
      || lookup.bindingToken !== binding.bindingToken
      || lookup.bindingRevision !== binding.bindingRevision) return undefined
    return this.states.get(target.fileIdentity)?.bindings.get(binding.bindingToken)?.port
  }

  private state(identity: CanonicalFileIdentity): IdentityState {
    const existing = this.states.get(identity)
    if (existing) return existing
    const created: IdentityState = {
      epoch: 0,
      reservations: new Map(),
      bindings: new Map(),
      rebinds: new Map(),
      destinationGuards: new Map(),
    }
    this.states.set(identity, created)
    return created
  }

  private allocateRevisions(count: number): readonly number[] {
    if (!Number.isSafeInteger(count) || count <= 0
      || this.nextValue > Number.MAX_SAFE_INTEGER - count) {
      throw new Error('Open-document registry revision space is exhausted')
    }
    const first = this.nextValue + 1
    this.nextValue += count
    return Array.from({ length: count }, (_, index) => first + index)
  }

  private async withIdentityLeases<T>(
    identities: readonly CanonicalFileIdentity[],
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const held = this.heldKeys.getStore()
    const keys = [...new Set(identities)].sort().filter((key) => !held?.has(key))
    const leases = keys.map((key) => {
      const previous = this.tails.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => { release = resolve })
      const tail = previous.catch(() => undefined).then(() => current)
      this.tails.set(key, tail)
      return { key, previous, release, tail }
    })
    await Promise.all(leases.map(({ previous }) => previous.catch(() => undefined)))
    const nextHeld = new Set(held ?? [])
    for (const key of keys) nextHeld.add(key)
    try {
      return await this.heldKeys.run(nextHeld, operation)
    } finally {
      for (const { key, release, tail } of leases) {
        release()
        if (this.tails.get(key) === tail) this.tails.delete(key)
      }
    }
  }
}
