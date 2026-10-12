import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const assetDirectory = path.join(
  process.cwd(),
  'src',
  'renderer',
  'assets',
  'workspace',
)

describe('workspace action icon assets', () => {
  it.each(['search.png', 'reload.png'])('%s is an original 22 by 22 PNG', (name) => {
    const filePath = path.join(assetDirectory, name)
    expect(existsSync(filePath)).toBe(true)
    if (!existsSync(filePath)) return

    const image = readFileSync(filePath)
    expect(image.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(image.readUInt32BE(16)).toBe(22)
    expect(image.readUInt32BE(20)).toBe(22)
  })

  it('uses the approved replacement reload artwork', () => {
    const image = readFileSync(path.join(assetDirectory, 'reload.png'))
    expect(createHash('sha256').update(image).digest('hex')).toBe(
      '022f5c0de2667127dcf43e29d1c34dcd45f67bf28aaf6074c7e79a2508c35d49',
    )
  })
})
