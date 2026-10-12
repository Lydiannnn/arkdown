import { parseClosePreparationAttempt, type ClosePreparationAttempt } from './close-preparation'
import { isExactOwnRecord } from './ai-conversation'

export const CLOSE_RECOVERY_CHANNELS = Object.freeze({ get: 'arkdown:close-recovery:get',
  action: 'arkdown:close-recovery:action', changed: 'arkdown:close-recovery:changed', ready: 'arkdown:close-recovery:ready' })
export const CLOSE_RECOVERY_STAGES = ['prepare-editor', 'await-user', 'await-preferences', 'settle-document', 'settle-preferences',
  'quiesce-owner', 'drain-ipc', 'persist-window', 'finalize', 'native-close', 'restore-editor'] as const
export const CLOSE_RECOVERY_ERRORS = ['editor-unavailable', 'document-save-failed', 'draft-end-failed',
  'document-result-unknown', 'preferences-save-failed', 'ai-drain-failed', 'owner-close-failed', 'ipc-drain-failed',
  'window-settings-failed', 'cleanup-failed', 'native-close-failed', 'restore-failed'] as const
const ACTIONS = ['return', 'retry', 'copy', 'continue-using', 'stop-ai-and-close'] as const
export interface CloseRecoveryState {
  attemptId: string; generation: number
  stage: typeof CLOSE_RECOVERY_STAGES[number]
  error: typeof CLOSE_RECOVERY_ERRORS[number] | null
  feedback: 'hidden' | 'progress' | 'await-user' | 'no-progress' | 'long-wait'
  rendererUnavailable: boolean
  elapsedMs: number
  canReturn: boolean; canRetry: boolean; confirmAi: boolean
  dark: boolean; themeColor: string
}
export interface CloseRecoveryAction { attemptId: string; generation: number; action: typeof ACTIONS[number] }
export type CloseRecoveryReady = ClosePreparationAttempt & { height?: number }
export interface CloseRecoveryApi {
  get(): Promise<CloseRecoveryState | null>
  ready(attempt: CloseRecoveryReady): Promise<boolean>
  subscribe(handler: (state: CloseRecoveryState) => void): () => void
  act(command: CloseRecoveryAction): Promise<boolean>
}
export function parseCloseRecoveryReady(input: unknown): CloseRecoveryReady | undefined {
  try {
    if (!isExactOwnRecord(input, ['attemptId', 'generation']) && !isExactOwnRecord(input, ['attemptId', 'generation', 'height'])) return undefined
    const attempt = parseClosePreparationAttempt({ attemptId: input.attemptId, generation: input.generation })
    if (!attempt || input.height !== undefined && (typeof input.height !== 'number' || !Number.isFinite(input.height) || input.height <= 0)) return undefined
    return { ...attempt, ...(input.height === undefined ? {} : { height: input.height as number }) }
  } catch { return undefined }
}
export function parseCloseRecoveryAction(input: unknown): CloseRecoveryAction | undefined {
  try {
  if (!isExactOwnRecord(input, ['attemptId', 'generation', 'action'])) return undefined
  const attempt = parseClosePreparationAttempt({ attemptId: input.attemptId, generation: input.generation })
  return attempt && ACTIONS.includes(input.action as CloseRecoveryAction['action'])
    ? { ...attempt, action: input.action as CloseRecoveryAction['action'] } : undefined
  } catch { return undefined }
}
export function parseCloseRecoveryState(input: unknown): CloseRecoveryState | undefined {
  try {
  if (!isExactOwnRecord(input, ['attemptId', 'generation', 'stage', 'error', 'feedback', 'rendererUnavailable',
    'elapsedMs', 'canReturn', 'canRetry', 'confirmAi', 'dark', 'themeColor'])) return undefined
  const attempt = parseClosePreparationAttempt({ attemptId: input.attemptId, generation: input.generation })
  if (!attempt || !CLOSE_RECOVERY_STAGES.includes(input.stage as CloseRecoveryState['stage'])
    || !(input.error === null || CLOSE_RECOVERY_ERRORS.includes(input.error as CloseRecoveryState['error'] & string))
    || !['hidden', 'progress', 'await-user', 'no-progress', 'long-wait'].includes(input.feedback as string)
    || typeof input.elapsedMs !== 'number' || !Number.isFinite(input.elapsedMs) || input.elapsedMs < 0
    || input.elapsedMs > Number.MAX_SAFE_INTEGER || typeof input.themeColor !== 'string' || !/^#[0-9a-f]{6}$/iu.test(input.themeColor)
    || ['rendererUnavailable', 'canReturn', 'canRetry', 'confirmAi', 'dark'].some(key => typeof input[key] !== 'boolean')) return undefined
  return Object.freeze({ ...input }) as unknown as CloseRecoveryState
  } catch { return undefined }
}
