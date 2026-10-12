import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'workspace-color-marks-layout.spec.ts',
  globalSetup: undefined,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  projects: ([1, 1.25, 1.5, 2] as const).map((deviceScaleFactor) => ({
    name: `dpr-${deviceScaleFactor}`,
    metadata: { requestedDpr: deviceScaleFactor },
    use: {
      browserName: 'chromium',
      deviceScaleFactor,
      viewport: { width: 360, height: 420 },
    },
  })),
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
