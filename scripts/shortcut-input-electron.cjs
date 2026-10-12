// First run prepare-shortcut-acceptance.mjs with Node. Run THIS file with Electron.
const { app, BrowserWindow, Menu } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path'), fs = require('node:fs'), os = require('node:os')
const { createKeyboardShortcutInputHandler } = require('../.shortcut-fixture/input.cjs')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'arkdown-shortcut-acceptance-'))
app.setPath('userData', userData)
let win
app.whenReady().then(async () => {
  let bindings = {}, recording = false, native = [], renderer = [], menus = 0
  win = new BrowserWindow({ width: 700, height: 450, show: true })
  const wc = win.webContents
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Fixture', submenu: [{ label: 'Menu collision', accelerator: 'Ctrl+Left', click: () => menus++ }] }]))
  wc.on('before-input-event', createKeyboardShortcutInputHandler({ getBindings: () => bindings, isRecording: () => recording,
    executeNative: id => native.push(id), executeRenderer: id => renderer.push(id), sendInputEvent: event => wc.sendInputEvent(event), setIgnoreMenuShortcuts: value => wc.setIgnoreMenuShortcuts(value) }))
  await win.loadFile(path.resolve(__dirname, '../.shortcut-fixture/index.html'))
  win.focus(); wc.focus()
  const evaluate = value => wc.executeJavaScript(value)
  const reset = kind => evaluate(`fixture.reset(${JSON.stringify(kind)})`)
  const read = kind => evaluate(`fixture.read(${JSON.stringify(kind)})`)
  const key = async (keyCode, modifiers = ['control']) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const evidence = []
  for (const kind of ['text', 'cm', 'pm']) {
    bindings = { 'navigation.left': 'Ctrl+R', 'file.save': 'Ctrl+Left', 'navigation.select-left': 'Ctrl+Alt+R', 'navigation.delete-left': 'Ctrl+Alt+D', 'edit.undo': 'Ctrl+Alt+U', 'edit.redo': 'Ctrl+Alt+Y' }
    await reset(kind)
    await key('R')
    assert.equal((await read(kind)).head, 11, `${kind}: remapped word left`)
    await reset(kind)
    await key('R', ['control', 'isautorepeat'])
    assert.equal((await read(kind)).head, 11, `${kind}: repeated navigation`)
    assert.equal((await read(kind)).events[0].repeat, true, `${kind}: repeat flag preserved`)
    const before = native.length
    await key('Left')
    assert.equal(native.length, before + 1, `${kind}: reused old combo once`)
    assert.equal((await read(kind)).head, 11, `${kind}: reused key cannot also navigate`)
    await reset(kind)
    await key('R', ['control', 'alt'])
    assert.deepEqual([(await read(kind)).anchor, (await read(kind)).head], [11, 16], `${kind}: selection`)
    await reset(kind)
    await key('D', ['control', 'alt'])
    assert.equal((await read(kind)).text, 'alpha beta ', `${kind}: delete word`)
    await key('U', ['control', 'alt'])
    assert.equal((await read(kind)).text, 'alpha beta gamma', `${kind}: undo`)
    await key('Y', ['control', 'alt'])
    assert.equal((await read(kind)).text, 'alpha beta ', `${kind}: redo`)
    recording = true
    await reset(kind)
    await key('R')
    assert.equal((await read(kind)).head, 16, `${kind}: recording bypass`)
    recording = false
    bindings = {}
    await key('Left')
    assert.equal((await read(kind)).head, 11, `${kind}: restored default`)
    evidence.push({ kind, ok: true })
  }
  bindings = { 'editor.strong': 'Ctrl+R', 'document.outline': 'Ctrl+B' }
  await key('B'); await key('R')
  assert.deepEqual(renderer, ['toggle-document-outline'])
  assert.equal(native.at(-1), 'format.strong')
  assert.equal(menus, 0)
  console.log(JSON.stringify({ ok: true, electron: process.versions.electron, evidence, menus, userData }))
  win.close(); app.quit()
}).catch(error => { console.error(error.stack); if (win && !win.isDestroyed()) win.destroy(); app.exit(1) })
