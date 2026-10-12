import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: '.', testMatch: 'startup-guide-layout.spec.ts', workers: 1,
  reporter: [['line']], timeout: 30_000,
  outputDir: '../../.superpowers/sdd/2026-09-08-ui-backlog/task-10-browser-artifacts',
  use: { headless: true, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5,
    launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
})
