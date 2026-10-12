// @vitest-environment node
import { fork } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'rolldown'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { WindowBounds } from '../../src/main/settings/settings-store'

interface Snapshot {
  pid: number
  connectionIds: string[]
  hasSyntheticCredential: boolean
  windowBounds?: WindowBounds
}

let sandbox: string
let workerPath: string
beforeAll(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), 'arkdown-settings-concurrency-'))
  workerPath = path.join(sandbox, 'settings-worker.cjs')
  await build({
    input: path.resolve('tests/fixtures/settings-concurrency-worker.ts'), platform: 'node',
    output: { file: workerPath, format: 'cjs' },
  })
})
afterAll(async () => { await rm(sandbox, { recursive: true, force: true }) })

function worker(root: string) {
  const child = fork(workerPath, [root], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let id = 0
  let stderr = ''
  child.stderr!.on('data', (data) => { stderr += String(data) })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return {
    child,
    async request(command: string): Promise<Snapshot> {
      const requestId = ++id
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Worker timed out: ${command}; ${stderr}`)), 5000)
        const onExit = () => finish(new Error(`Worker exited: ${stderr}`))
        const onMessage = (message: { id: number; value?: Snapshot; error?: string }) => {
          if (message.id !== requestId) return
          finish(message.error ? new Error(message.error) : undefined, message.value)
        }
        const finish = (error?: Error, value?: Snapshot) => {
          clearTimeout(timer)
          child.off('exit', onExit)
          child.off('message', onMessage)
          if (error) reject(error)
          else resolve(value!)
        }
        child.once('exit', onExit)
        child.on('message', onMessage)
        child.send({ id: requestId, command })
      })
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (child.connected) child.send({ id: ++id, command: 'exit' })
      const timer = setTimeout(() => child.kill(), 5000)
      await exited
      clearTimeout(timer)
    },
  }
}

async function assertModelSurvivesClose() {
  const root = path.join(sandbox, 'preserve-model')
  const a = worker(root)
  const b = worker(root)
  try {
    const initialA = await a.request('load')
    const initialB = await b.request('load')
    expect(initialA.pid).not.toBe(initialB.pid)
    expect(initialA.connectionIds).toEqual([])
    await b.request('add-model')
    const beforeClose = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'))
    expect(beforeClose.models.connections.map((item: { id: string }) => item.id)).toEqual([
      '550e8400-e29b-41d4-a716-446655440001',
    ])
    const closedA = await a.request('close')
    const cachedB = await b.request('cache')
    const disk = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'))
    // Metadata and paired synthetic credentials both survive the unrelated close write.
    expect(closedA.hasSyntheticCredential).toBe(true)
    expect(cachedB.hasSyntheticCredential).toBe(true)
    expect(cachedB.connectionIds).toEqual(['550e8400-e29b-41d4-a716-446655440001'])
    expect(disk.windowBounds).toEqual({ width: 1200, height: 800, x: 80, y: 60 })
    expect({ diskIds: disk.models?.connections.map((item: { id: string }) => item.id) ?? [],
      cacheAIds: closedA.connectionIds }).toEqual({
      diskIds: ['550e8400-e29b-41d4-a716-446655440001'],
      cacheAIds: ['550e8400-e29b-41d4-a716-446655440001'],
    })
  } finally {
    await a.stop()
    await b.stop()
  }
}

// The acceptance now requires the production authority/finite writers in both children.
it.skipIf(process.platform !== 'win32')('LEGACY-020 retains B model metadata after previously loaded A saves bounds on close', async () => {
  await assertModelSurvivesClose()
})

it.skipIf(process.platform !== 'win32')('does not resurrect a removed model when a stale process closes', async () => {
  const root = path.join(sandbox, 'preserve-removal')
  const a = worker(root), b = worker(root)
  try {
    await a.request('load'); await b.request('load')
    await b.request('add-model')
    expect((await a.request('refresh')).connectionIds).toHaveLength(1)
    await b.request('remove-model')
    const closedA = await a.request('close')
    expect(closedA.connectionIds).toEqual([])
    expect(closedA.hasSyntheticCredential).toBe(false)
    const disk = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'))
    expect(disk.models.connections).toEqual([])
    expect(disk.windowBounds).toEqual({ width: 1200, height: 800, x: 80, y: 60 })
  } finally { await a.stop(); await b.stop() }
})
