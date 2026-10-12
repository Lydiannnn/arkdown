import { parseCodexCliConnectionTestResult, type CodexCliConnectionTestResult } from './large-model-settings'

export type CodexCliLoginStatus = 'completed' | 'cancelled' | 'failed' | 'not-found' | 'timeout'
export interface CodexCliLoginOutcome { status: CodexCliLoginStatus }
export type CodexCliLoginResult =
  | { status: 'completed'; connection: CodexCliConnectionTestResult }
  | { status: Exclude<CodexCliLoginStatus, 'completed'> }

export function parseCodexCliLoginResult(value: unknown): CodexCliLoginResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!Object.hasOwn(record, 'status')) return undefined
  if (record.status === 'completed') {
    if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'connection')) return undefined
    const connection = parseCodexCliConnectionTestResult(record.connection)
    return connection ? { status: 'completed', connection } : undefined
  }
  if (Object.keys(record).length !== 1 || !['cancelled', 'failed', 'not-found', 'timeout'].includes(record.status as string)) return undefined
  return { status: record.status as Exclude<CodexCliLoginStatus, 'completed'> }
}
