import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  MediumMutationLockBusyError,
  acquireMediumMutationLock,
  mediumMutationWriterPresentSync,
} from '../../src/main/screenshot-translation/medium-mutation-lock'

const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), 'arkdown-medium-mutation-lock-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (value) => await rm(value, { recursive: true, force: true })))
})

const owner = (pid: number, creationIdentity = `created-${pid}`) => ({ pid, creationIdentity })
const identityMatches = async (pid: number, expected: string) => (
  expected === `created-${pid}` ? 'alive-match' as const : 'dead-or-mismatch' as const
)

it('ignores and removes old ownerless or truncated candidates without wedging acquisition', async () => {
  const lockRoot = await root()
  await mkdir(lockRoot, { recursive: true })
  const ownerless = path.join(lockRoot, '123e4567-e89b-42d3-a456-426614174000.choosing.json')
  const truncated = path.join(lockRoot, '223e4567-e89b-42d3-a456-426614174000.waiting.json')
  await writeFile(ownerless, '')
  await writeFile(truncated, '{"schemaVersion":1')
  await utimes(ownerless, new Date(0), new Date(0))
  await utimes(truncated, new Date(0), new Date(0))

  const acquired = await acquireMediumMutationLock({
    root: lockRoot,
    owner: owner(10),
    processIdentityMatches: identityMatches,
    token: '323e4567-e89b-42d3-a456-426614174000',
    invalidRecordGraceMs: 0,
  })

  expect((await readdir(lockRoot)).sort()).toEqual(['323e4567-e89b-42d3-a456-426614174000.waiting.json'])
  await acquired.release()
})

it('serializes two recoverers that encounter one stale candidate', async () => {
  const lockRoot = await root()
  await mkdir(lockRoot, { recursive: true })
  await writeFile(path.join(lockRoot, '123e4567-e89b-42d3-a456-426614174000.waiting.json'), JSON.stringify({
    schemaVersion: 1,
    token: '123e4567-e89b-42d3-a456-426614174000',
    pid: 9,
    creationIdentity: 'old-process',
    phase: 'waiting',
    ticket: 1,
  }))
  const options = {
    root: lockRoot,
    processIdentityMatches: identityMatches,
    pollIntervalMs: 1,
    waitTimeoutMs: 1_000,
  }
  const first = acquireMediumMutationLock({
    ...options, owner: owner(10), token: '223e4567-e89b-42d3-a456-426614174000',
  })
  const second = acquireMediumMutationLock({
    ...options, owner: owner(11), token: '323e4567-e89b-42d3-a456-426614174000',
  })
  const winner = await Promise.race([
    first.then((lease) => ({ name: 'first' as const, lease })),
    second.then((lease) => ({ name: 'second' as const, lease })),
  ])
  let loserSettled = false
  const loser = (winner.name === 'first' ? second : first).then((lease) => {
    loserSettled = true
    return lease
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(loserSettled).toBe(false)
  await winner.lease.release()
  const next = await loser
  await next.release()
})

it('an old owner release is token-scoped and cannot delete a later owner', async () => {
  const lockRoot = await root()
  const oldOwner = await acquireMediumMutationLock({
    root: lockRoot, owner: owner(10), processIdentityMatches: identityMatches,
    token: '123e4567-e89b-42d3-a456-426614174000',
  })
  await oldOwner.release()
  const newOwner = await acquireMediumMutationLock({
    root: lockRoot, owner: owner(11), processIdentityMatches: identityMatches,
    token: '223e4567-e89b-42d3-a456-426614174000',
  })

  await oldOwner.release()
  expect(mediumMutationWriterPresentSync(lockRoot)).toBe(true)
  expect(JSON.parse(await readFile(path.join(lockRoot, '223e4567-e89b-42d3-a456-426614174000.waiting.json'), 'utf8')))
    .toMatchObject({ pid: 11, creationIdentity: 'created-11' })
  await newOwner.release()
})

it('treats a matching PID with a different creation identity as stale', async () => {
  const lockRoot = await root()
  await mkdir(lockRoot, { recursive: true })
  await writeFile(path.join(lockRoot, '123e4567-e89b-42d3-a456-426614174000.waiting.json'), JSON.stringify({
    schemaVersion: 1,
    token: '123e4567-e89b-42d3-a456-426614174000',
    pid: 10,
    creationIdentity: 'created-before-reuse',
    phase: 'waiting',
    ticket: 1,
  }))
  const acquired = await acquireMediumMutationLock({
    root: lockRoot,
    owner: owner(11),
    processIdentityMatches: async () => 'dead-or-mismatch',
    token: '223e4567-e89b-42d3-a456-426614174000',
  })
  await acquired.release()
})

it('bounds live contention without deleting the live owner', async () => {
  const lockRoot = await root()
  const live = await acquireMediumMutationLock({
    root: lockRoot, owner: owner(10), processIdentityMatches: identityMatches,
    token: '123e4567-e89b-42d3-a456-426614174000',
  })
  await expect(acquireMediumMutationLock({
    root: lockRoot,
    owner: owner(11),
    processIdentityMatches: identityMatches,
    token: '223e4567-e89b-42d3-a456-426614174000',
    pollIntervalMs: 1,
    waitTimeoutMs: 5,
  })).rejects.toBeInstanceOf(MediumMutationLockBusyError)
  expect(mediumMutationWriterPresentSync(lockRoot)).toBe(true)
  await live.release()
})

it('conservatively preserves a candidate when process identity is unknown', async () => {
  const lockRoot = await root()
  await mkdir(lockRoot, { recursive: true })
  const candidatePath = path.join(lockRoot, '123e4567-e89b-42d3-a456-426614174000.waiting.json')
  await writeFile(candidatePath, JSON.stringify({
    schemaVersion: 1,
    token: '123e4567-e89b-42d3-a456-426614174000',
    pid: 10,
    creationIdentity: 'created-10',
    phase: 'waiting',
    ticket: 1,
  }))

  await expect(acquireMediumMutationLock({
    root: lockRoot,
    owner: owner(11),
    processIdentityMatches: async () => 'unknown',
    token: '223e4567-e89b-42d3-a456-426614174000',
    pollIntervalMs: 1,
    waitTimeoutMs: 5,
  })).rejects.toBeInstanceOf(MediumMutationLockBusyError)
  await expect(readFile(candidatePath, 'utf8')).resolves.toContain('created-10')
})
