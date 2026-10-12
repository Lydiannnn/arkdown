import { expect, it } from 'vitest'
import { restoreWindowBounds, type WorkArea } from '../../src/main/settings/window-bounds'

const workAreas: WorkArea[] = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 1920, height: 1040 },
]

it('drops extreme dimensions that fit no display work area', () => {
  expect(restoreWindowBounds({ width: 5000, height: 3000, x: 0, y: 0 }, workAreas)).toBeUndefined()
})

it('drops a disconnected-display position while retaining a valid size', () => {
  expect(restoreWindowBounds({ width: 900, height: 700, x: 9000, y: 9000 }, workAreas)).toEqual({
    width: 900,
    height: 700,
  })
})

it('keeps a position that intersects an available display work area', () => {
  expect(restoreWindowBounds({ width: 900, height: 700, x: 1950, y: 50 }, workAreas)).toEqual({
    width: 900,
    height: 700,
    x: 1950,
    y: 50,
  })
})
