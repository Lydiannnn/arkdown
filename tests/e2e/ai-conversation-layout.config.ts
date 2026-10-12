import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'ai-conversation-layout.spec.ts',
  workers: 1,
  use: { browserName: 'chromium', channel: 'chrome', viewport: { width: 1100, height: 820 }, deviceScaleFactor: 1.5 },
})
