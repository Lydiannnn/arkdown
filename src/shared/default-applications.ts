export interface DefaultApplicationsStatus { markdown: boolean; text: boolean }
export interface DefaultApplicationsPromptState { starts: number; handled: boolean; version?: string; installationId?: string }
export function normalizeDefaultApplicationsPrompt(value: unknown): DefaultApplicationsPromptState {
  const input = value as Partial<DefaultApplicationsPromptState> | null
  return { starts: typeof input?.starts === 'number' && Number.isSafeInteger(input.starts) ? Math.max(0, Math.min(2, input.starts)) : 0,
    handled: input?.handled === true,
    ...(typeof input?.version === 'string' && input.version.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(input.version) ? { version: input.version } : {}),
    ...(typeof input?.installationId === 'string' && /^\d{14}-\d{1,10}$/.test(input.installationId) ? { installationId: input.installationId } : {}),
  }
}
