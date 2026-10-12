import { describe, expect, it, vi } from 'vitest'
import { bindDocxOwner } from '../../src/main/docx/docx-owner'

describe('owner-bound DOCX operations', () => {
  it('cancels all conversion entry points for one owner and uses its renewed signal on retry', async () => {
    const service = {
      import: vi.fn(async () => ({ markdown: '' })),
      importText: vi.fn(async () => ({ text: '' })),
      exportDocx: vi.fn(async () => {}),
      canReuseTarget: vi.fn(async () => true),
    }
    let owner = new AbortController()
    const otherOwner = new AbortController()
    const bound = bindDocxOwner(service as unknown as Parameters<typeof bindDocxOwner>[0], () => owner.signal)
    const other = bindDocxOwner(service as unknown as Parameters<typeof bindDocxOwner>[0], () => otherOwner.signal)
    await bound.import('source.docx')
    await bound.importText('source.docx')
    await bound.exportDocx('# New', 'target.docx')
    await other.exportDocx('# Other', 'other.docx')
    const calls = service.exportDocx.mock.calls as unknown as Array<[string, string, { signal: AbortSignal }]>
    const imports = service.import.mock.calls as unknown as Array<[string, { signal: AbortSignal }]>
    const texts = service.importText.mock.calls as unknown as Array<[string, { signal: AbortSignal }]>
    owner.abort()
    expect(imports[0][1].signal.aborted).toBe(true)
    expect(texts[0][1].signal.aborted).toBe(true)
    expect(calls[0][2].signal.aborted).toBe(true)
    expect(calls[1][2].signal.aborted).toBe(false)
    owner = new AbortController()
    await bound.exportDocx('# Retry', 'target.docx')
    expect(calls[2][2].signal.aborted).toBe(false)
  })

  it('preserves caller cancellation and import limits without canceling its owner', async () => {
    const service = { importText: vi.fn(async () => ({ text: '' })) }
    const owner = new AbortController()
    const caller = new AbortController()
    const bound = bindDocxOwner(service as unknown as Parameters<typeof bindDocxOwner>[0], () => owner.signal)
    await bound.importText('source.docx', { signal: caller.signal, timeoutMs: 50 })
    const calls = service.importText.mock.calls as unknown as Array<[string, { signal: AbortSignal; timeoutMs: number }]>
    expect(calls[0][1].timeoutMs).toBe(50)
    caller.abort()
    expect(calls[0][1].signal.aborted).toBe(true)
    expect(owner.signal.aborted).toBe(false)
  })
})
