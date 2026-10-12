import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsAuthority } from '../../src/main/settings/settings-authority'
import { SettingsTransactionStore } from '../../src/main/settings/settings-transaction-store'
import { DEFAULT_EDITOR_APPEARANCE } from '../../src/shared/editor-appearance-preferences'
import { SettingsPreferenceService } from '../../src/main/settings/settings-preference-service'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'arkdown-preference-authority-')); roots.push(root)
  const cipher = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(value), decrypt: (value: Buffer) => value.toString() }
  const first = new SettingsPreferenceService(new SettingsAuthority(new SettingsTransactionStore(root, cipher)))
  const second = new SettingsPreferenceService(new SettingsAuthority(new SettingsTransactionStore(root, cipher)))
  return { first, second }
}

describe('finite authoritative preference writes', () => {
  it('merges unrelated dirty fields using the original observed values and field revisions', async () => {
    const { first, second } = await fixture()
    const observed = await first.read('appearance')
    await second.patch(await second.read('appearance'), { bodyLatinFont: 'Arial' })
    const committed = await first.patch(observed, { maximumContentWidthPx: 900 })
    expect(committed).toMatchObject({ status: 'committed', snapshot: { group: 'appearance', values: { bodyLatinFont: 'Arial', maximumContentWidthPx: 900 } } })
    expect(committed.snapshot.observation.fields).toMatchObject({ bodyLatinFont: 1, maximumContentWidthPx: 2 })
  })

  it('does not let a refreshed cache bless the original retained form after same-field ABA', async () => {
    const { first, second } = await fixture()
    const original = await first.read('appearance')
    await second.patch(await second.read('appearance'), { bodyLatinFont: 'Arial' })
    await second.patch(await second.read('appearance'), { bodyLatinFont: DEFAULT_EDITOR_APPEARANCE.bodyLatinFont })
    await first.read('appearance')
    const conflict = await first.patch(original, { bodyLatinFont: 'Calibri' })
    expect(conflict).toMatchObject({ status: 'conflict', reason: 'field-changed', fields: ['bodyLatinFont'] })
    expect(conflict.snapshot.values.bodyLatinFont).toBe(DEFAULT_EDITOR_APPEARANCE.bodyLatinFont)
  })

  it('keeps caller data detached while waiting for its serialized write', async () => {
    const { first } = await fixture()
    const observed = await first.read('appearance')
    const patch = { bodyLatinFont: 'Arial' }
    const pending = first.patch(observed, patch)
    patch.bodyLatinFont = 'Calibri'; observed.values.bodyLatinFont = 'caller mutation'
    expect(await pending).toMatchObject({ status: 'committed', snapshot: { values: { bodyLatinFont: 'Arial' } } })
  })

  it('does not interpret undefined as clear and does not stamp no-op revisions', async () => {
    const { first } = await fixture()
    const observed = await first.read('appearance')
    expect(await first.patch(observed, { bodyLatinFont: undefined })).toMatchObject({ status: 'unchanged', snapshot: observed })
    await expect(first.patch(observed, { bodyLatinFont: null })).rejects.toThrow('SETTINGS_PREFERENCE_COMMAND_INVALID')
    expect((await first.read('appearance')).observation.revision).toBe(0)
  })

  it.each([
    ['search', { provider: 'google', customTemplate: '' }],
    ['layout', { leftSidebarWidth: 330 }],
    ['stickyNotes', { defaultColor: '#123456' }],
    ['desktopLifecycle', { launchAtLogin: true }],
  ] as const)('persists the finite %s group with fresh authoritative reads', async (group, changes) => {
    const { first, second } = await fixture()
    const observed = await first.read(group)
    expect(await first.patch(observed, changes)).toMatchObject({ status: 'committed' })
    expect((await second.read(group)).values).toMatchObject(changes)
  })

  it('rejects arbitrary paths and whole-object normalizer side effects before writing', async () => {
    const { first } = await fixture()
    const observed = await first.read('search')
    await expect(first.patch(observed, { 'appearance.themeColor': '#123456' })).rejects.toThrow('SETTINGS_PREFERENCE_COMMAND_INVALID')
    await expect(first.patch(observed, { customTemplate: 'https://example.com/?q={query}' })).rejects.toThrow('SETTINGS_PREFERENCE_COMMAND_INVALID')
    expect((await first.read('search')).observation.revision).toBe(0)
  })
})
