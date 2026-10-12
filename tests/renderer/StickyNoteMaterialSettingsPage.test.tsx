import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { StickyNoteMaterialSettingsPage } from '../../src/renderer/settings/StickyNoteMaterialSettingsPage'
import { copyStickyNoteWallpaperAppearances, DEFAULT_STICKY_NOTE_GLASS_APPEARANCES, type StickyNoteWallpaperAppearances } from '../../src/shared/sticky-note-glass-appearance'
import { DEFAULT_STICKY_NOTE_MICA_APPEARANCE } from '../../src/shared/sticky-note-mica-appearance'
import { DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS } from '../../src/shared/sticky-note-material-effects'

const defaults = () => copyStickyNoteWallpaperAppearances({ micaAppearance: DEFAULT_STICKY_NOTE_MICA_APPEARANCE, glassAppearances: DEFAULT_STICKY_NOTE_GLASS_APPEARANCES, materialEffects: DEFAULT_STICKY_NOTE_MATERIAL_EFFECTS })
function setup(initial = defaults(), disabled = false) {
  const changed = vi.fn()
  function Harness() {
    const [value, setValue] = useState(initial)
    return <StickyNoteMaterialSettingsPage value={value} disabled={disabled} onChange={(next) => { setValue(next); changed(next) }} />
  }
  const result = render(<Harness />)
  return { ...result, changed }
}

it('offers only each material’s supported controls and one reset', () => {
  const { container, changed } = setup()
  for (const [name, sliders, colors, checkbox] of [['Mica', 3, 1, null], ['暖雾玻璃', 6, 1, '显示投影'], ['深色玻璃', 6, 1, '显示投影'], ['Acrylic', 3, 0, '去除描边']] as const) {
    const group = within(screen.getByRole('region', { name }))
    expect(group.getAllByRole('slider')).toHaveLength(sliders)
    expect(group.queryAllByRole('textbox')).toHaveLength(colors)
    expect(group.getAllByRole('button')).toHaveLength(1)
    expect(group.getByRole('button', { name: '恢复默认' })).toBeVisible()
    expect(group.queryAllByRole('checkbox')).toHaveLength(checkbox ? 1 : 0)
    if (checkbox) expect(group.getByRole('checkbox', { name: checkbox })).toBeVisible()
  }
  expect(container.querySelector('textarea,input[type="number"]')).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})

it.each(['暖雾玻璃', '深色玻璃'] as const)('resets the whole %s recipe in one complete snapshot without changing its neighbours', (name) => {
  const initial = defaults()
  const id = name === '暖雾玻璃' ? 'warm-frosted-glass' : 'clear-glass'
  initial.glassAppearances[id] = { tintColor: '#123456', tintOpacity: .37, luminosityOpacity: .12345, saturation: .67 }
  initial.materialEffects[id] = { transparency: .81, innerGlowIntensity: .2, innerGlowRangePx: 9, shadowEnabled: true }
  initial.micaAppearance.tintOpacity = .456789
  const { changed } = setup(initial)
  fireEvent.click(within(screen.getByRole('region', { name })).getByRole('button', { name: '恢复默认' }))
  expect(changed).toHaveBeenCalledOnce()
  const next = changed.mock.calls[0]![0] as StickyNoteWallpaperAppearances
  expect(next).toEqual({ ...initial, glassAppearances: { ...initial.glassAppearances, [id]: defaults().glassAppearances[id] }, materialEffects: { ...initial.materialEffects, [id]: defaults().materialEffects[id] } })
  expect(initial.glassAppearances[id].tintColor).toBe('#123456')
})

it('keeps valid fractional values until the user edits and rejects incomplete HEX', () => {
  const initial = defaults()
  initial.micaAppearance.luminosityOpacity = .1295
  const { changed } = setup(initial)
  const mica = within(screen.getByRole('region', { name: 'Mica' }))
  expect(mica.getByText('12.95%')).toBeVisible()
  expect(changed).not.toHaveBeenCalled()
  const hex = mica.getByRole('textbox', { name: 'Mica 色调 HEX' })
  fireEvent.change(hex, { target: { value: '#12' } })
  expect(changed).not.toHaveBeenCalled()
  fireEvent.blur(hex)
  expect(hex).toHaveValue('#F3F3F3')
  fireEvent.change(hex, { target: { value: '#abcdef' } })
  expect(changed.mock.calls.at(-1)?.[0].micaAppearance).toEqual({ ...initial.micaAppearance, tintColor: '#ABCDEF' })
  fireEvent.change(mica.getByRole('slider', { name: 'Mica 着色强度' }), { target: { value: '28' } })
  expect(changed.mock.calls.at(-1)?.[0].micaAppearance.tintOpacity).toBe(.28)
})

it('disables all editing controls while the parent is saving', () => {
  const { container } = setup(defaults(), true)
  for (const element of container.querySelectorAll('input,button')) expect(element).toBeDisabled()
})

it('resets Acrylic effects and border without editing any base recipe', () => {
  const initial = defaults()
  initial.materialEffects['flowing-glass'] = { transparency: .9, innerGlowIntensity: .1, innerGlowRangePx: 2, borderHidden: false }
  const { changed } = setup(initial)
  fireEvent.click(within(screen.getByRole('region', { name: 'Acrylic' })).getByRole('button', { name: '恢复默认' }))
  expect(changed).toHaveBeenCalledOnce()
  expect(changed.mock.calls[0]![0]).toEqual({ ...initial, materialEffects: { ...initial.materialEffects, 'flowing-glass': { transparency: 0, innerGlowIntensity: .7, innerGlowRangePx: 30, borderHidden: true } } })
})
