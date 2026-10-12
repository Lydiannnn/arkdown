import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const directory = path.dirname(fileURLToPath(import.meta.url))
const bindingPath = process.env.STICKY_NOTE_SURFACE_TEST_BINDING ?? path.resolve(directory, '../dist/x64/surface.node')

test('workspace drag rejects non-absolute paths before entering the OS drag loop', () => {
  const binding = require(bindingPath)
  for (const file of ['', 'relative.md', 'C:relative.md', 'C:\\note.md\0other']) {
    assert.throws(() => binding.startWorkspaceFileDrag(0n, file), /absolute saved file path/)
  }
  assert.throws(() => binding.startWorkspaceFileDrag(0n, 'C:\\note.md'), /live window owned/)
  for (const args of [[], [0n], [0n, 'C:\\note.md', 7]]) {
    assert.throws(() => binding.startWorkspaceFileDrag(...args), /Expected HWND and absolute saved file path/)
  }
})

test('attach validates the closed source selector before window ownership', () => {
  const binding = require(bindingPath)
  for (const source of ['wallpaper', 'host']) {
    assert.throws(() => binding.attach(0n, source), /live window owned/)
  }
  for (const source of [undefined, null, false, 0, {}, [], 'HOST', 'host\0', 'other']) {
    assert.throws(() => binding.attach(0n, source), { name: 'TypeError' })
  }
  assert.throws(() => binding.attach(0n, 'host', true), { name: 'TypeError' })
})

test('Acrylic border validates the exact owned default-restoration contract', () => {
  const binding = require(bindingPath)
  assert.equal(typeof binding.setAcrylicBorderHidden, 'function')
  for (const args of [[], [0n], [0n, true, false]]) assert.throws(() => binding.setAcrylicBorderHidden(...args), { name: 'TypeError' })
  for (const hwnd of [undefined, null, 1, '1', {}, -1n, 1n << 80n]) {
    for (const hidden of [true, false]) assert.throws(() => binding.setAcrylicBorderHidden(hwnd, hidden), { name: 'TypeError' })
  }
  for (const hidden of [undefined, null, 0, 1, 'true', {}, [], 1n, new Boolean(true)])
    assert.throws(() => binding.setAcrylicBorderHidden(0n, hidden), { name: 'TypeError' })
  assert.throws(() => binding.setAcrylicBorderHidden(0n, true), { name: 'TypeError' })
  assert.throws(() => binding.setAcrylicBorderHidden(1n, true), { name: 'TypeError' })
  assert.equal(binding.setAcrylicBorderHidden(0n, false), true)
  binding.clear()
  assert.equal(binding.setAcrylicBorderHidden((1n << 64n) - 1n, false), true)
})

// These call the real N-API boundary. A handle-validation regression would
// permit malformed or foreign window requests to reach native composition.
test('native surface validates HWND input and makes absent cleanup idempotent', () => {
  let binding
  try { binding = require(bindingPath) } catch {}
  assert.ok(binding, 'A compiled surface.node implementing the native surface contract must be available')
  for (const name of ['attach', 'resize', 'detach', 'clear', 'state']) assert.equal(typeof binding[name], 'function', name)
  for (const value of [undefined, null, 1, '1', {}, -1n, 1n << 80n]) {
    assert.throws(() => binding.attach(value), { name: 'TypeError' })
    assert.throws(() => binding.resize(value), { name: 'TypeError' })
    assert.throws(() => binding.detach(value), { name: 'TypeError' })
  }
  assert.throws(() => binding.attach(0n), { name: 'TypeError' })
  assert.equal(binding.resize(0n), false)
  assert.equal(binding.detach(0n), false)
  assert.deepEqual(binding.state(0n), { attached: false, targetCount: 0, glassDecoration: false, decorationCount: 0, childResizeHookCount: 0, windowChildResizeHookCount: 0, glassParentSubclassInstalled: false, glassResizable: false, glassFrameRefreshPending: false, glassFrameStyleBits: 0, resizeCaptureActive: false, resizeWindowEnabled: false, resizeWindowIconic: false, resizeWindowZoomed: false, resizeEligibleChildCount: 0, resizeHookedChildCount: 0, resizeLinkedChildCount: 0, resizeUsableChildCount: 0, hostBackdropOwned: false, hostPolicyCount: 0, hostRestorePending: false, acrylicBorderHidden: false, acrylicBorderPending: false, acrylicBorderCount: 0 })
  binding.clear()
  binding.clear()
  assert.equal(binding.detach(0n), false)
})

test('configure rejects incomplete or unsafe appearance values before looking up the window', () => {
  const binding = require(bindingPath)
  assert.equal(typeof binding.configure, 'function')
  const raw = { tintColor: '#F3F3F3', tintOpacity: 0, luminosityOpacity: 0, saturation: 1 }
  for (const hwnd of [undefined, null, 1, '1', {}, -1n, 1n << 80n]) {
    assert.throws(() => binding.configure(hwnd, raw), { name: 'TypeError' })
  }
  for (const args of [[], [0n], [0n, raw, true]]) {
    assert.throws(() => binding.configure(...args), { name: 'TypeError' })
  }
  for (const value of [undefined, null, false, [], 'raw', 1, Object.create(raw),
    { ...raw, other: true }, { ...raw, [Symbol('extra')]: true }]) {
    assert.throws(() => binding.configure(0n, value), { name: 'TypeError' })
  }
  for (const field of Object.keys(raw)) {
    const missing = { ...raw }
    delete missing[field]
    assert.throws(() => binding.configure(0n, missing), { name: 'TypeError' })
  }
  for (const tintColor of ['#fff', '#11223344', '112233', '#GGGGGG', '#112233\0', null, 0, {}]) {
    assert.throws(() => binding.configure(0n, { ...raw, tintColor }), { name: 'TypeError' })
  }
  for (const field of ['tintOpacity', 'luminosityOpacity', 'saturation']) {
    for (const value of [-0.001, 1.001, NaN, Infinity, -Infinity, '0.5', null, true, {}, 1n]) {
      assert.throws(() => binding.configure(0n, { ...raw, [field]: value }), { name: 'TypeError' })
    }
  }
  assert.equal(binding.configure(0n, raw), false)
  assert.equal(binding.configure(0n, { tintColor: '#abcdef', tintOpacity: 0.5, luminosityOpacity: 1, saturation: 0 }), false)
  assert.equal(binding.configure(0n, Object.freeze({ ...raw })), false)
  assert.equal(binding.configure(0n, Object.assign(Object.create(null), raw)), false)
  const failure = new Error('appearance getter failed')
  assert.throws(() => binding.configure(0n, { ...raw, get tintColor() { throw failure } }), (error) => error === failure)
  assert.deepEqual(binding.state(0n), { attached: false, targetCount: 0, glassDecoration: false, decorationCount: 0, childResizeHookCount: 0, windowChildResizeHookCount: 0, glassParentSubclassInstalled: false, glassResizable: false, glassFrameRefreshPending: false, glassFrameStyleBits: 0, resizeCaptureActive: false, resizeWindowEnabled: false, resizeWindowIconic: false, resizeWindowZoomed: false, resizeEligibleChildCount: 0, resizeHookedChildCount: 0, resizeLinkedChildCount: 0, resizeUsableChildCount: 0, hostBackdropOwned: false, hostPolicyCount: 0, hostRestorePending: false, acrylicBorderHidden: false, acrylicBorderPending: false, acrylicBorderCount: 0 })
})

test('glass decoration validates both arguments before window ownership and makes absent restore idempotent', () => {
  const binding = require(bindingPath)
  assert.equal(typeof binding.setGlassDecoration, 'function')
  for (const args of [[], [0n], [0n, true, false, true, true]]) {
    assert.throws(() => binding.setGlassDecoration(...args), { name: 'TypeError' })
  }
  for (const hwnd of [undefined, null, 1, '1', {}, -1n, 1n << 80n]) {
    for (const enabled of [true, false]) assert.throws(() => binding.setGlassDecoration(hwnd, enabled), { name: 'TypeError' })
  }
  for (const enabled of [undefined, null, 0, 1, 'true', {}, [], 1n, new Boolean(true)]) {
    assert.throws(() => binding.setGlassDecoration(0n, enabled), { name: 'TypeError' })
  }
  assert.throws(() => binding.setGlassDecoration(0n, true), { name: 'TypeError' })
  assert.throws(() => binding.setGlassDecoration(1n, true), { name: 'TypeError' })
  assert.equal(binding.setGlassDecoration(0n, false), true)
  assert.equal(binding.setGlassDecoration(0n, false), true)
  assert.equal(binding.setGlassDecoration((1n << 64n) - 1n, false), true)
  binding.clear()
  assert.equal(binding.setGlassDecoration(0n, false), true)
})

test('glass shadow selection keeps the decoration scope and validates the optional boolean', () => {
  const binding = require(bindingPath)
  for (const shadow of [true, false]) {
    assert.throws(() => binding.setGlassDecoration(0n, true, shadow), /live window owned/)
  }
  for (const shadow of [undefined, null, 0, 1, 'false', {}, []]) {
    assert.throws(() => binding.setGlassDecoration(0n, true, shadow), { name: 'TypeError' })
  }
  assert.throws(() => binding.setGlassDecoration(0n, false, true), { name: 'TypeError' })
  assert.equal(binding.setGlassDecoration(0n, false, false), true)
})

test('glass resizability is an explicit boolean independent of the native frame snapshot', () => {
  const binding = require(bindingPath)
  for (const resizable of [true, false]) {
    assert.throws(() => binding.setGlassDecoration(0n, true, false, resizable), /live window owned/)
    assert.equal(binding.setGlassDecoration(0n, false, false, resizable), true)
  }
  for (const resizable of [undefined, null, 0, 1, 'true', {}, []]) {
    assert.throws(() => binding.setGlassDecoration(0n, true, false, resizable), { name: 'TypeError' })
  }
})
