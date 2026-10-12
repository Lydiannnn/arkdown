import { expect, it, vi } from 'vitest'
import { SettingsPresentation } from '../../src/main/settings/settings-presentation'
import { DEFAULT_SETTINGS } from '../../src/main/settings/settings-store'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import type { SettingsTransactionSnapshot } from '../../src/main/settings/settings-transaction-types'

function fixture() {
  let snapshot: SettingsTransactionSnapshot = { settings: structuredClone(DEFAULT_SETTINGS), revision: 0,
    minimumBaseRevision: 0, fieldRevisions: { fields: {}, connections: {}, tombstones: {} } }
  const listeners = new Set<(value: SettingsTransactionSnapshot) => void>()
  const source = { getDisplaySnapshot: () => structuredClone(snapshot), subscribe: (listener: (value: SettingsTransactionSnapshot) => void) => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  return { source, adopt: (next: Partial<SettingsTransactionSnapshot>) => {
    snapshot = { ...snapshot, ...next }; for (const listener of listeners) listener(structuredClone(snapshot))
  }, listeners }
}

it('projects copied display values with persistent group revisions and exposes no writer', () => {
  const { source, adopt } = fixture()
  const view = new SettingsPresentation(source)
  adopt({ revision: 8, settings: { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_EDITOR_APPEARANCE, editorTheme: 'dark' } },
    fieldRevisions: { fields: { 'appearance.editorTheme': 7, 'windowBounds': 8 }, connections: {}, tombstones: {} } })
  expect(view.getEditorAppearanceSnapshot().revision).toBe(7)
  expect(view.getEditorAppearanceSnapshot().appearance.editorTheme).toBe('dark')
  const copy = view.get(); copy.lastWorkspace = 'changed'
  expect(view.get().lastWorkspace).not.toBe('changed')
  expect('update' in view).toBe(false)
  expect('save' in view).toBe(false)
})

it('notifies only the changed display group including an ABA revision change, isolates listeners and disposes', () => {
  const { source, adopt, listeners } = fixture()
  const view = new SettingsPresentation(source)
  const appearance = vi.fn(); const layout = vi.fn()
  view.subscribeEditorAppearance(() => { throw new Error('observer') })
  view.subscribeEditorAppearance(appearance); view.subscribeLayout(layout)
  adopt({ revision: 1, fieldRevisions: { fields: { windowBounds: 1 }, connections: {}, tombstones: {} } })
  expect(appearance).not.toHaveBeenCalled(); expect(layout).not.toHaveBeenCalled()
  adopt({ revision: 2, fieldRevisions: { fields: { 'appearance.editorTheme': 2 }, connections: {}, tombstones: {} } })
  expect(appearance).toHaveBeenCalledOnce(); expect(layout).not.toHaveBeenCalled()
  view.dispose(); expect(listeners.size).toBe(0)
  adopt({ revision: 3, fieldRevisions: { fields: { 'appearance.editorTheme': 3 }, connections: {}, tombstones: {} } })
  expect(appearance).toHaveBeenCalledOnce()
})
