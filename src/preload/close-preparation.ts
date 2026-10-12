import { canTransitionClosePreparation, parseClosePreparationRequest, parseClosePreparationResult,
  type ClosePreparationIdentity, type ClosePreparationEvent, type ClosePreparationResult, type ClosePreparationStage,
  type ClosePreparationHandler, type ClosePreparationHandlerContext } from '../shared/close-preparation'
export type { ClosePreparationHandler, ClosePreparationHandlerContext } from '../shared/close-preparation'
interface Flight {
  identity: ClosePreparationIdentity
  stage: ClosePreparationStage
  sequence: number
  timer?: ReturnType<typeof setInterval>
  terminal?: Extract<ClosePreparationEvent, { type: 'result' }>
}

/** Inactive until the production preload explicitly composes this bridge. No business IPC gate. */
export function createClosePreparationBridge(options: { transport: {
  subscribe(listener: (input: unknown) => void): () => void
  send(event: ClosePreparationEvent): void
} }): { setHandler(handler: ClosePreparationHandler): () => void; dispose(): void } {
  let registration: { handler: ClosePreparationHandler } | undefined
  let current: Flight | undefined
  let disposed = false
  const owned = (flight: Flight) => !disposed && current === flight && !flight.terminal
  const send = (event: ClosePreparationEvent) => {
    if (!disposed) try { options.transport.send(event) } catch { /* Transport loss never cancels the handler. */ }
  }
  const stopHeartbeat = (flight: Flight) => {
    if (flight.timer !== undefined) clearInterval(flight.timer)
    flight.timer = undefined
  }
  const unknownResult = (flight: Flight): ClosePreparationResult => ({ status: 'blocked',
    code: flight.stage === 'settle-document' ? 'document-result-unknown' : 'editor-unavailable' })
  const finish = (flight: Flight, input: unknown) => {
    if (!owned(flight)) return
    let result = parseClosePreparationResult(input)
    if (!result || (result.status === 'ready' && flight.stage !== 'settle-preferences')) result = unknownResult(flight)
    stopHeartbeat(flight)
    flight.terminal = Object.freeze({ ...flight.identity, sequence: ++flight.sequence, type: 'result', result })
    send(flight.terminal)
  }
  const detach = options.transport.subscribe(input => {
    if (disposed) return
    const identity = parseClosePreparationRequest(input)
    if (!identity) return
    if (current) {
      const same = identity.attemptId === current.identity.attemptId && identity.generation === current.identity.generation
        && identity.requestId === current.identity.requestId
      if (same) { if (current.terminal) send(current.terminal); return }
      if (!current.terminal || identity.generation <= current.identity.generation) {
        const result: ClosePreparationResult = {
          status: 'blocked', code: !current.terminal ? 'document-result-unknown' : 'editor-unavailable',
        }
        send(Object.freeze({ ...identity, sequence: 1, type: 'result', result }))
        return
      }
    }
    const flight: Flight = { identity, stage: 'prepare-editor', sequence: 0 }
    current = flight
    const captured = registration?.handler
    if (!captured) { finish(flight, { status: 'failed', code: 'editor-unavailable' }); return }
    const heartbeat = () => {
      if (owned(flight)) send(Object.freeze({ ...identity, sequence: ++flight.sequence, type: 'heartbeat' }))
    }
    flight.timer = setInterval(heartbeat, 1_000)
    heartbeat()
    const context: ClosePreparationHandlerContext = Object.freeze({ ...identity,
      enter(stage: ClosePreparationStage) {
        if (!owned(flight) || stage === flight.stage || !canTransitionClosePreparation(flight.stage, stage)) return
        flight.stage = stage
        send(Object.freeze({ ...identity, sequence: ++flight.sequence, type: 'stage', stage }))
      },
    })
    void Promise.resolve().then(() => owned(flight) ? captured(context) : undefined).then(
      result => finish(flight, result), () => finish(flight, unknownResult(flight)),
    )
  })
  return {
    setHandler(next) {
      if (disposed) return () => undefined
      const ownedRegistration = { handler: next }
      registration = ownedRegistration
      return () => { if (registration === ownedRegistration) registration = undefined }
    },
    dispose() {
      if (disposed) return
      disposed = true
      registration = undefined
      if (current) stopHeartbeat(current)
      try { detach() } catch { /* Detaching observers cannot authorize a pending write. */ }
    },
  }
}
