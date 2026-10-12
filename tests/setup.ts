import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'

afterEach(cleanup)

// Existing interaction tests start after onboarding; its first-use tests clear this marker.
beforeEach(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('arkdown.workspace-intro-seen.v1', '1')
})
