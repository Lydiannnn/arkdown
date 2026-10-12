// Manual-only Electron probe. Never imported by Arkdown or the unit test runner.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { pathToFileURL } = require('node:url')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arkdown-drag-probe-'))
const sourceRoot = path.join(root, 'source')
const destinationRoot = path.join(root, 'destination')
fs.mkdirSync(sourceRoot)
fs.mkdirSync(destinationRoot)
fs.mkdirSync(path.join(root, 'profile'))
fs.mkdirSync(path.join(root, 'session'))
app.setPath('userData', path.join(root, 'profile'))
app.setPath('sessionData', path.join(root, 'session'))
app.disableHardwareAcceleration()

const files = new Map([
  ['markdown', { name: 'probe-note.md', text: '# Synthetic drag probe\n\nNo private content.\n' }],
  ['text', { name: 'probe-note.txt', text: 'Synthetic text drag probe.\n' }],
  ['code', { name: 'probe-data.json', text: '{"probe":true,"version":1}\n' }],
])
for (const file of files.values()) {
  file.path = path.join(sourceRoot, file.name)
  fs.writeFileSync(file.path, file.text, { encoding: 'utf8', flag: 'wx' })
  file.sha256 = createHash('sha256').update(file.text).digest('hex')
}
const logPath = path.join(root, 'events.jsonl')
let sequence = 0
let window
let active = null
const log = (type, data = {}) => fs.appendFileSync(logPath,
  JSON.stringify({ sequence: ++sequence, time: new Date().toISOString(), type, ...data }) + '\n', 'utf8')
const sourceState = () => [...files].map(([id, file]) => {
  try {
    const stat = fs.lstatSync(file.path)
    return { id, exists: true, regular: stat.isFile() && !stat.isSymbolicLink(),
      sha256: createHash('sha256').update(fs.readFileSync(file.path)).digest('hex'), expected: file.sha256 }
  } catch (error) { return { id, exists: false, error: error.code ?? 'UNKNOWN' } }
})
const pageUrl = pathToFileURL(path.join(__dirname, 'index.html')).href
const owns = event => window && !window.isDestroyed()
  && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
  && event.senderFrame.url === pageUrl

ipcMain.handle('probe:info', event => {
  if (!owns(event)) throw new Error('Invalid probe sender')
  return { root, sourceRoot, destinationRoot, files: [...files].map(([id, file]) => ({ id, name: file.name })),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node } }
})
ipcMain.on('probe:begin', (event, id) => {
  if (!owns(event) || typeof id !== 'string' || !files.has(id) || active) return
  const file = files.get(id)
  const before = sourceState()
  if (before.some(item => !item.regular || item.sha256 !== item.expected)) {
    log('refused-source-changed', { before })
    return
  }
  active = id
  log('native-begin', { id, before })
  // Explicit nonempty drag bitmap; no temp copy or application file is passed.
  const pixels = Buffer.alloc(32 * 32 * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 75; pixels[offset + 1] = 75; pixels[offset + 2] = 205; pixels[offset + 3] = 255
  }
  try {
    event.sender.startDrag({ file: file.path, icon: nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }) })
    log('native-return', { id, after: sourceState() })
  } catch (error) {
    log('native-error', { id, error: typeof error.code === 'string' ? error.code : 'START_DRAG_FAILED' })
  } finally { active = null }
})
ipcMain.on('probe:telemetry', (event, input) => {
  if (!owns(event) || !input || typeof input !== 'object') return
  const events = ['pointerdown', 'dragstart', 'dragenter', 'dragover', 'drop', 'dragend']
  if (!events.includes(input.event)) return
  // Log only finite observations. External filenames/paths/content are omitted.
  const types = Array.isArray(input.types) ? input.types.filter(item => typeof item === 'string').slice(0, 12)
    .map(item => item.slice(0, 100)) : []
  const sourceIds = Array.isArray(input.paths) ? input.paths.slice(0, 8).map(value =>
    [...files].find(([, file]) => file.path === value)?.[0] ?? 'external') : []
  log('renderer-event', { event: input.event, active,
    mode: ['native', 'html'].includes(input.mode) ? input.mode : 'target',
    id: files.has(input.id) ? input.id : null,
    rendererTime: Number.isFinite(input.rendererTime) ? input.rendererTime : null,
    clientX: Number.isFinite(input.clientX) ? input.clientX : null,
    clientY: Number.isFinite(input.clientY) ? input.clientY : null,
    targetId: ['target', 'result', 'checkpoint', 'quit'].includes(input.targetId) ? input.targetId : null,
    prevented: input.prevented === true,
    sourceIds, types, ctrl: input.ctrl === true, shift: input.shift === true, alt: input.alt === true,
    effectAllowed: typeof input.effectAllowed === 'string' ? input.effectAllowed.slice(0, 32) : '',
    dropEffect: typeof input.dropEffect === 'string' ? input.dropEffect.slice(0, 32) : '',
    trusted: input.trusted === true })
})
ipcMain.handle('probe:checkpoint', event => {
  if (!owns(event)) throw new Error('Invalid probe sender')
  const state = sourceState()
  log('checkpoint', { state })
  return state
})
ipcMain.on('probe:quit', event => { if (owns(event)) app.quit() })

app.whenReady().then(async () => {
  window = new BrowserWindow({ width: 880, height: 640, title: 'Arkdown — isolated drag probe',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false } })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true }))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  log('ready', { root, versions: process.versions, source: sourceState() })
  await window.loadFile(path.join(__dirname, 'index.html'))
})
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => log('quit', { source: sourceState() }))
// Preserve every synthetic artifact and log for inspection. No cleanup/delete API.
