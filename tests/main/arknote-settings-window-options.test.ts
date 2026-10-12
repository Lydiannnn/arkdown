import { expect, it } from 'vitest'
import { buildArknoteSettingsWindowOptions } from '../../src/main/create-arknote-settings-window'

it('opens standalone Arknote settings at the approved default size', () => {
  expect(buildArknoteSettingsWindowOptions('C:\\app\\preload.js')).toMatchObject({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    show: false,
    frame: false,
  })
  expect(buildArknoteSettingsWindowOptions('C:\\app\\preload.js')).not.toHaveProperty('titleBarOverlay')
})
