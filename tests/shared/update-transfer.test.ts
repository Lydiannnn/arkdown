import { expect, it } from 'vitest'
import { parseUpdateAction, parseUpdateTransfer } from '../../src/shared/update-transfer'

it('accepts only finite update actions, never arbitrary paths or URLs', () => {
  for (const action of ['open', 'later', 'skip', 'download', 'cancel-download', 'dismiss', 'install', 'work-started', 'claim-gate']) {
    expect(parseUpdateAction(action)).toBe(action)
  }
  for (const value of [{ action: 'install', path: 'C:/other.exe' }, 'quit', null, 'https://example.com']) expect(parseUpdateAction(value)).toBeUndefined()
})
it('validates byte progress and refuses ready-before-verification states', () => {
  const value = { phase: 'downloading', received: 8, total: 10, error: null, dialog: 'progress', forced: false }
  expect(parseUpdateTransfer(value)).toEqual(value)
  for (const patch of [{ received: 11 }, { total: -1 }, { received: NaN }, { phase: 'ready' },
    { phase: 'unknown' }, { error: 'x'.repeat(2049) }, { url: 'https://evil.example' }]) {
    expect(parseUpdateTransfer({ ...value, ...patch })).toBeUndefined()
  }
  expect(parseUpdateTransfer({ ...value, phase: 'ready', received: 10, dialog: 'install' })).toBeDefined()
})
