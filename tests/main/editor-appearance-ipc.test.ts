import { expect, it, vi } from 'vitest'
import { createIpcOperations } from '../../src/main/ipc/register-ipc'

const defaults = {
  minimumContentMarginPx: 30,
  maximumContentWidthPx: 1200,
  preserveSingleLineBreaks: true,
  spellCheckEnabled: false,
  showEditIndicators: true,
  editorTheme: 'minimal' as const,
  headingLatinFont: 'Arial',
  headingCjkFont: 'SimHei',
  bodyLatinFont: 'Arial',
  bodyCjkFont: 'SimHei',
  themeColor: '#800080',
  micaOpacityPercent: 0 as const,
}

function dependencies() {
  return {
    chooseDirectory: vi.fn(),
    workspace: {} as never,
    documents: {} as never,
    getLastWorkspace: () => null,
    setLastWorkspace: vi.fn(),
    reportError: vi.fn(),
    getEditorAppearancePreferences: vi.fn(() => ({ appearance: defaults, revision: 0 })),
    setEditorAppearancePreferences: vi.fn(async (appearance) => ({ appearance, revision: 1 })),
    compareAndSetEditorAppearancePreferences: vi.fn(async () => ({
      appearance: defaults,
      revision: 2,
    })),
    getSystemFonts: vi.fn(async () => ['Arial', 'SimHei']),
  }
}

it('gets and updates validated editor appearance preferences', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)
  const updated = {
    ...defaults,
    minimumContentMarginPx: 64,
    maximumContentWidthPx: 1080,
    spellCheckEnabled: true,
  }

  await expect(operations.getEditorAppearancePreferences()).resolves.toEqual({
    ok: true,
    value: { appearance: defaults, revision: 0 },
  })
  await expect(operations.setEditorAppearancePreferences(updated)).resolves.toEqual({
    ok: true,
    value: { appearance: updated, revision: 1 },
  })
  expect(deps.setEditorAppearancePreferences).toHaveBeenCalledWith(updated)
  await expect(operations.getSystemFonts()).resolves.toEqual({
    ok: true,
    value: ['Arial', 'SimHei'],
  })
})

it('validates and forwards an atomic editor appearance compare-and-set rollback', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)
  const expected = { ...defaults, spellCheckEnabled: true }

  await expect(operations.compareAndSetEditorAppearancePreferences({
    expectedRevision: 1,
    expectedAppearance: expected,
    replacement: defaults,
  })).resolves.toEqual({
    ok: true,
    value: { appearance: defaults, revision: 2 },
  })
  expect(deps.compareAndSetEditorAppearancePreferences).toHaveBeenCalledWith(
    1,
    expected,
    defaults,
  )

  await expect(operations.compareAndSetEditorAppearancePreferences({
    expectedRevision: 1,
    expectedAppearance: expected,
    replacement: { ...defaults, spellCheckEnabled: 'false' },
  })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(deps.compareAndSetEditorAppearancePreferences).toHaveBeenCalledOnce()

  for (const expectedRevision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(operations.compareAndSetEditorAppearancePreferences({
      expectedRevision,
      expectedAppearance: expected,
      replacement: defaults,
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
})

it('rejects malformed editor appearance preferences', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  for (const input of [
    { ...defaults, minimumContentMarginPx: 29 },
    { ...defaults, minimumContentMarginPx: 151 },
    { ...defaults, minimumContentMarginPx: 30.5 },
    { ...defaults, maximumContentWidthPx: 599 },
    { ...defaults, maximumContentWidthPx: 1201 },
    { ...defaults, maximumContentWidthPx: 1000.5 },
    { ...defaults, bodyLatinFont: '' },
    { ...defaults, extra: true },
    { ...defaults, themeColor: '#fff' },
    { ...defaults, themeColor: '800080' },
    { ...defaults, micaOpacityPercent: 30 },
    { ...defaults, micaOpacityPercent: -1 },
    { ...defaults, micaOpacityPercent: 101 },
    { ...defaults, micaOpacityPercent: 30.5 },
    { ...defaults, spellCheckEnabled: null },
    { ...defaults, spellCheckEnabled: 1 },
    { ...defaults, spellCheckEnabled: 'true' },
    { ...defaults, showEditIndicators: undefined },
    { ...defaults, showEditIndicators: null },
    { ...defaults, showEditIndicators: 1 },
    { ...defaults, showEditIndicators: 'true' },
    { ...defaults, editorTheme: 'GitHub' },
    { ...defaults, editorTheme: 'github' },
    { ...defaults, editorTheme: null },
    { ...defaults, editorTheme: undefined },
  ]) {
    await expect(operations.setEditorAppearancePreferences(input)).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    })
  }
  expect(deps.setEditorAppearancePreferences).not.toHaveBeenCalled()
})

it('requires the complete minimal theme for set and both compare-and-set appearances', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)
  const { editorTheme: _missing, ...missingTheme } = defaults

  await expect(operations.setEditorAppearancePreferences(missingTheme))
    .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  for (const input of [
    {
      expectedRevision: 0,
      expectedAppearance: missingTheme,
      replacement: defaults,
    },
    {
      expectedRevision: 0,
      expectedAppearance: defaults,
      replacement: missingTheme,
    },
  ]) {
    await expect(operations.compareAndSetEditorAppearancePreferences(input))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(deps.setEditorAppearancePreferences).not.toHaveBeenCalled()
  expect(deps.compareAndSetEditorAppearancePreferences).not.toHaveBeenCalled()
})

it('requires complete edit-indicator values for both compare-and-set appearances', async () => {
  const deps = dependencies()
  const operations = createIpcOperations(deps)

  for (const input of [
    {
      expectedRevision: 0,
      expectedAppearance: { ...defaults, showEditIndicators: undefined },
      replacement: defaults,
    },
    {
      expectedRevision: 0,
      expectedAppearance: defaults,
      replacement: { ...defaults, showEditIndicators: 'false' },
    },
  ]) {
    await expect(operations.compareAndSetEditorAppearancePreferences(input))
      .resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  }
  expect(deps.compareAndSetEditorAppearancePreferences).not.toHaveBeenCalled()
})
