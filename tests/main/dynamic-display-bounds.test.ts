import { expect, it } from 'vitest'
import { createDisplayBoundsNormalizer, type WorkArea } from '../../src/main/settings/window-bounds'

it('reads the current display work areas each time bounds are saved', () => {
  let workAreas: WorkArea[] = [{ x: 0, y: 0, width: 1920, height: 1040 }]
  const normalize = createDisplayBoundsNormalizer(() => workAreas)
  const bounds = { width: 900, height: 700, x: 2500, y: 50 }

  expect(normalize(bounds)).toEqual({ width: 900, height: 700 })

  workAreas = [{ x: 1920, y: 0, width: 1920, height: 1040 }]
  expect(normalize(bounds)).toEqual(bounds)
})
