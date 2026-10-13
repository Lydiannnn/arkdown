import { expect, it, vi } from 'vitest'
import { DefaultApplicationsStartup } from '../../src/main/default-applications/startup'
import { SettingsCoordinator } from '../../src/main/settings/settings-coordinator'

function fixture() {
  const settings = new SettingsCoordinator({ save: async () => {} }, { lastWorkspace: 'C:/Notes' })
  const service = {
    getStatus: vi.fn(async () => ({ markdown: false, text: false })),
    setEnabled: vi.fn(async () => ({ markdown: true, text: true })),
  }
  const launch = (version = '1.0.4', installationId = '20261013000000-1') =>
    new DefaultApplicationsStartup(settings, service, version, async () => installationId)
  return { settings, service, launch }
}

it('offers on the first close once, retaining the independent second-start offer after rejection', async () => {
  const { launch, settings } = fixture()
  const prompt = vi.fn(async () => false)
  const first = launch()
  await first.onReady(prompt)
  expect(prompt).not.toHaveBeenCalled()
  await Promise.all([first.onClose(prompt), first.onClose(prompt)])
  expect(prompt).toHaveBeenCalledOnce()
  expect(settings.get().defaultApplicationsPrompt).toMatchObject({ starts: 1, handled: false, closeHandled: true })
  const second = launch()
  await second.onReady(prompt)
  await second.onClose(prompt)
  const third = launch()
  await third.onReady(prompt)
  await third.onClose(prompt)
  expect(prompt).toHaveBeenCalledTimes(2)
  expect(settings.get().lastWorkspace).toBe('C:/Notes')
})

it('counts a quick first close before deferred startup only once', async () => {
  const { launch, settings } = fixture()
  const prompt = vi.fn(async () => false)
  const first = launch()
  await first.onClose(prompt)
  await first.onReady(prompt)
  expect(prompt).toHaveBeenCalledOnce()
  expect(settings.get().defaultApplicationsPrompt?.starts).toBe(1)
  await launch().onReady(prompt)
  expect(prompt).toHaveBeenCalledTimes(2)
})

it('applies only an affirmative close offer and stays quiet when both types are already defaults', async () => {
  const { launch, service } = fixture()
  const prompt = vi.fn(async () => true)
  await launch().onClose(prompt)
  expect(service.setEnabled).toHaveBeenCalledExactlyOnceWith(true)
  service.getStatus.mockResolvedValue({ markdown: true, text: true })
  const second = launch()
  await second.onReady(prompt)
  await second.onClose(prompt)
  expect(prompt).toHaveBeenCalledOnce()
  expect(service.setEnabled).toHaveBeenCalledOnce()
})

it('resets the close offer on upgrade or reinstall without reoffering for the same installation', async () => {
  const { launch } = fixture()
  const prompt = vi.fn(async () => false)
  await launch().onClose(prompt)
  await launch().onClose(prompt)
  await launch('1.0.5').onClose(prompt)
  await launch('1.0.5', '20261013000001-2').onClose(prompt)
  await launch('1.0.5', '20261013000001-2').onClose(prompt)
  expect(prompt).toHaveBeenCalledTimes(3)
})

it('serializes a closing window behind an already displayed startup offer', async () => {
  const { launch, settings } = fixture()
  await launch().onReady(async () => false)
  let answer!: (accepted: boolean) => void
  const startupPrompt = vi.fn(() => new Promise<boolean>(resolve => { answer = resolve }))
  const closePrompt = vi.fn(async () => false)
  const second = launch()
  const ready = second.onReady(startupPrompt)
  await vi.waitFor(() => expect(startupPrompt).toHaveBeenCalledOnce())
  const closing = second.onClose(closePrompt)
  expect(closePrompt).not.toHaveBeenCalled()
  answer(false)
  await Promise.all([ready, closing])
  expect(closePrompt).toHaveBeenCalledOnce()
  expect(settings.get().defaultApplicationsPrompt).toMatchObject({ handled: true, closeHandled: true })
})

it('does not consume a close offer when registration fails', async () => {
  const { launch, settings, service } = fixture()
  service.setEnabled.mockRejectedValueOnce(new Error('registration unavailable'))
  await expect(launch().onClose(async () => true)).rejects.toThrow('registration unavailable')
  expect(settings.get().defaultApplicationsPrompt?.closeHandled).not.toBe(true)
  const prompt = vi.fn(async () => false)
  await launch().onClose(prompt)
  expect(prompt).toHaveBeenCalledOnce()
})

it('defers a late startup offer after workspace selection starts without consuming either reminder', async () => {
  const { launch, settings, service } = fixture()
  await launch().onReady(async () => false)
  let resolveStatus!: (status: { markdown: boolean; text: boolean }) => void
  service.getStatus.mockImplementationOnce(() => new Promise(resolve => { resolveStatus = resolve }))
  const prompt = vi.fn(async () => false)
  const second = launch()
  const starting = second.onReady(prompt)
  await vi.waitFor(() => expect(resolveStatus).toBeTypeOf('function'))
  second.deferStartupOffer()
  resolveStatus({ markdown: true, text: false })
  await starting
  expect(prompt).not.toHaveBeenCalled()
  expect(settings.get().defaultApplicationsPrompt).toMatchObject({ starts: 2, handled: false })
  expect(settings.get().defaultApplicationsPrompt?.closeHandled).not.toBe(true)
  await second.onClose(prompt)
  expect(prompt).toHaveBeenCalledOnce()
  await launch().onReady(prompt)
  expect(prompt).toHaveBeenCalledTimes(2)
})

it('defers startup before the timer runs but still records the start and allows the first close offer', async () => {
  const { launch, settings } = fixture()
  const first = launch()
  first.deferStartupOffer()
  const prompt = vi.fn(async () => false)
  await first.onReady(prompt)
  expect(settings.get().defaultApplicationsPrompt?.starts).toBe(1)
  expect(prompt).not.toHaveBeenCalled()
  await first.onClose(prompt)
  expect(prompt).toHaveBeenCalledOnce()
  await launch().onReady(prompt)
  expect(prompt).toHaveBeenCalledTimes(2)
})

it.each([
  { markdown: true, text: true, offers: 0 },
  { markdown: true, text: false, offers: 1 },
  { markdown: false, text: true, offers: 1 },
  { markdown: false, text: false, offers: 1 },
])('checks both association types before offering on close: %j', async ({ markdown, text, offers }) => {
  const { launch, service } = fixture()
  service.getStatus.mockResolvedValue({ markdown, text })
  const prompt = vi.fn(async () => false)
  await launch().onClose(prompt)
  expect(prompt).toHaveBeenCalledTimes(offers)
  expect(service.setEnabled).not.toHaveBeenCalled()
})
