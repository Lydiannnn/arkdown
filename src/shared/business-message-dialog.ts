export const BUSINESS_MESSAGE_CHANNELS = {
  get: 'business-message:get', ready: 'business-message:ready', respond: 'business-message:respond',
} as const

export interface BusinessMessageState {
  requestId: string
  title: string
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
  dark: boolean
}
export interface BusinessMessageApi {
  get(): Promise<BusinessMessageState | null>
  ready(input: { requestId: string; height: number }): Promise<boolean>
  respond(input: { requestId: string; response: number }): Promise<boolean>
}
export function parseBusinessMessageState(input: unknown): BusinessMessageState | null {
  if (!input || typeof input !== 'object') return null
  const value = input as Record<string, unknown>
  if (typeof value.requestId !== 'string' || value.requestId.length > 128
    || typeof value.title !== 'string' || value.title.length > 512
    || typeof value.message !== 'string' || value.message.length > 8192
    || typeof value.detail !== 'string' || value.detail.length > 16384
    || !Array.isArray(value.buttons) || !value.buttons.length || value.buttons.length > 8
    || value.buttons.some(text => typeof text !== 'string' || text.length > 128)
    || typeof value.dark !== 'boolean') return null
  for (const key of ['defaultId', 'cancelId'] as const) {
    if (!Number.isInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) >= value.buttons.length) return null
  }
  return { requestId: value.requestId, title: value.title, message: value.message, detail: value.detail,
    buttons: [...value.buttons], defaultId: value.defaultId as number, cancelId: value.cancelId as number, dark: value.dark }
}
