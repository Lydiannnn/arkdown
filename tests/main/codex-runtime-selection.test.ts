// @vitest-environment node
import { expect, it, vi } from 'vitest'
const execute = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execute }))
import { createCodexRuntimeSelection, probeCodexExecutable } from '../../src/main/codex/codex-runtime-selection'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness() {
  const resolveManaged = vi.fn(async (): Promise<string | undefined> => undefined)
  const installManaged = vi.fn(async (_signal: AbortSignal): Promise<string | undefined> => 'C:\\managed\\codex.exe')
  const discoverCommands = vi.fn(async () => ['C:\\external\\codex.exe'])
  const probeExternal = vi.fn(async () => true)
  return { resolveManaged, installManaged, discoverCommands, probeExternal,
    selection: createCodexRuntimeSelection({ resolveManaged, installManaged, discoverCommands, probeExternal }) }
}
it('resolves passively, then prefers a verified Full runtime without discovery or downloads', async () => {
  const h = harness()
  expect(await h.selection.resolve()).toBeUndefined()
  expect(h.resolveManaged).not.toHaveBeenCalled()
  h.resolveManaged.mockResolvedValue('C:\\full\\codex.exe')
  expect(await h.selection.ensure()).toBe('C:\\full\\codex.exe')
  expect(await h.selection.resolve()).toBe('C:\\full\\codex.exe')
  expect(await h.selection.resolve()).toBe('C:\\full\\codex.exe')
  expect(h.resolveManaged).toHaveBeenCalledTimes(1)
  expect(h.discoverCommands).not.toHaveBeenCalled()
  expect(h.installManaged).not.toHaveBeenCalled()
})
it('reuses a valid external CLI and keeps one path for health, login and inference', async () => {
  const h = harness()
  expect(await h.selection.ensure()).toBe('C:\\external\\codex.exe')
  h.discoverCommands.mockResolvedValue(['C:\\other\\codex.exe'])
  expect(await Promise.all([h.selection.resolve(), h.selection.resolve(), h.selection.resolve()])).toEqual(Array(3).fill('C:\\external\\codex.exe'))
  expect(h.probeExternal).toHaveBeenCalledTimes(1)
  expect(h.discoverCommands).toHaveBeenCalledTimes(1)
  expect(h.installManaged).not.toHaveBeenCalled()
})
it('installs a managed runtime when external executables cannot run', async () => {
  const h = harness(); h.probeExternal.mockResolvedValue(false)
  expect(await h.selection.ensure()).toBe('C:\\managed\\codex.exe')
  expect(await h.selection.resolve()).toBe('C:\\managed\\codex.exe')
  expect(h.installManaged).toHaveBeenCalledTimes(1)
})
it('revalidates on the next user operation and prefers an available managed tree', async () => {
  const h = harness(); await h.selection.ensure()
  h.resolveManaged.mockResolvedValue('C:\\full\\codex.exe')
  expect(await h.selection.ensure()).toBe('C:\\full\\codex.exe')
  expect(h.resolveManaged).toHaveBeenCalledTimes(2)
  expect(h.probeExternal).toHaveBeenCalledTimes(1)
})
it('cancels a waiting selection without allowing late validation to select or install', async () => {
  const h = harness(), validation = deferred<string | undefined>(), owner = new AbortController()
  h.resolveManaged.mockReturnValue(validation.promise)
  const pending = h.selection.ensure(owner.signal)
  await vi.waitFor(() => expect(h.resolveManaged).toHaveBeenCalledOnce())
  owner.abort()
  expect(await pending).toBeUndefined()
  validation.resolve('C:\\late\\codex.exe')
  await Promise.resolve(); await Promise.resolve()
  expect(await h.selection.resolve()).toBeUndefined()
  expect(h.installManaged).not.toHaveBeenCalled()
})
it('joins concurrent operations and preserves an active caller when another cancels', async () => {
  const h = harness(), validation = deferred<string | undefined>(), owner = new AbortController()
  h.resolveManaged.mockReturnValue(validation.promise)
  const first = h.selection.ensure(owner.signal), second = h.selection.ensure()
  owner.abort(); expect(await first).toBeUndefined()
  validation.resolve('C:\\full\\codex.exe')
  expect(await second).toBe('C:\\full\\codex.exe')
  expect(h.resolveManaged).toHaveBeenCalledOnce()
  expect(await h.selection.resolve()).toBe('C:\\full\\codex.exe')
})
it('ignores a late cancelled installation even when a new operation already selected another runtime', async () => {
  const h = harness(), install = deferred<string | undefined>(), owner = new AbortController()
  h.probeExternal.mockResolvedValue(false); h.installManaged.mockReturnValue(install.promise)
  const first = h.selection.ensure(owner.signal)
  await vi.waitFor(() => expect(h.installManaged).toHaveBeenCalledOnce())
  owner.abort(); expect(await first).toBeUndefined()
  h.resolveManaged.mockResolvedValue('C:\\new\\codex.exe')
  expect(await h.selection.ensure()).toBe('C:\\new\\codex.exe')
  install.resolve('C:\\late\\codex.exe'); await Promise.resolve(); await Promise.resolve()
  expect(await h.selection.resolve()).toBe('C:\\new\\codex.exe')
})
it('bounds the external version probe and never invokes a shell', async () => {
  execute.mockImplementation((_command, _args, _options, callback) => { callback(null, 'codex-cli 0.144.1\r\n', '') })
  const controller = new AbortController()
  expect(await probeCodexExecutable('C:\\external path\\codex.exe', controller.signal)).toBe(true)
  expect(execute).toHaveBeenCalledWith('C:\\external path\\codex.exe', ['--version'], expect.objectContaining({ shell: false, windowsHide: true, timeout: 2000, maxBuffer: 4096, signal: controller.signal }), expect.any(Function))
  execute.mockImplementation((_command, _args, _options, callback) => { callback(new Error('private diagnostic'), '', '') })
  expect(await probeCodexExecutable('C:\\external\\codex.exe', controller.signal)).toBe(false)
})
it('rejects unrelated version output, wrappers and already-aborted probes', async () => {
  execute.mockImplementation((_command, _args, _options, callback) => { callback(null, 'some other application 1.2.3', '') })
  const controller = new AbortController()
  expect(await probeCodexExecutable('C:\\external\\codex.exe', controller.signal)).toBe(false)
  execute.mockClear()
  expect(await probeCodexExecutable('C:\\external\\codex.cmd', controller.signal)).toBe(false)
  controller.abort()
  expect(await probeCodexExecutable('C:\\external\\codex.exe', controller.signal)).toBe(false)
  expect(execute).not.toHaveBeenCalled()
})
it('cancels active verification on disposal and remains passive after shutdown', async () => {
  const h = harness(), validation = deferred<string | undefined>()
  h.resolveManaged.mockReturnValue(validation.promise)
  const pending = h.selection.ensure()
  await vi.waitFor(() => expect(h.resolveManaged).toHaveBeenCalledOnce())
  const cleanup = h.selection.dispose()
  validation.resolve('C:\\late\\codex.exe')
  await cleanup
  expect(await pending).toBeUndefined()
  expect(await h.selection.resolve()).toBeUndefined()
  expect(await h.selection.ensure()).toBeUndefined()
  expect(h.discoverCommands).not.toHaveBeenCalled()
  expect(h.installManaged).not.toHaveBeenCalled()
})
