import { describe, expect, it, vi } from 'vitest'
import { PublicError } from '../../src/shared/public-errors'
import {
  createOwnerAwareLinkTargetOpener,
  openLinkTarget,
} from '../../src/main/link-target-opener'

function adapters() {
  return {
    realpath: vi.fn(async (value: string) => `canonical:${value}`),
    releaseFocus: vi.fn(),
    restoreFocus: vi.fn(),
    openExternal: vi.fn(async (): Promise<void> => undefined),
    openPath: vi.fn(async () => ''),
  }
}

describe('openLinkTarget', () => {
  it('opens a validated web target in the default browser', async () => {
    const deps = adapters()
    const events: string[] = []
    deps.releaseFocus.mockImplementation(() => { events.push('release-focus') })
    deps.openExternal.mockImplementation(async () => { events.push('open-external') })

    await openLinkTarget('https://example.com/docs', deps)

    expect(deps.openExternal).toHaveBeenCalledWith('https://example.com/docs')
    expect(events).toEqual(['release-focus', 'open-external'])
    expect(deps.releaseFocus).toHaveBeenCalledOnce()
    expect(deps.restoreFocus).not.toHaveBeenCalled()
    expect(deps.realpath).not.toHaveBeenCalled()
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it.each([
    ['file:///C:/Literal%20Folder/note.md', 'C:\\Literal Folder\\note.md'],
    ['file://server/share/Team%20Notes.md', '\\\\server\\share\\Team Notes.md'],
  ])('canonicalizes the local target %s before opening its literal native path', async (
    input,
    nativePath,
  ) => {
    const deps = adapters()
    const events: string[] = []
    deps.realpath.mockImplementation(async () => {
      events.push('realpath')
      return 'C:\\Canonical Folder\\note.md'
    })
    deps.releaseFocus.mockImplementation(() => { events.push('release-focus') })
    deps.openPath.mockImplementation(async () => {
      events.push('open-path')
      return ''
    })

    await openLinkTarget(input, deps)

    expect(deps.realpath).toHaveBeenCalledWith(nativePath)
    expect(deps.openPath).toHaveBeenCalledWith('C:\\Canonical Folder\\note.md')
    expect(events).toEqual(['realpath', 'release-focus', 'open-path'])
    expect(deps.releaseFocus).toHaveBeenCalledOnce()
    expect(deps.restoreFocus).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it.each([
    'file:///C|/Windows/file.txt',
    'file://C:/Windows/file.txt',
    String.raw`file:///C:\Windows/file.txt`,
  ])('rejects the malformed raw file target %s before any main opener side effect', async (input) => {
    const deps = adapters()

    await expect(openLinkTarget(input, deps)).rejects.toEqual(new PublicError('INVALID_INPUT'))
    expect(deps.realpath).not.toHaveBeenCalled()
    expect(deps.releaseFocus).not.toHaveBeenCalled()
    expect(deps.restoreFocus).not.toHaveBeenCalled()
    expect(deps.openPath).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('maps a missing local target to the bounded public error', async () => {
    const deps = adapters()
    deps.realpath.mockRejectedValue(Object.assign(new Error('private path'), { code: 'ENOENT' }))

    const result = openLinkTarget('C:\\Missing Folder\\note.md', deps)

    await expect(result).rejects.toEqual(new PublicError('FILE_NOT_FOUND'))
    expect(deps.releaseFocus).not.toHaveBeenCalled()
    expect(deps.restoreFocus).not.toHaveBeenCalled()
    expect(deps.openPath).not.toHaveBeenCalled()
  })

  it('does not reclaim focus after the system opener settles', async () => {
    let settle!: () => void
    const deps = adapters()
    deps.openExternal.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))

    const opening = openLinkTarget('https://example.com/focus', deps)

    expect(deps.releaseFocus).toHaveBeenCalledOnce()
    settle()
    await opening
    expect(deps.releaseFocus).toHaveBeenCalledOnce()
    expect(deps.restoreFocus).not.toHaveBeenCalled()
  })

  it('restores the still-live owner when the web opener rejects', async () => {
    const deps = adapters()
    const failure = new Error('browser launch failed')
    deps.openExternal.mockRejectedValue(failure)

    await expect(openLinkTarget('https://example.com/failure', deps)).rejects.toBe(failure)

    expect(deps.releaseFocus).toHaveBeenCalledOnce()
    expect(deps.restoreFocus).toHaveBeenCalledOnce()
  })

  it.each([
    ['resolved failure', async () => 'No application is associated'],
    ['rejected failure', async () => { throw new Error('native launch failed') }],
  ])('restores the still-live owner after a local %s', async (_name, openPath) => {
    const deps = adapters()
    deps.openPath.mockImplementation(openPath)

    await expect(openLinkTarget('C:\\Notes\\failure.md', deps)).rejects.toThrow()

    expect(deps.releaseFocus).toHaveBeenCalledOnce()
    expect(deps.restoreFocus).toHaveBeenCalledOnce()
  })

  it('binds focus compensation to the originating owner without reclaiming success', async () => {
    let destroyed = false
    const owner = {
      blur: vi.fn(),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
    }
    const system = {
      realpath: vi.fn(async (value: string) => value),
      openExternal: vi.fn(async () => undefined),
      openPath: vi.fn(async () => ''),
    }
    const open = createOwnerAwareLinkTargetOpener(owner, system)

    await open('https://example.com/success')
    expect(owner.blur).toHaveBeenCalledOnce()
    expect(owner.focus).not.toHaveBeenCalled()

    system.openExternal.mockRejectedValueOnce(new Error('launch failed'))
    await expect(open('https://example.com/failure')).rejects.toThrow('launch failed')
    expect(owner.blur).toHaveBeenCalledTimes(2)
    expect(owner.focus).toHaveBeenCalledOnce()

    system.openExternal.mockImplementationOnce(async () => {
      destroyed = true
      throw new Error('owner closed during launch')
    })
    await expect(open('https://example.com/closed')).rejects.toThrow('owner closed during launch')
    expect(owner.focus).toHaveBeenCalledOnce()
  })
})
