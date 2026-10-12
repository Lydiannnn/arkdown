// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { UpdatePreferences } from '../../src/main/updates/update-preferences'
it('persists only a validated version and tolerates corrupt or BOM-prefixed preferences', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-update-preferences-'))
  try {
    const preferences = new UpdatePreferences(root)
    expect(await preferences.readSkippedVersion()).toBeNull()
    await preferences.skipVersion('1.0.5'); expect(await new UpdatePreferences(root).readSkippedVersion()).toBe('1.0.5')
    await expect(preferences.skipVersion('../invalid')).rejects.toThrow()
    await writeFile(path.join(root, 'skip.json'), '\uFEFF{"schemaVersion":1,"version":"1.0.6"}')
    expect(await preferences.readSkippedVersion()).toBe('1.0.6')
    await writeFile(path.join(root, 'skip.json'), 'invalid'); expect(await preferences.readSkippedVersion()).toBeNull()
  } finally { await rm(root, { recursive: true, force: true }) }
})
