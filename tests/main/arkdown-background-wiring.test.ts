import { expect, it } from 'vitest'
import { backgroundImageSelectionDialogOptions } from '../../src/main/arkdown-main'

it('limits main-background selection to supported static image extensions', () => {
  expect(backgroundImageSelectionDialogOptions()).toEqual({
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [{
      name: '背景图片',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg'],
    }],
  })
})

it('opens main-background selection in the last selected image directory', () => {
  expect(backgroundImageSelectionDialogOptions('C:\\pictures\\wallpapers')).toEqual({
    title: '选择背景图片',
    properties: ['openFile'],
    defaultPath: 'C:\\pictures\\wallpapers',
    filters: [{
      name: '背景图片',
      extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg'],
    }],
  })
})
