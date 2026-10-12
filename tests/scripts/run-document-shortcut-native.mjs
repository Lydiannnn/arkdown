// Windows-only integration: real .lnk files and the production inspector, no application windows.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON tests/scripts/run-document-shortcut-native.mjs
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'rolldown'
import { waitForElectronExecutablesQuiet } from '../e2e/support/runtime.ts'

if (process.platform !== 'win32') throw new Error('This regression requires Windows')
const require = createRequire(import.meta.url)
const executable = require('electron')
const root = await mkdtemp(path.join(tmpdir(), 'arkdown-document-shortcut-native-'))
const bundle = path.join(root, 'inspector.cjs')
await build({ input: fileURLToPath(new URL('../../src/main/dropped-path-inspector.ts', import.meta.url)),
  external: ['electron', /^node:/], output: { file: bundle, format: 'cjs' } })
await mkdir(path.join(root, 'user-data'))
const runner = path.join(root, 'runner.cjs')
await writeFile(runner, `
const { app, shell } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { inspectDroppedPath } = require('./inspector.cjs');
app.setPath('userData', path.join(__dirname, 'user-data'));
app.whenReady().then(async () => {
  let passed = 0;
  for (const name of ['中文 文档.md', '正文.txt', 'config.json', 'module.cjs', 'source.ts']) {
    const target = path.join(__dirname, name);
    const shortcut = path.join(__dirname, name + '.lnk');
    await fs.writeFile(target, 'fixture', 'utf8');
    assert.equal(shell.writeShortcutLink(shortcut, { target }), true);
    assert.deepEqual(await inspectDroppedPath(shortcut, true), { kind: 'file', absolutePath: target });
    assert.deepEqual(await inspectDroppedPath(shortcut), { kind: 'file', absolutePath: shortcut });
    passed++;
  }
  const missing = path.join(__dirname, 'missing.md');
  const broken = path.join(__dirname, 'broken.lnk');
  assert.equal(shell.writeShortcutLink(broken, { target: missing }), true);
  await assert.rejects(inspectDroppedPath(broken, true), { code: 'FILE_NOT_FOUND' });
  passed++;
  const program = path.join(__dirname, 'program.lnk');
  assert.equal(shell.writeShortcutLink(program, { target: process.execPath, args: '--version' }), true);
  await assert.rejects(inspectDroppedPath(program, true), { code: 'UNSUPPORTED_FILE_TYPE' });
  passed++;
  await fs.writeFile(path.join(__dirname, 'result.json'), JSON.stringify({ passed }, null, 2), 'utf8');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`, 'utf8')
// The fixture directory is retained for inspection; no user document or shortcut is touched.
const outcome = await new Promise((resolve, reject) => {
  const child = spawn(executable, [runner], { windowsHide: true, shell: false, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ code, signal }))
})
await waitForElectronExecutablesQuiet({ executables: [executable] })
if (outcome.code !== 0) throw new Error('Shortcut integration failed: ' + JSON.stringify(outcome))
process.stdout.write(await readFile(path.join(root, 'result.json'), 'utf8') + '\n')
