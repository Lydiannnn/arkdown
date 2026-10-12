// @vitest-environment node
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ArknotePipeServer } from '../../src/main/arknote/arknote-pipe-server'
import { ArknoteClientRuntime } from '../../src/main/arknote/arknote-client-runtime'
import { ArknoteServiceRuntime } from '../../src/main/arknote/arknote-service-runtime'
import { arknotePipeName } from '../../src/shared/arknote-protocol'
import { stopNotesForUpdate } from '../../src/main/updates/update-notes'

it('keeps the real note pipe alive through prepare acknowledgement, then confirms normal service exit', async () => {
  const root = path.join(os.tmpdir(), 'arkdown-update-pipe-' + randomUUID()), token = 'a'.repeat(64)
  const commands: string[] = []; let quit = false, saved = 0, waited = false
  let service: ArknoteServiceRuntime
  const pipe = new ArknotePipeServer({ pipeName: arknotePipeName(root), token, handleRequest: async command => {
    commands.push(command)
    if (command === 'service.prepare-update') { await service.prepareUpdateQuit(); return { prepared: true } }
    if (command === 'service.cancel-update') { await service.cancelUpdateQuit(); return null }
    if (command === 'service.quit') { await service.flushAndQuit(); return null }
    throw new Error('Unexpected request')
  } })
  service = new ArknoteServiceRuntime({ launchArguments: [], store: { initialize: async () => {} },
    session: { restore: async () => 0, captureAndFlush: async () => { saved++ } }, pipe,
    tray: { initialize() {}, destroy() {} }, windows: { closeAll: async () => { await new Promise(resolve => setTimeout(resolve, 20)) } },
    mutations: { pauseAndDrain: async () => {}, resume() {} }, openBox: async () => {}, createNote: async () => {},
    openSettings: async () => {}, quitApp() { quit = true } })
  const client = new ArknoteClientRuntime({ executablePath: path.join(root, 'Arkdown.exe'), readToken: async () => token,
    launch: () => { throw new Error('Test must not start a real process') } })
  await service.initialize()
  try {
    await expect(stopNotesForUpdate(client, { notesRunning: async () => true, waitNotesStopped: async () => {
      await new Promise(resolve => setTimeout(resolve, 30)); expect(quit).toBe(true); waited = true
    } })).resolves.toBe(true)
    expect(commands).toEqual(['service.prepare-update', 'service.quit'])
    expect(saved).toBe(1); expect(waited).toBe(true)
  } finally { client.dispose(); await pipe.stop() }
})
