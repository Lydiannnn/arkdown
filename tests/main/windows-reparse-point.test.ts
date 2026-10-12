import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  queryWindowsReparsePoint,
  type WindowsReparsePointCommandRunner,
} from '../../src/main/workspace/windows-reparse-point'

const roots: string[] = []

afterEach(async () => Promise.all(
  roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
))

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

it.runIf(process.platform === 'win32')(
  'queries the absolute System32 fsutil executable with bounded exact arguments',
  async () => {
    const target = 'C:\\workspace\\source.pdf'
    const run = vi.fn<WindowsReparsePointCommandRunner>(async () => ({
      error: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }))

    await expect(queryWindowsReparsePoint(target, run)).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith(
      path.win32.join(process.env.SystemRoot!, 'System32', 'fsutil.exe'),
      ['reparsepoint', 'query', target],
      {
        encoding: 'buffer',
        maxBuffer: 4 * 1024,
        shell: false,
        timeout: 2_000,
        windowsHide: true,
      },
    )
  },
)

it.runIf(process.platform === 'win32')(
  'recognizes only the stable Windows not-a-reparse-point error and fails closed otherwise',
  async () => {
    const ordinary: WindowsReparsePointCommandRunner = async () => ({
      error: Object.assign(new Error('fsutil exited 1'), { code: 1, killed: false }),
      stdout: Buffer.from('Error 4390: The file or directory is not a reparse point.\r\n', 'ascii'),
      stderr: Buffer.alloc(0),
    })
    const unavailable: WindowsReparsePointCommandRunner = async () => ({
      error: Object.assign(new Error('fsutil exited 1'), { code: 1, killed: false }),
      stdout: Buffer.from('Error 5: Access is denied.\r\n', 'ascii'),
      stderr: Buffer.alloc(0),
    })
    const timedOutAfterOutput: WindowsReparsePointCommandRunner = async () => ({
      error: Object.assign(new Error('fsutil timed out'), { code: null, killed: true }),
      stdout: Buffer.from('Error 4390: The file or directory is not a reparse point.\r\n', 'ascii'),
      stderr: Buffer.alloc(0),
    })

    await expect(queryWindowsReparsePoint('C:\\workspace\\source.pdf', ordinary))
      .resolves.toBe(false)
    await expect(queryWindowsReparsePoint('C:\\workspace\\source.pdf', unavailable))
      .rejects.toThrow('Windows reparse-point inspection failed')
    await expect(queryWindowsReparsePoint('C:\\workspace\\source.pdf', timedOutAfterOutput))
      .rejects.toThrow('Windows reparse-point inspection failed')
  },
)

it.runIf(process.platform === 'win32')(
  'uses the real Windows capability to distinguish an ordinary file from a junction route',
  async () => {
    const root = await createRoot('arkdown-reparse-point-')
    const ordinary = path.join(root, 'source.pdf')
    const target = path.join(root, 'target')
    const junction = path.join(root, 'route')
    await writeFile(ordinary, 'fixture', 'utf8')
    await mkdir(target)
    await symlink(target, junction, 'junction')

    await expect(queryWindowsReparsePoint(ordinary)).resolves.toBe(false)
    await expect(queryWindowsReparsePoint(junction)).resolves.toBe(true)
  },
)
