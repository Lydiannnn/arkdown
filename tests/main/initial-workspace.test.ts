import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { INITIAL_WORKSPACE_MARKER, prepareInitialWorkspace } from '../../src/main/initial-workspace'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arkdown-initial-test-')); roots.push(root)
  const options = { templateRoot: path.join(root, 'templates'), documentsRoot: path.join(root, 'Documents'),
    stateRoot: path.join(root, 'state'), previousWorkspace: null as string | null }
  await mkdir(options.templateRoot)
  await writeFile(path.join(options.templateRoot, '01-欢迎使用.md'), '# 欢迎', 'utf8')
  await writeFile(path.join(options.templateRoot, '02-写作.md'), '# 写作', 'utf8')
  return options
}
it('copies a real editable welcome and chapters only once and never overwrites edits', async () => {
  const options = await fixture()
  const welcome = await prepareInitialWorkspace(options)
  expect(welcome).toBe(path.join(options.documentsRoot, 'Arkdown', '初始工作区', '01-欢迎使用.md'))
  expect(await readdir(path.dirname(welcome!))).toEqual([INITIAL_WORKSPACE_MARKER, '01-欢迎使用.md', '02-写作.md'])
  await writeFile(welcome!, '# 我的修改', 'utf8')
  expect(await prepareInitialWorkspace(options)).toBeNull()
  expect(await readFile(welcome!, 'utf8')).toBe('# 我的修改')
})
it('does not append renamed chapters or restore removed files when another portable profile starts', async () => {
  const options = await fixture()
  const welcome = (await prepareInitialWorkspace(options))!
  await writeFile(welcome, '# 我的内容', 'utf8')
  await rm(path.join(path.dirname(welcome), '02-写作.md'))
  await writeFile(path.join(options.templateRoot, '03-重新编号.md'), '# 新模板', 'utf8')
  const nextOptions = { ...options, stateRoot: path.join(path.dirname(options.stateRoot), 'new-profile') }
  expect(await prepareInitialWorkspace(nextOptions)).toBe(welcome)
  expect(await readdir(path.dirname(welcome))).toEqual([INITIAL_WORKSPACE_MARKER, '01-欢迎使用.md'])
  expect(await readFile(welcome, 'utf8')).toBe('# 我的内容')
  await rm(welcome)
  expect(await prepareInitialWorkspace({ ...options, stateRoot: path.join(path.dirname(options.stateRoot), 'third-profile') })).toBeNull()
})
it('keeps files from a partial or earlier copy and leaves existing workspaces alone', async () => {
  const options = await fixture()
  expect(await prepareInitialWorkspace({ ...options, previousWorkspace: 'already-selected' })).toBeNull()
  const destination = path.join(options.documentsRoot, 'Arkdown', '初始工作区')
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, '01-欢迎使用.md'), '# 保留', 'utf8')
  const welcome = await prepareInitialWorkspace(options)
  expect(await readFile(welcome!, 'utf8')).toBe('# 保留')
  expect(await readFile(path.join(destination, '02-写作.md'), 'utf8')).toBe('# 写作')
})
it('allows a retry when templates are missing without marking initialization complete', async () => {
  const options = await fixture()
  const welcome = path.join(options.templateRoot, '01-欢迎使用.md')
  await rm(welcome)
  await expect(prepareInitialWorkspace(options)).rejects.toThrow()
  await writeFile(welcome, '# 恢复模板', 'utf8')
  expect(await prepareInitialWorkspace(options)).not.toBeNull()
})

it('copies nested article images once and preserves user resources across portable profiles', async () => {
  const options = await fixture()
  const assetFolder = path.join('assets', 'summer-sea-breeze')
  await mkdir(path.join(options.templateRoot, assetFolder), { recursive: true })
  const imagePath = path.join(assetFolder, '01-coastal-ride.png')
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  await writeFile(path.join(options.templateRoot, imagePath), image)
  const welcome = (await prepareInitialWorkspace(options))!
  const destination = path.dirname(welcome)
  expect(await readFile(path.join(destination, imagePath))).toEqual(image)
  await writeFile(path.join(destination, imagePath), 'user image')
  await writeFile(path.join(options.templateRoot, assetFolder, '02-new-image.png'), image)
  await writeFile(path.join(options.templateRoot, '11-把夏天骑进海风里.md'), '# 新文章', 'utf8')
  await prepareInitialWorkspace({ ...options, stateRoot: path.join(path.dirname(options.stateRoot), 'next-profile') })
  expect(await readFile(path.join(destination, imagePath), 'utf8')).toBe('user image')
  expect(await readdir(path.join(destination, assetFolder))).toEqual(['01-coastal-ride.png'])
  expect(await readdir(destination)).not.toContain('11-把夏天骑进海风里.md')
})

it('does not redeliver retired sample content into a marked user workspace', async () => {
  const options = await fixture()
  const destination = path.join(options.documentsRoot, 'Arkdown', '初始工作区')
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, INITIAL_WORKSPACE_MARKER), '{"version":1}')
  await writeFile(path.join(destination, '01-欢迎使用.md'), '# 用户的修改')
  const templateRoot = path.resolve('initial-workspace')
  expect(await prepareInitialWorkspace({ ...options, templateRoot, previousWorkspace: destination })).toBeNull()
  expect(await readdir(destination)).toEqual([INITIAL_WORKSPACE_MARKER, '01-欢迎使用.md'])
  expect(await readFile(path.join(destination, '01-欢迎使用.md'), 'utf8')).toBe('# 用户的修改')
})

it('initializes exactly the ten real guides without a retired story or image directory', async () => {
  const options = await fixture()
  options.templateRoot = path.resolve('initial-workspace')
  const welcome = (await prepareInitialWorkspace(options))!
  const files = await readdir(path.dirname(welcome))
  expect(files.filter(name => name.endsWith('.md'))).toHaveLength(10)
  expect(files).not.toContain('11-把夏天骑进海风里.md')
  expect(files).not.toContain('assets')
})

it('leaves an existing user-edited sample untouched instead of deleting user data', async () => {
  const options = await fixture()
  const destination = path.join(options.documentsRoot, 'Arkdown', '初始工作区')
  await mkdir(destination, { recursive: true })
  await writeFile(path.join(destination, INITIAL_WORKSPACE_MARKER), '{"version":2}')
  await writeFile(path.join(destination, '11-把夏天骑进海风里.md'), '# 我的改写')
  expect(await prepareInitialWorkspace({ ...options, previousWorkspace: destination })).toBeNull()
  expect(await readFile(path.join(destination, '11-把夏天骑进海风里.md'), 'utf8')).toBe('# 我的改写')
})

it.each(['parent', 'workspace', 'assets'])('does not initialize through a %s junction', async location => {
  const options = await fixture()
  const outside = path.join(path.dirname(options.stateRoot), 'outside')
  const parent = path.join(options.documentsRoot, 'Arkdown')
  const destination = path.join(parent, '初始工作区')
  const linked = location === 'parent' ? parent : location === 'workspace' ? destination : path.join(destination, 'assets')
  await mkdir(path.dirname(linked), { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(outside, 'user.md'), '# Keep me')
  await mkdir(path.join(options.templateRoot, 'assets'))
  await writeFile(path.join(options.templateRoot, 'assets', 'example.png'), 'image')
  await symlink(outside, linked, 'junction')
  await expect(prepareInitialWorkspace(options)).rejects.toThrow(/symbolic|link|directory/i)
  expect(await readdir(outside)).toEqual(['user.md'])
  expect(await readFile(path.join(outside, 'user.md'), 'utf8')).toBe('# Keep me')
})
