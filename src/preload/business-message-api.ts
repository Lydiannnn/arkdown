import { BUSINESS_MESSAGE_CHANNELS as channels, parseBusinessMessageState, type BusinessMessageApi } from '../shared/business-message-dialog'

export function createBusinessMessageApi(transport: { invoke(channel: string, input?: unknown): Promise<unknown> }): BusinessMessageApi {
  return Object.freeze<BusinessMessageApi>({
    get: async () => parseBusinessMessageState(await transport.invoke(channels.get)),
    ready: async input => await transport.invoke(channels.ready, { requestId: input.requestId, height: input.height }) === true,
    respond: async input => await transport.invoke(channels.respond, { requestId: input.requestId, response: input.response }) === true,
  })
}
