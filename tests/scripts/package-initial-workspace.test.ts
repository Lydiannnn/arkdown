import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { expect, it } from 'vitest'
import { copyInitialWorkspaceToPackages } from '../../scripts/package-initial-workspace'

it('ships the numbered welcome and all chapters in each package without replacing existing files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-initial-package-'))
  try {
    const output = path.join(root, 'Arkdown-win32-x64')
    await mkdir(output)
    await copyInitialWorkspaceToPackages([output])
    const folder = path.join(output, '初始工作区')
    const files = (await readdir(folder)).filter(name => name.endsWith('.md')).sort()
    expect(files).toHaveLength(10)
    expect(files.at(-1)).toBe('10-常用快捷键.md')
    expect(await readdir(folder)).not.toContain('assets')
    expect(files).toContain('02-与 AI 一起处理文档.md')
    expect(files).not.toContain('02-开始第一篇文档.md')
    expect(files.some(name => name.includes('遇到问题'))).toBe(false)
    expect(files.every((name, index) => name.startsWith(String(index + 1).padStart(2, '0') + '-') && name.endsWith('.md'))).toBe(true)
    expect(await readFile(path.join(folder, '01-欢迎使用.md'), 'utf8')).toContain('arkdown:choose-workspace')
    for (const name of files) {
      expect((await readFile(path.join(folder, name))).equals(await readFile(path.resolve('initial-workspace', name)))).toBe(true)
    }
    await expect(copyInitialWorkspaceToPackages([output])).rejects.toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
