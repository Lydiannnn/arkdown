import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import forgeConfig from '../../forge.config'

describe('Arkdown branding', () => {
  it('uses the Arkdown project and executable metadata', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      name?: string
      productName?: string
      description?: string
    }

    expect(packageJson.name).toBe('arkdown')
    expect(packageJson.productName).toBe('Arkdown')
    expect(packageJson.description).not.toMatch(new RegExp(['ty', 'pora|local', 'md'].join(''), 'i'))
    expect(forgeConfig.packagerConfig?.executableName).toBe('Arkdown')
  })
})
