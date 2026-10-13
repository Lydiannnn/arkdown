import { execFile } from 'node:child_process'
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const projectRoot = resolve(import.meta.dirname, '..')
const defaultSourceRoot = join(projectRoot, 'guide-web')
const defaultOutputRoot = join(projectRoot, 'user-guide', 'dist')
const execFileAsync = promisify(execFile)
const GUIDE_PAGES = [
  'index.html', 'workspace.html', 'writing.html', 'saving.html', 'media.html',
  'notes.html', 'translation.html', 'ai.html', 'settings.html', 'shortcuts.html',
] as const
const GUIDE_FILES = [...GUIDE_PAGES, 'guide.css', 'guide.js', 'search-index.js'] as const

async function requireFile(path: string): Promise<void> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`required guide asset is not a file: ${path}`)
}

export async function buildUserGuide(
  outputRoot = defaultOutputRoot,
  sourceRoot = defaultSourceRoot,
): Promise<void> {
  await Promise.all([
    ...GUIDE_FILES.map((file) => requireFile(join(sourceRoot, file))),
    requireFile(join(sourceRoot, 'assets', 'background-settings.png')),
    requireFile(join(sourceRoot, 'assets', 'editor.png')),
    requireFile(join(sourceRoot, 'assets', 'favicon.svg')),
    requireFile(join(sourceRoot, 'assets', 'preferences.png')),
  ])

  await rm(outputRoot, { recursive: true, force: true })
  const siteRoot = join(outputRoot, '使用说明书')
  await mkdir(siteRoot, { recursive: true })
  await Promise.all(GUIDE_FILES.map((file) => cp(join(sourceRoot, file), join(siteRoot, file))))
  await cp(join(sourceRoot, 'assets'), join(siteRoot, 'assets'), { recursive: true })
  await writeFile(join(outputRoot, '使用说明书.html'), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="0; url=使用说明书/index.html">
  <title>Arkdown 使用说明</title>
</head>
<body><p><a href="使用说明书/index.html">打开 Arkdown 使用说明</a></p></body>
</html>
`, 'utf8')
}

async function rebuildPublishedSource(): Promise<void> {
  await execFileAsync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    join(defaultSourceRoot, 'build.mjs'),
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await rebuildPublishedSource()
  await execFileAsync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    join(projectRoot, 'scripts', 'build-initial-workspace.mjs'),
  ], { cwd: projectRoot, encoding: 'utf8' })
  await buildUserGuide()
}
