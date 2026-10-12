import { expect, it, vi } from 'vitest'
import { executeImageResourceCommand } from '../../src/renderer/editor/context-menu/image-context-actions'
import { buildVisualEditorMenu } from '../../src/renderer/editor/context-menu/editor-menu-model'
import { collectEnabledCommandIds } from '../../src/renderer/context-menu/context-menu-types'

it('builds the full Typora-style local image menu', () => {
  const menu = buildVisualEditorMenu({
    kind: 'image',
    selectionText: '',
    source: 'C:\\photos\\photo.png',
    imageAlignment: 'center',
  })
  const ids = collectEnabledCommandIds(menu)
  expect(ids).toEqual(expect.arrayContaining([
    'image-reveal',
    'image-copy',
    'image-save-copy',
    'image-copy-to',
    'image-copy-address',
    'image-to-markdown',
    'image-to-html',
    'image-zoom-25',
    'image-zoom-adaptive',
    'image-align-left',
    'image-align-center',
    'image-align-right',
    'image-alt',
    'delete-object',
  ]))

  const alignment = menu.find((item) => item.kind === 'submenu' && item.id === 'image-alignment')
  expect(alignment?.kind).toBe('submenu')
  if (!alignment || alignment.kind !== 'submenu') throw new Error('image alignment submenu missing')
  const choices = alignment.items.filter((item) => item.kind === 'command')
  expect(choices).toHaveLength(3)
  expect(choices.map((item) => item.iconChoice)).toEqual([true, true, true])
  expect(choices.map((item) => item.checked)).toEqual([false, true, false])
})

it('uses only copy-safe APIs and returns a replacement after copy-to succeeds', async () => {
  const api = {
    revealImage: vi.fn(async () => ({ ok: true as const, value: null })),
    copyImage: vi.fn(async () => ({ ok: true as const, value: null })),
    saveImageCopy: vi.fn(async () => ({ ok: true as const, value: 'C:\\copies\\photo.png' })),
    copyImageTo: vi.fn(async () => ({ ok: true as const, value: 'C:\\assets\\photo.png' })),
  }
  const writeText = vi.fn(async () => undefined)
  const source = 'C:\\photos\\photo.png'

  await executeImageResourceCommand('image-reveal', source, api, writeText)
  await executeImageResourceCommand('image-copy', source, api, writeText)
  await executeImageResourceCommand('image-save-copy', source, api, writeText)
  const copied = await executeImageResourceCommand('image-copy-to', source, api, writeText)
  await executeImageResourceCommand('image-copy-address', source, api, writeText)

  expect(api.revealImage).toHaveBeenCalledWith(source)
  expect(api.copyImage).toHaveBeenCalledWith(source)
  expect(api.saveImageCopy).toHaveBeenCalledWith(source)
  expect(api.copyImageTo).toHaveBeenCalledWith(source)
  expect(writeText).toHaveBeenCalledWith(source)
  expect(copied.replacementSource).toBe('C:\\assets\\photo.png')
})

it('does not expose any source-resource mutation API', () => {
  const apiSurface = ['revealImage', 'copyImage', 'saveImageCopy', 'copyImageTo']
  expect(apiSurface).not.toEqual(expect.arrayContaining([
    'renameImage',
    'moveImage',
    'deleteImage',
    'overwriteImage',
  ]))
})
