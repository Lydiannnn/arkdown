export const UPDATE_ACTIONS = ['open', 'later', 'skip', 'download', 'cancel-download', 'dismiss', 'install', 'work-started', 'claim-gate'] as const
export type UpdateAction = typeof UPDATE_ACTIONS[number]
export interface UpdateTransferSnapshot {
  phase: 'idle' | 'downloading' | 'verifying' | 'ready' | 'preparing' | 'closing' | 'failed'
  received: number
  total: number
  error: string | null
  dialog: 'hidden' | 'offer' | 'progress' | 'install'
  forced: boolean
}
export function parseUpdateAction(value: unknown): UpdateAction | undefined {
  return typeof value === 'string' && (UPDATE_ACTIONS as readonly string[]).includes(value) ? value as UpdateAction : undefined
}
export function parseUpdateTransfer(value: unknown): UpdateTransferSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const r = value as Record<string, unknown>
  if (Object.keys(r).length !== 6 || !['idle', 'downloading', 'verifying', 'ready', 'preparing', 'closing', 'failed'].includes(r.phase as string)
    || !['hidden', 'offer', 'progress', 'install'].includes(r.dialog as string) || typeof r.forced !== 'boolean'
    || !(r.error === null || typeof r.error === 'string' && r.error.length <= 2048)
    || !Number.isSafeInteger(r.received) || !Number.isSafeInteger(r.total)
    || (r.received as number) < 0 || (r.total as number) < (r.received as number) || (r.total as number) > 32 * 1024 ** 3
    || r.phase === 'ready' && (r.received !== r.total || !r.total)) return undefined
  return structuredClone(value) as UpdateTransferSnapshot
}
