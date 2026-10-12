import type { BigIntStats } from 'node:fs'

declare const canonicalFileIdentityBrand: unique symbol

/** Main-process-only canonical identity for the current NTFS dev/ino contract. */
export type CanonicalFileIdentity = string & {
  readonly [canonicalFileIdentityBrand]: 'CanonicalFileIdentity'
}

function identityComponent(value: unknown): bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new Error('Filesystem identity is unavailable')
  }
  return value
}

export function canonicalFileIdentityFromStats(
  metadata: Pick<BigIntStats, 'dev' | 'ino'>,
): CanonicalFileIdentity {
  const device = identityComponent(metadata.dev)
  const inode = identityComponent(metadata.ino)
  return `${device.toString(16)}.${inode.toString(16)}` as CanonicalFileIdentity
}

export function sameCanonicalFileIdentity(
  first: CanonicalFileIdentity,
  second: CanonicalFileIdentity,
): boolean {
  return first === second
}
