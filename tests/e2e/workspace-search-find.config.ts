import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'workspace-search-find.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['line']],
  use: { browserName: 'chromium', headless: true, viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1.5 },
})
