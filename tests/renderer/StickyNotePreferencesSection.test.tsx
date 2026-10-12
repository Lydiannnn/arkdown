import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { StickyNotePreferencesSection } from '../../src/renderer/settings/StickyNotePreferencesSection'
import {
  DEFAULT_STICKY_NOTE_PREFERENCES,
  copyStickyNotePreferences,
} from '../../src/shared/sticky-note-preferences'

describe('StickyNotePreferencesSection', () => {
  it.each(['arkdown-embedded', 'arknote-standalone'] as const)('edits only future defaults and preserves legacy arrays on %s', (surface) => {
    const initial = copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)
    initial.colorPresets[7]!.value = '#654321'
    initial.texturePresets[2]!.opacityPercent = 47
    const onChange = vi.fn()
    function Harness() {
      const [value, setValue] = useState(initial)
      return <StickyNotePreferencesSection surface={surface} value={value} onChange={(next) => { setValue(next); onChange(next) }} />
    }
    const { container } = render(<Harness />)
    expect(container.querySelector('.sticky-note-preferences-section')).toHaveClass('sticky-note-preferences-section--' + surface)
    expect(Array.from(container.querySelectorAll('h3')).map(h => h.textContent)).toEqual(['默认材质', '默认颜色'])
    expect(screen.getAllByRole('radio')).toHaveLength(5)
    const colorSection = screen.getByRole('region', { name: '默认颜色' })
    expect(colorSection).toContainElement(screen.getByRole('radio', { name: '颜色' }))
    expect(screen.getByRole('radio', { name: '颜色' }).compareDocumentPosition(screen.getByLabelText('自定义颜色')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Mica' })).toBeChecked()
    expect(screen.getByLabelText('自定义颜色')).toBeDisabled()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: '颜色' }))
    expect(screen.getByLabelText('自定义颜色')).toBeEnabled()
    fireEvent.change(screen.getByLabelText('自定义颜色'), { target: { value: '#123456' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Acrylic' }))
    expect(screen.getByLabelText('自定义颜色')).toBeDisabled()
    expect(screen.getByLabelText('自定义颜色')).toHaveValue('#123456')
    fireEvent.click(screen.getByRole('radio', { name: '颜色' }))
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ ...initial, defaultAppearance: 'color', defaultColor: '#123456' })
    fireEvent.click(screen.getByRole('button', { name: '恢复便签默认样式' }))
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ ...initial, defaultAppearance: 'mica-light', defaultColor: '#F9E78B' })
    expect(screen.getByLabelText('自定义颜色')).toBeDisabled()
  })
  it('places lifecycle checkboxes before their option text', () => {
    render(<StickyNotePreferencesSection
      launchAtLogin={false}
      onChange={vi.fn()}
      onLaunchAtLoginChange={vi.fn()}
      value={copyStickyNotePreferences(DEFAULT_STICKY_NOTE_PREFERENCES)}
    />)

    for (const name of ['开机启动']) {
      const checkbox = screen.getByRole('checkbox', { name })
      expect(checkbox.parentElement?.firstElementChild).toBe(checkbox)
      expect(checkbox.parentElement).toHaveClass('preferences-checkbox-description')
    }
  })
})
