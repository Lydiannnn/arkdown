import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    clearMocks: true,
    // Set ARKDOWN_SERIAL_TESTS=1 only for explicit serial evidence runs.
    fileParallelism: process.env.ARKDOWN_SERIAL_TESTS !== '1',
  },
})
