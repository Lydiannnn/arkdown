import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// These Markdown chapters are hand-maintained sources, independent of the HTML handbook.
// Keep this build entry point read-only so packaging never regenerates their contents.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'initial-workspace')
const expected = [
  '01-欢迎使用.md',
  '02-与 AI 一起处理文档.md',
  '03-管理文件与工作区.md',
  '04-编辑与排版.md',
  '05-保存、转换与导出.md',
  '06-图片与本地资源.md',
  '07-用便签收纳零散想法.md',
  '08-划词翻译与截图识别.md',
  '09-把 Arkdown 调整得顺手.md',
  '10-常用快捷键.md',
  '11-把夏天骑进海风里.md',
]
const actual = (await readdir(source)).filter(name => name.endsWith('.md')).sort()
if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
  throw new Error(`Initial workspace must contain the ${expected.length} expected Markdown chapters`)
}
for (const name of expected) {
  const markdown = await readFile(path.join(source, name), 'utf8')
  if (!markdown.trim()) throw new Error(`Initial workspace chapter is empty: ${name}`)
}
const article = await readFile(path.join(source, '11-把夏天骑进海风里.md'), 'utf8')
const images = [...article.matchAll(/!\[[^\]]*\]\((assets\/summer-sea-breeze\/[^)]+)\)/g)].map(match => match[1])
if (images.length !== 4 || new Set(images).size !== 4) {
  throw new Error('Summer article must reference four distinct bundled images')
}
for (const relativePath of images) {
  if (!(await readFile(path.join(source, relativePath))).length) {
    throw new Error(`Initial workspace image is empty: ${relativePath}`)
  }
}
console.log(`Initial workspace: validated ${expected.length} hand-maintained Markdown documents`)
