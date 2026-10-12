import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'preferences-layout.spec.ts',
  workers: 1,
  projects: [1, 1.25, 1.5, 2].map((deviceScaleFactor) => ({
    name: `dpr-${deviceScaleFactor}`,
    use: {
      browserName: 'chromium',
      channel: 'chrome',
      baseURL: 'http://127.0.0.1:4174',
      deviceScaleFactor,
      viewport: { width: 1280, height: 720 },
    },
  })),
})
