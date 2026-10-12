import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'background-settings-layout.spec.ts',
  workers: 1,
  use: {
    browserName: 'chromium',
    baseURL: 'http://127.0.0.1:4174',
    deviceScaleFactor: 1.5,
    viewport: { width: 600, height: 1000 },
  },
})
