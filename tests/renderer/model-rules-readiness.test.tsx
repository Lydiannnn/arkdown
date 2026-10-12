import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as runtime from '../../src/renderer/settings/model-rules-runtime'
import { getModelCapabilityRules, setModelCapabilityRules, type RuleFile } from '../../src/shared/model-capability-rules'
import type { ModelCapabilityRulesState } from '../../src/shared/model-capability-rules-state'
import { ModelThinkingControls } from '../../src/renderer/editor/ModelThinkingControls'
import { ManualModelThinkingFields } from '../../src/renderer/settings/ManualModelThinkingFields'

const rules: RuleFile = { schemaVersion: 1, revision: '2026-09-17', rules: [] }
const state = (rules: RuleFile | null): ModelCapabilityRulesState => ({ rules, bundledRevision: '2026-09-12', warning: null })
const sessions: Array<{ dispose(): void }> = []
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); setModelCapabilityRules(null) })
function begin() {
  let resolve!: (result: { ok: true; value: ModelCapabilityRulesState }) => void
  let reject!: (error: Error) => void
  let changed!: (value: ModelCapabilityRulesState) => void
  const unsubscribe = vi.fn()
  const session = runtime.startModelRulesInitialization({
    getModelCapabilityRules: () => new Promise((yes, no) => { resolve = yes; reject = no }),
    onModelCapabilityRulesChanged: listener => { changed = listener; return unsubscribe },
  })
  sessions.push(session)
  return { session, resolve, reject, changed, unsubscribe }
}
it('exposes pending synchronously, then enables controls when the authoritative read arrives', async () => {
  expect(runtime.startModelRulesInitialization).toBeTypeOf('function')
  const pending = begin()
  const change = vi.fn()
  render(<ModelThinkingControls label="AI" thinkingConnection={{ provider: 'deepseek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', modelId: 'deepseek-v4-flash' }} thinkingPreference={{ thinkingMode: 'default', reasoningEffort: 'default' }} onThinkingChange={change} />)
  expect(runtime.areModelRulesReady()).toBe(false)
  const toggle = screen.getByRole('switch', { name: 'AI思考' })
  expect(toggle).toBeDisabled()
  fireEvent.click(toggle)
  expect(change).not.toHaveBeenCalled()
  await act(async () => { pending.resolve({ ok: true, value: state(null) }); await pending.session.ready })
  expect(toggle).toBeEnabled()
  fireEvent.click(toggle)
  expect(change).toHaveBeenCalledOnce()
})
it('accepts a live update immediately and ignores the stale startup response', async () => {
  expect(runtime.startModelRulesInitialization).toBeTypeOf('function')
  const pending = begin()
  pending.changed(state(rules))
  expect(runtime.areModelRulesReady()).toBe(true)
  pending.resolve({ ok: true, value: state(null) })
  await pending.session.ready
  expect(getModelCapabilityRules()).toEqual(rules)
})
it('disables manual thinking capability edits until rules are current', () => {
  begin()
  render(<ManualModelThinkingFields protocol="openai" detected={{ thinking: 'unknown', encoding: 'none', efforts: [], defaultThinking: 'default', defaultEffort: 'default', disabledEfforts: [] }} onChange={vi.fn()} />)
  expect(screen.getByRole('combobox', { name: '思考能力识别' })).toBeDisabled()
})
it('unsubscribes before a pending read settles and ignores late callbacks and results', async () => {
  expect(runtime.startModelRulesInitialization).toBeTypeOf('function')
  const pending = begin()
  pending.session.dispose()
  pending.session.dispose()
  expect(pending.unsubscribe).toHaveBeenCalledOnce()
  pending.changed(state(rules))
  pending.resolve({ ok: true, value: state(rules) })
  await pending.session.ready
  expect(getModelCapabilityRules()).toBeNull()
})
it('settles a rejected IPC read to the existing fallback without leaving actions pending', async () => {
  expect(runtime.startModelRulesInitialization).toBeTypeOf('function')
  const pending = begin()
  pending.reject(new Error('IPC unavailable'))
  await pending.session.ready
  expect(runtime.areModelRulesReady()).toBe(true)
  expect(getModelCapabilityRules()).toBeNull()
})
