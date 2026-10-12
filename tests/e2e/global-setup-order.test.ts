import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
  order: [] as string[],
  provenance: vi.fn(),
  audit: vi.fn(),
  copy: vi.fn(),
}))
vi.mock('../../scripts/package-provenance', () => ({
  assertPackageProvenanceMatchesCleanSource: () => {
    operations.order.push('provenance')
    return operations.provenance()
  },
}))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFile = (...args: unknown[]) => {
    operations.order.push('audit')
    operations.audit(...args.slice(0, -1))
    const callback = args.at(-1) as (error: Error) => void
    callback(new Error('audit rejected test artifact'))
  }
  return { ...actual, execFile, default: { ...actual, execFile } }
})
vi.mock('./support/runtime', () => ({
  runE2eStage: (_label: string, action: () => Promise<unknown>) => action(),
  prepareSharedRuntime: (...args: unknown[]) => {
    operations.order.push('copy')
    return operations.copy(...args)
  },
  cleanupRuntime: vi.fn(),
}))

import globalSetup from './global-setup'

describe('native acceptance package gate ordering', () => {
  beforeEach(() => {
    operations.order.length = 0
    vi.clearAllMocks()
  })

  it('rejects stale source provenance before auditing or copying a native runtime', async () => {
    operations.provenance.mockRejectedValue(new Error('stale package source'))
    await expect(globalSetup()).rejects.toThrow('stale package source')
    expect(operations.order).toEqual(['provenance'])
    expect(operations.audit).not.toHaveBeenCalled()
    expect(operations.copy).not.toHaveBeenCalled()
  })

  it('runs the native ESM audit after provenance and refuses to copy a rejected artifact', async () => {
    operations.provenance.mockResolvedValue(undefined)
    await expect(globalSetup()).rejects.toThrow('audit rejected test artifact')
    expect(operations.order).toEqual(['provenance', 'audit'])
    expect(operations.audit.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['--input-type=module', '--eval']))
    expect(operations.audit.mock.calls[0]?.[2]).toMatchObject({ shell: false, windowsHide: true })
    expect(operations.copy).not.toHaveBeenCalled()
  })
})
