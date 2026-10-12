import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'screenshot-translation-layout.spec.ts',
  globalSetup: undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers: 4,
  reporter: [['line']],
  projects: ([1, 1.25, 1.5, 2] as const).map((deviceScaleFactor) => ({
    name: `dpr-${deviceScaleFactor}`,
    metadata: { requestedDpr: deviceScaleFactor },
    use: {
      browserName: 'chromium',
      deviceScaleFactor,
      viewport: { width: 1280, height: 720 },
    },
  })),
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
