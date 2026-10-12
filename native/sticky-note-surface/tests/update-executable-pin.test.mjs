import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, linkSync, symlinkSync, copyFileSync, openSync, closeSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
const binding = createRequire(import.meta.url)(path.resolve('native/sticky-note-surface/dist/x64/surface.node'))

test('failure diagnostics retain the pin API error and distinguish validation refusals', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ark-update-pin-diagnostic-'))
  const file = path.join(root, 'Arkdown.Update.exe')
  writeFileSync(file, 'original image')
  try {
    const writer = openSync(file, 'r+')
    try {
      assert.throws(() => binding.pinUpdateExecutable(file), error => {
        assert.equal(error.code, 'ERR_NATIVE_SURFACE')
        assert.equal(error.message, 'Cannot pin update executable path')
        assert.deepEqual(error.updateDiagnostic, {
          operation: 'CreateFileW', path: file, directory: false,
          nativeErrorCode: 32, nativeCodeSource: 'GetLastError', validationReason: null,
          access: 0x80000000, share: 1, creation: 3, flags: 0x00200000,
        })
        return true
      })
    } finally { closeSync(writer) }
    assert.equal(readFileSync(file, 'utf8'), 'original image')
    const lease = binding.pinUpdateExecutable(file); lease.close()
    const link = path.join(root, 'linked.exe'); linkSync(file, link)
    assert.throws(() => binding.pinUpdateExecutable(link), error => {
      assert.equal(error.updateDiagnostic.operation, 'GetFileInformationByHandle')
      assert.equal(error.updateDiagnostic.nativeErrorCode, null)
      assert.equal(error.updateDiagnostic.validationReason, 'hard-link')
      return true
    })
    rmSync(link)
    const real = path.join(root, 'real'); mkdirSync(real)
    const redirected = path.join(root, 'redirected'); symlinkSync(real, redirected, 'junction')
    assert.throws(() => binding.pinUpdateExecutable(path.join(redirected, 'Arkdown.Update.exe')), error => {
      assert.equal(error.updateDiagnostic.path, redirected)
      assert.equal(error.updateDiagnostic.directory, true)
      assert.equal(error.updateDiagnostic.nativeErrorCode, null)
      assert.equal(error.updateDiagnostic.validationReason, 'reparse-point')
      return true
    })
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('ark-update-pin-diagnostic-'))
    rmSync(path.join(root, 'redirected'), { force: true })
    rmSync(root, { recursive: true, force: true })
  }
})

test('permits a real Windows process image to load while the executable lease is held', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ark-update-pin-launch-'))
  const file = path.join(root, 'Arkdown.Update.exe')
  let lease
  try {
    copyFileSync(path.join(process.env.SystemRoot, 'System32/where.exe'), file)
    lease = binding.pinUpdateExecutable(file)
    const result = await promisify(execFile)(file, ['cmd.exe'], { windowsHide: true, timeout: 5000 })
    assert.match(result.stdout, /cmd\.exe/i)
  } finally { lease?.close(); rmSync(root, { recursive: true, force: true }) }
})

test('pins the verified executable bytes and every ancestor against replacement until release', () => {
  assert.equal(typeof binding.pinUpdateExecutable, 'function', 'native launch lease is required')
  const root = mkdtempSync(path.join(os.tmpdir(), 'ark-update-pin-'))
  const parent = path.join(root, 'session'), file = path.join(parent, 'Arkdown.Update.exe')
  mkdirSync(parent); writeFileSync(file, 'synthetic image bytes')
  let lease
  try {
    lease = binding.pinUpdateExecutable(file)
    assert.deepEqual(lease.bytes, Buffer.from('synthetic image bytes'))
    assert.throws(() => writeFileSync(file, 'changed'), /EPERM|EACCES|EBUSY/)
    assert.throws(() => renameSync(file, path.join(parent, 'replaced.exe')), /EPERM|EACCES|EBUSY/)
    assert.throws(() => renameSync(parent, path.join(root, 'replaced')), /EPERM|EACCES|EBUSY/)
    assert.throws(() => lease.close.call({}), /Invalid update executable lease/)
    lease.close(); lease.close()
    writeFileSync(file, 'after release'); assert.equal(readFileSync(file, 'utf8'), 'after release')
  } finally { lease?.close(); rmSync(root, { recursive: true, force: true }) }
})

test('rejects redirected, hard-linked, oversized and invalid executable paths', () => {
  assert.equal(typeof binding.pinUpdateExecutable, 'function', 'native launch lease is required')
  const root = mkdtempSync(path.join(os.tmpdir(), 'ark-update-pin-reject-'))
  try {
    const dir = path.join(root, 'real'); mkdirSync(dir)
    const file = path.join(dir, 'Arkdown.Update.exe'); writeFileSync(file, 'bytes')
    const link = path.join(root, 'Arkdown.Update.exe'); linkSync(file, link)
    assert.throws(() => binding.pinUpdateExecutable(link)); rmSync(link)
    const redirected = path.join(root, 'redirected'); symlinkSync(dir, redirected, 'junction')
    assert.throws(() => binding.pinUpdateExecutable(path.join(redirected, 'Arkdown.Update.exe')))
    writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1)); assert.throws(() => binding.pinUpdateExecutable(file))
    for (const value of ['', 'relative.exe', 'C:relative.exe', file + '\0other', file + ':data', null, 1])
      assert.throws(() => binding.pinUpdateExecutable(value))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
