import path from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ on: vi.fn(), setAppUserModelId: vi.fn() }))
vi.mock('electron', () => ({ app: { ...mock, isPackaged: false, getAppPath: () => '/application' } }))
import { configureApplicationBranding } from '../../src/main/branding'
beforeEach(() => vi.clearAllMocks())
it.each(['arkdown', 'arknote'] as const)('assigns the %s identity to every new window', mode => {
  configureApplicationBranding(mode)
  const window = { setIcon: vi.fn() }
  expect(mock.on).toHaveBeenCalledWith('browser-window-created', expect.any(Function))
  mock.on.mock.calls[0][1]({}, window)
  expect(window.setIcon).toHaveBeenCalledWith(path.join('/application', 'assets', 'branding', mode === 'arknote' ? 'arknote-app-256.png' : 'arkdown-app-rounded-256.png'))
  if (process.platform === 'win32') expect(mock.setAppUserModelId).toHaveBeenCalledWith(mode === 'arknote' ? 'Arknote.Desktop' : 'Arkdown.Desktop')
})
