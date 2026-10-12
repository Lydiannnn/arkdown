import { defineConfig } from '@playwright/test'

const packageFreeSpecs = [
  '**/*-layout.spec.ts',
  '**/task12-list-quote-styles.spec.ts',
]
const geometrySpecs = [
  '**/menu-hairlines.spec.ts',
  '**/edit-indicators.spec.ts',
]
const nativeOnlySpecs = ['**/screenshot-translation.spec.ts']

export default defineConfig({
  globalSetup: './tests/e2e/global-setup.ts',
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  outputDir: 'test-results/electron',
  reporter: [['line']],
  projects: [
    {
      name: 'native-150',
      testIgnore: packageFreeSpecs,
      metadata: { requestedDpr: 1.5, expectedSystemScale: 1.5 },
    },
    ...([1, 1.25, 1.5, 2] as const).map((requestedDpr) => ({
      name: `geometry-dpr-${requestedDpr}`,
      testMatch: geometrySpecs,
      testIgnore: nativeOnlySpecs,
      metadata: { requestedDpr, expectedSystemScale: 1.5 },
    })),
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
