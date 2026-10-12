import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { auditBrandingResources, copyBrandingToPackages } from '../../scripts/package-branding'

it('packages exact approved native assets and rejects missing, modified and extra resources', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-branding-'))
  try {
    const resources = path.join(root, 'resources', 'branding')
    expect(await auditBrandingResources(resources)).not.toEqual([])
    await copyBrandingToPackages([root])
    expect(await auditBrandingResources(resources)).toEqual([])
    await writeFile(path.join(resources, 'ark-md.ico'), 'wrong icon')
    await writeFile(path.join(resources, 'unapproved.ico'), 'extra')
    await rm(path.join(resources, 'ark-txt.ico'))
    expect(await auditBrandingResources(resources)).toEqual(expect.arrayContaining([
      'modified branding resource: ark-md.ico', 'unexpected branding resource: unapproved.ico', 'missing branding resource: ark-txt.ico',
    ]))
  } finally { await rm(root, { recursive: true, force: true }) }
})
