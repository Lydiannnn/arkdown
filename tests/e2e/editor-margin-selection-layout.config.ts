import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'editor-margin-selection-layout.spec.ts',
  globalSetup: undefined,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  projects: ([1, 1.25, 1.5, 2] as const).map((deviceScaleFactor) => ({
    name: `dpr-${deviceScaleFactor}`,
    metadata: { requestedDpr: deviceScaleFactor },
    use: {
      browserName: 'chromium' as const,
      deviceScaleFactor,
      viewport: { width: 1440, height: 720 },
    },
  })),
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
