import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export type SettingsWriteLockErrorCode =
  | 'SETTINGS_LOCK_TIMEOUT'
  | 'SETTINGS_LOCK_INVALID_TIMEOUT'
  | 'SETTINGS_LOCK_UNSUPPORTED_PLATFORM'
  | 'SETTINGS_LOCK_IDENTITY_FAILED'
  | 'SETTINGS_LOCK_ACQUIRE_FAILED'
  | 'SETTINGS_LOCK_REENTRANT'

export class SettingsWriteLockError extends Error {
  constructor(readonly code: SettingsWriteLockErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'SettingsWriteLockError'
  }
}

const ownership = new AsyncLocalStorage<Map<string, { active: boolean }>>()

async function pipeName(dataRoot: string): Promise<string> {
  try {
    // The root must already exist. File identity also unifies junction/drive/case aliases,
    // without conflating two case-sensitive directories whose names differ only by case.
    const canonicalRoot = await realpath(path.resolve(dataRoot))
    const identity = await stat(canonicalRoot, { bigint: true })
    if (!identity.isDirectory() || identity.ino === 0n) throw new Error('No stable directory identity')
    const digest = createHash('sha256').update(`${identity.dev}:${identity.ino}`).digest('hex')
    return `\\\\.\\pipe\\arkdown-settings-write-v1-${digest}`
  } catch (cause) {
    throw new SettingsWriteLockError('SETTINGS_LOCK_IDENTITY_FAILED', { cause })
  }
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => resolve()) })
}

function tryAcquire(name: string, signal: AbortSignal): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    // This endpoint carries no messages. Closing unexpected peers prevents them from
    // extending the lease via an accepted connection when the operation completes.
    const server = createServer((socket) => socket.destroy())
    let acquired = false
    const abort = () => {
      void close(server)
      reject(new SettingsWriteLockError('SETTINGS_LOCK_TIMEOUT'))
    }
    signal.addEventListener('abort', abort, { once: true })
    server.on('error', (cause: NodeJS.ErrnoException) => {
      // After listening, accept errors do not revoke the bound pipe's ownership.
      // No traffic is needed for this lease. Handle every such error without closing
      // the server or changing an already-running write's result; only its finally
      // block may release the lease once the operation has actually settled.
      if (acquired) return
      signal.removeEventListener('abort', abort)
      void close(server)
      if (cause.code === 'EADDRINUSE') resolve(undefined)
      else reject(new SettingsWriteLockError('SETTINGS_LOCK_ACQUIRE_FAILED', { cause }))
    })
    server.once('listening', () => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { abort(); return }
      acquired = true
      resolve(server)
    })
    if (signal.aborted) { abort(); return }
    // On Windows libuv uses FILE_FLAG_FIRST_PIPE_INSTANCE. A competing bind fails;
    // the OS releases every handle on process death. Never unlink/steal a timed-out lock.
    try { server.listen({ path: name, exclusive: true }) } catch (cause) {
      signal.removeEventListener('abort', abort)
      void close(server)
      reject(new SettingsWriteLockError('SETTINGS_LOCK_ACQUIRE_FAILED', { cause }))
    }
  })
}

/** Main-process only. timeoutMs bounds acquisition, never the protected operation.
 * All reads, validation and writes belong inside operation; a locked stale snapshot
 * still loses updates. The existing data root must not be replaced during a lease.
 */
export async function withSettingsWriteLock<T>(
  dataRoot: string, operation: () => Promise<T>, timeoutMs: number,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1) {
    throw new SettingsWriteLockError('SETTINGS_LOCK_INVALID_TIMEOUT')
  }
  if (process.platform !== 'win32') throw new SettingsWriteLockError('SETTINGS_LOCK_UNSUPPORTED_PLATFORM')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new SettingsWriteLockError('SETTINGS_LOCK_TIMEOUT'))
    }, timeoutMs)
  })
  let server: Server | undefined
  let name: string
  try {
    name = await Promise.race([pipeName(dataRoot), deadline])
    if (ownership.getStore()?.get(name)?.active) throw new SettingsWriteLockError('SETTINGS_LOCK_REENTRANT')
    while (!server) {
      server = await Promise.race([tryAcquire(name, controller.signal), deadline])
      if (!server) {
        await Promise.race([delay(15, undefined, { signal: controller.signal }), deadline])
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new SettingsWriteLockError('SETTINGS_LOCK_TIMEOUT')
    throw error
  } finally { clearTimeout(timer!) }

  const lease = { active: true }
  const scope = new Map(ownership.getStore())
  scope.set(name, lease)
  try {
    return await ownership.run(scope, operation)
  } finally {
    lease.active = false
    await close(server)
  }
}
