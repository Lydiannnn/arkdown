import path from 'node:path'
import { documentTypeForPath, isEditableDocumentPath } from '../shared/document-types'

export function startupDocumentIntent(
  argv: readonly string[],
  isPackaged: boolean,
): string | null {
  const candidates = argv.slice(isPackaged ? 1 : 2)
  for (const candidate of candidates) {
    if (candidate.startsWith('-') || !path.win32.isAbsolute(candidate)) continue
    const definition = documentTypeForPath(candidate)
    if (isEditableDocumentPath(candidate) || definition?.importWithPandoc) return candidate
  }
  return null
}

export type StartupWindowIntent =
  | { kind: 'document'; absolutePath: string }
  | { kind: 'blank' }
  | { kind: 'none' }

export interface StartupDocumentIntentPresentationTarget {
  once(event: 'closed', listener: () => void): unknown
  isDestroyed(): boolean
  show(): void
  focus(): void
}

export interface StartupDocumentIntentPresenter {
  present(
    loaded: Promise<void>,
    reportFailure: (error: unknown) => Promise<void>,
  ): Promise<void>
}

export function createStartupDocumentIntentPresenter(
  target: StartupDocumentIntentPresentationTarget,
): StartupDocumentIntentPresenter {
  let generation = 0
  target.once('closed', () => { generation += 1 })

  return {
    async present(loaded, reportFailure) {
      const presentationGeneration = ++generation
      try {
        await loaded
      } catch (error) {
        await reportFailure(error)
      }
      if (target.isDestroyed() || generation !== presentationGeneration) return
      target.show()
      if (target.isDestroyed() || generation !== presentationGeneration) return
      target.focus()
    },
  }
}

export function chooseStartupWindowIntent(input: {
  explicitDocument: string | null
  recoveredDraftCount: number
  recentDocuments: readonly string[]
}): StartupWindowIntent {
  if (input.explicitDocument) {
    return { kind: 'document', absolutePath: input.explicitDocument }
  }
  if (input.recoveredDraftCount > 0) return { kind: 'none' }
  const recentDocument = input.recentDocuments[0]
  return recentDocument
    ? { kind: 'document', absolutePath: recentDocument }
    : { kind: 'blank' }
}
