import { expect, it, vi } from 'vitest'
import { createArkdownApi } from '../../src/preload/arkdown-api'
import { IPC_CHANNELS } from '../../src/shared/contracts'

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

it('uses fixed channels for editor appearance preferences and local fonts', async () => {
  const updated = {
    ...defaults,
    minimumContentMarginPx: 72,
    maximumContentWidthPx: 1040,
    bodyCjkFont: 'Microsoft YaHei',
  }
  const invoke = vi.fn()
    .mockResolvedValueOnce({ ok: true, value: { appearance: defaults, revision: 0 } })
    .mockResolvedValueOnce({ ok: true, value: { appearance: updated, revision: 1 } })
    .mockResolvedValueOnce({ ok: true, value: ['Arial', 'SimHei'] })
  const api = createArkdownApi(invoke)

  await expect(api.getEditorAppearancePreferences?.()).resolves.toEqual({
    ok: true,
    value: { appearance: defaults, revision: 0 },
  })
  await expect(api.setEditorAppearancePreferences?.(updated)).resolves.toEqual({
    ok: true,
    value: { appearance: updated, revision: 1 },
  })
  await expect(api.getSystemFonts?.()).resolves.toEqual({
    ok: true,
    value: ['Arial', 'SimHei'],
  })
  expect(invoke.mock.calls).toEqual([
    [IPC_CHANNELS.getEditorAppearancePreferences],
    [IPC_CHANNELS.setEditorAppearancePreferences, updated],
    [IPC_CHANNELS.getSystemFonts],
  ])
})

it('uses a fixed validated channel for atomic editor appearance rollback', async () => {
  const expected = { ...defaults, spellCheckEnabled: true }
  const invoke = vi.fn().mockResolvedValue({
    ok: true,
    value: { appearance: defaults, revision: 2 },
  })
  const api = createArkdownApi(invoke)

  await expect(api.compareAndSetEditorAppearancePreferences?.(
    1,
    expected,
    defaults,
  )).resolves.toEqual({
    ok: true,
    value: { appearance: defaults, revision: 2 },
  })
  expect(invoke).toHaveBeenCalledWith(
    IPC_CHANNELS.compareAndSetEditorAppearancePreferences,
    { expectedRevision: 1, expectedAppearance: expected, replacement: defaults },
  )
})

it('delivers only validated persisted appearance changes from other windows', () => {
  let emit: ((value: unknown) => void) | null = null
  const api = createArkdownApi(
    vi.fn(),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      subscribe(listener) {
        emit = listener
        return () => { emit = null }
      },
    },
  )
  const listener = vi.fn()
  const deliver = (value: unknown) => emit?.(value)

  const unsubscribe = api.onEditorAppearancePreferencesChanged?.(listener)
  deliver({ appearance: { ...defaults, spellCheckEnabled: true }, revision: 2 })
  deliver({ appearance: { ...defaults, spellCheckEnabled: 'true' }, revision: 3 })
  deliver({ appearance: { ...defaults, editorTheme: 'GitHub' }, revision: 3 })
  deliver({ appearance: { ...defaults, showEditIndicators: undefined }, revision: 3 })
  const { showEditIndicators: _missing, ...missingEditIndicator } = defaults
  deliver({ appearance: missingEditIndicator, revision: 3 })
  deliver({ appearance: { ...defaults, spellCheckEnabled: true }, revision: 2.5 })

  expect(listener).toHaveBeenCalledOnce()
  expect(listener).toHaveBeenCalledWith({
    appearance: { ...defaults, spellCheckEnabled: true },
    revision: 2,
  })
  unsubscribe?.()
  expect(emit).toBeNull()
})

it('rejects incomplete or malformed edit-indicator snapshots at the preload boundary', async () => {
  const { showEditIndicators: _missing, ...missingEditIndicator } = defaults
  for (const appearance of [
    missingEditIndicator,
    { ...defaults, showEditIndicators: undefined },
    { ...defaults, showEditIndicators: null },
    { ...defaults, showEditIndicators: 1 },
    { ...defaults, showEditIndicators: 'true' },
    { ...defaults, extra: true },
    { ...defaults, editorTheme: 'GitHub' },
    { ...defaults, editorTheme: null },
  ]) {
    const api = createArkdownApi(vi.fn().mockResolvedValue({
      ok: true,
      value: { appearance, revision: 1 },
    }))
    await expect(api.getEditorAppearancePreferences?.()).resolves.toMatchObject({
      ok: false,
      error: { code: 'OPERATION_FAILED' },
    })
  }
})

it('rejects incomplete or malformed outbound appearance requests before invoking IPC', async () => {
  const invoke = vi.fn()
  const api = createArkdownApi(invoke)
  const { editorTheme: _missingTheme, ...missingTheme } = defaults

  await expect(api.setEditorAppearancePreferences?.(missingTheme as never)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  await expect(api.setEditorAppearancePreferences?.({
    ...defaults,
    editorTheme: 'GitHub',
  } as never)).resolves.toMatchObject({
    ok: false,
    error: { code: 'INVALID_INPUT' },
  })
  await expect(api.compareAndSetEditorAppearancePreferences?.(
    0,
    missingTheme as never,
    defaults,
  )).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  await expect(api.compareAndSetEditorAppearancePreferences?.(
    -1,
    defaults,
    defaults,
  )).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
  expect(invoke).not.toHaveBeenCalled()
})

it.each([30, 101])('rejects Mica opacity %i at the canonical preload boundary', async (micaOpacityPercent) => {
  const badAppearance = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: { appearance: { ...defaults, micaOpacityPercent }, revision: 1 },
  }))
  await expect(badAppearance.getEditorAppearancePreferences?.()).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})

it('rejects malformed font-list values at the preload boundary', async () => {
  const badFonts = createArkdownApi(vi.fn().mockResolvedValue({
    ok: true,
    value: ['Arial', 42],
  }))
  await expect(badFonts.getSystemFonts?.()).resolves.toMatchObject({
    ok: false,
    error: { code: 'OPERATION_FAILED' },
  })
})
