import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { arknotePipeName } from '../../src/shared/arknote-protocol'
import { ArknotePipeClient } from '../../src/main/arknote/arknote-pipe-client'
import { ArknotePipeServer } from '../../src/main/arknote/arknote-pipe-server'
import { PublicError } from '../../src/shared/public-errors'

const token = 'a'.repeat(64)

function parseEcho(value: unknown): { echoed: string } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  return Reflect.ownKeys(record).length === 1 && typeof record.echoed === 'string'
    ? { echoed: record.echoed }
    : undefined
}

describe('Arknote named pipe', () => {
  it.each(['SHELL_INTEGRATION_CONFLICT', 'WALLPAPER_APPEARANCE_SAVED_NOT_APPLIED'] as const)('retains safe preference error %s across the existing message-only pipe', async (code) => {
    const pipeName = arknotePipeName(`C:\\test\\${randomUUID()}`)
    const server = new ArknotePipeServer({ pipeName, token,
      handleRequest: async () => { throw new PublicError(code) },
    })
    const client = new ArknotePipeClient({ pipeName, token, timeoutMs: 2_000 })
    await server.start()
    try {
      await expect(client.request('settings.set', {}, parseEcho)).rejects.toMatchObject({ code })
    } finally { client.close(); await server.stop() }
  })
  it('authenticates and exchanges strict request/response frames over a real local pipe', async () => {
    const pipeName = arknotePipeName(`C:\\test\\${randomUUID()}`)
    const server = new ArknotePipeServer({
      pipeName,
      token,
      handleRequest: async (command, payload) => ({
        echoed: `${command}:${String((payload as { value?: unknown }).value)}`,
      }),
    })
    const client = new ArknotePipeClient({ pipeName, token, timeoutMs: 2_000 })
    await server.start()

    try {
      await expect(client.request('health.ping', { value: 'ok' }, parseEcho))
        .resolves.toEqual({ echoed: 'health.ping:ok' })
    } finally {
      client.close()
      await server.stop()
    }
  })

  it('rejects the connection before dispatching requests when the token is wrong', async () => {
    const pipeName = arknotePipeName(`C:\\test\\${randomUUID()}`)
    let dispatched = 0
    const server = new ArknotePipeServer({
      pipeName,
      token,
      handleRequest: async () => { dispatched += 1; return null },
    })
    const client = new ArknotePipeClient({
      pipeName,
      token: 'b'.repeat(64),
      timeoutMs: 2_000,
    })
    await server.start()

    try {
      await expect(client.connect()).rejects.toThrow('Arknote authentication failed')
      expect(dispatched).toBe(0)
    } finally {
      client.close()
      await server.stop()
    }
  })

  it('rejects an in-flight handshake when explicitly closed', async () => {
    const pipeName = arknotePipeName(`C:\\test\\${randomUUID()}`)
    let peer: net.Socket | null = null
    const server = net.createServer((socket) => { peer = socket })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(pipeName, resolve)
    })
    const client = new ArknotePipeClient({ pipeName, token, timeoutMs: 2_000 })

    try {
      const connection = client.connect()
      await new Promise<void>((resolve) => server.once('connection', () => resolve()))
      client.close()
      const outcome = await Promise.race([
        connection.then(() => 'resolved', (error: Error) => error.message),
        new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ])
      expect(outcome).toBe('Arknote connection closed')
    } finally {
      client.close()
      if (peer) (peer as net.Socket).destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('delivers service events and can reconnect after an explicit close', async () => {
    const pipeName = arknotePipeName(`C:\\test\\${randomUUID()}`)
    const server = new ArknotePipeServer({
      pipeName,
      token,
      handleRequest: async () => ({ echoed: 'ready' }),
    })
    const client = new ArknotePipeClient({ pipeName, token, timeoutMs: 2_000 })
    const event = new Promise<unknown>((resolve) => client.subscribe(resolve))
    await server.start()

    try {
      await client.connect()
      server.broadcast({ type: 'settings-changed', revision: 1 })
      await expect(event).resolves.toEqual({ type: 'settings-changed', revision: 1 })
      client.close()
      await expect(client.request('health.ping', {}, parseEcho))
        .resolves.toEqual({ echoed: 'ready' })
    } finally {
      client.close()
      await server.stop()
    }
  })
})
