import { mkdtemp, mkdir, readFile, writeFile, readdir, rename, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { INITIAL_WORKSPACE_MARKER, prepareInitialWorkspace, migrateInitialWorkspace } from '../../src/main/initial-workspace'

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

const articleName = '11-把夏天骑进海风里.md'
const articleImages = ['01-coastal-ride.png', '02-sand-and-rest.png', '03-postcard-cafe.png', '04-blue-hour.png']
async function legacyFixture() {
  const options = await fixture()
  options.templateRoot = path.resolve('initial-workspace')
  const destination = path.join(options.documentsRoot, 'Arkdown', '初始工作区')
  await mkdir(destination, { recursive: true })
  await mkdir(options.stateRoot, { recursive: true })
  await writeFile(path.join(destination, INITIAL_WORKSPACE_MARKER), '\ufeff{"version":1}', 'utf8')
  await writeFile(path.join(options.stateRoot, 'initial-workspace-v1.json'), '{"version":1}', 'utf8')
  await writeFile(path.join(destination, '01-欢迎使用.md'), '# 我的欢迎页', 'utf8')
  return { options, destination }
}

it('installs all eleven real chapters with resolvable article images for a new user', async () => {
  const options = await fixture()
  options.templateRoot = path.resolve('initial-workspace')
  const welcome = (await prepareInitialWorkspace(options))!
  const destination = path.dirname(welcome)
  expect((await readdir(destination)).filter(name => name.endsWith('.md'))).toHaveLength(11)
  const article = await readFile(path.join(destination, articleName), 'utf8')
  for (const image of articleImages) {
    const relative = `assets/summer-sea-breeze/${image}`
    expect(article).toContain(`](${relative})`)
    expect((await readFile(path.join(destination, relative))).equals(await readFile(path.join(options.templateRoot, relative)))).toBe(true)
  }
})

it('migrates a selected legacy initial workspace despite its profile marker, preserving edits and omitted old chapters', async () => {
  const { options, destination } = await legacyFixture()
  const assetFolder = path.join(destination, 'assets/summer-sea-breeze')
  await mkdir(assetFolder, { recursive: true })
  await writeFile(path.join(assetFolder, articleImages[0]), 'user image', 'utf8')
  const selected = { ...options, previousWorkspace: destination }
  expect(await prepareInitialWorkspace(selected)).toBeNull()
  expect((await readFile(path.join(destination, articleName))).equals(await readFile(path.join(options.templateRoot, articleName)))).toBe(true)
  expect(await readFile(path.join(destination, '01-欢迎使用.md'), 'utf8')).toBe('# 我的欢迎页')
  expect((await readdir(destination)).filter(name => name.endsWith('.md'))).toEqual(['01-欢迎使用.md', articleName])
  expect(await readFile(path.join(assetFolder, articleImages[0]), 'utf8')).toBe('user image')
  for (const image of articleImages.slice(1)) expect((await readFile(path.join(assetFolder, image))).equals(await readFile(path.join(options.templateRoot, 'assets/summer-sea-breeze', image)))).toBe(true)
  await rm(path.join(destination, articleName))
  await rm(path.join(assetFolder, articleImages[1]))
  await migrateInitialWorkspace({ ...selected, stateRoot: path.join(options.stateRoot, 'another-profile') })
  expect(await readdir(destination)).not.toContain(articleName)
  expect(await readdir(assetFolder)).not.toContain(articleImages[1])
})

it('keeps an existing edited article while filling only its missing shipped dependencies', async () => {
  const { options, destination } = await legacyFixture()
  await writeFile(path.join(destination, articleName), '# 我的散文', 'utf8')
  await migrateInitialWorkspace(options)
  expect(await readFile(path.join(destination, articleName), 'utf8')).toBe('# 我的散文')
  expect(await readdir(path.join(destination, 'assets/summer-sea-breeze'))).toEqual(articleImages)
})

it('does not migrate an arbitrary selected workspace or a default folder without a recognized marker', async () => {
  const { options, destination } = await legacyFixture()
  await migrateInitialWorkspace({ ...options, previousWorkspace: path.join(options.documentsRoot, 'Other') })
  expect(await readdir(destination)).not.toContain(articleName)
  for (const marker of ['', '{"version":99}', '{"version":"1"}', 'broken']) {
    await writeFile(path.join(destination, INITIAL_WORKSPACE_MARKER), marker)
    await migrateInitialWorkspace(options)
    expect(await readdir(destination)).not.toContain(articleName)
  }
  await rm(path.join(destination, INITIAL_WORKSPACE_MARKER))
  await migrateInitialWorkspace(options)
  expect(await readdir(destination)).not.toContain(articleName)
})

it('leaves legacy migration retryable when a shipped dependency is missing', async () => {
  const { options, destination } = await legacyFixture()
  const incomplete = await fixture()
  await expect(migrateInitialWorkspace({ ...options, templateRoot: incomplete.templateRoot })).rejects.toThrow()
  expect(JSON.parse((await readFile(path.join(destination, INITIAL_WORKSPACE_MARKER), 'utf8')).replace(/^\uFEFF/, '')).version).toBe(1)
  await migrateInitialWorkspace(options)
  expect(await readdir(destination)).toContain(articleName)
})

it.each(['parent', 'workspace', 'assets'])('does not follow a %s junction in the migration destination', async (location) => {
  const { options, destination } = await legacyFixture()
  const outside = path.join(options.documentsRoot, 'user-assets')
  const linkedPath = location === 'parent' ? path.dirname(destination) : location === 'workspace' ? destination : path.join(destination, 'assets')
  if (location === 'assets') await mkdir(outside)
  else await rename(linkedPath, outside)
  const before = await readdir(outside, { recursive: true })
  await symlink(outside, linkedPath, 'junction')
  await expect(migrateInitialWorkspace(options)).rejects.toThrow(/symbolic|link|directory/i)
  expect(await readdir(outside, { recursive: true })).toEqual(before)
})
