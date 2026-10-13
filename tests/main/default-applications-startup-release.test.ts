import { expect, it, vi } from 'vitest'
import { DefaultApplicationsStartup } from '../../src/main/default-applications/startup'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'
import type { DefaultApplicationsPromptState } from '../../src/shared/default-applications'
import { createSettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-schema'
import type { SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'
import { PublicError } from '../../src/shared/public-errors'

function fixture(previous: DefaultApplicationsPromptState = { starts: 2, handled: true }) {
  const save = vi.fn(async () => {})
  const settings = new SettingsCoordinator({ save }, { lastWorkspace: 'C:/Notes', defaultApplicationsPrompt: previous })
  const getStatus = vi.fn(async () => ({ markdown: false, text: false }))
  const setEnabled = vi.fn(async () => ({ markdown: true, text: true }))
  const prompt = vi.fn(async () => false)
  const start = (version = '1.0.2', installationId?: string) =>
    new DefaultApplicationsStartup(settings, { getStatus, setEnabled }, version, async () => installationId).onReady(prompt)
  return { settings, save, getStatus, setEnabled, prompt, start }
}

it('checks an upgraded legacy profile once without clearing its workspace', async () => {
  const test = fixture()
  await test.start()
  await test.start()
  expect(test.getStatus).toHaveBeenCalledOnce()
  expect(test.prompt).toHaveBeenCalledOnce()
  expect(test.setEnabled).not.toHaveBeenCalled()
  expect(test.settings.get()).toMatchObject({ lastWorkspace: 'C:/Notes', defaultApplicationsPrompt: { version: '1.0.2', handled: true } })
})

function observedFixture() {
  const observed = createSettingsTransactionSnapshot({ lastWorkspace: null, defaultApplicationsPrompt: { starts: 2, handled: false, version: '1.0.4' } })
  const recordApplicationStart = vi.fn(async () => structuredClone(observed))
  const markApplicationOfferHandled = vi.fn(async (_snapshot: SettingsTransactionSnapshot) => {})
  const authority = { recordApplicationStart, markApplicationOfferHandled,
    markApplicationCloseOfferHandled: vi.fn(async (_snapshot: SettingsTransactionSnapshot) => {}),
    readFresh: vi.fn(async () => structuredClone(observed)),
  }
  const service = { getStatus: vi.fn(async () => ({ markdown: false, text: false })),
    setEnabled: vi.fn(async () => ({ markdown: true, text: true })) }
  const startup = new DefaultApplicationsStartup({ authority }, service, '1.0.4')
  return { authority, service, startup, observed }
}

it('uses the original authoritative offer across an asynchronous native prompt', async () => {
  const test = observedFixture()
  await test.startup.onReady(async () => {
    test.observed.revision = 9
    test.observed.settings.defaultApplicationsPrompt = { starts: 2, handled: false, version: '1.0.5' }
    return true
  })
  expect(test.authority.recordApplicationStart).toHaveBeenCalledExactlyOnceWith('1.0.4', undefined)
  expect(test.authority.markApplicationOfferHandled).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    revision: 0, settings: expect.objectContaining({ defaultApplicationsPrompt: { starts: 2, handled: false, version: '1.0.4' } }),
  }))
  expect(test.service.setEnabled).toHaveBeenCalledOnce()
})

it('never repeats a native action or consumes another offer after completion conflicts', async () => {
  const test = observedFixture()
  test.authority.markApplicationOfferHandled.mockRejectedValueOnce(new Error('SETTINGS_COMMAND_CONFLICT'))
  const prompt = vi.fn(async () => true)
  await expect(test.startup.onReady(prompt)).rejects.toThrow('SETTINGS_COMMAND_CONFLICT')
  await test.startup.onReady(prompt)
  expect(prompt).toHaveBeenCalledOnce()
  expect(test.service.setEnabled).toHaveBeenCalledOnce()
  expect(test.authority.markApplicationOfferHandled).toHaveBeenCalledOnce()
})

it('leaves the observed offer retryable when a native action fails', async () => {
  const test = observedFixture()
  test.service.setEnabled.mockRejectedValueOnce(new Error('native unavailable'))
  await expect(test.startup.onReady(async () => true)).rejects.toThrow('native unavailable')
  expect(test.authority.markApplicationOfferHandled).not.toHaveBeenCalled()
})

it.each(['record', 'query', 'prompt', 'handled'] as const)('keeps a background %s failure separate from a requested default-app change', async phase => {
  const test = observedFixture()
  const failure = new Error('background failed')
  if (phase === 'record') test.authority.recordApplicationStart.mockRejectedValueOnce(failure)
  if (phase === 'query') test.service.getStatus.mockRejectedValueOnce(failure)
  if (phase === 'handled') test.authority.markApplicationOfferHandled.mockRejectedValueOnce(failure)
  await expect(test.startup.onReady(async () => {
    if (phase === 'prompt') throw failure
    return false
  })).rejects.toBe(failure)
  expect(test.service.setEnabled).not.toHaveBeenCalled()
})

it('identifies only an explicitly requested native enable failure for the user-facing error dialog', async () => {
  const test = observedFixture()
  const failure = new PublicError('SHELL_INTEGRATION_CONFLICT')
  test.service.setEnabled.mockRejectedValueOnce(failure)
  await expect(test.startup.onReady(async () => true)).rejects.toMatchObject({
    name: 'DefaultApplicationsEnableError', cause: failure,
  })
  expect(test.authority.markApplicationOfferHandled).not.toHaveBeenCalled()
})

it('identifies an incomplete explicit enable even if offer bookkeeping also fails', async () => {
  const test = observedFixture()
  test.service.setEnabled.mockResolvedValueOnce({ markdown: true, text: false })
  test.authority.markApplicationOfferHandled.mockRejectedValueOnce(new Error('record failed'))
  await expect(test.startup.onReady(async () => true)).rejects.toMatchObject({
    name: 'DefaultApplicationsEnableError', cause: { code: 'DEFAULT_APPLICATIONS_NOT_APPLIED' },
  })
})

it('offers again for the next version, including after an earlier rejection', async () => {
  const test = fixture()
  await test.start('1.0.2')
  await test.start('1.0.3')
  await test.start('1.0.3')
  expect(test.prompt).toHaveBeenCalledTimes(2)
})

it('checks after reinstalling the same version, preserving settings and consuming only the new installation offer', async () => {
  const test = fixture()
  await test.start('1.0.2', '20260920070000-10000')
  await test.start('1.0.2', '20260920070000-10000')
  await test.start('1.0.2', '20260920070100-20000')
  await test.start('1.0.2', '20260920070100-20000')
  expect(test.prompt).toHaveBeenCalledTimes(2)
  expect(test.settings.get()).toMatchObject({ lastWorkspace: 'C:/Notes', defaultApplicationsPrompt: { installationId: '20260920070100-20000', handled: true } })
})

it('quietly completes the release check when both formats already use Arkdown', async () => {
  const test = fixture()
  test.getStatus.mockResolvedValue({ markdown: true, text: true })
  await test.start()
  test.getStatus.mockResolvedValue({ markdown: false, text: false })
  await test.start()
  expect(test.getStatus).toHaveBeenCalledOnce()
  expect(test.prompt).not.toHaveBeenCalled()
})

it.each([{ markdown: false, text: true }, { markdown: true, text: false }])('offers when either format is missing: %j', async status => {
  const test = fixture()
  test.getStatus.mockResolvedValue(status)
  test.prompt.mockResolvedValue(true)
  await test.start()
  expect(test.prompt).toHaveBeenCalledOnce()
  expect(test.setEnabled).toHaveBeenCalledWith(true)
})

it.each(['query', 'apply'] as const)('keeps a failed %s retryable on the next launch of the same installation', async phase => {
  const test = fixture()
  test.prompt.mockResolvedValue(true)
  if (phase === 'query') test.getStatus.mockRejectedValueOnce(new Error('transient'))
  else test.setEnabled.mockRejectedValueOnce(new Error('transient'))
  await expect(test.start('1.0.2', '20260920070000-10000')).rejects.toThrow('transient')
  expect(test.settings.get().defaultApplicationsPrompt?.handled).toBe(false)
  await test.start('1.0.2', '20260920070000-10000')
  expect(test.settings.get().defaultApplicationsPrompt?.handled).toBe(true)
})

it('retains the second-start timing for a brand-new profile', async () => {
  const test = fixture({ starts: 0, handled: false })
  await test.start()
  expect(test.prompt).not.toHaveBeenCalled()
  await test.start()
  await test.start()
  expect(test.prompt).toHaveBeenCalledOnce()
})

it('does not consume the release offer when its installation marker cannot be read', async () => {
  const test = fixture()
  const startup = new DefaultApplicationsStartup(test.settings, test, '1.0.2', async () => { throw new Error('marker busy') })
  await expect(startup.onReady(test.prompt)).rejects.toThrow('marker busy')
  expect(test.save).not.toHaveBeenCalled()
  expect(test.prompt).not.toHaveBeenCalled()
})
