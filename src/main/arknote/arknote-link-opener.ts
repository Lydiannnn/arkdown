import {
  createOwnerAwareLinkTargetOpener,
  type LinkTargetOwner,
  type SystemLinkTargetAdapters,
} from '../link-target-opener'

export function createArknoteStickyNoteLinkOpener(
  owner: LinkTargetOwner,
  adapters: SystemLinkTargetAdapters,
): (target: string) => Promise<void> {
  return createOwnerAwareLinkTargetOpener(owner, adapters)
}
