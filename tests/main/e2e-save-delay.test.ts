import { expect, it, vi } from 'vitest'
import { createE2ePersistenceObserver } from '../../src/main/e2e-bootstrap'

it('delays only E2E document persistence when an explicit bounded delay is set', async () => {
  vi.useFakeTimers()
  const observer = createE2ePersistenceObserver({
    ARKDOWN_E2E: '1',
    ARKDOWN_E2E_SAVE_DELAY_MS: '1200',
  })
  const pending = observer?.({
    stage: 'save-content-start',
    relativePath: 'note.md',
    queueTarget: 'C:\\workspace\\note.md',
  })

  let settled = false
  void pending?.then(() => { settled = true })
  await vi.advanceTimersByTimeAsync(1199)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await pending
  expect(settled).toBe(true)
  vi.useRealTimers()
})

it.each([
  {},
  { ARKDOWN_E2E: 'true', ARKDOWN_E2E_SAVE_DELAY_MS: '1200' },
  { ARKDOWN_E2E: '1', ARKDOWN_E2E_SAVE_DELAY_MS: '0' },
  { ARKDOWN_E2E: '1', ARKDOWN_E2E_SAVE_DELAY_MS: '10001' },
  { ARKDOWN_E2E: '1', ARKDOWN_E2E_SAVE_DELAY_MS: 'not-a-number' },
])('does not install a persistence delay outside the exact safe gate: %j', (environment) => {
  expect(createE2ePersistenceObserver(environment)).toBeUndefined()
})
