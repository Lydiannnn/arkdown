import { describe, expect, it } from 'vitest'
import { THEME_COLOR_PRESETS } from '../../src/shared/theme-color'
import { WORKSPACE_COLOR_IDS } from '../../src/shared/workspace-color-marks'

describe('theme color presets', () => {
  it('places standard blue immediately after blue', () => {
    expect(THEME_COLOR_PRESETS.slice(0, 5)).toEqual([
      { name: '红色', value: '#C62828' },
      { name: '紫色', value: '#800080' },
      { name: '蓝色', value: '#2563EB' },
      { name: '标准蓝色', value: '#3677B7' },
      { name: '青色', value: '#007C91' },
    ])
  })

  it('does not change the persisted seven-color workspace mark palette', () => {
    expect(WORKSPACE_COLOR_IDS).toEqual([
      '#C62828', '#800080', '#2563EB', '#007C91', '#18864B', '#C66A00', '#B83280',
    ])
  })
})
