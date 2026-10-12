import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { installStartupWindowCloseGuard } from '../../src/main/startup-window-close-guard'

it('keeps recovery and warning prompt windows from quitting startup, then restores normal quit', () => {
  const application = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const finishStartup = installStartupWindowCloseGuard(application)
  expect(application.listenerCount('window-all-closed')).toBe(1)
  application.emit('window-all-closed')
  application.emit('window-all-closed')
  expect(application.quit).not.toHaveBeenCalled()
  finishStartup()
  finishStartup()
  application.emit('window-all-closed')
  expect(application.quit).toHaveBeenCalledOnce()
})
it('holds the process after its final document closes while update handoff is active', () => {
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() }); let hold = true
  installStartupWindowCloseGuard(app, () => hold)()
  app.emit('window-all-closed'); expect(app.quit).not.toHaveBeenCalled()
  hold = false; app.emit('window-all-closed'); expect(app.quit).toHaveBeenCalledOnce()
})
