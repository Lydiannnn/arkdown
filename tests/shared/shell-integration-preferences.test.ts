import { expect, it } from 'vitest'
import { normalizeShellIntegrationPreferences, parseShellIntegrationUpdate } from '../../src/shared/shell-integration-preferences'
import { parseShellIntegrationSnapshot, parseObservedShellIntegrationUpdate } from '../../src/shared/shell-integration-preferences'

it('defaults new and legacy settings to all enabled', () => {
  expect(normalizeShellIntegrationPreferences(undefined)).toEqual({ documentOpenMenu: true, markdownShellNew: true })
  expect(normalizeShellIntegrationPreferences({ documentOpenMenu: 'true' })).toEqual(normalizeShellIntegrationPreferences(undefined))
})

const observed = { values: { documentOpenMenu: true, markdownShellNew: false }, unavailable: [],
  observation: { version: 1, revision: 4, minimumBaseRevision: 0, fields: { documentOpenMenu: 3 } } }

it('accepts only bounded finite shell observations and captures the submitted values', () => {
  expect(parseShellIntegrationSnapshot(observed)).toEqual(observed)
  const input = { feature: 'documentOpenMenu', enabled: false, observed: structuredClone(observed) }
  const parsed = parseObservedShellIntegrationUpdate(input)
  input.observed.values.documentOpenMenu = false
  expect(parsed?.observed.values.documentOpenMenu).toBe(true)
  for (const value of [observed.values, { ...observed, extra: 1 }, { ...observed, unavailable: ['foreign'] },
    { ...observed, unavailable: ['documentOpenMenu', 'documentOpenMenu'] },
    { ...observed, observation: { ...observed.observation, fields: { path: 1 } } },
    { ...observed, observation: { ...observed.observation, fields: { documentOpenMenu: 5 } } },
    { ...observed, observation: { ...observed.observation, minimumBaseRevision: 5 } }]) {
    expect(parseShellIntegrationSnapshot(value)).toBeUndefined()
  }
  expect(parseObservedShellIntegrationUpdate({ feature: 'documentOpenMenu', enabled: false })).toBeUndefined()
  expect(parseObservedShellIntegrationUpdate({ ...input, command: 'foreign' })).toBeUndefined()
})

it('preserves explicitly disabled settings', () => {
  expect(normalizeShellIntegrationPreferences({ documentOpenMenu: false, markdownShellNew: false })).toEqual({ documentOpenMenu: false, markdownShellNew: false })
})

it('accepts only an exact feature and boolean update, never renderer commands', () => {
  expect(parseShellIntegrationUpdate({ feature: 'markdownShellNew', enabled: true })).toEqual({ feature: 'markdownShellNew', enabled: true })
  for (const value of [null, [], { feature: 'command', enabled: true }, { feature: 'markdownShellNew', enabled: 1 }, { feature: 'markdownShellNew', enabled: true, path: 'HKCU' }]) {
    expect(parseShellIntegrationUpdate(value)).toBeUndefined()
  }
})
