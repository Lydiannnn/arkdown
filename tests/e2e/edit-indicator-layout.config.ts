import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'edit-indicator-layout.spec.ts',
  workers: 1,
  projects: [1, 1.25, 1.5, 2].map((deviceScaleFactor) => ({
    name: `dpr-${deviceScaleFactor}`,
    use: {
      browserName: 'chromium',
      deviceScaleFactor,
      viewport: { width: 1200, height: 820 },
    },
  })),
})
