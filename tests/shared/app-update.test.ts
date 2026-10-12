import { describe, expect, it } from 'vitest'
import { compareUpdateVersions } from '../../src/shared/app-update'

describe('semantic application update ordering', () => {
  it.each([
    ['1.0.10', '1.0.9', 1], ['1.0.4', '1.0.4', 0], ['1.0.3', '1.0.4', -1],
    ['1.0.0-beta.10', '1.0.0-beta.2', 1], ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0+abc', '1.0.0+def', 0],
    ['10000000000000000001.0.0', '10000000000000000000.0.0', 1],
  ])('compares %s against %s', (a, b, result) => expect(compareUpdateVersions(a as string, b as string)).toBe(result))
  it.each(['01.0.1', '1.0', '1.0.0-01', 'v1.0.0', '1.0.0 ', '1.0.0-汉字', '1.0.0+', '1'.repeat(49)])(
    'rejects invalid version %s', value => expect(compareUpdateVersions(value, '1.0.0')).toBeUndefined())
})
