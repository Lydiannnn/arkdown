import { EventEmitter } from 'node:events'
import { execFileSync, spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { openSiblingArkdown } from '../../src/main/arknote-main'

function fixture(failure?: 'missing' | 'error' | 'throw') {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  const spawn = vi.fn(() => {
    if (failure === 'throw') throw new Error('spawn denied')
    queueMicrotask(() => failure === 'error' ? child.emit('error', new Error('spawn denied')) : child.emit('spawn'))
    return child as never
  })
  const showError = vi.fn()
  const stat = vi.fn(async () => {
    if (failure === 'missing') throw new Error('ENOENT')
    return { isFile: () => true }
  })
  return { child, spawn, showError, stat }
}

it('launches the sibling Arkdown GUI with an argument array and no shell', async () => {
  const deps = fixture()
  const directory = 'C:\\Apps\\Arkdown 安装'
  await openSiblingArkdown(directory, deps)
  expect(deps.stat).toHaveBeenCalledWith(path.join(directory, 'Arkdown.exe'))
  expect(deps.spawn).toHaveBeenCalledExactlyOnceWith(path.join(directory, 'Arkdown.exe'), [], {
    cwd: directory, shell: false, windowsHide: false, detached: true, stdio: 'ignore',
  })
  expect(deps.child.unref).toHaveBeenCalledOnce()
  expect(deps.showError).not.toHaveBeenCalled()
})

it.each(['missing', 'error', 'throw'] as const)('makes %s launch failures visible', async (failure) => {
  const deps = fixture(failure)
  await openSiblingArkdown('C:\\Apps\\Arknote', deps)
  expect(deps.showError).toHaveBeenCalledOnce()
  expect(deps.showError.mock.calls[0]![0]).toContain('Arkdown')
  expect(deps.child.unref).not.toHaveBeenCalled()
  if (failure === 'missing') expect(deps.spawn).not.toHaveBeenCalled()
})

const csharpCompiler = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')

it('awaits the styled launch-failure acknowledgment before finishing', async () => {
  const deps = fixture('missing')
  let acknowledge!: () => void
  deps.showError.mockImplementation(() => new Promise<void>(resolve => { acknowledge = resolve }))
  let finished = false
  const result = openSiblingArkdown('C:\\Apps\\Arknote', deps).then(() => { finished = true })
  await vi.waitFor(() => expect(deps.showError).toHaveBeenCalledOnce())
  expect(finished).toBe(false)
  acknowledge()
  await result
  expect(finished).toBe(true)
  expect(deps.spawn).not.toHaveBeenCalled()
})

it('propagates styled launch-failure presentation errors without retrying the launch', async () => {
  const deps = fixture('missing')
  deps.showError.mockRejectedValue(new Error('dialog unavailable'))
  await expect(openSiblingArkdown('C:\\Apps\\Arknote', deps)).rejects.toThrow('dialog unavailable')
  expect(deps.spawn).not.toHaveBeenCalled()
  expect(deps.child.unref).not.toHaveBeenCalled()
})

it.skipIf(process.platform !== 'win32' || !existsSync(csharpCompiler))('allows the launched Windows GUI to show its first window', async () => {
  // A real GUI-subsystem process catches STARTUPINFO/SW_HIDE behavior that a
  // mocked spawn event cannot detect. The probe window stays outside the desktop.
  const directory = await mkdtemp(path.join(os.tmpdir(), 'arkdown-gui-launch-'))
  let exited: Promise<void> | undefined
  try {
    const source = path.join(directory, 'LaunchProbe.cs')
    await writeFile(source, `
using System;
using System.IO;
using System.Runtime.InteropServices;
class LaunchProbe {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CreateWindowEx(uint exStyle, string className, string name, uint style,
    int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
  static int Main() {
    IntPtr window = CreateWindowEx(0, "STATIC", "Arkdown launch probe", 0x00CF0000,
      -32000, -32000, 1, 1, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (window == IntPtr.Zero) return 1;
    try {
      ShowWindow(window, 1);
      File.WriteAllText("visible.txt", IsWindowVisible(window) ? "visible" : "hidden");
      return 0;
    } finally { DestroyWindow(window); }
  }
}`, 'utf8')
    execFileSync(csharpCompiler, ['/nologo', '/target:winexe', `/out:${path.join(directory, 'Arkdown.exe')}`, source], {
      windowsHide: true, stdio: 'pipe',
    })
    const showError = vi.fn()
    await openSiblingArkdown(directory, {
      stat, showError,
      spawn: (executable, args, options) => {
        const child = spawnProcess(executable, args, options)
        exited = new Promise<void>((resolve, reject) => {
          child.once('error', reject)
          child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Probe exited with ${code}`)))
        })
        return child
      },
    })
    await exited
    expect(showError).not.toHaveBeenCalled()
    expect(await readFile(path.join(directory, 'visible.txt'), 'utf8')).toBe('visible')
  } finally {
    await exited?.catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)
