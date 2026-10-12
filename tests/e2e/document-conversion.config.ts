import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'document-conversion.spec.ts',
  globalSetup: './global-setup.ts',
  timeout: 300_000,
  expect: { timeout: 45_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: '../../test-results/document-conversion-electron',
  reporter: [['line']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
