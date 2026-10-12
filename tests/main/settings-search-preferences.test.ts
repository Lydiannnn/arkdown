import { expect, it } from 'vitest'
import { SettingsStore } from '../../src/main/settings/settings-store'
import { DEFAULT_BACKGROUND_SETTINGS } from '../../src/shared/background-settings'

it('loads valid browser search preferences and drops unsafe custom templates', async () => {
  const validStore = new SettingsStore('C:\\portable', Date.now, {
    readTextFile: async () => JSON.stringify({
      lastWorkspace: null,
      search: {
        provider: 'google',
        customTemplate: '',
      },
    }),
  })
  await expect(validStore.load()).resolves.toEqual({
    lastWorkspace: null,
    windowBounds: undefined,
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
    search: {
      provider: 'google',
      customTemplate: '',
    },
  })

  const unsafeStore = new SettingsStore('C:\\portable', Date.now, {
    readTextFile: async () => JSON.stringify({
      lastWorkspace: null,
      search: {
        provider: 'custom',
        customTemplate: 'javascript:alert(1)?q={query}',
      },
    }),
  })
  await expect(unsafeStore.load()).resolves.toEqual({
    lastWorkspace: null,
    windowBounds: undefined,
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
    search: undefined,
  })

  const removedProviderStore = new SettingsStore('C:\\portable', Date.now, {
    readTextFile: async () => JSON.stringify({
      lastWorkspace: null,
      search: {
        provider: 'duckduckgo',
        customTemplate: '',
      },
    }),
  })
  await expect(removedProviderStore.load()).resolves.toEqual({
    lastWorkspace: null,
    windowBounds: undefined,
    layout: { leftSidebarWidth: 300, rightSidebarWidth: 530 },
    screenshotOcr: { preferredTier: 'small' },
    mainBackground: DEFAULT_BACKGROUND_SETTINGS,
    shellIntegration: { documentOpenMenu: true, markdownShellNew: true },
    search: undefined,
  })
})
