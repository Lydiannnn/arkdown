import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import type { PublicPreferenceSnapshot } from '../../src/shared/preference-observation'

const observed: PublicPreferenceSnapshot<'appearance'> = { group: 'appearance', values: { ...DEFAULT_EDITOR_APPEARANCE }, observation: { version: 1, revision: 5, minimumBaseRevision: 0, fields: { bodyLatinFont: 3 } } }
function fixture() {
  const settingsPreferences = { read: vi.fn(async () => structuredClone(observed)), patch: vi.fn(async () => ({ status: 'unchanged' as const, snapshot: observed })) }
  const operations = createIpcOperations({ chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(), settingsPreferences: settingsPreferences as never })
  return { settingsPreferences, operations }
}

it('awaits an authoritative read and forwards the exact original observed command', async () => {
  const { settingsPreferences, operations } = fixture()
  await expect(operations.getPreferenceSnapshot({ group: 'appearance' })).resolves.toEqual({ ok: true, value: observed })
  expect(settingsPreferences.read).toHaveBeenCalledExactlyOnceWith('appearance')
  const input = { observed, changes: { bodyLatinFont: 'Arial' } }
  await expect(operations.patchPreferences(input)).resolves.toEqual({ ok: true, value: { status: 'unchanged', snapshot: observed } })
  expect(settingsPreferences.patch).toHaveBeenCalledExactlyOnceWith(observed, input.changes)
})

it('rejects unobserved, unknown-path, malformed revision and accessor commands before persistence', async () => {
  const { settingsPreferences, operations } = fixture()
  for (const input of [{ changes: { bodyLatinFont: 'Arial' } }, { observed, changes: { 'models.aiConversation.writePolicy': 'workspace-grant' } },
    { observed: { ...observed, observation: { ...observed.observation, revision: -1 } }, changes: {} },
    { observed, changes: { bodyLatinFont: 'Arial' }, extra: true }]) {
    expect(await operations.patchPreferences(input)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  const getter = vi.fn(() => 'Arial'), changes = Object.defineProperty({}, 'bodyLatinFont', { enumerable: true, get: getter })
  expect(await operations.patchPreferences({ observed, changes })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(await operations.getPreferenceSnapshot({ group: 'secrets' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(settingsPreferences.patch).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled()
})

it('fails closed without the transaction service rather than dispatching to a legacy writer', async () => {
  const setEditorAppearancePreferences = vi.fn()
  const operations = createIpcOperations({ chooseDirectory: vi.fn(), workspace: {} as never, documents: {} as never,
    getLastWorkspace: () => null, setLastWorkspace: vi.fn(), reportError: vi.fn(), setEditorAppearancePreferences })
  expect(await operations.patchPreferences({ observed, changes: { bodyLatinFont: 'Arial' } })).toMatchObject({ ok: false })
  expect(setEditorAppearancePreferences).not.toHaveBeenCalled()
})
