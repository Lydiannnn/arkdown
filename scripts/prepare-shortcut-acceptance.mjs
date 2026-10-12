import { build } from 'rolldown'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.shortcut-fixture')
await mkdir(output, { recursive: true })
await build({ input: path.join(root, 'src/main/settings/keyboard-shortcut-input.ts'), platform: 'node', output: { file: path.join(output, 'input.cjs'), format: 'cjs' } })
await build({ input: path.join(root, 'scripts/shortcut-acceptance-renderer.ts'), platform: 'browser', output: { file: path.join(output, 'renderer.js'), format: 'iife' } })
await writeFile(path.join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Arkdown synthetic shortcut fixture</title><style>body{font:16px sans-serif}.cm-editor,textarea,.ProseMirror{border:1px solid #888;margin:10px;min-height:50px;white-space:pre-wrap}</style><textarea id="text"></textarea><div id="cm"></div><div id="pm"></div><script src="renderer.js"></script>', 'utf8')
console.log(output)
