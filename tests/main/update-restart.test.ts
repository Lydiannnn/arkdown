// @vitest-environment node
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { inspectUpdateStartup, acknowledgeUpdateRestart } from '../../src/main/updates/update-restart'
it('refuses editing after a helper dies during installer replacement', async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), 'arkdown-installer-guard-'))
  try {
    await writeFile(path.join(target, '.arkdown-installer-update.ini'), '[ArkdownUpdate]\nSchema=1\n')
    await expect(inspectUpdateStartup({ executablePath: path.join(target, 'Arknote.exe'), version: '1.0.4', argv: [] })).rejects.toThrow('安装')
  } finally { await rm(target, { recursive: true, force: true }) }
})
it('blocks an interrupted portable update but admits only a matching verified restart session', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'arkdown-restart-')), target = path.join(temp, 'app')
  const name = '.ArkdownUpdate-' + 'a'.repeat(32), session = path.join(temp, name), token = 'b'.repeat(64)
  try {
    await mkdir(target); await mkdir(session)
    const input = { executablePath: path.join(target, 'Arkdown.exe'), version: '1.0.5', argv: [] as string[] }
    expect(await inspectUpdateStartup(input)).toEqual({})
    await writeFile(path.join(target, '.arkdown-update-pending.json'), JSON.stringify({ schemaVersion: 1, session: name }))
    expect(await inspectUpdateStartup(input)).toEqual({ recoverySession: session })
    await writeFile(path.join(session, 'request.json'), JSON.stringify({ protocolVersion: 1, target, session, token, version: '1.0.5', kind: 'portable' }))
    await writeFile(path.join(session, 'journal.json'), JSON.stringify({ schemaVersion: 1, target, state: 'applied', newVersion: '1.0.5' }))
    const argv = ['--arkdown-update-session=' + session, '--arkdown-update-token=' + token]
    const admitted = await inspectUpdateStartup({ ...input, argv })
    expect(admitted.restart?.version).toBe('1.0.5')
    await acknowledgeUpdateRestart(admitted.restart!, 'arkdown', 123)
    expect(JSON.parse(await readFile(path.join(session, 'arkdown-ready.json'), 'utf8'))).toMatchObject({ token, version: '1.0.5', pid: 123 })
    await expect(inspectUpdateStartup({ ...input, argv: [argv[0], '--arkdown-update-token=' + 'c'.repeat(64)] })).rejects.toThrow()
    await expect(inspectUpdateStartup({ ...input, version: '1.0.4', argv })).rejects.toThrow()
  } finally { await rm(temp, { recursive: true, force: true }) }
})
