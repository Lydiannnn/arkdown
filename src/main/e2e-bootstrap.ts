import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DocumentPersistenceEvent } from './documents/document-service'
import type { AppSettings } from './settings/settings-store'

interface SettingsWriter {
  save(settings: AppSettings): Promise<void>
}

interface E2eEnvironment {
  ARKDOWN_E2E?: string
  ARKDOWN_E2E_WORKSPACE?: string
  ARKDOWN_E2E_SAVE_DELAY_MS?: string
  ARKDOWN_E2E_TRAY_STATE_DIRECTORY?: string
}

export interface E2eTrayState {
  role: 'arkdown' | 'arknote'
  processId: number
  active: number
  created: number
  destroyed: number
}

export function createE2eTrayProbe(options: {
  environment: E2eEnvironment
  processId: number
  role: E2eTrayState['role']
  writeState?: (state: E2eTrayState) => void
}): { created(): void; destroyed(): void } {
  const directory = options.environment.ARKDOWN_E2E_TRAY_STATE_DIRECTORY
  const enabled = options.environment.ARKDOWN_E2E === '1'
    && typeof directory === 'string'
    && path.isAbsolute(directory)
  if (!enabled) return { created: () => undefined, destroyed: () => undefined }
  const writeState = options.writeState ?? ((state: E2eTrayState) => {
    writeFileSync(path.join(directory, options.role + '.json'), JSON.stringify(state), 'utf8')
  })
  const state: E2eTrayState = {
    role: options.role,
    processId: options.processId,
    active: 0,
    created: 0,
    destroyed: 0,
  }
  const write = () => writeState({ ...state })
  write()
  return {
    created: () => {
      state.active += 1
      state.created += 1
      write()
    },
    destroyed: () => {
      state.active = Math.max(0, state.active - 1)
      state.destroyed += 1
      write()
    },
  }
}

const NOOP_SETTINGS_WRITER: SettingsWriter = {
  save: async () => undefined,
}

export function configureE2eBootstrap<T extends SettingsWriter>(
  settings: AppSettings,
  writer: T,
  environment: E2eEnvironment,
): { settings: AppSettings; writer: SettingsWriter } {
  const workspace = environment.ARKDOWN_E2E === '1'
    ? environment.ARKDOWN_E2E_WORKSPACE
    : undefined
  if (!workspace) return { settings, writer }

  return {
    settings: { ...settings, lastWorkspace: workspace },
    writer: NOOP_SETTINGS_WRITER,
  }
}

export function createE2ePersistenceObserver(
  environment: E2eEnvironment,
): ((event: DocumentPersistenceEvent) => Promise<void>) | undefined {
  if (environment.ARKDOWN_E2E !== '1') return undefined
  const delayMs = Number(environment.ARKDOWN_E2E_SAVE_DELAY_MS)
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 10_000) return undefined

  return async (event) => {
    if (event.stage !== 'save-content-start') return
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
  }
}

export function shouldUseNativeLoginItemSettings(
  environment: E2eEnvironment,
): boolean {
  return environment.ARKDOWN_E2E !== '1'
}
