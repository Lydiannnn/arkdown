import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'sidebar-transition-layout.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['line']],
  projects: ([1, 1.25, 1.5, 2] as const).map((deviceScaleFactor) => ({
    name: `dpr-${deviceScaleFactor}`,
    metadata: { requestedDpr: deviceScaleFactor },
    use: {
      browserName: 'chromium' as const,
      deviceScaleFactor,
      viewport: { width: 960, height: 540 },
    },
  })),
})
