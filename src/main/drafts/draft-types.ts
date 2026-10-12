import type { DocumentEncoding, NewlineStyle } from '../../shared/contracts'

export interface DraftAssetRecord {
  assetId: string
  fileName: string
  sha256: string
}

export interface DraftManifest {
  version: 1
  draftId: string
  originalAbsolutePath: string | null
  workspaceAbsolutePath: string | null
  originalRevision: string | null
  originalMtimeMs: number | null
  encoding: DocumentEncoding
  newline: NewlineStyle
  updatedAt: string
  appVersion: string
  ignoredAt: string | null
  bodySha256: string
  assets: DraftAssetRecord[]
}

export interface DraftSummary {
  draftId: string
  originalAbsolutePath: string | null
  workspaceAbsolutePath: string | null
  originalRevision: string | null
  originalMtimeMs: number | null
  encoding: DocumentEncoding
  newline: NewlineStyle
  updatedAt: string
  ignoredAt: string | null
}

export interface RecoveredDraft {
  manifest: DraftSummary
  markdown: string
}

// One fsync/atomic replace commits the body and its metadata together. Ended
// records live outside removable content, so cleanup can never resurrect data.
export type DraftLifecycleRecord =
  | { version: 2; state: 'active'; manifest: DraftManifest; markdown: string }
  | { version: 2; state: 'ended'; draftId: string; reason: 'saved' | 'discarded' | 'clean'; endedAt: string }
