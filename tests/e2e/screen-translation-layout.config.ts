import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.', testMatch: 'screen-translation-layout.spec.ts', workers: 1,
  timeout: 60_000, expect: { timeout: 15_000 },
  outputDir: '../../test-results/screen-translation-layout', reporter: [['line']],
  use: { browserName: 'chromium', deviceScaleFactor: 1.5, viewport: { width: 360, height: 450 },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
})
