// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { writeUpdateManagedManifest, verifyUpdateManagedManifest } from '../../scripts/package-update-manifest'
it('binds program files to version/edition and rejects user-data inclusion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-update-manifest-'))
  try {
    await mkdir(path.join(root, 'resources')); await writeFile(path.join(root, 'Arkdown.exe'), 'program')
    await writeFile(path.join(root, 'resources', 'app.asar'), 'app')
    await writeUpdateManagedManifest(root, '1.0.4', 'full')
    const manifest = JSON.parse(await readFile(path.join(root, 'resources', 'update-managed-files.json'), 'utf8'))
    expect(manifest).toMatchObject({ schemaVersion: 1, product: 'Arkdown', version: '1.0.4', edition: 'Full' })
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(['Arkdown.exe', 'resources/app.asar'])
    expect(manifest.files.every((f: { sha256: string }) => /^[a-f0-9]{64}$/.test(f.sha256))).toBe(true)
    await verifyUpdateManagedManifest(root, '1.0.4', 'full')
    await writeFile(path.join(root, 'Arkdown.exe'), 'changed')
    await expect(verifyUpdateManagedManifest(root, '1.0.4', 'full')).rejects.toThrow('does not match')
    await mkdir(path.join(root, 'portable-data')); await writeFile(path.join(root, 'portable-data', 'settings.json'), 'private')
    await expect(writeUpdateManagedManifest(root, '1.0.4', 'full')).rejects.toThrow('user data')
  } finally { await rm(root, { recursive: true, force: true }) }
})
