import { parseLinkTarget } from '../shared/link-target'
import { PublicError } from '../shared/public-errors'

export interface OpenLinkTargetAdapters {
  realpath(target: string): Promise<string>
  releaseFocus?(): void
  restoreFocus?(): void
  openExternal(target: string): Promise<void>
  openPath(target: string): Promise<string>
}

export interface LinkTargetOwner {
  blur(): void
  focus(): void
  isDestroyed(): boolean
}

export type SystemLinkTargetAdapters = Pick<
  OpenLinkTargetAdapters,
  'realpath' | 'openExternal' | 'openPath'
>

async function openAfterFocusRelease(
  adapters: OpenLinkTargetAdapters,
  open: () => Promise<void>,
): Promise<void> {
  adapters.releaseFocus?.()
  try {
    await open()
  } catch (error) {
    adapters.restoreFocus?.()
    throw error
  }
}

export function createOwnerAwareLinkTargetOpener(
  owner: LinkTargetOwner,
  adapters: SystemLinkTargetAdapters,
): (target: string) => Promise<void> {
  return (target) => openLinkTarget(target, {
    ...adapters,
    releaseFocus: () => {
      if (owner.isDestroyed()) return
      try { owner.blur() } catch { /* the owner closed during the foreground handoff */ }
    },
    restoreFocus: () => {
      if (owner.isDestroyed()) return
      try { owner.focus() } catch { /* the owner closed before compensation */ }
    },
  })
}

export async function openLinkTarget(
  value: string,
  adapters: OpenLinkTargetAdapters,
): Promise<void> {
  const target = parseLinkTarget(value)
  if (!target) throw new PublicError('INVALID_INPUT')
  if (target.kind === 'web') {
    await openAfterFocusRelease(adapters, () => adapters.openExternal(target.url))
    return
  }

  let canonical: string
  try {
    canonical = await adapters.realpath(target.path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new PublicError('FILE_NOT_FOUND')
    throw error
  }
  await openAfterFocusRelease(adapters, async () => {
    const failure = await adapters.openPath(canonical)
    if (failure) throw new Error(failure)
  })
}
