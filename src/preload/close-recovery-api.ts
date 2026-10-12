import { CLOSE_RECOVERY_CHANNELS, parseCloseRecoveryAction, parseCloseRecoveryState, parseCloseRecoveryReady, type CloseRecoveryApi } from '../shared/close-recovery'

export function createCloseRecoveryApi(transport: {
  invoke(channel: string, input?: unknown): Promise<unknown>
  subscribe(channel: string, handler: (input: unknown) => void): () => void
}): CloseRecoveryApi {
  return Object.freeze<CloseRecoveryApi>({
    get: async () => parseCloseRecoveryState(await transport.invoke(CLOSE_RECOVERY_CHANNELS.get)) ?? null,
    ready: async input => {
      const attempt = parseCloseRecoveryReady(input)
      return attempt ? await transport.invoke(CLOSE_RECOVERY_CHANNELS.ready, attempt) === true : false
    },
    subscribe: handler => transport.subscribe(CLOSE_RECOVERY_CHANNELS.changed, input => {
      const state = parseCloseRecoveryState(input)
      if (state) handler(state)
    }),
    act: async input => {
      const command = parseCloseRecoveryAction(input)
      return command ? await transport.invoke(CLOSE_RECOVERY_CHANNELS.action, command) === true : false
    },
  })
}
