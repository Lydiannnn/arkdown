import { expect, it, vi } from 'vitest'
import * as bootstrap from '../../src/main/e2e-bootstrap'

it('records gated Arkdown zero-tray and Arknote create/destroy state', () => {
  const createProbe = (bootstrap as unknown as {
    createE2eTrayProbe?: (options: {
      environment: Record<string, string | undefined>
      processId: number
      role: 'arkdown' | 'arknote'
      writeState(state: unknown): void
    }) => { created(): void; destroyed(): void }
  }).createE2eTrayProbe
  expect(createProbe).toBeTypeOf('function')
  if (!createProbe) return

  const arkdownStates: unknown[] = []
  createProbe({
    environment: { ARKDOWN_E2E: '1', ARKDOWN_E2E_TRAY_STATE_DIRECTORY: 'C:\\state' },
    processId: 10,
    role: 'arkdown',
    writeState: (state) => arkdownStates.push(state),
  })
  expect(arkdownStates).toEqual([{ role: 'arkdown', processId: 10, active: 0, created: 0, destroyed: 0 }])

  const writeState = vi.fn()
  const arknote = createProbe({
    environment: { ARKDOWN_E2E: '1', ARKDOWN_E2E_TRAY_STATE_DIRECTORY: 'C:\\state' },
    processId: 11,
    role: 'arknote',
    writeState,
  })
  arknote.created()
  arknote.destroyed()
  expect(writeState.mock.calls.map(([state]) => state)).toEqual([
    { role: 'arknote', processId: 11, active: 0, created: 0, destroyed: 0 },
    { role: 'arknote', processId: 11, active: 1, created: 1, destroyed: 0 },
    { role: 'arknote', processId: 11, active: 0, created: 1, destroyed: 1 },
  ])
})

it('does nothing without the exact E2E gate and absolute state directory', () => {
  const createProbe = (bootstrap as unknown as { createE2eTrayProbe?: Function }).createE2eTrayProbe
  expect(createProbe).toBeTypeOf('function')
  if (!createProbe) return
  const writeState = vi.fn()
  const probe = createProbe({ environment: { ARKDOWN_E2E: 'true', ARKDOWN_E2E_TRAY_STATE_DIRECTORY: 'relative' }, processId: 1, role: 'arknote', writeState })
  probe.created()
  probe.destroyed()
  expect(writeState).not.toHaveBeenCalled()
})
