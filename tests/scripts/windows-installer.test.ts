import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectInstallerFiles, installerFileEntries, installerDefines } from '../../scripts/windows-installer-input'

const roots: string[] = []
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-installer-input-')); roots.push(root); return root }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Windows installer payload', () => {
  it('rejects a package containing private user data, including empty data directories', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'portable-data'))
    await expect(collectInstallerFiles(root)).rejects.toThrow(/user data/i)
  })
  it('rejects draft directories rather than silently publishing or overwriting them', async () => {
    const root = await fixture()
    await mkdir(path.join(root, 'temp'))
    await writeFile(path.join(root, 'temp', 'draft.md'), 'private unsaved content')
    await expect(collectInstallerFiles(root)).rejects.toThrow(/user data/i)
  })
  it('makes the complete inventory reproducible and identifies editable workspace templates', async () => {
    const root = await fixture()
    await mkdir(path.join(root, '初始工作区'))
    await writeFile(path.join(root, 'Arkdown.exe'), 'app')
    await writeFile(path.join(root, '初始工作区', '01-欢迎.md'), 'hello')
    const files = await collectInstallerFiles(root)
    expect(files.map(f => ({ path: f.path, preserveExisting: f.preserveExisting }))).toEqual([
      { path: 'Arkdown.exe', preserveExisting: false }, { path: '初始工作区/01-欢迎.md', preserveExisting: true },
    ])
    expect(files.find(f => f.path.endsWith('.md'))?.sha256).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    const entries = installerFileEntries(root, files)
    expect(entries).toContain('Flags: onlyifdoesntexist uninsneveruninstall')
    expect(entries).toContain('Flags: ignoreversion')
    expect(entries).not.toContain('recursesubdirs')
  })
  it('rejects wildcard/control characters in filenames used by the compiler', () => {
    expect(() => installerFileEntries('C:/build', [{ path: 'bad\nname', size: 1, sha256: 'a'.repeat(64), preserveExisting: false }])).toThrow()
  })
  it('preserves numeric version ordering for downgrade prevention', () => {
    expect(installerDefines('1.10.2', 'full')).toEqual({ version: '1.10.2', edition: 'Full', versionMS: 65546, versionLS: 131072 })
    expect(() => installerDefines('1.0.1-beta', 'full')).toThrow()
    expect(() => installerDefines('1.0.1', 'wrong')).toThrow()
  })
})
