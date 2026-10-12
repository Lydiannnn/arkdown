import { expect, it, vi } from 'vitest'
import {
  configureE2eBootstrap,
  shouldUseNativeLoginItemSettings,
} from '../../src/main/e2e-bootstrap'
import type { AppSettings } from '../../src/main/settings/settings-store'

const settings: AppSettings = {
  lastWorkspace: 'C:\\saved',
  windowBounds: { width: 900, height: 700, x: 10, y: 20 },
}

it('overrides only the exact E2E gate and suppresses settings writes', async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  const result = configureE2eBootstrap(
    settings,
    { save },
    { ARKDOWN_E2E: '1', ARKDOWN_E2E_WORKSPACE: 'C:\\temporary' },
  )

  expect(result.settings).toEqual({
    ...settings,
    lastWorkspace: 'C:\\temporary',
  })
  await result.writer.save(result.settings)
  expect(save).not.toHaveBeenCalled()
})

it.each([
  {},
  { ARKDOWN_E2E: 'true', ARKDOWN_E2E_WORKSPACE: 'C:\\temporary' },
  { ARKDOWN_E2E: '01', ARKDOWN_E2E_WORKSPACE: 'C:\\temporary' },
  { ARKDOWN_E2E: '1' },
  { ARKDOWN_E2E: '1', ARKDOWN_E2E_WORKSPACE: '' },
])('keeps normal settings and persistence outside the exact complete gate: %j', async (environment) => {
  const save = vi.fn().mockResolvedValue(undefined)
  const writer = { save }
  const result = configureE2eBootstrap(settings, writer, environment)

  expect(result).toEqual({ settings, writer })
  await result.writer.save(result.settings)
  expect(save).toHaveBeenCalledWith(settings)
})

it('never writes the native Windows login item during the exact E2E gate', () => {
  expect(shouldUseNativeLoginItemSettings({ ARKDOWN_E2E: '1' })).toBe(false)
  expect(shouldUseNativeLoginItemSettings({ ARKDOWN_E2E: 'true' })).toBe(true)
  expect(shouldUseNativeLoginItemSettings({})).toBe(true)
})
