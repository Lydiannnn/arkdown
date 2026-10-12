// @vitest-environment node
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { queryUpdateLaunchGate, updateLaunchPipe } from '../../src/main/updates/update-launch-gate'
it('uses one installation identity across both apps, unrelated to profile', () => {
  expect(updateLaunchPipe('C:\\App\\Arkdown')).toBe(updateLaunchPipe('c:\\app\\arkdown\\'))
  expect(updateLaunchPipe('C:\\App\\Arkdown')).not.toBe(updateLaunchPipe('C:\\App\\Other'))
})
it('admits an absent lease but fails closed on occupied, malformed or stalled helpers', async () => {
  const pipe = '\\\\.\\pipe\\arkdown-update-test-' + randomUUID()
  expect(await queryUpdateLaunchGate('C:\\app', [], 'arkdown', pipe)).toBe('absent')
  let reply = '{"allowed":false}\n'
  const sockets = new Set<net.Socket>()
  const server = net.createServer(socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.on('data', () => { if (reply) socket.end(reply) }) })
  await new Promise<void>(resolve => server.listen(pipe, resolve))
  try {
    expect(await queryUpdateLaunchGate('C:\\app', [], 'arknote', pipe, 100)).toBe('blocked')
    reply = '{"allowed":true}\n'
    expect(await queryUpdateLaunchGate('C:\\app', ['--arkdown-update-session=C:\\session', '--arkdown-update-token=' + 'a'.repeat(64)], 'arkdown', pipe, 100)).toBe('allowed')
    reply = 'broken\n'; await expect(queryUpdateLaunchGate('C:\\app', [], 'arkdown', pipe, 100)).rejects.toThrow()
    reply = ''; await expect(queryUpdateLaunchGate('C:\\app', [], 'arkdown', pipe, 100)).rejects.toThrow()
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
