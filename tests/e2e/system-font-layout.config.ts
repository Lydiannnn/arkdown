import { defineConfig } from '@playwright/test'
export default defineConfig({ testDir: '.', testMatch: 'system-font-layout.spec.ts', workers: 1,
  reporter: [['line']], timeout: 30_000,
  use: { headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1.5,
    launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
})
